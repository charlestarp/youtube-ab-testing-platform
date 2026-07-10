/**
 * Learnings engine — turns the pile of completed A/B tests into decisions.
 *
 * Three things:
 *  1. Per-test confidence. Re-scores every completed test with a two-proportion
 *     z-test (winner vs runner-up) so we can separate real wins from coin flips.
 *  2. Portfolio ROI. The extra views testing has bought, summed conservatively
 *     over the confident wins only.
 *  3. Within-test tag uplift. For each creative tag, how much a variant carrying
 *     it beats its OWN test's average, controlling for the video. Ranked into
 *     proven moves and busted myths.
 */

import { getDb } from '../db/client.js';
import { calculateSignificance } from './stats.js';
import { classifyContent, type ContentType } from './content-type.js';

// video_id -> youtube.db category, for content-type classification.
function categoryByVideo(): Map<string, string> {
  try {
    return new Map((getDb().prepare('SELECT video_id, category FROM yt.videos').all() as any[]).map(r => [r.video_id, r.category]));
  } catch {
    return new Map();
  }
}

// Count ONLY real per-slot measurements. Legacy 'baseline' / 'activation_baseline'
// rows are snapshots, not slot deltas, and sometimes hold cumulative video totals
// (that is what produced impossible 22% CTRs). Also drop any row whose implied CTR
// is physically impossible (>25%), which flags a corrupt capture.
const NOT_BASELINE = `(
  (tm.realtime_views_json LIKE '%"type":"rotation_slot"%' OR tm.realtime_views_json LIKE '%"type":"reconstructed_vtr"%')
  AND NOT (tm.ctr > 25)
  AND tm.realtime_views_json NOT LIKE '%"suspect":true%'
)`;

export type Tier = 'confident' | 'lean' | 'coinflip';

export interface TestConfidence {
  test_id: number;
  video_title: string | null;
  video_id: string;
  test_type: string;
  completed_at: string | null;
  winner_label: string | null;
  winner_ctr: number;      // percent
  runnerup_label: string | null;
  runnerup_ctr: number;    // percent
  lift_pct: number;        // winner over runner-up, percent
  winner_impressions: number;
  confidence: number;      // 0..1
  tier: Tier;
  extra_views: number;     // realized during the test, vs the losing average
  content_type: ContentType;
}

interface VariantAgg {
  id: number;
  label: string;
  is_control: number;
  imp: number;
  views: number;
  ctr: number; // percent
}

function tierFor(confidence: number): Tier {
  if (confidence >= 0.9) return 'confident';
  if (confidence >= 0.75) return 'lean';
  return 'coinflip';
}

/** Per-test confidence for every completed test that declared a winner.
 *  Pass a content type to restrict to podcast or TNTL tests only. */
export function computeTestConfidence(filter?: ContentType): TestConfidence[] {
  const db = getDb();
  const catByVideo = categoryByVideo();
  const tests = db.prepare(`
    SELECT id, video_title, video_id, test_type, completed_at, winner_variant_id
    FROM tests
    WHERE status = 'completed' AND winner_variant_id IS NOT NULL
    ORDER BY completed_at DESC
  `).all() as any[];

  const variantStmt = db.prepare(`
    SELECT tv.id, tv.label, tv.is_control,
      COALESCE(SUM(tm.impressions), 0) AS imp,
      COALESCE(SUM(tm.views), 0) AS views,
      CASE WHEN SUM(tm.impressions) > 0
        THEN SUM(tm.impressions * tm.ctr) / SUM(tm.impressions) ELSE 0 END AS ctr
    FROM test_variants tv
    LEFT JOIN test_measurements tm ON tm.variant_id = tv.id AND ${NOT_BASELINE}
    WHERE tv.test_id = ? AND tv.active = 1
    GROUP BY tv.id
  `);

  const out: TestConfidence[] = [];
  for (const t of tests) {
    const content_type = classifyContent(t.video_title, catByVideo.get(t.video_id));
    if (filter && content_type !== filter) continue;
    const variants = variantStmt.all(t.id) as VariantAgg[];
    const withImp = variants.filter(v => v.imp > 0);
    if (withImp.length < 2) continue;

    const winner = withImp.find(v => v.id === t.winner_variant_id);
    if (!winner) continue;
    const others = withImp.filter(v => v.id !== winner.id);
    if (others.length === 0) continue;

    // Runner-up = the strongest variant that did NOT win.
    const runnerup = others.reduce((a, b) => (b.ctr > a.ctr ? b : a));

    const clicks = (v: VariantAgg) => Math.round((v.imp * v.ctr) / 100);
    const sig = calculateSignificance(winner.imp, clicks(winner), runnerup.imp, clicks(runnerup));

    const lift = runnerup.ctr > 0 ? ((winner.ctr - runnerup.ctr) / runnerup.ctr) * 100 : 0;

    // Extra views during the test: winner's CTR edge over the losing average,
    // applied to the winner's own impressions. Clamped at zero (never negative).
    const losers = others;
    const loserImp = losers.reduce((s, v) => s + v.imp, 0);
    const loserMeanCtr = loserImp > 0 ? losers.reduce((s, v) => s + v.ctr * v.imp, 0) / loserImp : 0;
    const extra = Math.max(0, ((winner.ctr - loserMeanCtr) / 100) * winner.imp);

    out.push({
      test_id: t.id,
      video_title: t.video_title,
      video_id: t.video_id,
      test_type: t.test_type,
      completed_at: t.completed_at,
      winner_label: winner.label,
      winner_ctr: round2(winner.ctr),
      runnerup_label: runnerup.label,
      runnerup_ctr: round2(runnerup.ctr),
      lift_pct: round1(lift),
      winner_impressions: winner.imp,
      confidence: sig.confidence,
      tier: tierFor(sig.confidence),
      extra_views: Math.round(extra),
      content_type,
    });
  }
  return out;
}

export interface TagUplift {
  tag_id: number;
  name: string;
  category: string | null;
  color: string | null;
  tests: number;          // how many tests this tag appeared in (with data)
  avg_uplift_pct: number; // impression-weighted, vs each test's own mean
  win_rate: number;       // share of its tests where a tagged variant won
  verdict: 'proven' | 'promising' | 'coinflip' | 'weak';
}

/**
 * Within-test uplift: each tagged variant is compared to the average CTR of its
 * OWN test, so the video itself is controlled for. Averaged across tests,
 * weighted by impressions.
 */
export function computeTagUplift(minTests = 3, filter?: ContentType, sinceDays?: number): TagUplift[] {
  const db = getDb();

  // Tests matching the content-type filter (derive type from title/category).
  const catByVideo = categoryByVideo();
  const allowedTests = new Set<number>();
  if (filter) {
    for (const t of db.prepare(`SELECT id, video_title, video_id FROM tests WHERE status='completed'`).all() as any[]) {
      if (classifyContent(t.video_title, catByVideo.get(t.video_id)) === filter) allowedTests.add(t.id);
    }
  }

  // Every active variant in a completed test, with its own weighted CTR + impressions.
  // sinceDays limits to tests completed in that window (7 / 30 / all).
  const rows = (db.prepare(`
    SELECT tv.id AS variant_id, tv.test_id, t.winner_variant_id,
      COALESCE(SUM(tm.impressions), 0) AS imp,
      CASE WHEN SUM(tm.impressions) > 0
        THEN SUM(tm.impressions * tm.ctr) / SUM(tm.impressions) ELSE 0 END AS ctr
    FROM test_variants tv
    JOIN tests t ON t.id = tv.test_id AND t.status = 'completed'
      ${sinceDays ? "AND COALESCE(t.completed_at, t.created_at) >= datetime('now', ?)" : ''}
    LEFT JOIN test_measurements tm ON tm.variant_id = tv.id AND ${NOT_BASELINE}
    WHERE tv.active = 1
    GROUP BY tv.id
    HAVING imp > 0
  `).all(...(sinceDays ? [`-${sinceDays} days`] : [])) as any[]).filter(r => !filter || allowedTests.has(r.test_id));

  // Per-test impression-weighted mean CTR.
  const byTest = new Map<number, { impSum: number; wSum: number }>();
  for (const r of rows) {
    const e = byTest.get(r.test_id) ?? { impSum: 0, wSum: 0 };
    e.impSum += r.imp;
    e.wSum += r.ctr * r.imp;
    byTest.set(r.test_id, e);
  }
  const testMean = new Map<number, number>();
  for (const [tid, e] of byTest) testMean.set(tid, e.impSum > 0 ? e.wSum / e.impSum : 0);

  // Variant -> tags.
  const tagRows = db.prepare(`
    SELECT vt.variant_id, th.id AS tag_id, th.name, th.category, th.color
    FROM variant_tags vt JOIN thumbnail_tags th ON th.id = vt.tag_id
  `).all() as any[];
  const tagsByVariant = new Map<number, any[]>();
  for (const tr of tagRows) {
    const arr = tagsByVariant.get(tr.variant_id) ?? [];
    arr.push(tr);
    tagsByVariant.set(tr.variant_id, arr);
  }

  // Accumulate per-tag uplift, weighted by impressions.
  interface Acc { name: string; category: string | null; color: string | null; tests: Set<number>; wUplift: number; wImp: number; wins: number; testCount: number; }
  const acc = new Map<number, Acc>();
  for (const r of rows) {
    const mean = testMean.get(r.test_id) ?? 0;
    if (mean <= 0) continue;
    const uplift = (r.ctr - mean) / mean; // relative, e.g. 0.08 = +8%
    const tags = tagsByVariant.get(r.variant_id) ?? [];
    for (const tg of tags) {
      const a = acc.get(tg.tag_id) ?? { name: tg.name, category: tg.category, color: tg.color, tests: new Set<number>(), wUplift: 0, wImp: 0, wins: 0, testCount: 0 };
      a.wUplift += uplift * r.imp;
      a.wImp += r.imp;
      if (!a.tests.has(r.test_id)) {
        a.tests.add(r.test_id);
        if (r.winner_variant_id === r.variant_id) a.wins += 1;
      }
      acc.set(tg.tag_id, a);
    }
  }

  const out: TagUplift[] = [];
  for (const [tag_id, a] of acc) {
    const tests = a.tests.size;
    if (tests < minTests) continue;
    const avg = a.wImp > 0 ? (a.wUplift / a.wImp) * 100 : 0;
    const winRate = tests > 0 ? a.wins / tests : 0;
    let verdict: TagUplift['verdict'];
    if (avg >= 5 && tests >= 4) verdict = 'proven';
    else if (avg >= 2) verdict = 'promising';
    else if (avg <= -3) verdict = 'weak';
    else verdict = 'coinflip';
    out.push({ tag_id, name: a.name, category: a.category, color: a.color, tests, avg_uplift_pct: round1(avg), win_rate: round2(winRate), verdict });
  }
  out.sort((x, y) => y.avg_uplift_pct - x.avg_uplift_pct);
  return out;
}

export interface Portfolio {
  total_tests: number;
  confident: number;
  lean: number;
  coinflip: number;
  avg_confident_lift: number; // percent, for the dashboard
  extra_views_total: number;  // conservative ROI, confident wins only
  decisive_rate: number;      // share of tests that were confident or lean
}

export function computePortfolio(conf: TestConfidence[]): Portfolio {
  const total = conf.length;
  const confident = conf.filter(c => c.tier === 'confident');
  const lean = conf.filter(c => c.tier === 'lean');
  const coinflip = conf.filter(c => c.tier === 'coinflip');
  const avgLift = confident.length > 0 ? confident.reduce((s, c) => s + c.lift_pct, 0) / confident.length : 0;
  const extra = confident.reduce((s, c) => s + c.extra_views, 0);
  return {
    total_tests: total,
    confident: confident.length,
    lean: lean.length,
    coinflip: coinflip.length,
    avg_confident_lift: round1(avgLift),
    extra_views_total: Math.round(extra),
    decisive_rate: total > 0 ? round2((confident.length + lean.length) / total) : 0,
  };
}

export interface BrandMention {
  text: string;
  author: string | null;
  video_id: string | null;
  comment_id: string | null;
  video_title: string | null;
  is_competitor: number;
  published_at: string | null;
}

/**
 * Brand reach: comments flagged as mentioning Toni and Ryan (`mentions_us`),
 * including the ones landing on other channels' videos. A mention counts as
 * "another channel" only when the video is NOT one of ours (channel_videos)
 * but IS a tracked competitor video. Our own videos win the title lookup.
 */
export function computeBrandMentions(): { total: number; recent: BrandMention[] } {
  const db = getDb();
  try {
    const total = (db.prepare(`SELECT COUNT(*) AS c FROM comments WHERE mentions_us = 1`).get() as any)?.c ?? 0;
    // A video is "ours" if we ran a test on it, it's on our synced channel, or the
    // matched competitor entry is our own channel (the show tracks itself). Scalar
    // subqueries keep one row per comment (a video can have several tests).
    const recent = db.prepare(`
      SELECT c.content AS text, c.author AS author, c.published_at AS published_at,
        c.video_id AS video_id, c.comment_id AS comment_id,
        COALESCE(
          (SELECT video_title FROM tests WHERE video_id = c.video_id AND video_title IS NOT NULL LIMIT 1),
          (SELECT title FROM channel_videos WHERE video_id = c.video_id LIMIT 1),
          (SELECT title FROM competitor_videos WHERE video_id = c.video_id LIMIT 1)
        ) AS video_title,
        CASE
          WHEN EXISTS (SELECT 1 FROM tests WHERE video_id = c.video_id)
            OR EXISTS (SELECT 1 FROM channel_videos WHERE video_id = c.video_id)
            OR EXISTS (SELECT 1 FROM competitor_videos cv JOIN competitors co ON co.id = cv.competitor_id
                       WHERE cv.video_id = c.video_id AND LOWER(co.name) = 'toni and ryan')
            THEN 0
          WHEN EXISTS (SELECT 1 FROM competitor_videos WHERE video_id = c.video_id) THEN 1
          ELSE 0
        END AS is_competitor
      FROM comments c
      WHERE c.mentions_us = 1
      ORDER BY c.published_at DESC
      LIMIT 10
    `).all() as any[];
    return { total, recent };
  } catch {
    return { total: 0, recent: [] };
  }
}

function round1(n: number): number { return Math.round(n * 10) / 10; }
function round2(n: number): number { return Math.round(n * 100) / 100; }
