/**
 * Pre-flight title scorer — called before any live test slot burns.
 *
 * Combines three signal sources, ranked by reliability:
 *   1. A/B uplift verdicts  (head-to-head proof on this exact channel)
 *   2. Corpus lift          (published video view correlations by tag)
 *   3. Test-winner similarity (how close to past winning titles)
 * Plus a light format heuristic (word count sweet spot).
 *
 * Returns a 0-100 score, a CTR band, per-tag signals, and human-readable
 * reasons. Never blocks — caller always decides what to do with the result.
 */
import { getDb } from '../db/client.js';
import { ruleTags } from './title-tagger.js';
import { computeTitleCorpus, computeTitleAbUplift } from './title-insights.js';
import { classifyContent, type ContentType } from './content-type.js';

const AD_WORDS = [
  'squirt', 'orgasm', 'penis', 'vagina', 'dildo', 'vibrator',
  'murder', 'suicide', 'cocaine', 'meth', 'heroin',
  'naked', 'nude', 'topless', 'porn',
];

function tokenSet(t: string): Set<string> {
  return new Set(t.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 1));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const inter = [...a].filter(w => b.has(w)).length;
  return inter / (a.size + b.size - inter);
}

function containment(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const inter = [...a].filter(w => b.has(w)).length;
  return inter / Math.min(a.size, b.size);
}

function similarity(aSet: Set<string>, bTitle: string): number {
  const bSet = tokenSet(bTitle);
  return 0.6 * jaccard(aSet, bSet) + 0.4 * containment(aSet, bSet);
}

export interface TitleSignal {
  tag: string;
  verdict: 'proven' | 'promising' | 'coinflip' | 'weak' | 'corpus_positive' | 'corpus_neutral' | 'corpus_negative';
  uplift_pct: number;  // % relative (AB) or % vs median (corpus)
  source: 'ab' | 'corpus';
}

export interface SimilarWinner {
  title: string;
  ctr: number;      // weighted CTR % of the winning variant
  similarity: number; // 0-100 integer
}

export interface TitlePreflightResult {
  score: number;             // 0-100
  ctr_band: 'top quartile' | 'above median' | 'around median' | 'below median';
  confidence: 'high' | 'medium' | 'low';
  verdict: 'strong' | 'good' | 'neutral' | 'weak';
  signals: TitleSignal[];
  similar_winners: SimilarWinner[];
  reasons: string[];
  content_type: ContentType;
}

export function preflightTitle(title: string, contentType?: ContentType): TitlePreflightResult {
  const ctype: ContentType = contentType ?? classifyContent(title, null);
  const tags = ruleTags(title);

  // Load A/B and corpus data (sync, in-process — already cached by the DB layer).
  let abData: ReturnType<typeof computeTitleAbUplift>[ContentType] = [];
  let corpusTags: ReturnType<typeof computeTitleCorpus>[ContentType]['tags'] = [];
  try { abData    = computeTitleAbUplift(1)[ctype]; }  catch {}
  try { corpusTags = computeTitleCorpus()[ctype]?.tags ?? []; } catch {}

  const abMap     = new Map(abData.map(t => [t.name, t]));
  const corpusMap = new Map(corpusTags.map(t => [t.name, t]));

  const signals: TitleSignal[] = [];
  const reasons: string[] = [];
  let score = 50;
  let abSignalCount = 0;

  for (const tag of tags) {
    const ab = abMap.get(tag);
    if (ab) {
      abSignalCount++;
      let delta = 0;
      if (ab.verdict === 'proven')     delta = +15;
      else if (ab.verdict === 'promising') delta = +8;
      else if (ab.verdict === 'weak')  delta = -12;
      // coinflip → delta 0

      score += delta;
      signals.push({ tag, verdict: ab.verdict, uplift_pct: ab.avg_uplift_pct, source: 'ab' });
      if (delta !== 0) {
        const dir = delta > 0 ? '+' : '';
        reasons.push(`"${tag}" is ${ab.verdict} in A/B (${dir}${ab.avg_uplift_pct}% CTR avg, ${ab.tests} test${ab.tests !== 1 ? 's' : ''})`);
      }
    } else {
      const corp = corpusMap.get(tag);
      if (corp) {
        const pct = Math.round((corp.lift_vs_median - 1) * 100);
        let delta = 0;
        let v: TitleSignal['verdict'];
        if (corp.lift_vs_median >= 1.4)       { delta = +8;  v = 'corpus_positive'; }
        else if (corp.lift_vs_median >= 1.1)  { delta = +4;  v = 'corpus_positive'; }
        else if (corp.lift_vs_median < 0.8)   { delta = -6;  v = 'corpus_negative'; }
        else                                   { delta =  0;  v = 'corpus_neutral';  }
        score += delta;
        signals.push({ tag, verdict: v, uplift_pct: pct, source: 'corpus' });
        if (Math.abs(delta) >= 4) {
          reasons.push(`"${tag}": ${pct >= 0 ? '+' : ''}${pct}% vs ${ctype} median (${corp.videos} videos)`);
        }
      }
    }
  }

  // Format heuristic: word-count sweet spot 5-8 words.
  const words = title.trim().split(/\s+/).length;
  if (words >= 5 && words <= 8) {
    score += 5;
  } else if (words <= 3 || words >= 13) {
    score -= 5;
    reasons.push(`${words} words — outside the 5-8 sweet spot`);
  }

  // Ad-safety hard penalty.
  const low = title.toLowerCase();
  const adHit = AD_WORDS.find(w => low.includes(w));
  if (adHit) {
    score -= 20;
    reasons.push(`Ad-risk word "${adHit}" — may limit recommendations`);
  }

  // Similarity to test winners with real CTR data.
  const similar_winners: SimilarWinner[] = [];
  try {
    const db = getDb();
    // Completed tests where the winning variant has a real CTR measurement.
    const winners = db.prepare(`
      SELECT tv.title,
        CASE WHEN SUM(tm.impressions) > 0
          THEN ROUND(SUM(tm.impressions * tm.ctr) / SUM(tm.impressions), 1)
          ELSE 0 END AS ctr
      FROM test_variants tv
      JOIN tests t ON t.id = tv.test_id
        AND t.status = 'completed'
        AND t.winner_variant_id = tv.id
      LEFT JOIN test_measurements tm ON tm.variant_id = tv.id
        AND (
          tm.realtime_views_json LIKE '%"type":"rotation_slot"%'
          OR tm.realtime_views_json LIKE '%"type":"reconstructed_vtr"%'
        )
        AND NOT (tm.ctr > 25)
      WHERE tv.title IS NOT NULL AND tv.title != '' AND tv.active = 1
      GROUP BY tv.id
      HAVING ctr > 0
      ORDER BY ctr DESC
    `).all() as { title: string; ctr: number }[];

    const aTokens = tokenSet(title);
    let winBonus = 0;
    for (const w of winners) {
      const sim = similarity(aTokens, w.title);
      if (sim >= 0.45) {
        const simPct = Math.round(sim * 100);
        similar_winners.push({ title: w.title, ctr: w.ctr, similarity: simPct });
        const bonus = sim >= 0.7 ? 8 : 5;
        // Cap total winner-similarity bonus at 15 pts.
        const allowed = Math.min(bonus, 15 - winBonus);
        if (allowed > 0) { score += allowed; winBonus += allowed; }
        reasons.push(`${simPct}% similar to A/B winner "${w.title}" (${w.ctr}% CTR)`);
      }
    }
    similar_winners.sort((a, b) => b.similarity - a.similarity);
    similar_winners.splice(3);
    // Remove the verbose reasons if there are many matches — keep only top 2.
    const winReasons = reasons.filter(r => r.includes('similar to A/B winner'));
    if (winReasons.length > 2) {
      reasons.splice(reasons.indexOf(winReasons[2]), reasons.length - reasons.indexOf(winReasons[2]));
    }
  } catch {}

  score = Math.max(0, Math.min(100, Math.round(score)));

  const ctr_band: TitlePreflightResult['ctr_band'] =
    score >= 72 ? 'top quartile' :
    score >= 55 ? 'above median' :
    score >= 40 ? 'around median' : 'below median';

  const verdict: TitlePreflightResult['verdict'] =
    ctr_band === 'top quartile' ? 'strong' :
    ctr_band === 'above median' ? 'good'   :
    ctr_band === 'around median' ? 'neutral' : 'weak';

  const confidence: TitlePreflightResult['confidence'] =
    abSignalCount >= 3 ? 'high' :
    abSignalCount >= 1 ? 'medium' : 'low';

  return { score, ctr_band, confidence, verdict, signals, similar_winners, reasons, content_type: ctype };
}
