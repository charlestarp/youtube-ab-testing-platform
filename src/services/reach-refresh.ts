/**
 * THE single source of truth for variant CTR.
 *
 * Pulls the real Reach hourly CTR server-side (studio-fetch) and maps each hour to
 * whichever variant was live, producing an impression-weighted CTR per active variant.
 * Writes it to test_variants.ctr_override, which the frontend prefers over any computed
 * value. Refreshed hourly => live, not frozen. Nothing else writes active-variant CTR,
 * so noisy extension/realtime data can never clobber the displayed number.
 *
 * Soft-removed (active=0) variants keep their frozen final ctr_override untouched.
 */
import Database from 'better-sqlite3';
import path from 'path';
import { fetchReachHourly } from './studio-fetch.js';

export interface RefreshResult {
  testId: number;
  videoId: string;
  channelId: string;
  blendedCtr: number;
  perVariant: { label: string; variantId: number; ctr: number; impressions: number; hours: number }[];
}

export async function refreshTestCtr(testId: number, dbPath?: string): Promise<RefreshResult> {
  const db = new Database(dbPath || path.join(process.cwd(), 'data/testing.db'));
  try {
    const test = db.prepare('SELECT id, video_id, ctr_locked FROM tests WHERE id=?').get(testId) as any;
    if (!test?.video_id) throw new Error(`test ${testId} has no video_id`);
    if (test.ctr_locked) throw new Error(`test ${testId} is CTR-locked — refusing to overwrite frozen values (unlock first)`);

    const payload = await fetchReachHourly(test.video_id);

    const variants = db.prepare('SELECT id,label,active,active_since FROM test_variants WHERE test_id=?').all(testId) as any[];
    const activeById: Record<number, any> = {};
    for (const v of variants) activeById[v.id] = v;

    // Index the real per-hour Reach data by hour-start ms.
    const byHour = new Map<number, { imp: number; views: number; ctr: number; watchHrs: number; avgDur: number }>();
    for (let i = 0; i < payload.timestamps.length; i++) {
      byHour.set(new Date(payload.timestamps[i]).getTime(), {
        imp: payload.metrics.VIDEO_THUMBNAIL_IMPRESSIONS[i],
        views: payload.metrics.EXTERNAL_VIEWS[i],
        ctr: payload.metrics.VIDEO_THUMBNAIL_IMPRESSIONS_VTR[i],
        watchHrs: payload.metrics.EXTERNAL_WATCH_TIME_HOURS?.[i] || 0,
        avgDur: payload.metrics.AVERAGE_WATCH_TIME_SEC?.[i] || 0,
      });
    }

    // Each measurement row is one rotation slot (~1 hour). Write the REAL per-hour CTR
    // into the row so the per-hour breakdown shows distinct, true values. The page's
    // impression-weighted aggregate of these rows becomes the variant headline.
    // Only overwrite watch-time columns when the Engagement screen actually returned data,
    // otherwise a failed engagement fetch (all-zero) would clobber good extension values.
    const hasWatch = (payload.metrics.EXTERNAL_WATCH_TIME_HOURS || []).some(x => x > 0);

    const meas = db.prepare('SELECT id, variant_id, realtime_views_json FROM test_measurements WHERE test_id=?').all(testId) as any[];
    const writeRow = db.prepare('UPDATE test_measurements SET impressions=?, views=?, ctr=?, watch_time_hours=?, avg_view_duration=?, subs_gained=? WHERE id=?');
    const writeRowNoWatch = db.prepare('UPDATE test_measurements SET impressions=?, views=?, ctr=?, subs_gained=? WHERE id=?');
    // Per-hour net subscribers, mapped onto slots with the same midpoint rule as
    // Reach buckets. Primary: the payload's own SUBSCRIBERS_NET_CHANGE series
    // (internal Studio API, same call as impressions). Fallback: hourly_metrics
    // (extension-fed) when the Overview fetch failed.
    const payloadSubs = payload.metrics.SUBSCRIBERS_NET_CHANGE;
    const subsHours: { hourStart: number; subs: number }[] = payloadSubs
      ? payload.timestamps.map((t, i) => ({ hourStart: new Date(t).getTime(), subs: payloadSubs[i] || 0 }))
      : (db.prepare('SELECT hour_ts, subscribers_net FROM hourly_metrics WHERE video_id=? AND subscribers_net != 0').all(test.video_id) as any[])
          .map(r => ({ hourStart: new Date(r.hour_ts).getTime(), subs: r.subscribers_net }));
    const subsForWindow = (startMs: number, endMs: number): number => {
      let s = 0;
      for (const r of subsHours) {
        const mid = r.hourStart + 1_800_000;
        if (mid >= startMs && mid < endMs) s += r.subs;
      }
      return s;
    };
    const agg: Record<number, { clicks: number; imp: number; hours: number }> = {};

    // Bucket spans: recent videos give 1h buckets, older videos only DAILY (24h)
    // buckets — YouTube stops retaining hourly impressions after a video's early
    // life. The midpoint must therefore be start + span/2 (not a fixed +30min),
    // so a daily bucket lands in the daily rotation slot that covers most of it.
    const hourKeys = [...byHour.keys()].sort((a, b) => a - b);
    const spanOf = new Map<number, number>();
    for (let i = 0; i < hourKeys.length; i++) {
      const span = i + 1 < hourKeys.length ? hourKeys[i + 1] - hourKeys[i] : (i > 0 ? hourKeys[i] - hourKeys[i - 1] : 3_600_000);
      spanOf.set(hourKeys[i], span);
    }
    // The video's plausible impressions-per-hour, from settled buckets normalised
    // by their own spans (a daily bucket = value/24h). Used to reject buckets
    // whose value is impossible for their claimed span (boundary-bucket dumps).
    let mappingHourlyRef = 0;
    {
      let sum = 0, n = 0;
      for (let i = Math.max(1, hourKeys.length - 5); i < hourKeys.length - 1; i++) {
        const v = byHour.get(hourKeys[i])?.imp || 0;
        if (v <= 0) continue;
        const spanH = Math.max(1, (hourKeys[i] - hourKeys[i - 1]) / 3_600_000);
        sum += v / spanH; n++;
      }
      mappingHourlyRef = n ? sum / n : 0;
    }

    // CURRENT-BUCKET counters — used for the LIVE slot below. Live traffic only
    // ever lands in the LAST (current, partial) time bucket; changes to OLDER
    // buckets are YouTube's batch RESTATEMENTS of history. Deltas must therefore
    // be keyed to the current bucket only — differencing the lifetime total let a
    // restatement dump ~5,100 phantom impressions on one variant of test 190
    // (2026-07-08) while its sibling got the real ~80/hour trickle.
    const lastIdx = payload.timestamps.length - 1;
    const bucketKey = lastIdx >= 0 ? payload.timestamps[lastIdx] : '';
    const bImp = lastIdx >= 0 ? (payload.metrics.VIDEO_THUMBNAIL_IMPRESSIONS[lastIdx] || 0) : 0;
    const bViews = lastIdx >= 0 ? (payload.metrics.EXTERNAL_VIEWS[lastIdx] || 0) : 0;
    const bClicks = lastIdx >= 0 ? bImp * ((payload.metrics.VIDEO_THUMBNAIL_IMPRESSIONS_VTR[lastIdx] || 0) / 100) : 0;
    const bWatchHrs = lastIdx >= 0 ? (payload.metrics.EXTERNAL_WATCH_TIME_HOURS?.[lastIdx] || 0) : 0;
    // PURE-DAILY DETECTION: if even the freshest bucket spans > 2h, YouTube has
    // NO hourly resolution for this video (aged/low-traffic). Hourly sampling can
    // only ever produce a day-sized delta that gets quarantined, so skip the
    // live-delta write entirely and flag the test — honest "no hourly data" beats
    // generating garbage every cycle (test 190's video, ciH4dkjwjHE, 2026-07-09).
    const lastBucketSpanMin = lastIdx >= 1 ? (new Date(payload.timestamps[lastIdx]).getTime() - new Date(payload.timestamps[lastIdx - 1]).getTime()) / 60_000 : 1440;
    const pureDaily = lastBucketSpanMin > 120;
    // Public cumulative likes/comments (Data API videos.list, 1 unit on the
    // rotating READ keys) — delta-sampled into the live slot like the rest.
    let pubStats: { likes: number; comments: number } | null = null;
    try {
      // Internal Studio endpoint first (quota-free); public Data API as fallback.
      const { fetchVideoPublicStats } = await import('./studio-fetch.js');
      const s = await fetchVideoPublicStats(test.video_id);
      pubStats = { likes: s.likes, comments: s.comments };
    } catch (internalErr: any) {
      try {
        const { getVideoStats } = await import('./youtube-api.js');
        const s = await getVideoStats(test.video_id);
        pubStats = { likes: s.likes, comments: s.comments };
      } catch (e: any) {
        // Both sources down: likes/comments hold at their last value. Loud, not
        // silent — an entire test finishing with 0 likes (tests 194/195,
        // 2026-07-09) is how we learn this was failing all along.
        console.warn(`[reach-refresh] test ${testId}: likes/comments frozen this cycle (internal: ${internalErr?.message}; data api: ${e?.message})`);
      }
    }
    // Video length → avg % watched (= avg view duration / duration). Use the
    // app's shared connection: it has youtube.db ATTACHed as yt (this local
    // connection does not).
    let durationSec = 0;
    try {
      const { getDb } = await import('../db/client.js');
      durationSec = (getDb().prepare('SELECT duration_seconds FROM yt.videos WHERE video_id = ?').get(test.video_id) as any)?.duration_seconds || 0;
    } catch {}

    const tx = db.transaction(() => {
      for (const m of meas) {
        const v = activeById[m.variant_id];
        if (!v || !v.active) continue; // never touch frozen/removed variants
        let start = 0, end = 0;
        try { const j = JSON.parse(m.realtime_views_json || '{}'); if (j.activated_at && j.completed_at) { start = new Date(j.activated_at).getTime(); end = new Date(j.completed_at).getTime(); } } catch {}
        if (!start || !end) continue;
        // Attribute a Reach bucket to this slot when the bucket's MIDPOINT falls
        // in the slot window. The midpoint (not the bucket start) tolerates the
        // rotation activating a little past the top of the hour (e.g. 21:00:57).
        // A bucket must not be materially LARGER than the slot (a daily bucket
        // dumped into a 1-hour slot credits a whole day to one variant — the
        // test-191 bug); coarse buckets are handled by the live-delta slots and
        // the daily-exact rebalance below instead.
        const slotSpan = end - start;
        let imp = 0, views = 0, clicks = 0, watchHrs = 0;
        for (const [hourStart, h] of byHour) {
          const span = spanOf.get(hourStart) || 3_600_000;
          if (span > slotSpan * 1.5) continue;
          // PLAUSIBILITY: at the boundary between a video's daily head and hourly
          // tail, a DAY bucket inherits a 60-min "span" from gap-to-next and
          // sails through the span guard holding ~a day's data (dumped 3,671
          // imp into test 190's hour, 2026-07-08; real hour was +73). Skip any
          // bucket whose value is impossible for its claimed span.
          if (mappingHourlyRef > 0 && h.imp > mappingHourlyRef * (span / 3_600_000) * 6 + 100) {
            console.warn(`[reach-refresh] test ${testId}: skipping implausible bucket ${new Date(hourStart).toISOString().slice(5, 16)} (imp=${h.imp} for ${Math.round(span / 60000)}min span, ref ~${Math.round(mappingHourlyRef)}/h)`);
            continue;
          }
          const mid = hourStart + span / 2;
          if (mid >= start && mid < end && h.imp > 0) { imp += h.imp; views += h.views; clicks += h.imp * (h.ctr / 100); watchHrs += h.watchHrs; }
        }
        if (imp <= 0) continue; // outside the available Reach window — leave the row as-is
        const ctr = Math.round((clicks / imp) * 10000) / 100;
        const slotSubs = subsForWindow(start, end);
        if (hasWatch) {
          // Avg view duration for the slot = total watch seconds / total views (views-weighted).
          const avgDur = views > 0 ? Math.round((watchHrs * 3600 / views) * 100) / 100 : 0;
          writeRow.run(imp, views, ctr, Math.round(watchHrs * 1000) / 1000, avgDur, slotSubs, m.id);
        } else {
          writeRowNoWatch.run(imp, views, ctr, slotSubs, m.id);
        }
        if (!agg[m.variant_id]) agg[m.variant_id] = { clicks: 0, imp: 0, hours: 0 };
        agg[m.variant_id].clicks += clicks; agg[m.variant_id].imp += imp; agg[m.variant_id].hours++;
      }
      // ── LIVE slot ─────────────────────────────────────────────────────────
      // Real-time numbers for the variant that is live RIGHT NOW, so a fresh
      // test — and daily-speed tests on old videos — shows movement within one
      // refresh cycle instead of waiting for the first completed rotation.
      // Attribution is sound by construction: whatever YouTube's lifetime
      // cumulative counters gained since the previous refresh accrued while
      // THIS variant was live. All values are YouTube's own; nothing invented.
      // (Today's VTR can lag impressions by a few hours — the live CTR catches
      // up as YouTube settles it; the completed slot is later written exactly.)
      const activeV = variants.find(v => v.active && v.active_since);
      const liveRows = meas.filter(m => (m.realtime_views_json || '').includes('"live":true'));
      const nowIso = new Date().toISOString();
      // Coarse granularity = YouTube only has DAILY buckets for this (older)
      // video. Hourly slots then cannot be filled from buckets — the live-delta
      // accruals ARE the slot's real measured numbers, so on rotation they are
      // TRANSFERRED into the completed slot row instead of thrown away.
      const spans = [...spanOf.values()].sort((a, b) => a - b);
      const coarse = spans.length > 0 && spans[Math.floor(spans.length / 2)] > 2 * 3_600_000;
      for (const lr of liveRows) {
        let j: any = {}; try { j = JSON.parse(lr.realtime_views_json || '{}'); } catch {}
        const stale = !activeV || lr.variant_id !== activeV.id || j.activated_at !== activeV.active_since;
        if (!stale) continue;
        if (coarse && j.activated_at) {
          // Move the accrued real deltas into the completed slot for this window.
          // If the completed row isn't visible yet (rotation just happened), KEEP
          // the live row for the next cycle rather than losing the measurements.
          const done = meas.find(m => m.id !== lr.id && m.variant_id === lr.variant_id && (m.realtime_views_json || '').includes(`"activated_at":"${j.activated_at}"`) && !(m.realtime_views_json || '').includes('"live":true'));
          const lrRow: any = db.prepare('SELECT impressions, views, ctr, watch_time_hours, avg_view_duration, avg_view_pct, likes, comments FROM test_measurements WHERE id=?').get(lr.id);
          if (!done && lrRow && (lrRow.impressions || 0) > 0) continue; // wait for the completed slot to appear
          if (done && lrRow && (lrRow.impressions || 0) > 0) {
            db.prepare('UPDATE test_measurements SET impressions=?, views=?, ctr=?, watch_time_hours=?, avg_view_duration=?, avg_view_pct=?, likes=?, comments=? WHERE id=? AND impressions=0')
              .run(lrRow.impressions, lrRow.views, lrRow.ctr, lrRow.watch_time_hours || 0, lrRow.avg_view_duration || 0, lrRow.avg_view_pct || 0, lrRow.likes || 0, lrRow.comments || 0, done.id);
          }
        }
        db.prepare('DELETE FROM test_measurements WHERE id=?').run(lr.id); // superseded by the completed slot
      }
      // NOTE (2026-07-08): the old "daily-exact CTR rebalance" that redistributed
      // the day's clicks across slots WEIGHTED BY VIEWS was removed. It forced
      // every slot's CTR to be proportional to views-per-impression — erasing the
      // exact variant signal a test measures (it pinned test 188's three variants
      // to 1.76/1.76/1.75%). The live-delta slots below measure REAL clicks:
      // YouTube's cumulative clicks counter (Σ imp×VTR) ticks live even on old
      // videos (verified 2026-07-08: +1.1 clicks / +10 imp over 7 min, strictly
      // non-decreasing), so delta-sampled slot CTR is measured data, not a model.
      if (activeV && pureDaily) {
        // No hourly data exists for this video — do not fabricate slot deltas.
        // Flag the test once so the UI can tell the user plainly.
        db.prepare(`UPDATE tests SET hourly_available = 0 WHERE id = ? AND COALESCE(hourly_available,1) = 1`).run(testId);
        console.warn(`[reach-refresh] test ${testId} (${test.video_id}): video is PURE DAILY (last bucket ${Math.round(lastBucketSpanMin)}min) — hourly sampling not possible, skipping live-delta`);
      } else if (activeV) {
        const cur = liveRows.find(lr => {
          try { const j = JSON.parse(lr.realtime_views_json || '{}'); return lr.variant_id === activeV.id && j.activated_at === activeV.active_since; } catch { return false; }
        });
        // Bucket-keyed snapshot: deltas are computed ONLY within the same current
        // bucket (same bucketKey). On rollover (new bucket appears) the new
        // bucket's own value IS the delta (it started from 0). Changes to any
        // OLDER bucket are restatements of history and are never attributed.
        const cumNow: any = { key: bucketKey, imp: bImp, views: bViews, clicks: Math.round(bClicks * 100) / 100, watchHrs: Math.round(bWatchHrs * 1000) / 1000 };
        if (pubStats) { cumNow.likes = pubStats.likes; cumNow.comments = pubStats.comments; }
        if (!cur) {
          // Seed with the current bucket as it stands at activation; deltas accumulate from here.
          db.prepare(`INSERT INTO test_measurements (test_id, variant_id, measured_at, impressions, views, ctr, watch_time_hours, avg_view_duration, likes, comments, realtime_views_json) VALUES (?,?,?,0,0,0,0,0,0,0,?)`)
            .run(testId, activeV.id, nowIso, JSON.stringify({ type: 'rotation_slot', live: true, activated_at: activeV.active_since, cum: cumNow }));
        } else {
          let j: any = {}; try { j = JSON.parse(cur.realtime_views_json || '{}'); } catch {}
          const prev = j.cum || cumNow;
          // Legacy live rows (pre bucket-keying) have no key — treat as fresh seed
          // this cycle (accrue 0) rather than risk a lifetime-total delta.
          const sameBucket = prev.key === bucketKey;
          const legacy = prev.key == null;
          // ROLLOVER = attribute NOTHING, re-seed. A "new" bucket is NOT
          // guaranteed to start from zero: YouTube re-buckets partial days, and
          // the new key can carry HOURS of prior traffic (this dumped 4,589
          // impressions on test 190's first hour, 2026-07-08). Losing <=20 min of
          // real traffic once per rollover is the honest trade — never inflate.
          const dOf = (nowV: number, prevV: number) => (legacy || !sameBucket) ? 0 : Math.max(0, nowV - (prevV || 0));
          let dImp = dOf(bImp, prev.imp);
          let dViews = dOf(bViews, prev.views);
          let dClicks = dOf(bClicks, prev.clicks);
          let dWatch = (prev.watchHrs == null) ? 0 : dOf(bWatchHrs, prev.watchHrs);
          // RESTATEMENT GUARD: YouTube can backfill earlier hours INTO the current
          // bucket in one batch. That shows up as a delta far beyond the video's
          // plausible live rate — attribute NOTHING that cycle (re-seed baseline,
          // log it) rather than crediting phantom traffic to the live variant.
          // Plausible hourly rate = average of the SETTLED buckets' values divided
          // by THEIR OWN spans (a settled daily bucket = value/24h). Using the
          // last-gap as the span under-divided and inflated the ceiling to ~8000
          // right when the 4,589 dump needed catching (2026-07-08).
          let settledImpPerHour = 0, settledN = 0;
          for (let i = Math.max(1, lastIdx - 3); i < lastIdx; i++) {
            const v = payload.metrics.VIDEO_THUMBNAIL_IMPRESSIONS[i] || 0;
            if (v <= 0) continue;
            const spanH = Math.max(1, (new Date(payload.timestamps[i]).getTime() - new Date(payload.timestamps[i - 1]).getTime()) / 3_600_000);
            settledImpPerHour += v / spanH; settledN++;
          }
          const hourlyRef = settledN ? settledImpPerHour / settledN : 0;
          const prevAtMs = j.cum_at ? new Date(j.cum_at).getTime() : Date.now() - 20 * 60_000;
          const elapsedH = Math.max(0.05, (Date.now() - prevAtMs) / 3_600_000);
          const maxPlausible = hourlyRef > 0 ? hourlyRef * elapsedH * 6 + 50 : 300 * elapsedH + 50;
          if (dImp > maxPlausible) {
            console.warn(`[reach-refresh] test ${testId}: skipping restatement spike (dImp=${dImp} > plausible ${Math.round(maxPlausible)} for ${elapsedH.toFixed(2)}h)`);
            dImp = 0; dViews = 0; dClicks = 0; dWatch = 0;
          }
          j.cum_at = nowIso;
          const dLikes = (prev.likes == null || !pubStats) ? 0 : Math.max(0, pubStats.likes - prev.likes);
          const dComments = (prev.comments == null || !pubStats) ? 0 : Math.max(0, pubStats.comments - prev.comments);
          const row: any = db.prepare('SELECT impressions, views, ctr, watch_time_hours, likes, comments FROM test_measurements WHERE id=?').get(cur.id);
          const nImp = (row?.impressions || 0) + dImp;
          const nViews = (row?.views || 0) + dViews;
          const nClicks = (row?.impressions || 0) * ((row?.ctr || 0) / 100) + dClicks;
          const nCtr = nImp > 0 ? Math.round((nClicks / nImp) * 10000) / 100 : 0;
          const nWatch = Math.round(((row?.watch_time_hours || 0) + dWatch) * 1000) / 1000;
          const nAvgDur = nViews > 0 ? Math.round((nWatch * 3600 / nViews) * 100) / 100 : 0; // sec/view
          // Avg % watched = avg view duration over the video's length.
          const nAvgPct = durationSec > 0 && nAvgDur > 0 ? Math.min(100, Math.round((nAvgDur / durationSec) * 10000) / 100) : 0;
          if (!pubStats) { delete cumNow.likes; delete cumNow.comments; if (prev.likes != null) { cumNow.likes = prev.likes; cumNow.comments = prev.comments; } }
          j.cum = cumNow;
          // Subs for the live slot: absolute sum over the slot's window from our
          // hourly_metrics (idempotent, no delta state needed).
          const liveSubs = subsForWindow(new Date(activeV.active_since!).getTime(), Date.now());
          db.prepare('UPDATE test_measurements SET impressions=?, views=?, ctr=?, watch_time_hours=?, avg_view_duration=?, avg_view_pct=?, likes=?, comments=?, subs_gained=?, measured_at=?, realtime_views_json=? WHERE id=?')
            .run(nImp, nViews, nCtr, nWatch, nAvgDur, nAvgPct, (row?.likes || 0) + dLikes, (row?.comments || 0) + dComments, liveSubs, nowIso, JSON.stringify(j), cur.id);
        }
      }

      // Clear the override on active variants so the headline = impression-weighted
      // aggregate of the real per-hour rows (single source, no flat number).
      const clearOverride = db.prepare('UPDATE test_variants SET ctr_override=NULL WHERE id=? AND active=1');
      for (const v of variants) if (v.active) clearOverride.run(v.id);
    });
    tx();

    const perVariant: RefreshResult['perVariant'] = [];
    for (const v of variants) {
      if (!v.active) continue;
      const a = agg[v.id];
      if (!a || a.imp <= 0) continue;
      perVariant.push({ label: v.label, variantId: v.id, ctr: Math.round((a.clicks / a.imp) * 10000) / 100, impressions: Math.round(a.imp), hours: a.hours });
    }

    perVariant.sort((x, y) => x.label.localeCompare(y.label));

    // ── SELF-RECONCILIATION ─────────────────────────────────────────────────
    // Our sampled slot totals must add up to YouTube's OWN current-bucket total
    // for the same window. If they drift beyond tolerance, say so loudly — the
    // system audits its accuracy against YouTube every cycle instead of being
    // trusted on faith. (Slots may cover less of the bucket than its full span —
    // e.g. the test started mid-bucket — so sampled ≤ bucket is fine; sampled
    // EXCEEDING the bucket by >15% means we're inflating and must be flagged.)
    try {
      const bucketStartMs = bucketKey ? new Date(bucketKey).getTime() : 0;
      if (bucketStartMs > 0) {
        const sampled = (db.prepare(`
          SELECT SUM(impressions) imp FROM test_measurements
          WHERE test_id = ? AND realtime_views_json LIKE '%"type":"rotation_slot"%'
            AND json_extract(realtime_views_json,'$.activated_at') >= ?
        `).get(testId, new Date(bucketStartMs).toISOString()) as any)?.imp || 0;
        if (bImp > 100 && sampled > bImp * 1.15) {
          console.error(`[reach-refresh] RECONCILIATION FAIL test ${testId}: sampled ${sampled} imp since bucket start vs YouTube's own bucket ${bImp} — sampling is INFLATING, investigate immediately`);
        }
      }
      // SLOT QUARANTINE: violations ACT, they don't just log (a 28,805-imp slot
      // displayed to Charles despite the alarms, 2026-07-09). Any completed slot
      // whose impressions are impossible for a ~1h window — beyond 8x the video's
      // plausible hourly rate — is marked suspect:true, which the UI and every
      // aggregate ALREADY exclude. Garbage can alarm AND disappear.
      if (mappingHourlyRef > 0) {
        const cap = Math.round(mappingHourlyRef * 8 + 150);
        const bad = db.prepare(`
          SELECT id, impressions FROM test_measurements
          WHERE test_id = ? AND realtime_views_json LIKE '%"type":"rotation_slot"%'
            AND realtime_views_json NOT LIKE '%"live":true%'
            AND realtime_views_json NOT LIKE '%"suspect":true%'
            AND impressions > ?
        `).all(testId, cap) as any[];
        for (const b of bad) {
          db.prepare(`UPDATE test_measurements SET realtime_views_json = json_set(COALESCE(realtime_views_json,'{}'), '$.suspect', json('true'), '$.suspect_reason', 'impossible for slot window (cap ' || ? || '/h)') WHERE id = ?`).run(cap, b.id);
          console.error(`[reach-refresh] QUARANTINED slot ${b.id} on test ${testId}: ${b.impressions} imp > plausible ${cap} — hidden from UI and aggregates`);
        }
      }
      // Adjacent-hour coherence alarm (kept as a secondary signal).
      const doneSlots = (db.prepare(`
        SELECT impressions FROM test_measurements
        WHERE test_id = ? AND realtime_views_json LIKE '%"type":"rotation_slot"%'
          AND realtime_views_json NOT LIKE '%"live":true%'
          AND realtime_views_json NOT LIKE '%"suspect":true%' AND impressions > 0
        ORDER BY measured_at DESC LIMIT 6
      `).all(testId) as any[]).map(r => r.impressions);
      for (let i = 1; i < doneSlots.length; i++) {
        const hi = Math.max(doneSlots[i - 1], doneSlots[i]), lo = Math.min(doneSlots[i - 1], doneSlots[i]);
        if (lo >= 10 && hi / lo > 8) {
          console.error(`[reach-refresh] COHERENCE FAIL test ${testId}: adjacent completed slots ${hi} vs ${lo} imp (>${Math.round(hi / lo)}x) — attribution broken, do not trust this test`);
          break;
        }
      }
    } catch { /* reconciliation must never break the refresh */ }

    return { testId, videoId: test.video_id, channelId: payload.channel_id, blendedCtr: payload.total_ctr, perVariant };
  } finally {
    db.close();
  }
}

/** Refresh every running test that has a video. Safe to call hourly. */
export async function refreshAllRunningTests(dbPath?: string): Promise<RefreshResult[]> {
  const db = new Database(dbPath || path.join(process.cwd(), 'data/testing.db'), { readonly: true });
  // Running tests, plus recently-completed ones whose recent hours YouTube is still
  // settling (matches the hourly-data ingestion window) so their CTR stays current.
  const ids = (db.prepare(`
    SELECT id FROM tests
    WHERE video_id IS NOT NULL
      AND ctr_locked = 0
      AND replace(replace(COALESCE(started_at, created_at),'T',' '),'.000Z','') <= datetime('now')
      AND (status='running' OR (status='completed' AND completed_at > datetime('now','-48 hours')))
  `).all() as any[]).map(r => r.id);
  db.close();
  const out: RefreshResult[] = [];
  for (const id of ids) {
    try { out.push(await refreshTestCtr(id, dbPath)); }
    catch (e: any) { console.error(`[reach-refresh] test ${id} failed: ${e.message}`); }
  }
  return out;
}
