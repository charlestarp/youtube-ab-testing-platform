import { getDb } from '../db/client.js';
import type { TitlePreflightResult } from './title-preflight.js';

export function savePrediction(opts: {
  videoId?: string | null;
  testId?: number | null;
  title: string;
  result: TitlePreflightResult;
}): void {
  const db = getDb();
  const patterns = opts.result.signals
    .filter(s => s.source === 'ab' && (s.verdict === 'proven' || s.verdict === 'promising'))
    .map(s => s.tag);
  try {
    db.prepare(`
      INSERT INTO title_predictions (video_id, test_id, title, predicted_band, predicted_score, confidence, patterns_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      opts.videoId ?? null,
      opts.testId ?? null,
      opts.title,
      opts.result.ctr_band,
      opts.result.score,
      opts.result.confidence,
      JSON.stringify(patterns),
    );
  } catch (e: any) {
    console.error('[title-calibration] savePrediction failed:', e?.message);
  }
}

export function resolveTestPredictions(testId: number, winnerVariantId: number): void {
  const db = getDb();
  try {
    const winnerRow = db.prepare(`
      SELECT tv.title,
        CASE WHEN SUM(tm.impressions) > 0
          THEN ROUND(SUM(tm.impressions * tm.ctr) / SUM(tm.impressions), 2)
          ELSE 0 END AS ctr
      FROM test_variants tv
      LEFT JOIN test_measurements tm ON tm.variant_id = tv.id
        AND (tm.realtime_views_json LIKE '%"type":"rotation_slot"%'
          OR tm.realtime_views_json LIKE '%"type":"reconstructed_vtr"%')
        AND NOT (tm.ctr > 25)
      WHERE tv.id = ?
      GROUP BY tv.id
    `).get(winnerVariantId) as { title: string | null; ctr: number } | undefined;

    if (!winnerRow || !winnerRow.title || winnerRow.ctr <= 0) return;

    const actualCtr = winnerRow.ctr;
    const actualBand =
      actualCtr >= 8 ? 'top quartile' :
      actualCtr >= 5 ? 'above median' :
      actualCtr >= 3 ? 'around median' : 'below median';

    db.prepare(`
      UPDATE title_predictions
      SET actual_winner_ctr = ?, actual_band = ?, resolved_at = datetime('now')
      WHERE test_id = ? AND title = ? AND resolved_at IS NULL
    `).run(actualCtr, actualBand, testId, winnerRow.title);
  } catch (e: any) {
    console.error('[title-calibration] resolveTestPredictions failed:', e?.message);
  }
}

export interface CalibrationBand {
  predicted_band: string;
  predictions: number;
  resolved: number;
  correct: number;
  accuracy: number | null;
  avg_actual_ctr: number | null;
}

export interface CalibrationReport {
  total_predictions: number;
  resolved: number;
  overall_accuracy: number | null;
  by_band: CalibrationBand[];
  health_note: string;
}

export function getCalibrationReport(): CalibrationReport {
  const db = getDb();

  const bands = ['top quartile', 'above median', 'around median', 'below median'];

  const byBand: CalibrationBand[] = bands.map(band => {
    const row = db.prepare(`
      SELECT
        COUNT(*) as predictions,
        SUM(CASE WHEN resolved_at IS NOT NULL THEN 1 ELSE 0 END) as resolved,
        SUM(CASE WHEN resolved_at IS NOT NULL AND actual_band = predicted_band THEN 1 ELSE 0 END) as correct,
        ROUND(AVG(CASE WHEN resolved_at IS NOT NULL THEN actual_winner_ctr END), 2) as avg_actual_ctr
      FROM title_predictions
      WHERE predicted_band = ?
    `).get(band) as any;

    const resolved = row?.resolved ?? 0;
    const correct = row?.correct ?? 0;
    return {
      predicted_band: band,
      predictions: row?.predictions ?? 0,
      resolved,
      correct,
      accuracy: resolved > 0 ? Math.round((correct / resolved) * 100) : null,
      avg_actual_ctr: row?.avg_actual_ctr ?? null,
    };
  });

  const total = byBand.reduce((s, b) => s + b.predictions, 0);
  const resolvedTotal = byBand.reduce((s, b) => s + b.resolved, 0);
  const correctTotal = byBand.reduce((s, b) => s + b.correct, 0);
  const overallAccuracy = resolvedTotal > 0 ? Math.round((correctTotal / resolvedTotal) * 100) : null;

  let health_note: string;
  if (resolvedTotal === 0) {
    health_note = 'Pre-flight calibration: no resolved predictions yet — accuracy will show once tests complete.';
  } else {
    const pct = overallAccuracy ?? 0;
    const qualifier = pct >= 70 ? 'strong' : pct >= 50 ? 'moderate' : 'weak';
    health_note = `Pre-flight predictor: ${pct}% accuracy across ${resolvedTotal} resolved predictions (${qualifier} signal).`;
  }

  return { total_predictions: total, resolved: resolvedTotal, overall_accuracy: overallAccuracy, by_band: byBand, health_note };
}
