/**
 * Per-test learning notes. When a test completes, store a plain-English lesson in
 * tests.learning_note: which variant won, by how much, the confidence, and the
 * attributes the winner used. Deterministic (no AI) — pulled straight from the
 * measured CTRs and the variant's tags. This turns every test into a searchable
 * lesson the Producer can reference, on top of the aggregate A/B uplift tables.
 */
import { getDb } from '../db/client.js';

const NOT_BASELINE = `(
  (tm.realtime_views_json LIKE '%"type":"rotation_slot"%' OR tm.realtime_views_json LIKE '%"type":"reconstructed_vtr"%')
  AND NOT (tm.ctr > 25)
  AND tm.realtime_views_json NOT LIKE '%"suspect":true%'
)`;

export function ensureLearningSchema(): void {
  try { getDb().exec(`ALTER TABLE tests ADD COLUMN learning_note TEXT`); } catch {}
}

function variantTags(variantId: number, testType: string): string[] {
  const db = getDb();
  if (testType === 'thumbnail') {
    return (db.prepare(`SELECT th.name FROM variant_tags vt JOIN thumbnail_tags th ON th.id = vt.tag_id WHERE vt.variant_id = ?`).all(variantId) as any[]).map(r => r.name);
  }
  return (db.prepare(`SELECT tt.name FROM title_tag_map m JOIN title_tags tt ON tt.id = m.tag_id WHERE m.variant_id = ?`).all(variantId) as any[]).map(r => r.name);
}

/** Build (and store) the learning note for one completed test. Returns it, or null. */
export function generateTestLearning(testId: number): string | null {
  const db = getDb();
  const test: any = db.prepare(`SELECT id, test_type, video_title FROM tests WHERE id = ? AND status = 'completed'`).get(testId);
  if (!test) return null;
  const variants = db.prepare(`
    SELECT tv.id, tv.label, tv.title,
      COALESCE(SUM(tm.impressions), 0) AS imp,
      CASE WHEN SUM(tm.impressions) > 0 THEN SUM(tm.impressions * tm.ctr) / SUM(tm.impressions) ELSE 0 END AS ctr
    FROM test_variants tv
    LEFT JOIN test_measurements tm ON tm.variant_id = tv.id AND ${NOT_BASELINE}
    WHERE tv.test_id = ? AND tv.active = 1
    GROUP BY tv.id HAVING imp > 0
    ORDER BY ctr DESC`).all(testId) as any[];
  if (variants.length < 2) return null;

  const win = variants[0], lose = variants[variants.length - 1];
  const lift = lose.ctr > 0 ? ((win.ctr - lose.ctr) / lose.ctr) * 100 : 0;
  const minImp = Math.min(...variants.map(v => v.imp));
  // Rough confidence: enough impressions on the smaller variant AND a real gap.
  const tier = minImp >= 3000 && lift >= 6 ? 'confident' : lift >= 3 ? 'leaning' : 'coin flip';
  const winTags = variantTags(win.id, test.test_type);
  const loseTags = variantTags(lose.id, test.test_type);
  const winOnly = winTags.filter(t => !loseTags.includes(t));
  const what = test.test_type === 'thumbnail' ? 'thumbnail' : 'title';

  const note = `${win.label} beat ${lose.label} (${win.ctr.toFixed(1)}% vs ${lose.ctr.toFixed(1)}% CTR, +${lift.toFixed(0)}%, ${tier}).`
    + (winOnly.length ? ` Winning ${what} used: ${winOnly.slice(0, 6).join(', ')}.` : '')
    + (test.test_type === 'title' && win.title ? ` Won: "${win.title}".` : '');

  db.prepare(`UPDATE tests SET learning_note = ? WHERE id = ?`).run(note, testId);
  return note;
}

/** Backfill notes for every completed test that doesn't have one yet. */
export function backfillTestLearnings(): number {
  ensureLearningSchema();
  const db = getDb();
  const ids = db.prepare(`SELECT id FROM tests WHERE status = 'completed' AND winner_variant_id IS NOT NULL AND (learning_note IS NULL OR learning_note = '')`).all() as any[];
  let n = 0;
  for (const { id } of ids) { try { if (generateTestLearning(id)) n++; } catch {} }
  if (n > 0) console.log(`[test-learning] wrote ${n} learning note(s)`);
  return n;
}

/** Recent per-test lessons, newest first — for the Producer to reference. */
export function recentTestLearnings(limit = 25, contentFilter?: 'podcast' | 'TNTL'): string[] {
  ensureLearningSchema();
  const db = getDb();
  const rows = db.prepare(`
    SELECT video_title, test_type, learning_note, COALESCE(completed_at, created_at) AS at
    FROM tests WHERE learning_note IS NOT NULL AND learning_note != ''
    ORDER BY at DESC LIMIT ?`).all(Math.min(50, limit)) as any[];
  return rows.map(r => `${(r.at || '').slice(0, 10)} [${r.test_type}] ${r.video_title || ''}: ${r.learning_note}`);
}
