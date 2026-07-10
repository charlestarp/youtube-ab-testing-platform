/**
 * Test runner — manages A/B test lifecycle.
 *
 * Every cycle (runs every 30 min, or hourly aligned):
 * 1. Check if any test's start time has arrived — activate first variant
 * 2. Check if active variant's rotation period has elapsed — swap to next
 * 3. Collect measurements via Studio scraper for each active test
 * 4. Check if test is complete — evaluate results
 */

import { getDb } from '../db/client.js';
import { uploadThumbnail, updateVideoTitle, getVideoStats } from './youtube-api.js';

import type { Test, TestVariant } from '../types/index.js';

// Queue for thumbnail uploads — prevents concurrent Chrome sessions
let _uploadQueue = Promise.resolve();

// Concurrency guard — prevents duplicate rotations from overlapping invocations
let _cycleRunning = false;

export async function runTestCycle(): Promise<void> {
  if (_cycleRunning) {
    console.log('[test-runner] Cycle already running, skipping');
    return;
  }
  _cycleRunning = true;
  try {
    await _runTestCycleInner();
  } finally {
    _cycleRunning = false;
  }
}

async function _runTestCycleInner(): Promise<void> {
  console.log('[test-runner] runTestCycle called');
  const db = getDb();

  // Re-push any winners that failed to go live at completion (e.g. YouTube API quota exhausted).
  // Runs every cycle regardless of running tests, so the winner always lands once quota frees up.
  try { await retryPendingWinners(db); } catch (e: any) { console.error('[test-runner] retryPendingWinners:', e?.message); }

  console.log('[test-runner] Starting cycle');

  const runningTests = db.prepare("SELECT * FROM tests WHERE status = 'running'").all() as Test[];

  if (runningTests.length === 0) return;
  console.log(`[test-runner] Processing ${runningTests.length} running test(s)`);

  for (const test of runningTests) {
    try {
      await processTest(test);
    } catch (err: any) {
      console.error(`[test-runner] Error processing test ${test.id}: ${err.message}`);
      db.prepare('UPDATE tests SET error_msg = ? WHERE id = ?').run(err.message, test.id);
    }
  }

  // Studio scraping disabled — Chrome extension handles all data collection
}

async function processTest(test: Test): Promise<void> {
  const db = getDb();
  const variants = db.prepare('SELECT * FROM test_variants WHERE test_id = ? AND active = 1 ORDER BY label').all(test.id) as TestVariant[];
  if (variants.length < 2) return;

  const now = new Date();
  const startTime = test.started_at ? new Date(test.started_at) : null;

  // Check if test hasn't started yet (waiting for start time)
  if (startTime && now < startTime) {
    console.log(`[test-runner] Test ${test.id}: waiting until ${startTime.toISOString()}`);
    return;
  }

  // Find the currently active variant
  let activeVariant = variants.find(v => v.active_since != null);

  if (!activeVariant) {
    // No variant marked active — check if we have measurement history
    // (this handles the case where the API restarted mid-rotation)
    const lastMeasurement = db.prepare(
      `SELECT variant_id FROM test_measurements WHERE test_id = ?
       AND (realtime_views_json IS NULL OR realtime_views_json NOT LIKE '%"type":"activation_baseline"%')
       ORDER BY measured_at DESC LIMIT 1`
    ).get(test.id) as any;

    if (!lastMeasurement) {
      // Truly first activation
      console.log(`[test-runner] Test ${test.id}: activating first variant ${variants[0].label}`);
      await activateVariant(test, variants[0]);
      return;
    }

    // We have history but no active variant — pick the variant with fewest rotations.
    // Must use same counting logic as normal rotation (all rotation_slot rows, not just impressions > 0)
    // so a variant that ran but got 0 data doesn't get scheduled twice.
    const timesEach = (test as any).duration_hours_per_variant || 4;
    const variantHours = db.prepare(`
      SELECT variant_id, COUNT(*) as hours
      FROM test_measurements WHERE test_id = ?
      AND (realtime_views_json IS NULL OR realtime_views_json NOT LIKE '%"type":"activation_baseline"%')
      GROUP BY variant_id
    `).all(test.id) as any[];

    const hoursMap: Record<number, number> = {};
    for (const v of variants) hoursMap[v.id] = 0;
    for (const vh of variantHours) hoursMap[vh.variant_id] = vh.hours;

    // Check if all variants already completed — if so, evaluate instead of reactivating
    const allCompleted = variants.every(v => hoursMap[v.id] >= timesEach);
    if (allCompleted) {
      console.log(`[test-runner] Test ${test.id}: all variants done during recovery, evaluating`);
      await evaluateTest(test, variants);
      return;
    }

    // Find variant with fewest hours that still needs more
    const lastVariantId = lastMeasurement.variant_id;
    const lastIdx = variants.findIndex(v => v.id === lastVariantId);
    let nextVariant = variants[0];
    const minHours = Math.min(...variants.map(v => hoursMap[v.id]));
    for (let i = 1; i <= variants.length; i++) {
      const candidate = variants[(lastIdx + i) % variants.length];
      if (hoursMap[candidate.id] === minHours && hoursMap[candidate.id] < timesEach) {
        nextVariant = candidate;
        break;
      }
    }

    const hoursStr = variants.map(v => `${v.label}:${hoursMap[v.id]}/${timesEach}`).join(' ');
    console.log(`[test-runner] Test ${test.id}: recovering, activating ${nextVariant.label} [${hoursStr}]`);
    await activateVariant(test, nextVariant);
    return;
  }

  // Rotation logic:
  //   Hourly: each thumbnail shows for 1 hour, cycle through all, repeat N times
  //   Daily: each thumbnail shows for 1 day
  const testSpeed = (test as any).test_speed || 'daily';
  const rotationMs = testSpeed === 'hourly' ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  const activeSince = new Date(activeVariant.active_since!);
  const msActive = now.getTime() - activeSince.getTime();

  // 5-minute tolerance: activation happens at :01:xx, runner fires at :00:xx next hour.
  // Without tolerance, msActive is ~58-59 min (< 60 min) so rotation gets skipped an entire hour.
  const tolerance = testSpeed === 'hourly' ? 5 * 60 * 1000 : 30 * 60 * 1000;
  if (msActive >= rotationMs - tolerance) {
    // Hour is up — rotate to next variant
    // Data collection is SEPARATE (handled by Chrome extension when user visits Studio)

    // Deactivate current
    db.prepare('UPDATE test_variants SET active_since = NULL WHERE id = ?').run(activeVariant.id);

    const timesEach = (test as any).duration_hours_per_variant || 4;

    // Count how many times each variant has been activated (rotation count, not data count)
    // This ensures rotation completes regardless of whether data was collected
    const variantRotations = db.prepare(`
      SELECT variant_id, COUNT(*) as rotations
      FROM test_measurements
      WHERE test_id = ?
      AND (realtime_views_json IS NULL OR realtime_views_json NOT LIKE '%"type":"activation_baseline"%')
      GROUP BY variant_id
    `).all(test.id) as any[];

    const hoursMap: Record<number, number> = {};
    for (const v of variants) hoursMap[v.id] = 0;
    for (const vh of variantRotations) hoursMap[vh.variant_id] = vh.rotations;

    // Current variant just finished a rotation — increment
    hoursMap[activeVariant.id] = (hoursMap[activeVariant.id] || 0) + 1;

    // Get current snapshot and compute delta from when this variant was activated
    const endSnapshot = await getSnapshot(test.video_id);

    // Find the baseline snapshot (recorded when this variant was activated)
    const baselineRow = db.prepare(`
      SELECT realtime_views_json FROM test_measurements
      WHERE test_id = ? AND variant_id = ? AND realtime_views_json LIKE '%"type":"rotation_slot"%'
      ORDER BY measured_at DESC LIMIT 1
    `).get(test.id, activeVariant.id) as any;

    // Also check for a baseline stored when activating this variant
    const activationBaseline = db.prepare(`
      SELECT realtime_views_json FROM test_measurements
      WHERE test_id = ? AND variant_id = ? AND realtime_views_json LIKE '%"type":"activation_baseline"%'
      ORDER BY measured_at DESC LIMIT 1
    `).get(test.id, activeVariant.id) as any;

    let baseline = activationBaseline ? JSON.parse(activationBaseline.realtime_views_json) : null;

    let deltaViews = 0, deltaImpressions = 0;
    let deltaWatchTime = 0, deltaAvgDuration = 0, deltaLikes = 0, deltaComments = 0, deltaSubs = 0;
    // Set when we detect the delta is not a valid per-slot measurement and cannot
    // reconstruct a real one — the row is written with 0 metrics + a suspect flag
    // so it can never pollute a SUM or CTR aggregate.
    let forcedSuspect = false;

    if (baseline && endSnapshot.impressions > 0) {
      deltaImpressions = Math.max(0, endSnapshot.impressions - (baseline.impressions || 0));
      deltaViews = Math.max(0, endSnapshot.views - (baseline.views || 0));
      deltaWatchTime = Math.max(0, endSnapshot.watchTimeHours - (baseline.watchTimeHours || 0));
      deltaLikes = Math.max(0, endSnapshot.likes - (baseline.likes || 0));
      deltaComments = Math.max(0, endSnapshot.comments - (baseline.comments || 0));
      deltaSubs = endSnapshot.subsGained - (baseline.subsGained || 0);
      deltaAvgDuration = endSnapshot.avgViewDuration;

      // Duration-aware validity: the delta is only a real per-slot measurement if the
      // baseline snapshot was taken near this slot's activation and the end snapshot near
      // its completion. If the baseline snapshot predates the slot by much more than the
      // slot's own wall-clock duration (a stale-baseline / Studio-data-gap leak), the delta
      // actually spans many hours of cumulative growth — impossible for one slot. Baselines
      // written before this fix have no snapshot_at; those fall back to the magnitude check.
      const slotSpanH = activeVariant.active_since
        ? Math.max(0, (Date.now() - new Date(activeVariant.active_since).getTime()) / 3600000)
        : 1;
      const baseSnapMs = baseline.snapshot_at ? new Date(baseline.snapshot_at).getTime() : null;
      const endSnapMs = endSnapshot.scrapedAt ? new Date(endSnapshot.scrapedAt).getTime() : null;
      const measuredSpanH = (baseSnapMs && endSnapMs) ? (endSnapMs - baseSnapMs) / 3600000 : null;
      // Allow the measured window to exceed the slot by up to one extra slot-length (covers
      // normal scrape jitter); beyond that the baseline is stale and the delta is invalid.
      const staleBaseline = measuredSpanH != null && measuredSpanH > slotSpanH + Math.max(1, slotSpanH);

      // Magnitude backstop for baselines lacking snapshot_at: reject if the delta dwarfs
      // other completed slots in this test (a lifetime-total baseline leak).
      const avgSlotImp = db.prepare(`
        SELECT AVG(impressions) as avg_imp FROM test_measurements
        WHERE test_id = ? AND impressions > 0 AND impressions < 100000
        AND json_extract(realtime_views_json, '$.type') = 'rotation_slot'
      `).get(test.id) as any;
      const threshold = avgSlotImp?.avg_imp ? Math.max(avgSlotImp.avg_imp * 5, 50000) : 200000;
      if (staleBaseline || deltaImpressions > threshold) {
        console.log(`[test-runner] Rejecting measurement for ${activeVariant.label} — ${staleBaseline ? `stale baseline (delta spans ~${measuredSpanH!.toFixed(1)}h vs ~${slotSpanH.toFixed(1)}h slot)` : `${deltaImpressions} imp too high (avg slot: ${Math.round(avgSlotImp?.avg_imp || 0)}, threshold: ${Math.round(threshold)})`}. Reconstructing from studio snapshots...`);
        // Try to reconstruct the real per-slot delta from studio snapshots that actually
        // fall inside [active_since, now]. datetime() normalises the timestamp format —
        // studio_snapshots.scraped_at is 'YYYY-MM-DD HH:MM:SS' (UTC) while active_since is
        // ISO '…T…Z'; a raw string compare mis-sorts (space < 'T') and breaks the >= bound.
        if (activeVariant.active_since) {
          const startSnap = db.prepare(`
            SELECT impressions, views, ctr, likes, comments, watch_time_hours FROM studio_snapshots
            WHERE video_id = ? AND impressions > 0 AND datetime(scraped_at) >= datetime(?)
            ORDER BY scraped_at ASC LIMIT 1
          `).get(test.video_id, activeVariant.active_since) as any;
          const endSnap = db.prepare(`
            SELECT impressions, views, ctr, likes, comments, watch_time_hours FROM studio_snapshots
            WHERE video_id = ? AND impressions > 0 AND datetime(scraped_at) <= datetime(?)
            ORDER BY scraped_at DESC LIMIT 1
          `).get(test.video_id, new Date().toISOString()) as any;
          if (startSnap && endSnap && endSnap.impressions > startSnap.impressions) {
            deltaImpressions = endSnap.impressions - startSnap.impressions;
            deltaViews = Math.max(0, endSnap.views - startSnap.views);
            deltaLikes = Math.max(0, endSnap.likes - startSnap.likes);
            deltaComments = Math.max(0, endSnap.comments - startSnap.comments);
            deltaWatchTime = Math.max(0, endSnap.watch_time_hours - startSnap.watch_time_hours);
            console.log(`[test-runner] ${activeVariant.label}: reconstructed from snapshots: +${deltaViews} views, +${deltaImpressions} imp`);
          } else {
            deltaImpressions = 0; deltaViews = 0;
            deltaWatchTime = 0; deltaLikes = 0; deltaComments = 0; deltaSubs = 0;
            forcedSuspect = true;
          }
        } else {
          deltaImpressions = 0; deltaViews = 0;
          deltaWatchTime = 0; deltaLikes = 0; deltaComments = 0; deltaSubs = 0;
          forcedSuspect = true;
        }
      }

      console.log(`[test-runner] ${activeVariant.label}: +${deltaViews} views, +${deltaImpressions} imp`);
    } else {
      console.log(`[test-runner] ${activeVariant.label}: no activation_baseline found`);
      // No baseline means activateVariant could not get a studio snapshot.
      // Try to reconstruct this slot's data from studio_snapshots table.
      if (activeVariant.active_since) {
        const startSnap = db.prepare(`
          SELECT impressions, views, ctr, likes, comments, watch_time_hours, avg_view_duration_sec, avg_view_pct
          FROM studio_snapshots WHERE video_id = ? AND scraped_at >= ? ORDER BY scraped_at ASC LIMIT 1
        `).get(test.video_id, activeVariant.active_since) as any;
        const endSnap = db.prepare(`
          SELECT impressions, views, ctr, likes, comments, watch_time_hours, avg_view_duration_sec, avg_view_pct
          FROM studio_snapshots WHERE video_id = ? AND scraped_at <= ? ORDER BY scraped_at DESC LIMIT 1
        `).get(test.video_id, new Date().toISOString()) as any;

        if (startSnap && endSnap && endSnap.impressions > startSnap.impressions) {
          deltaImpressions = endSnap.impressions - startSnap.impressions;
          deltaViews = Math.max(0, endSnap.views - startSnap.views);
          deltaLikes = Math.max(0, endSnap.likes - startSnap.likes);
          deltaComments = Math.max(0, endSnap.comments - startSnap.comments);
          deltaWatchTime = Math.max(0, endSnap.watch_time_hours - startSnap.watch_time_hours);
          deltaAvgDuration = endSnap.avg_view_duration_sec || 0;
          console.log(`[test-runner] ${activeVariant.label}: reconstructed from studio snapshots: +${deltaViews} views, +${deltaImpressions} imp`);
        } else {
          console.log(`[test-runner] ${activeVariant.label}: no studio snapshots for reconstruction, recording empty slot (hourly backfill will fill it)`);
        }
      }
      // Record the end snapshot as a baseline for the NEXT activation of this variant,
      // but do NOT skip the rotation_slot write below — let it record with whatever data we have (possibly 0s).
      // The hourly-data backfill will fill in real data later.
      if (endSnapshot.impressions > 0) {
        db.prepare(`
          DELETE FROM test_measurements WHERE test_id = ? AND variant_id = ?
          AND realtime_views_json LIKE '%"type":"activation_baseline"%'
        `).run(test.id, activeVariant.id);
        db.prepare(`
          INSERT INTO test_measurements (test_id, variant_id, impressions, views, ctr,
            watch_time_hours, avg_view_duration, avg_view_pct, likes, comments, subs_gained,
            realtime_views_json)
          VALUES (?, ?, 0, 0, 0, 0, 0, 0, 0, 0, 0, ?)
        `).run(test.id, activeVariant.id, JSON.stringify({
          type: 'activation_baseline',
          impressions: endSnapshot.impressions,
          views: endSnapshot.views,
          ctr: endSnapshot.ctr,
          likes: endSnapshot.likes,
          comments: endSnapshot.comments,
          watchTimeHours: endSnapshot.watchTimeHours,
          subsGained: endSnapshot.subsGained,
          snapshot_at: endSnapshot.scrapedAt,
          recorded_at: new Date().toISOString(),
        }));
      }
    }

    // If normal delta was 0 but studio snapshots exist for this window, reconstruct from them
    if (deltaImpressions === 0 && activeVariant.active_since) {
      const startSnap = db.prepare(`
        SELECT impressions, views, ctr, likes, comments, watch_time_hours, avg_view_duration_sec, avg_view_pct
        FROM studio_snapshots WHERE video_id = ? AND scraped_at >= ? ORDER BY scraped_at ASC LIMIT 1
      `).get(test.video_id, activeVariant.active_since) as any;
      const endSnap = db.prepare(`
        SELECT impressions, views, ctr, likes, comments, watch_time_hours, avg_view_duration_sec, avg_view_pct
        FROM studio_snapshots WHERE video_id = ? AND scraped_at <= ? ORDER BY scraped_at DESC LIMIT 1
      `).get(test.video_id, new Date().toISOString()) as any;

      if (startSnap && endSnap && endSnap.impressions > startSnap.impressions) {
        deltaImpressions = endSnap.impressions - startSnap.impressions;
        deltaViews = Math.max(0, endSnap.views - startSnap.views);
        deltaLikes = Math.max(0, endSnap.likes - startSnap.likes);
        deltaComments = Math.max(0, endSnap.comments - startSnap.comments);
        deltaWatchTime = Math.max(0, endSnap.watch_time_hours - startSnap.watch_time_hours);
        deltaAvgDuration = endSnap.avg_view_duration_sec || 0;
        console.log(`[test-runner] ${activeVariant.label}: reconstructed from studio snapshots: +${deltaViews} views, +${deltaImpressions} imp`);
      }
    }

    // CTR: use views/impressions as initial value.
    // The hourly-data backfill will overwrite this with real YouTube CTR
    // from get_screen reach data when it arrives (within minutes).
    const deltaCtr = deltaImpressions > 0 && deltaViews > 0
      ? Math.round((deltaViews / deltaImpressions) * 10000) / 100 : 0;
    // AVD = watch time / views
    if (deltaAvgDuration === 0 && deltaWatchTime > 0 && deltaViews > 0) {
      deltaAvgDuration = deltaWatchTime * 3600 / deltaViews;
    }

    // Atomic: delete activation baseline + insert rotation_slot measurement
    const completedAt = new Date().toISOString();
    // Sanity: a slot delta with impossible CTR (>25%) means a bad baseline (e.g.
    // the delta captured a cumulative lifetime figure). Flag it so it is excluded
    // from analysis and surfaced by the data-integrity audit. This is what
    // produced the old 22% CTR results.
    const impliedCtr = deltaImpressions > 0 ? deltaViews / deltaImpressions : 0;
    // Duration-aware rate backstop: derive the slot's wall-clock span and reject a delta
    // whose implied hourly rate is impossible even for this channel's biggest videos.
    // Caps are set ~2x above the observed legit ceiling across all historical slots
    // (max ~58k impressions/hr, ~2100 watch-hours/hr) so they only catch gross
    // full-cumulative leaks and never reject legitimate high-traffic slots. The
    // primary guard against subtler stale-baseline leaks is the window-span check above.
    const slotHours = activeVariant.active_since
      ? Math.max(0.05, (new Date(completedAt).getTime() - new Date(activeVariant.active_since).getTime()) / 3600000)
      : 1;
    const impPerHour = deltaImpressions / slotHours;
    const watchHoursPerHour = deltaWatchTime / slotHours; // implied avg concurrent viewers
    const rateImpossible = impPerHour > 120000 || watchHoursPerHour > 4000;
    const suspect = forcedSuspect || deltaImpressions < 0 || deltaViews < 0 || impliedCtr > 0.25 || rateImpossible;
    if (suspect) {
      console.warn(`[test-runner] SUSPECT slot for test ${test.id} ${activeVariant.label}: imp=${deltaImpressions} views=${deltaViews} wt=${deltaWatchTime.toFixed(0)}h over ${slotHours.toFixed(2)}h ctr=${(impliedCtr * 100).toFixed(1)}%${forcedSuspect ? ' [unreconstructable]' : ''}${rateImpossible ? ' [rate impossible]' : ''} — flagged, excluded from analysis`);
    }
    const writeRotationSlot = db.transaction(() => {
      if (activationBaseline) {
        db.prepare(`
          DELETE FROM test_measurements WHERE test_id = ? AND variant_id = ?
          AND realtime_views_json LIKE '%"type":"activation_baseline"%'
        `).run(test.id, activeVariant.id);
      }
      db.prepare(`
        INSERT INTO test_measurements (test_id, variant_id, measured_at, impressions, views, ctr,
          watch_time_hours, avg_view_duration, avg_view_pct, likes, comments, subs_gained,
          realtime_views_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(test.id, activeVariant.id, activeVariant.active_since,
        suspect ? 0 : deltaImpressions, suspect ? 0 : deltaViews, suspect ? 0 : deltaCtr,
        suspect ? 0 : deltaWatchTime, suspect ? 0 : deltaAvgDuration, suspect ? 0 : (endSnapshot.avgViewPct || 0), deltaLikes, deltaComments, deltaSubs,
        JSON.stringify({
          type: 'rotation_slot',
          activated_at: activeVariant.active_since,
          completed_at: completedAt,
          ...(suspect ? { suspect: true } : {}),
        }));
    });
    writeRotationSlot();

    console.log(`[test-runner] Test ${test.id}: ${activeVariant.label} completed rotation ${hoursMap[activeVariant.id]}/${timesEach}`);

    // Check if ALL variants have completed timesEach rotations
    const allDone = variants.every(v => hoursMap[v.id] >= timesEach);

    if (allDone) {
      console.log(`[test-runner] Test ${test.id}: all variants done (${timesEach} hours each), evaluating`);
      await evaluateTest(test, variants);
      return;
    }

    // Simple rotation: always go to the next variant in order (A->B->C->D->A...)
    const currentIdx = variants.findIndex(v => v.id === activeVariant.id);
    let nextVariant: TestVariant | null = null;

    for (let i = 1; i <= variants.length; i++) {
      const candidate = variants[(currentIdx + i) % variants.length];
      if (hoursMap[candidate.id] < timesEach) {
        nextVariant = candidate;
        break;
      }
    }

    if (!nextVariant) {
      // Shouldn't happen if allDone check passed, but safety
      console.log(`[test-runner] Test ${test.id}: no variant needs more hours, evaluating`);
      await evaluateTest(test, variants);
      return;
    }

    const hoursStr = variants.map(v => `${v.label}:${hoursMap[v.id]}/${timesEach}`).join(' ');
    console.log(`[test-runner] Test ${test.id}: rotating ${activeVariant.label} -> ${nextVariant.label} [${hoursStr}]`);
    await activateVariant(test, nextVariant);
  }
  // If hour isn't up yet, do nothing — only collect data at rotation time
}

/**
 * Get current video stats snapshot (from Studio scraper or API).
 * Retries up to 3 times if Studio returns 0 impressions (bad scrape).
 */
async function getSnapshot(videoId: string): Promise<{ views: number; impressions: number; ctr: number; likes: number; comments: number; watchTimeHours: number; avgViewDuration: number; avgViewPct: number; subsGained: number; scrapedAt: string | null }> {
  const db = getDb();

  for (let attempt = 0; attempt < 3; attempt++) {
    // Get latest studio snapshot with valid impressions
    const studio = db.prepare(
      'SELECT * FROM studio_snapshots WHERE video_id = ? AND impressions > 0 ORDER BY scraped_at DESC LIMIT 1'
    ).get(videoId) as any;

    if (studio) {
      // Check it's recent (within last 2 hours)
      const age = Date.now() - new Date(studio.scraped_at).getTime();
      if (age < 2 * 60 * 60 * 1000) {
        // Fix avg_view_pct: if stored as fraction (< 1), convert to percentage
        const avgViewPct = studio.avg_view_pct < 1 ? studio.avg_view_pct * 100 : studio.avg_view_pct;

        return {
          views: studio.views || 0,
          impressions: studio.impressions || 0,
          ctr: studio.ctr || 0,
          likes: studio.likes || 0,
          comments: studio.comments || 0,
          watchTimeHours: studio.watch_time_hours || 0,
          avgViewDuration: studio.avg_view_duration_sec || 0,
          avgViewPct,
          subsGained: studio.subscribers_net || 0,
          scrapedAt: studio.scraped_at || null,
        };
      }
    }

    // No recent snapshot — just wait briefly for extension data
    if (attempt < 2) {
      console.log(`[test-runner] No valid snapshot for ${videoId}, waiting for extension data (attempt ${attempt + 1}/3)`);
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  // After retries, accept whatever we have (even if old)
  const fallbackStudio = db.prepare(
    'SELECT * FROM studio_snapshots WHERE video_id = ? AND impressions > 0 ORDER BY scraped_at DESC LIMIT 1'
  ).get(videoId) as any;

  if (fallbackStudio) {
    console.log(`[test-runner] Using older snapshot for ${videoId} (age: ${Math.round((Date.now() - new Date(fallbackStudio.scraped_at).getTime()) / 60000)}min)`);
    let likes = 0, comments = 0;
    try {
      const apiStats = await getVideoStats(videoId);
      likes = apiStats.likes || 0;
      comments = apiStats.comments || 0;
    } catch {}
    const avgViewPct = fallbackStudio.avg_view_pct < 1 ? fallbackStudio.avg_view_pct * 100 : fallbackStudio.avg_view_pct;
    return {
      views: fallbackStudio.views || 0,
      impressions: fallbackStudio.impressions || 0,
      ctr: fallbackStudio.ctr || 0,
      likes,
      comments,
      watchTimeHours: fallbackStudio.watch_time_hours || 0,
      avgViewDuration: fallbackStudio.avg_view_duration_sec || 0,
      avgViewPct,
      subsGained: fallbackStudio.subscribers_net || 0,
      scrapedAt: fallbackStudio.scraped_at || null,
    };
  }

  // Last resort: API
  try {
    const stats = await getVideoStats(videoId);
    return { views: stats.views, impressions: 0, ctr: 0, likes: stats.likes, comments: stats.comments, watchTimeHours: 0, avgViewDuration: 0, avgViewPct: 0, subsGained: 0, scrapedAt: null };
  } catch {
    return { views: 0, impressions: 0, ctr: 0, likes: 0, comments: 0, watchTimeHours: 0, avgViewDuration: 0, avgViewPct: 0, subsGained: 0, scrapedAt: null };
  }
}

async function activateVariant(test: Test, variant: TestVariant): Promise<void> {
  const db = getDb();

  // Upload thumbnail/title — queued to prevent concurrent Chrome sessions
  // Capture test ID so the queue can skip if the test was completed/paused while waiting
  const channel = (test as any).channel || 'main';
  const testId = test.id;
  // For a paired (test_type='both') test the title and thumbnail MUST change
  // together or the comparison is meaningless. The thumbnail goes up via Firefox
  // (can fail); the title via API (reliable). So we gate the title on the
  // thumbnail succeeding — if the thumbnail fails, we do NOT change the title,
  // keeping both on the previous variant instead of desyncing them.
  let thumbnailOk = false;
  if ((test.test_type === 'thumbnail' || test.test_type === 'both') && variant.thumbnail_path) {
    const thumbPath = variant.thumbnail_path;
    const videoId = test.video_id;
    const varLabel = variant.label;
    _uploadQueue = _uploadQueue
      .then(() => new Promise(r => setTimeout(r, 5000))) // wait between uploads
      .then(async () => {
        // Check if the test is still running before uploading — prevents stale uploads
        // from overwriting thumbnails on videos whose tests have already completed
        const currentTest = db.prepare('SELECT status FROM tests WHERE id = ?').get(testId) as any;
        if (!currentTest || currentTest.status !== 'running') {
          console.log(`[test-runner] Skipping upload ${varLabel} for ${videoId} — test ${testId} is ${currentTest?.status || 'gone'}`);
          return;
        }
        try {
          await uploadThumbnail(videoId, thumbPath, channel);
          thumbnailOk = true;
          console.log(`[test-runner] Uploaded thumbnail ${varLabel} for ${videoId} (${channel})`);
          // Clear consecutive failure counter on success
          db.prepare('UPDATE tests SET error_msg = NULL WHERE id = ? AND error_msg LIKE ?').run(testId, 'upload_fail%');
        } catch (err: any) {
          console.error(`[test-runner] Failed to upload thumbnail ${varLabel}: ${err.message}`);
          // Track consecutive failures and alert on the first one
          const failCount = db.prepare(
            "SELECT CAST(REPLACE(COALESCE(error_msg,'upload_fail:0'), 'upload_fail:', '') AS INTEGER) as n FROM tests WHERE id = ?"
          ).get(testId) as any;
          const n = (failCount?.n || 0) + 1;
          db.prepare("UPDATE tests SET error_msg = ? WHERE id = ?").run(`upload_fail:${n}`, testId);
          try {
            const { sendEmail } = await import('./email.js');
            if (n >= 3) {
              // 3+ consecutive failures — pause the test so it doesn't keep rotating with wrong thumbnails
              db.prepare("UPDATE tests SET status = 'paused' WHERE id = ? AND status = 'running'").run(testId);
              await sendEmail(
                'team@example.com',
                `YT Testing: Test PAUSED — ${n} consecutive upload failures`,
                `<p>Test <a href="https://app.example.com/tests/${testId}">#${testId}</a> has been <strong>automatically paused</strong> after ${n} consecutive thumbnail upload failures.</p>` +
                `<p>The Firefox Studio session may have expired. Re-login then resume the test.</p>` +
                `<p>Error: ${err.message}</p>` +
                `<p>Re-login: <code>open -a Firefox --args --profile ~/Projects/yt-testing/data/firefox-studio --no-remote https://studio.youtube.com</code></p>`
              );
            } else {
              await sendEmail(
                'team@example.com',
                `YT Testing: Thumbnail upload failed (${varLabel} for ${videoId})`,
                `<p>Thumbnail upload for variant <strong>${varLabel}</strong> failed on video <strong>${videoId}</strong> (failure #${n}).</p>` +
                `<p>Error: ${err.message}</p>` +
                `<p>The test rotation advanced but the <strong>wrong thumbnail may still be live</strong> on YouTube.</p>` +
                `<p>Check: <a href="https://studio.youtube.com/video/${videoId}/edit">YouTube Studio</a></p>` +
                `<p>Dashboard: <a href="https://app.example.com/tests/${testId}">app.example.com/tests/${testId}</a></p>`
              );
            }
          } catch {}
        }
      })
      .catch(err => console.error(`[test-runner] Upload queue error: ${err?.message}`));
  }

  if ((test.test_type === 'title' || test.test_type === 'both') && variant.title) {
    const titleToSet = variant.title;
    const titleVideoId = test.video_id;
    const isPaired = test.test_type === 'both';
    _uploadQueue = _uploadQueue.then(async () => {
      // Skip stale updates if the test stopped while queued.
      const currentTest = db.prepare('SELECT status FROM tests WHERE id = ?').get(testId) as any;
      if (!currentTest || currentTest.status !== 'running') {
        console.log(`[test-runner] Skipping title update ${variant.label} for ${titleVideoId} — test ${testId} is ${currentTest?.status || 'gone'}`);
        return;
      }
      // Paired test: only change the title if the thumbnail actually changed,
      // so the pair never desyncs (new title on an old thumbnail).
      if (isPaired && !thumbnailOk) {
        console.log(`[test-runner] Paired test ${testId}: thumbnail did not upload for ${variant.label}, skipping title change to avoid desync`);
        return;
      }
      try {
        await updateVideoTitle(titleVideoId, titleToSet);
        console.log(`[test-runner] Updated title for ${titleVideoId}`);
      } catch (err: any) {
        console.error(`[test-runner] Failed to update title: ${err.message}`);
      }
    }).catch(err => console.error(`[test-runner] Upload queue error: ${err?.message}`));
  }

  // Use actual activation time — snapping to top-of-hour caused premature rotation when
  // rotation happened mid-hour (e.g. B rotates at 09:55, C gets active_since=09:00,
  // 10:00 cycle sees 60+ min elapsed and immediately rotates C after only 4 minutes).
  const now = new Date();
  db.prepare('UPDATE test_variants SET active_since = ? WHERE id = ?').run(now.toISOString(), variant.id);

  // Record baseline snapshot so we can compute delta when this variant rotates out.
  // CRITICAL: only record baseline if we have valid impression data (> 0).
  // A baseline of 0 causes the slot delta to equal the lifetime total.
  try {
    const snapshot = await getSnapshot(test.video_id);
    if (!snapshot.impressions || snapshot.impressions === 0) {
      console.log(`[test-runner] Activated ${variant.label} for ${test.video_id} (no valid snapshot for baseline — will reconstruct from studio snapshots at rotation end)`);
      return;
    }
    // CRITICAL: reject a STALE snapshot as a baseline. getSnapshot's fallback path
    // will return an arbitrarily old snapshot when the extension has not reported
    // recently (e.g. a multi-hour Studio-data gap). If we store that as the baseline,
    // the slot delta at rotation = endSnapshot - staleBaseline spans the whole gap
    // (many hours of cumulative growth) and gets mis-attributed to a single ~1h slot.
    // This is exactly what produced a "1 hour" slot with 19,934 imp / 588 watch-hours
    // (baseline was ~33h stale). If the freshest snapshot is >2h old, record NO baseline;
    // the rotation end will reconstruct the real per-slot delta from studio_snapshots.
    const snapAgeMs = snapshot.scrapedAt ? Date.now() - new Date(snapshot.scrapedAt).getTime() : Infinity;
    if (snapAgeMs > 2 * 60 * 60 * 1000) {
      console.log(`[test-runner] Activated ${variant.label} for ${test.video_id} (snapshot ${Math.round(snapAgeMs / 3600000)}h stale — skipping baseline to avoid leak; will reconstruct at rotation end)`);
      // Ensure no leftover baseline from a prior activation is reused.
      db.prepare(`
        DELETE FROM test_measurements WHERE test_id = ? AND variant_id = ?
        AND realtime_views_json LIKE '%"type":"activation_baseline"%'
      `).run(test.id, variant.id);
      return;
    }
    // Delete any old activation baselines for this variant
    db.prepare(`
      DELETE FROM test_measurements WHERE test_id = ? AND variant_id = ?
      AND realtime_views_json LIKE '%"type":"activation_baseline"%'
    `).run(test.id, variant.id);

    db.prepare(`
      INSERT INTO test_measurements (test_id, variant_id, impressions, views, ctr,
        watch_time_hours, avg_view_duration, avg_view_pct, likes, comments, subs_gained,
        realtime_views_json)
      VALUES (?, ?, 0, 0, 0, 0, 0, 0, 0, 0, 0, ?)
    `).run(test.id, variant.id, JSON.stringify({
      type: 'activation_baseline',
      impressions: snapshot.impressions,
      views: snapshot.views,
      ctr: snapshot.ctr,
      likes: snapshot.likes,
      comments: snapshot.comments,
      watchTimeHours: snapshot.watchTimeHours,
      subsGained: snapshot.subsGained,
      snapshot_at: snapshot.scrapedAt,
      recorded_at: new Date().toISOString(),
    }));
    console.log(`[test-runner] Activated ${variant.label} for ${test.video_id} (baseline: imp=${snapshot.impressions} views=${snapshot.views})`);
  } catch (err: any) {
    console.log(`[test-runner] Activated ${variant.label} for ${test.video_id} (no baseline: ${err.message})`);
  }
}


// Re-apply winners that never went live (winner_applied=0) - typically because the YouTube Data
// API quota was exhausted when the test completed. Retried every cycle until it sticks; scoped to
// the last 4 days so we don't fight a newer running test for the same video.
// Exported so the settled-results sweep can push a flipped winner immediately
// instead of waiting for the next top-of-hour test cycle.
export async function retryPendingWinners(db: any): Promise<void> {
  const pending = db.prepare(`
    SELECT * FROM tests
    WHERE status = 'completed' AND winner_applied = 0 AND winner_variant_id IS NOT NULL
      AND completed_at > datetime('now', '-4 days')
  `).all() as Test[];
  if (!pending.length) return;
  console.log(`[test-runner] Retrying ${pending.length} unapplied winner(s)`);
  for (const test of pending) {
    // Skip if a newer test is running for this video (it owns the title/thumbnail now).
    const newer = db.prepare("SELECT id FROM tests WHERE video_id = ? AND status = 'running' AND id > ?").get(test.video_id, test.id) as any;
    if (newer) { db.prepare('UPDATE tests SET winner_applied = 1 WHERE id = ?').run(test.id); continue; }
    const winner = db.prepare('SELECT * FROM test_variants WHERE id = ?').get((test as any).winner_variant_id) as TestVariant | undefined;
    if (!winner) { db.prepare('UPDATE tests SET winner_applied = 1 WHERE id = ?').run(test.id); continue; }
    const channel = (test as any).channel || 'main';
    try {
      if ((test.test_type === 'title' || test.test_type === 'both') && winner.title) {
        await updateVideoTitle(test.video_id, winner.title);
      }
      if ((test.test_type === 'thumbnail' || test.test_type === 'both') && winner.thumbnail_path) {
        await uploadThumbnail(test.video_id, winner.thumbnail_path, channel);
      }
      db.prepare('UPDATE tests SET winner_applied = 1 WHERE id = ?').run(test.id);
      console.log(`[test-runner] Re-applied winner ${winner.label} for ${test.video_id} (test ${test.id})`);
    } catch (err: any) {
      console.warn(`[test-runner] Winner retry for test ${test.id} still failing (will retry next cycle): ${err.message}`);
    }
  }
}

export interface WinnerComputation {
  winnerId: number | null;
  hasEnoughData: boolean;
  variantData: { variant: TestVariant; measurements: any[]; totalImpressions: number; totalViews: number }[];
}

// Single source of the winner rule. Used at completion AND by the settled-results
// sweep that re-checks winners while YouTube settles the final hours of data, so
// both decisions can never drift apart.
export function computeWinnerForTest(test: Pick<Test, 'id'> & { auto_winner?: string }, variants: TestVariant[]): WinnerComputation {
  const db = getDb();

  // Get measurements per variant — exclude activation_baseline rows (they have 0s and would skew results)
  const variantData = variants.map(v => {
    const ms = db.prepare(
      `SELECT * FROM test_measurements WHERE test_id = ? AND variant_id = ?
       AND (realtime_views_json IS NULL OR realtime_views_json NOT LIKE '%"type":"activation_baseline"%')
       ORDER BY measured_at`
    ).all(test.id, v.id) as any[];

    const totalImpressions = ms.reduce((s, m) => s + (m.impressions || 0), 0);
    const totalViews = ms.reduce((s, m) => s + (m.views || 0), 0);

    return { variant: v, measurements: ms, totalImpressions, totalViews };
  });

  // Determine winner
  let winnerId: number | null = null;
  const autoWinner = (test as any).auto_winner || 'disabled';

  // Require minimum data before declaring a winner — prevents noise from low-traffic tests
  const MIN_IMPRESSIONS_FOR_WINNER = 500;
  const hasEnoughData = variantData.every(vd => vd.totalImpressions >= MIN_IMPRESSIONS_FOR_WINNER);

  if (autoWinner !== 'disabled' && variantData.length >= 2 && hasEnoughData) {
    // Sort by the selected metric
    const sorted = [...variantData].sort((a, b) => {
      if (autoWinner === 'ctr') {
        // Views per impression — the REAL, honest click-through: both numerator
        // and denominator are realtime for every video. The reconstructed VTR
        // (m.ctr) is derived from a DAILY figure on old videos and cannot split
        // titles (it produced a fake 6.4% vs 2.95% gap on test 190 where the true
        // views-per-impression was 15.6% vs 15.0%), so never decide a winner on it.
        const vpiA = a.totalImpressions > 0 ? a.totalViews / a.totalImpressions : 0;
        const vpiB = b.totalImpressions > 0 ? b.totalViews / b.totalImpressions : 0;
        return vpiB - vpiA;
      }
      if (autoWinner === 'views') return b.totalViews - a.totalViews;
      if (autoWinner === 'watch_time') {
        const wtA = a.measurements.reduce((s: number, m: any) => s + (m.watch_time_hours || 0), 0);
        const wtB = b.measurements.reduce((s: number, m: any) => s + (m.watch_time_hours || 0), 0);
        return wtB - wtA;
      }
      return b.totalViews - a.totalViews;
    });
    winnerId = sorted[0].variant.id;
  } else if (variantData.length >= 2 && hasEnoughData) {
    // Default (display only): highest views-per-impression — the real signal.
    const sorted = [...variantData].sort((a, b) => {
      const vpiA = a.totalImpressions > 0 ? a.totalViews / a.totalImpressions : 0;
      const vpiB = b.totalImpressions > 0 ? b.totalViews / b.totalImpressions : 0;
      return vpiB - vpiA;
    });
    winnerId = sorted[0].variant.id;
  }

  return { winnerId, hasEnoughData, variantData };
}

async function evaluateTest(test: Test, variants: TestVariant[]): Promise<void> {
  const db = getDb();
  const { winnerId, variantData } = computeWinnerForTest(test, variants);
  const autoWinner = (test as any).auto_winner || 'disabled';

  // Mark test as completed
  db.prepare(`
    UPDATE tests SET status = 'completed', completed_at = datetime('now'), winner_variant_id = ?
    WHERE id = ?
  `).run(winnerId, test.id);

  // Apply the winning variant's thumbnail/title when auto_winner is enabled.
  // If no winner or auto_winner is disabled, restore the original.
  const completeChannel = (test as any).channel || 'main';
  const videoId = test.video_id;
  const winnerVariant = winnerId ? variants.find(v => v.id === winnerId) : null;
  const shouldApplyWinner = autoWinner !== 'disabled' && winnerVariant;
  // Mark the winner as "not yet applied" so the retry pass re-pushes it if the upload below fails
  // (e.g. YouTube API quota exhausted). The success callbacks flip this to 1.
  db.prepare('UPDATE tests SET winner_applied = ? WHERE id = ?').run(shouldApplyWinner ? 0 : 1, test.id);

  if (shouldApplyWinner && (test.test_type === 'thumbnail' || test.test_type === 'both') && winnerVariant.thumbnail_path) {
    const winnerThumbPath = winnerVariant.thumbnail_path;
    const completedTestId = test.id;
    _uploadQueue = _uploadQueue
      .then(() => new Promise(r => setTimeout(r, 3000)))
      .then(async () => {
        // Check no newer test has started for this video
        const newerTest = db.prepare("SELECT id FROM tests WHERE video_id = ? AND status = 'running' AND id > ?").get(videoId, completedTestId) as any;
        if (newerTest) {
          console.log(`[test-runner] Skipping winner upload for ${videoId} — newer test ${newerTest.id} is running`);
          return;
        }
        try {
          await uploadThumbnail(videoId, winnerThumbPath, completeChannel);
          db.prepare('UPDATE tests SET winner_applied = 1 WHERE id = ?').run(completedTestId);
          console.log(`[test-runner] Applied winning thumbnail ${winnerVariant.label} for ${videoId}`);
        } catch (err: any) {
          console.error(`[test-runner] Failed to apply winning thumbnail (will retry): ${err.message}`);
          // Fallback: restore original
          if (test.original_thumbnail_blob) {
            try {
              const { writeFileSync } = await import('fs');
              const tmpPath = `/tmp/restore_${videoId}.jpg`;
              writeFileSync(tmpPath, test.original_thumbnail_blob);
              await uploadThumbnail(videoId, tmpPath, completeChannel);
              console.log(`[test-runner] Restored original thumbnail for ${videoId} (winner upload failed)`);
            } catch {}
          }
        }
      });
  } else if (test.original_thumbnail_blob && (test.test_type === 'thumbnail' || test.test_type === 'both')) {
    // No winner or auto_winner disabled — restore original
    const thumbBlob = test.original_thumbnail_blob;
    _uploadQueue = _uploadQueue
      .then(() => new Promise(r => setTimeout(r, 3000)))
      .then(async () => {
        try {
          const { writeFileSync } = await import('fs');
          const tmpPath = `/tmp/restore_${videoId}.jpg`;
          writeFileSync(tmpPath, thumbBlob);
          await uploadThumbnail(videoId, tmpPath, completeChannel);
          console.log(`[test-runner] Restored original thumbnail for ${videoId}`);
        } catch (err: any) {
          console.error(`[test-runner] Failed to restore original thumbnail: ${err.message}`);
        }
      });
  }

  if (shouldApplyWinner && (test.test_type === 'title' || test.test_type === 'both') && winnerVariant.title) {
    const winnerTitle = winnerVariant.title;
    _uploadQueue = _uploadQueue.then(async () => {
      try {
        await updateVideoTitle(videoId, winnerTitle);
        if (test.test_type === 'title') db.prepare('UPDATE tests SET winner_applied = 1 WHERE id = ?').run(test.id);
        console.log(`[test-runner] Applied winning title "${winnerTitle}" for ${videoId}`);
      } catch (err: any) {
        console.error(`[test-runner] Failed to apply winning title (will retry): ${err.message}`);
      }
    });
  } else if ((test.test_type === 'title' || test.test_type === 'both') && test.original_title) {
    const origTitle = test.original_title;
    _uploadQueue = _uploadQueue.then(async () => {
      try {
        await updateVideoTitle(videoId, origTitle);
        console.log(`[test-runner] Restored original title for ${videoId}`);
      } catch (err: any) {
        console.error(`[test-runner] Failed to restore original title: ${err.message}`);
      }
    });
  }

  const winnerLabel = winnerId ? variants.find(v => v.id === winnerId)?.label : 'none';
  console.log(`[test-runner] Test ${test.id} completed. Winner: ${winnerLabel}`);

  // Ensure all title variants get tagged (picks up any that missed the create-time fire).
  if (test.test_type === 'title' || test.test_type === 'both') {
    import('./title-tagger.js')
      .then(m => m.tagAllVariants({ semantic: true, onlyUntagged: true }))
      .catch(() => {});
  }

  // Auto-start any pending tests for the same video (e.g. thumbnail test after title test)
  const pendingTests = db.prepare(`
    SELECT id, video_title, test_type FROM tests
    WHERE video_id = ? AND status = 'pending' AND id != ?
    ORDER BY id ASC
  `).all(test.video_id, test.id) as any[];

  if (pendingTests.length > 0) {
    const next = pendingTests[0];
    db.prepare("UPDATE tests SET status = 'running', started_at = datetime('now') WHERE id = ?").run(next.id);
    // Activate first variant
    const firstVariant = db.prepare('SELECT * FROM test_variants WHERE test_id = ? ORDER BY id ASC LIMIT 1').get(next.id) as any;
    if (firstVariant) {
      await activateVariant({ ...test, id: next.id, video_id: test.video_id, test_type: next.test_type } as any, firstVariant);
    }
    console.log(`[test-runner] Auto-started pending test ${next.id} (${next.test_type}) for ${test.video_id}`);
  }

  // Send email notification — only if we actually collected data
  const totalImpressionsAllVariants = variantData.reduce((s, vd) => s + vd.totalImpressions, 0);
  if (totalImpressionsAllVariants > 0) {
    try {
      const { sendTestCompleteEmail } = await import('./email.js');
      await sendTestCompleteEmail(test.video_title || test.video_id, winnerLabel || '?', test.id);
    } catch {}
  } else {
    console.log(`[test-runner] Test ${test.id}: skipping completion email — no impression data collected`);
  }
}

