/**
 * Title insights, always split by content type (podcast vs TNTL) because their
 * view baselines differ ~6x. Two lenses:
 *   corpus — across ALL published videos: does a title attribute correlate with
 *            more views than that type's median? (works for never-tested videos)
 *   ab     — within A/B title tests: does the attribute beat its own test's mean CTR?
 */
import { getDb } from '../db/client.js';
import type { ContentType } from './content-type.js';

// Only real per-slot rows, and reject impossible CTR (see learnings.ts).
const NOT_BASELINE = `(
  (tm.realtime_views_json LIKE '%"type":"rotation_slot"%' OR tm.realtime_views_json LIKE '%"type":"reconstructed_vtr"%')
  AND NOT (tm.ctr > 25)
  AND tm.realtime_views_json NOT LIKE '%"suspect":true%'
)`;

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const round2 = (n: number) => Math.round(n * 100) / 100;
const round1 = (n: number) => Math.round(n * 10) / 10;

export interface CorpusTag {
  name: string; category: string | null; videos: number;
  lift_vs_median: number; // 1.0 = same as this type's median video
  median_views: number;
}

/** Corpus lens: for a content type, which title tags over/under-perform the median video. */
export function computeTitleCorpus(): Record<ContentType, { median_views: number; total_videos: number; tags: CorpusTag[] }> {
  const db = getDb();
  const rows = db.prepare(`
    SELECT v.video_id, v.view_count AS views, m.content_type AS ctype, tt.name, tt.category
    FROM yt.videos v
    JOIN title_tag_map m ON m.video_id = v.video_id
    JOIN title_tags tt ON tt.id = m.tag_id
    WHERE v.view_count > 0
  `).all() as any[];

  // Per type, all video views (distinct videos) for the median baseline.
  const viewsByType: Record<string, Map<string, number>> = { podcast: new Map(), TNTL: new Map() };
  for (const r of rows) if (viewsByType[r.ctype]) viewsByType[r.ctype].set(r.video_id, r.views);

  const out: any = {};
  for (const ctype of ['podcast', 'TNTL'] as ContentType[]) {
    const allViews = [...viewsByType[ctype].values()];
    const med = median(allViews);
    // group tag -> video views
    const byTag = new Map<string, { cat: string | null; views: number[] }>();
    for (const r of rows) {
      if (r.ctype !== ctype) continue;
      const e = byTag.get(r.name) ?? { cat: r.category as string | null, views: [] as number[] };
      e.views.push(r.views as number);
      byTag.set(r.name, e);
    }
    const tags: CorpusTag[] = [];
    for (const [name, e] of byTag) {
      if (e.views.length < 3) continue;
      const tagMed = median(e.views);
      tags.push({ name, category: e.cat, videos: e.views.length, median_views: Math.round(tagMed), lift_vs_median: med > 0 ? round2(tagMed / med) : 0 });
    }
    tags.sort((a, b) => b.lift_vs_median - a.lift_vs_median);
    out[ctype] = { median_views: Math.round(med), total_videos: allViews.length, tags };
  }
  return out;
}

export interface AbTitleTag {
  name: string; category: string | null; tests: number; avg_uplift_pct: number; win_rate: number;
  verdict: 'proven' | 'promising' | 'coinflip' | 'weak';
}

/** A/B lens: within title tests, title-tag CTR uplift vs the test's own mean, per type.
 *  Includes both pure title tests and 'both' tests (title + thumbnail changed). */
export function computeTitleAbUplift(minTests = 2, sinceDays?: number): Record<ContentType, AbTitleTag[]> {
  const db = getDb();
  // Each active title-or-both test variant: its weighted CTR, impressions, content type, winner flag.
  // sinceDays limits to tests completed in that window (7 / 30 / all).
  const rows = db.prepare(`
    SELECT tv.id AS variant_id, tv.test_id, t.winner_variant_id,
      COALESCE(SUM(tm.impressions), 0) AS imp,
      CASE WHEN SUM(tm.impressions) > 0 THEN SUM(tm.impressions * tm.ctr) / SUM(tm.impressions) ELSE 0 END AS ctr
    FROM test_variants tv
    JOIN tests t ON t.id = tv.test_id AND t.status = 'completed' AND t.test_type IN ('title', 'both')
      ${sinceDays ? "AND COALESCE(t.completed_at, t.created_at) >= datetime('now', ?)" : ''}
    LEFT JOIN test_measurements tm ON tm.variant_id = tv.id AND ${NOT_BASELINE}
    WHERE tv.active = 1
    GROUP BY tv.id HAVING imp > 0
  `).all(...(sinceDays ? [`-${sinceDays} days`] : [])) as any[];

  // Per-test mean CTR (impression weighted).
  const byTest = new Map<number, { impSum: number; wSum: number }>();
  for (const r of rows) {
    const e = byTest.get(r.test_id) ?? { impSum: 0, wSum: 0 };
    e.impSum += r.imp; e.wSum += r.ctr * r.imp; byTest.set(r.test_id, e);
  }
  const testMean = new Map<number, number>();
  for (const [tid, e] of byTest) testMean.set(tid, e.impSum > 0 ? e.wSum / e.impSum : 0);

  // Variant -> title tags (+ content type from the map).
  const tagRows = db.prepare(`
    SELECT m.variant_id, m.content_type, tt.name, tt.category
    FROM title_tag_map m JOIN title_tags tt ON tt.id = m.tag_id
    WHERE m.variant_id IS NOT NULL
  `).all() as any[];
  const tagsByVariant = new Map<number, any[]>();
  for (const tr of tagRows) {
    const arr = tagsByVariant.get(tr.variant_id) ?? [];
    arr.push(tr); tagsByVariant.set(tr.variant_id, arr);
  }

  interface Acc { cat: string | null; tests: Set<number>; wUplift: number; wImp: number; wins: number; }
  const acc: Record<string, Map<string, Acc>> = { podcast: new Map(), TNTL: new Map() };
  for (const r of rows) {
    const mean = testMean.get(r.test_id) ?? 0;
    if (mean <= 0) continue;
    const uplift = (r.ctr - mean) / mean;
    for (const tg of tagsByVariant.get(r.variant_id) ?? []) {
      const bucket = acc[tg.content_type as ContentType]; if (!bucket) continue;
      const a = bucket.get(tg.name) ?? { cat: tg.category, tests: new Set<number>(), wUplift: 0, wImp: 0, wins: 0 };
      a.wUplift += uplift * r.imp; a.wImp += r.imp;
      if (!a.tests.has(r.test_id)) { a.tests.add(r.test_id); if (r.winner_variant_id === r.variant_id) a.wins++; }
      bucket.set(tg.name, a);
    }
  }

  const out: any = { podcast: [], TNTL: [] };
  for (const ctype of ['podcast', 'TNTL'] as ContentType[]) {
    const list: AbTitleTag[] = [];
    for (const [name, a] of acc[ctype]) {
      if (a.tests.size < minTests) continue;
      const avg = round1(a.wImp > 0 ? (a.wUplift / a.wImp) * 100 : 0);
      const tests = a.tests.size;
      let verdict: AbTitleTag['verdict'];
      if (avg >= 5 && tests >= 4) verdict = 'proven';
      else if (avg >= 2) verdict = 'promising';
      else if (avg <= -3) verdict = 'weak';
      else verdict = 'coinflip';
      list.push({ name, category: a.cat, tests, avg_uplift_pct: avg, win_rate: round2(tests ? a.wins / tests : 0), verdict });
    }
    list.sort((x, y) => y.avg_uplift_pct - x.avg_uplift_pct);
    out[ctype] = list;
  }
  return out;
}
