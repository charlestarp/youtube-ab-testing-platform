/**
 * Read-only audit: recompute the winner for the last N completed tests from the
 * current (settled) measurement data and compare against the stored decision.
 * Usage: npx tsx src/scripts/verify-settled-winners.ts [N]
 */
import { getDb } from '../db/client.js';
import { computeWinnerForTest } from '../services/test-runner.js';
import type { TestVariant } from '../types/index.js';

const n = parseInt(process.argv[2] || '10');
const db = getDb();
const tests = db.prepare(`
  SELECT * FROM tests WHERE status = 'completed' AND video_id IS NOT NULL
  ORDER BY completed_at DESC LIMIT ?
`).all(n) as any[];

for (const test of tests) {
  const variants = db.prepare('SELECT * FROM test_variants WHERE test_id = ? AND active = 1 ORDER BY label').all(test.id) as TestVariant[];
  const { winnerId, hasEnoughData, variantData } = computeWinnerForTest(test, variants);
  const storedLabel = variants.find(v => v.id === test.winner_variant_id)?.label || 'none';
  const settledLabel = variants.find(v => v.id === winnerId)?.label || 'none';
  const detail = variantData
    .map(vd => `${vd.variant.label}: ${vd.totalImpressions > 0 ? ((vd.totalViews / vd.totalImpressions) * 100).toFixed(2) : '0.00'}% (${vd.totalViews}v/${vd.totalImpressions}i)`)
    .join('  ');
  const match = storedLabel === settledLabel ? 'OK   ' : (!hasEnoughData ? 'LOWDATA' : 'FLIP ');
  console.log(`${match} test ${test.id} [${test.completed_at}] auto=${test.auto_winner} ctr_locked=${test.ctr_locked} "${(test.video_title || test.video_id).slice(0, 45)}"`);
  console.log(`       stored=${storedLabel} settled=${settledLabel} enoughData=${hasEnoughData} | ${detail}`);
}
