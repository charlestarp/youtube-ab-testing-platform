/**
 * Settled-results sweep.
 *
 * YouTube's Reach data underreports the most recent ~2 hours (CTR reads ~2% low
 * until the hour settles). reach-refresh already keeps rewriting a completed
 * test's per-hour rows for 48 hours after completion, so the STORED data
 * self-corrects. This sweep closes the two gaps that correction never reached:
 *
 * 1. WINNER RE-EVALUATION: the winner was decided once, at the moment the test
 *    completed, on data whose final hours were still unsettled. Every sweep
 *    (each reach-refresh cycle, every 20 min) re-runs the exact same winner
 *    rule (computeWinnerForTest) over the now-corrected rows for tests inside
 *    the 48h settle window. If the winner changed, winner_variant_id is
 *    updated and winner_applied is reset to 0 so the existing retry pass in
 *    test-runner pushes the correct thumbnail/title live.
 *
 * 2. SETTLED FINAL REPORT: once a test's 48h settle window closes, a one-time
 *    email goes out with the final per-variant numbers (and a note if the
 *    winner flipped during settling). The immediate completion email stays,
 *    but is explicitly preliminary.
 */

import { getDb } from '../db/client.js';
import { computeWinnerForTest, retryPendingWinners } from './test-runner.js';
import type { TestVariant } from '../types/index.js';

export interface SettledVariantStats {
  label: string;
  title: string | null;
  impressions: number;
  views: number;
  vpi: number; // views per impression, the winner metric, as a percentage
  watchHours: number;
}

function settledStats(variantData: { variant: TestVariant; measurements: any[]; totalImpressions: number; totalViews: number }[]): SettledVariantStats[] {
  return variantData
    .map(vd => ({
      label: vd.variant.label,
      title: vd.variant.title || null,
      impressions: vd.totalImpressions,
      views: vd.totalViews,
      vpi: vd.totalImpressions > 0 ? Math.round((vd.totalViews / vd.totalImpressions) * 10000) / 100 : 0,
      watchHours: Math.round(vd.measurements.reduce((s: number, m: any) => s + (m.watch_time_hours || 0), 0) * 10) / 10,
    }))
    .sort((a, b) => b.vpi - a.vpi);
}

/** Re-check winners of completed tests still inside the 48h settle window. */
export async function reevaluateSettlingWinners(): Promise<void> {
  const db = getDb();
  let flipped = 0;
  const tests = db.prepare(`
    SELECT * FROM tests
    WHERE status = 'completed'
      AND ctr_locked = 0
      AND winner_variant_id IS NOT NULL
      AND COALESCE(winner_manual, 0) = 0
      AND completed_at > datetime('now', '-48 hours')
  `).all() as any[];

  for (const test of tests) {
    try {
      const variants = db.prepare('SELECT * FROM test_variants WHERE test_id = ? AND active = 1 ORDER BY label').all(test.id) as TestVariant[];
      const { winnerId, hasEnoughData, variantData } = computeWinnerForTest(test, variants);
      // Only act on a confident, different verdict. If settling dropped the data
      // below the confidence floor, leave the original decision alone.
      if (!hasEnoughData || !winnerId || winnerId === test.winner_variant_id) continue;

      // Hysteresis: near-ties must not flip (and re-upload thumbnails) back and
      // forth every sweep. Flip only when the challenger leads the stored winner
      // by at least 1% relative on the deciding metric.
      const autoWinnerMetric = test.auto_winner || 'disabled';
      const metricOf = (variantId: number): number => {
        const vd = variantData.find(d => d.variant.id === variantId);
        if (!vd) return 0;
        if (autoWinnerMetric === 'views') return vd.totalViews;
        if (autoWinnerMetric === 'watch_time') return vd.measurements.reduce((s: number, m: any) => s + (m.watch_time_hours || 0), 0);
        return vd.totalImpressions > 0 ? vd.totalViews / vd.totalImpressions : 0;
      };
      if (metricOf(winnerId) < metricOf(test.winner_variant_id) * 1.01) continue;

      const from = variants.find(v => v.id === test.winner_variant_id)?.label || '?';
      const to = variants.find(v => v.id === winnerId)?.label || '?';
      const autoWinner = test.auto_winner || 'disabled';
      const flip = JSON.stringify({ from, to, at: new Date().toISOString() });

      // winner_applied=0 hands the push to test-runner's existing retry pass,
      // which already guards against newer running tests on the same video.
      db.prepare('UPDATE tests SET winner_variant_id = ?, winner_applied = ?, settled_flip = ? WHERE id = ?')
        .run(winnerId, autoWinner !== 'disabled' ? 0 : 1, flip, test.id);
      if (autoWinner !== 'disabled') flipped++;
      console.log(`[settled-results] test ${test.id} (${test.video_id}): settled data FLIPPED winner ${from} -> ${to}${autoWinner !== 'disabled' ? ' (re-applying)' : ''}`);
      // Tell the humans NOW — waiting for the 48h settled report left Charles
      // discovering the 195 flip by noticing the thumbnail change (2026-07-10).
      try {
        const { sendEmail } = await import('./email.js');
        await sendEmail(process.env.NOTIFICATION_EMAIL || 'team@example.com',
          `Winner changed: ${test.video_title || test.video_id}`, `
          <div style="font-family:Helvetica Neue,sans-serif;max-width:520px;margin:0 auto;padding:40px 20px">
            <h2 style="color:#c98a1b">Winner changed during settling</h2>
            <p>As YouTube settled the final hours of data for "<strong>${(test.video_title || test.video_id).replace(/</g, '&lt;')}</strong>", the winner changed from <strong>Variant ${from}</strong> to <strong>Variant ${to}</strong>.</p>
            <p>${autoWinner !== 'disabled' ? `Variant ${to} is being applied to YouTube now.` : 'Auto-winner is off for this test, so nothing was changed on YouTube.'} The final settled report will follow when the 48 hour window closes.</p>
            <p style="margin-top:24px">
              <a href="https://app.example.com/tests/${test.id}" style="background:#7c63ff;color:white;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:500">View Test</a>
            </p>
          </div>`);
      } catch (e: any) { console.error(`[settled-results] flip email failed: ${e.message}`); }
    } catch (e: any) {
      console.error(`[settled-results] re-eval failed for test ${test.id}: ${e.message}`);
    }
  }

  // Push flipped winners live now rather than waiting for the next top-of-hour
  // test cycle (its own retry keeps them safe if this attempt fails).
  if (flipped > 0) {
    try { await retryPendingWinners(db); } catch (e: any) { console.error(`[settled-results] immediate re-apply failed (hourly retry will catch it): ${e.message}`); }
  }
}

/** Send the one-time settled final report for tests whose 48h window just closed. */
export async function sendSettledReports(): Promise<void> {
  const db = getDb();
  // The lower bound (-72h) keeps historical tests from before this feature from
  // ever matching; only tests whose window closes from now on get the report.
  const tests = db.prepare(`
    SELECT * FROM tests
    WHERE status = 'completed'
      AND COALESCE(settled_report_sent, 0) = 0
      AND completed_at <= datetime('now', '-48 hours')
      AND completed_at > datetime('now', '-72 hours')
  `).all() as any[];

  for (const test of tests) {
    try {
      const variants = db.prepare('SELECT * FROM test_variants WHERE test_id = ? AND active = 1 ORDER BY label').all(test.id) as TestVariant[];
      const { variantData } = computeWinnerForTest(test, variants);
      const stats = settledStats(variantData);
      const totalImpressions = stats.reduce((s, v) => s + v.impressions, 0);
      // Mark first so a crash mid-send can never double-email.
      db.prepare('UPDATE tests SET settled_report_sent = 1 WHERE id = ?').run(test.id);
      if (totalImpressions === 0) {
        console.log(`[settled-results] test ${test.id}: skipping settled report, no impression data`);
        continue;
      }
      const winnerLabel = variants.find(v => v.id === test.winner_variant_id)?.label || 'none';
      const flip = test.settled_flip ? JSON.parse(test.settled_flip) : null;
      const { sendSettledReportEmail } = await import('./email.js');
      await sendSettledReportEmail({
        testId: test.id,
        testTitle: test.video_title || test.video_id,
        winnerLabel,
        stats,
        flip,
      });
    } catch (e: any) {
      console.error(`[settled-results] settled report failed for test ${test.id}: ${e.message}`);
    }
  }
}

/** Run both passes. Called after every reach-refresh cycle (every 20 min). */
export async function settledSweep(): Promise<void> {
  await reevaluateSettlingWinners();
  await sendSettledReports();
}
