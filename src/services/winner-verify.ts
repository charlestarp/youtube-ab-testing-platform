/**
 * Verifies that each completed test's declared winner is ACTUALLY live on
 * YouTube, then heals mismatches. winner_applied=1 only proves an upload call
 * once returned success; YouTube can still be serving something else (failed
 * processing, a later manual change, cache-era confusion). Ground truth:
 *  - title: the public oEmbed endpoint (no auth, no quota)
 *  - thumbnail: pixel comparison (sharp, 32x18 MSE) of the live maxres jpg
 *    against every variant file — the winner must be the closest match.
 * Mismatches set winner_applied=0 so test-runner's retry pass re-pushes.
 * Runs inside the nightly deep audit; callable on demand.
 */

import { getDb } from '../db/client.js';

export interface WinnerVerifyRow {
  test_id: number;
  video_id: string;
  title: string;
  check: 'title' | 'thumbnail';
  status: 'ok' | 'mismatch' | 'skip';
  note: string;
}

async function liveTitle(videoId: string): Promise<string | null> {
  try {
    const res = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`);
    if (!res.ok) return null;
    return ((await res.json()) as any).title ?? null;
  } catch { return null; }
}

// MSE between two images downscaled to 32x18. Live thumbs are re-encoded by
// YouTube, so identical content lands well under 100; different thumbs land
// in the thousands (measured: same=4, different variants 178 to 7300).
async function thumbMse(liveBuf: Buffer, filePath: string, sharp: any): Promise<number> {
  const a = await sharp(liveBuf).resize(32, 18, { fit: 'fill' }).raw().toBuffer();
  const b = await sharp(filePath).resize(32, 18, { fit: 'fill' }).raw().toBuffer();
  let mse = 0;
  for (let i = 0; i < a.length; i++) mse += (a[i] - b[i]) ** 2;
  return Math.round(mse / a.length);
}

export async function verifyWinnersLive(applyFixes = true): Promise<WinnerVerifyRow[]> {
  const db = getDb();
  const rows: WinnerVerifyRow[] = [];

  // Latest completed test per video (an older test's winner is legitimately
  // superseded), skipping videos that currently have a running test (rotation
  // changes the live thumbnail/title BY DESIGN).
  const tests = db.prepare(`
    SELECT t.* FROM tests t
    WHERE t.status = 'completed' AND t.winner_variant_id IS NOT NULL
      AND t.auto_winner != 'disabled' AND t.winner_applied = 1
      AND t.completed_at > datetime('now','-14 days')
      AND t.id = (SELECT MAX(id) FROM tests WHERE video_id = t.video_id AND status = 'completed')
      AND NOT EXISTS (SELECT 1 FROM tests r WHERE r.video_id = t.video_id AND r.status = 'running')
  `).all() as any[];

  let sharp: any = null;
  try { sharp = (await import('sharp')).default; } catch { /* thumbnail checks skip */ }

  for (const test of tests) {
    const title = (test.video_title || test.video_id).slice(0, 60);
    const winner = db.prepare('SELECT * FROM test_variants WHERE id = ?').get(test.winner_variant_id) as any;
    if (!winner) continue;
    let mismatched = false;

    if ((test.test_type === 'title' || test.test_type === 'both') && winner.title) {
      const live = await liveTitle(test.video_id);
      if (live === null) {
        rows.push({ test_id: test.id, video_id: test.video_id, title, check: 'title', status: 'skip', note: 'oEmbed unavailable' });
      } else if (live.trim() === winner.title.trim()) {
        rows.push({ test_id: test.id, video_id: test.video_id, title, check: 'title', status: 'ok', note: `live title matches winner ${winner.label}` });
      } else {
        mismatched = true;
        rows.push({ test_id: test.id, video_id: test.video_id, title, check: 'title', status: 'mismatch', note: `live "${live.slice(0, 50)}" != winner ${winner.label} "${winner.title.slice(0, 50)}"` });
      }
    }

    if ((test.test_type === 'thumbnail' || test.test_type === 'both') && winner.thumbnail_path) {
      if (!sharp) {
        rows.push({ test_id: test.id, video_id: test.video_id, title, check: 'thumbnail', status: 'skip', note: 'sharp unavailable' });
      } else {
        try {
          const res = await fetch(`https://i.ytimg.com/vi/${test.video_id}/maxresdefault.jpg?cb=${Date.now()}`);
          if (!res.ok) throw new Error(`live thumb HTTP ${res.status}`);
          const liveBuf = Buffer.from(await res.arrayBuffer());
          const variants = db.prepare('SELECT label, thumbnail_path FROM test_variants WHERE test_id = ? AND thumbnail_path IS NOT NULL').all(test.id) as any[];
          const scores: { label: string; mse: number }[] = [];
          for (const v of variants) {
            try { scores.push({ label: v.label, mse: await thumbMse(liveBuf, v.thumbnail_path, sharp) }); } catch { /* file missing */ }
          }
          const winnerScore = scores.find(s => s.label === winner.label);
          const best = scores.slice().sort((a, b) => a.mse - b.mse)[0];
          if (!winnerScore || !best) {
            rows.push({ test_id: test.id, video_id: test.video_id, title, check: 'thumbnail', status: 'skip', note: 'variant files missing' });
          } else if (best.label === winner.label || winnerScore.mse < 100) {
            rows.push({ test_id: test.id, video_id: test.video_id, title, check: 'thumbnail', status: 'ok', note: `live matches winner ${winner.label} (mse ${winnerScore.mse})` });
          } else {
            mismatched = true;
            rows.push({ test_id: test.id, video_id: test.video_id, title, check: 'thumbnail', status: 'mismatch', note: `live looks like ${best.label} (mse ${best.mse}), winner ${winner.label} scores ${winnerScore.mse}` });
          }
        } catch (e: any) {
          rows.push({ test_id: test.id, video_id: test.video_id, title, check: 'thumbnail', status: 'skip', note: `check failed: ${e.message.slice(0, 60)}` });
        }
      }
    }

    if (mismatched && applyFixes) {
      db.prepare('UPDATE tests SET winner_applied = 0 WHERE id = ?').run(test.id);
      console.warn(`[winner-verify] test ${test.id} (${test.video_id}): live YouTube does not match winner ${winner.label} — queued re-apply`);
    }
  }

  // Push any queued re-applies now instead of waiting for the hourly cycle.
  if (applyFixes && rows.some(r => r.status === 'mismatch')) {
    try {
      const { retryPendingWinners } = await import('./test-runner.js');
      await retryPendingWinners(db);
    } catch (e: any) { console.error(`[winner-verify] immediate re-apply failed (hourly retry will catch it): ${e.message}`); }
  }
  return rows;
}
