/**
 * Retroactive engagement backfill for tests that already ran.
 *
 * Subs: the internal Studio Overview series (SUBSCRIBERS_NET_CHANGE) covers the
 * video's whole life, so past slots get real per-hour subs mapped by the same
 * midpoint rule reach-refresh uses live. Falls back to hourly_metrics.
 *
 * Likes/comments: YouTube keeps no history series, but our studio_snapshots
 * table sampled cumulative likes/comments every ~5 min while tests ran, so a
 * slot's delta = snapshot at slot end minus snapshot at slot start. Slots whose
 * nearest snapshots are more than 45 min outside the boundary are skipped
 * (honest gap beats invented numbers). Existing nonzero values are never
 * overwritten.
 *
 * Usage: npx tsx src/scripts/backfill-engagement.ts [--days 30] [--apply]
 * Default is a DRY RUN; pass --apply to write.
 */

import { getDb } from '../db/client.js';

const days = parseInt((process.argv.find(a => a.startsWith('--days')) || '').split('=')[1] || process.argv[process.argv.indexOf('--days') + 1] || '30') || 30;
const apply = process.argv.includes('--apply');

const utcMs = (s: string) => new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z').getTime();

async function main() {
  const db = getDb();
  const tests = db.prepare(`
    SELECT id, video_id, video_title, ctr_locked FROM tests
    WHERE status = 'completed' AND video_id IS NOT NULL
      AND completed_at > datetime('now', ?)
    ORDER BY id
  `).all(`-${days} days`) as any[];

  let wroteSubs = 0, wroteLikes = 0, skippedLocked = 0, skippedSlots = 0;

  for (const test of tests) {
    if (test.ctr_locked) { skippedLocked++; continue; }

    // Slots with a real window, on active (non-frozen) variants only.
    const slots = (db.prepare(`
      SELECT m.id, m.subs_gained, m.likes, m.comments, m.realtime_views_json
      FROM test_measurements m JOIN test_variants v ON v.id = m.variant_id
      WHERE m.test_id = ? AND v.active = 1
        AND (m.realtime_views_json LIKE '%"type":"rotation_slot"%' OR m.realtime_views_json LIKE '%"type":"reconstructed_vtr"%')
    `).all(test.id) as any[]).map(m => {
      try {
        const j = JSON.parse(m.realtime_views_json || '{}');
        if (!j.activated_at || !j.completed_at) return null;
        return { ...m, start: utcMs(j.activated_at), end: utcMs(j.completed_at) };
      } catch { return null; }
    }).filter(Boolean) as any[];
    if (slots.length === 0) continue;

    // Subs series: internal API first, hourly_metrics fallback. Each entry
    // carries its span so daily buckets can be excluded from hourly slots
    // (a day bucket midpoint-mapped into one slot would dump a day of subs).
    let subsHours: { hourStart: number; span: number; subs: number }[] = [];
    try {
      const { fetchReachHourly } = await import('../services/studio-fetch.js');
      const payload = await fetchReachHourly(test.video_id);
      const series = payload.metrics.SUBSCRIBERS_NET_CHANGE;
      if (series) {
        const ts = payload.timestamps.map(t => new Date(t).getTime());
        subsHours = ts.map((hourStart, i) => ({
          hourStart,
          span: i + 1 < ts.length ? ts[i + 1] - ts[i] : 3_600_000,
          subs: series[i] || 0,
        }));
      }
    } catch (e: any) {
      console.warn(`[backfill] test ${test.id}: internal subs series unavailable (${e.message.slice(0, 60)}), using hourly_metrics`);
    }
    if (subsHours.length === 0) {
      subsHours = (db.prepare('SELECT hour_ts, subscribers_net FROM hourly_metrics WHERE video_id=? AND subscribers_net != 0').all(test.video_id) as any[])
        .map(r => ({ hourStart: utcMs(r.hour_ts), span: 3_600_000, subs: r.subscribers_net }));
    }

    // Cumulative likes/comments snapshots, sorted, for boundary lookups.
    const snaps = (db.prepare('SELECT scraped_at, likes, comments FROM studio_snapshots WHERE video_id=? ORDER BY scraped_at').all(test.video_id) as any[])
      .map(s => ({ at: utcMs(s.scraped_at), likes: s.likes, comments: s.comments }));
    const snapAtOrBefore = (t: number) => {
      let best = null;
      for (const s of snaps) { if (s.at <= t) best = s; else break; }
      return best;
    };

    for (const slot of slots) {
      const slotSpan = slot.end - slot.start;

      // Subs: midpoint mapping, skipping buckets materially larger than the slot.
      let subs = 0, sawBucket = false;
      for (const h of subsHours) {
        if (h.span > slotSpan * 1.5) continue;
        const mid = h.hourStart + h.span / 2;
        if (mid >= slot.start && mid < slot.end) { subs += h.subs; sawBucket = true; }
      }
      if (sawBucket && slot.subs_gained === 0 && subs !== 0) {
        if (apply) db.prepare('UPDATE test_measurements SET subs_gained=? WHERE id=?').run(subs, slot.id);
        wroteSubs++;
      }

      // Likes/comments: snapshot delta across the slot window.
      if ((slot.likes || 0) === 0 && (slot.comments || 0) === 0 && snaps.length > 1) {
        const a = snapAtOrBefore(slot.start);
        const b = snapAtOrBefore(slot.end);
        const TOL = 45 * 60_000;
        if (a && b && b.at > a.at && slot.start - a.at <= TOL && slot.end - b.at <= TOL) {
          const dLikes = Math.max(0, b.likes - a.likes);
          const dComments = Math.max(0, b.comments - a.comments);
          if (dLikes > 0 || dComments > 0) {
            if (apply) db.prepare('UPDATE test_measurements SET likes=?, comments=? WHERE id=?').run(dLikes, dComments, slot.id);
            wroteLikes++;
          }
        } else {
          skippedSlots++;
        }
      }
    }
    console.log(`[backfill] test ${test.id} "${(test.video_title || test.video_id).slice(0, 40)}": ${slots.length} slots processed`);
  }

  console.log(`\n${apply ? 'APPLIED' : 'DRY RUN (pass --apply to write)'}: subs on ${wroteSubs} slots, likes/comments on ${wroteLikes} slots; ${skippedSlots} slots lacked snapshot coverage, ${skippedLocked} CTR-locked tests untouched.`);
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
