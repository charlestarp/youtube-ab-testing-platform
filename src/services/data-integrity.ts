/**
 * Data-integrity audit. Finds the measurement problems that used to silently
 * corrupt results (impossible CTRs, legacy baseline-only tests, cumulative
 * figures stored as slot deltas) so they can be reviewed rather than trusted.
 *
 * With the read filters now counting only real slot rows and rejecting >25% CTR,
 * these no longer pollute analysis — this audit just makes them visible.
 */
import { getDb } from '../db/client.js';

const REAL_SLOT = `(realtime_views_json LIKE '%"type":"rotation_slot"%' OR realtime_views_json LIKE '%"type":"reconstructed_vtr"%')`;

export interface IntegrityReport {
  summary: {
    completed_tests: number;
    tests_no_real_data: number;    // legacy baseline-only: now show "insufficient data"
    suspect_rows: number;          // impossible CTR or flagged at write time
    legacy_baseline_rows: number;  // old format, no longer counted
  };
  no_real_data: { test_id: number; video_title: string | null; completed_at: string | null }[];
  suspect_rows: { test_id: number; variant_label: string | null; measured_at: string | null; impressions: number; views: number; ctr: number; reason: string }[];
}

export function computeDataIntegrity(): IntegrityReport {
  const db = getDb();

  const completed = (db.prepare(`SELECT COUNT(*) c FROM tests WHERE status='completed'`).get() as any).c;

  // Completed tests with zero real slot rows -> now correctly show insufficient data.
  const noReal = db.prepare(`
    SELECT t.id AS test_id, t.video_title, t.completed_at
    FROM tests t
    WHERE t.status='completed'
      AND NOT EXISTS (SELECT 1 FROM test_measurements m WHERE m.test_id=t.id AND ${REAL_SLOT})
    ORDER BY t.completed_at DESC
  `).all() as any[];

  // Suspect rows: flagged at write time, or an impossible implied CTR, or negatives.
  const suspect = db.prepare(`
    SELECT m.test_id, v.label AS variant_label, m.measured_at, m.impressions, m.views, m.ctr,
      CASE
        WHEN m.realtime_views_json LIKE '%"suspect":true%' THEN 'flagged at capture'
        WHEN m.impressions < 0 OR m.views < 0 THEN 'negative delta'
        WHEN m.impressions > 0 AND CAST(m.views AS REAL)/m.impressions > 0.25 THEN 'impossible CTR'
        ELSE 'other'
      END AS reason
    FROM test_measurements m
    LEFT JOIN test_variants v ON v.id = m.variant_id
    WHERE ${REAL_SLOT} AND (
      m.realtime_views_json LIKE '%"suspect":true%'
      OR m.impressions < 0 OR m.views < 0
      OR (m.impressions > 0 AND CAST(m.views AS REAL)/m.impressions > 0.25)
    )
    ORDER BY m.test_id
  `).all() as any[];

  const legacyRows = (db.prepare(`
    SELECT COUNT(*) c FROM test_measurements
    WHERE realtime_views_json LIKE '%"type":"baseline"%'
  `).get() as any).c;

  return {
    summary: {
      completed_tests: completed,
      tests_no_real_data: noReal.length,
      suspect_rows: suspect.length,
      legacy_baseline_rows: legacyRows,
    },
    no_real_data: noReal,
    suspect_rows: suspect,
  };
}
