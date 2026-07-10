/**
 * Snapshot-delta engagement fill. Videos that only get DAILY analytics buckets
 * (hourly_available=0) skip reach-refresh's live-delta sampler, so their slots
 * never accrue likes/comments from the cumulative counters. But the studio
 * scraper samples cumulative likes/comments every ~5 minutes while a test is
 * active, so a slot's engagement = snapshot at slot end minus snapshot at slot
 * start. Runs every reach-refresh cycle for running + settling tests; only
 * ever fills slots whose likes AND comments are still 0 (never overwrites
 * live-accrued values). Same core the one-off backfill script uses.
 */

import { getDb } from '../db/client.js';

const utcMs = (s: string) => new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z').getTime();
const TOL = 45 * 60_000; // max distance from slot boundary to nearest snapshot

export function fillEngagementFromSnapshots(testIds?: number[]): { filled: number; skipped: number } {
  const db = getDb();
  let filled = 0, skipped = 0;

  const tests = testIds && testIds.length
    ? testIds.map(id => db.prepare('SELECT id, video_id, ctr_locked FROM tests WHERE id=?').get(id) as any).filter(Boolean)
    : db.prepare(`
        SELECT id, video_id, ctr_locked FROM tests
        WHERE video_id IS NOT NULL AND (
          status='running' OR (status='completed' AND completed_at > datetime('now','-48 hours')))
      `).all() as any[];

  for (const test of tests) {
    if (test.ctr_locked) continue;

    const slots = (db.prepare(`
      SELECT m.id, m.likes, m.comments, m.realtime_views_json
      FROM test_measurements m JOIN test_variants v ON v.id = m.variant_id
      WHERE m.test_id = ? AND v.active = 1
        AND COALESCE(m.likes,0) = 0 AND COALESCE(m.comments,0) = 0
        AND m.realtime_views_json LIKE '%"type":"rotation_slot"%'
        AND m.realtime_views_json NOT LIKE '%"live":true%'
    `).all(test.id) as any[]).map(m => {
      try {
        const j = JSON.parse(m.realtime_views_json || '{}');
        if (!j.activated_at || !j.completed_at) return null;
        return { id: m.id, start: utcMs(j.activated_at), end: utcMs(j.completed_at) };
      } catch { return null; }
    }).filter(Boolean) as any[];
    if (slots.length === 0) continue;

    const snaps = (db.prepare('SELECT scraped_at, likes, comments FROM studio_snapshots WHERE video_id=? ORDER BY scraped_at').all(test.video_id) as any[])
      .map(s => ({ at: utcMs(s.scraped_at), likes: s.likes, comments: s.comments }));
    if (snaps.length < 2) continue;
    const snapAtOrBefore = (t: number) => {
      let best = null;
      for (const s of snaps) { if (s.at <= t) best = s; else break; }
      return best;
    };

    for (const slot of slots) {
      const a = snapAtOrBefore(slot.start);
      const b = snapAtOrBefore(slot.end);
      if (!a || !b || b.at <= a.at || slot.start - a.at > TOL || slot.end - b.at > TOL) { skipped++; continue; }
      const dLikes = Math.max(0, b.likes - a.likes);
      const dComments = Math.max(0, b.comments - a.comments);
      if (dLikes === 0 && dComments === 0) continue; // legitimately quiet hour, nothing to write
      db.prepare('UPDATE test_measurements SET likes=?, comments=? WHERE id=? AND COALESCE(likes,0)=0 AND COALESCE(comments,0)=0')
        .run(dLikes, dComments, slot.id);
      filled++;
    }
  }
  if (filled > 0) console.log(`[engagement-fill] filled likes/comments on ${filled} slot(s) from snapshots (${skipped} lacked coverage)`);
  return { filled, skipped };
}
