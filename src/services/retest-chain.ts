/**
 * Revive re-testing. Re-run a thumbnail test using the thumbnails we already
 * made for a video (since the video is resurfacing), and optionally CHAIN a
 * title test that auto-starts the moment the thumbnail test finishes — so you
 * optimise the thumbnail first, then the title, hands-off.
 */
import { getDb } from '../db/client.js';

export function ensureChainSchema(): void {
  try { getDb().exec(`ALTER TABLE tests ADD COLUMN chain_next TEXT`); } catch {}
  try { getDb().exec(`ALTER TABLE tests ADD COLUMN chain_challenger TEXT`); } catch {}
}

/** Create + start a thumbnail test for `videoId`, reusing the thumbnails from its
 *  most recent completed thumbnail/both test. Optionally flag a title test to
 *  follow. Returns the new test id. */
export async function retestThumbnailFromPrior(videoId: string, chainTitle: boolean, userId: number, thumbnails?: string[], chainChallenger?: string): Promise<{ ok: boolean; test_id?: number; detail?: string; reused?: number; chained?: boolean }> {
  ensureChainSchema();
  const db = getDb();
  const prior: any = db.prepare(`
    SELECT t.id, t.video_title FROM tests t
    WHERE t.video_id = ? AND t.test_type IN ('thumbnail', 'both') AND t.status = 'completed'
      AND EXISTS (SELECT 1 FROM test_variants tv WHERE tv.test_id = t.id AND tv.thumbnail_path IS NOT NULL AND tv.thumbnail_path != '')
    ORDER BY t.id DESC LIMIT 1`).get(videoId);
  if (!prior) return { ok: false, detail: 'No prior thumbnail test to reuse for this video.' };
  let priorVariants = db.prepare(`
    SELECT label, thumbnail_path, title, is_control FROM test_variants
    WHERE test_id = ? AND thumbnail_path IS NOT NULL AND thumbnail_path != '' AND active = 1
    ORDER BY (is_control = 1) DESC, label`).all(prior.id) as any[];
  // If the review modal passed a chosen subset of thumbnails, keep only those.
  if (thumbnails && thumbnails.length) {
    const keep = new Set(thumbnails);
    const filtered = priorVariants.filter(v => keep.has(v.thumbnail_path));
    if (filtered.length >= 2) priorVariants = filtered;
  }
  if (priorVariants.length < 2) return { ok: false, detail: 'Need at least 2 thumbnails to test.' };

  let video: any = null;
  try { video = db.prepare('SELECT title FROM yt.videos WHERE video_id = ?').get(videoId); } catch {}
  const videoTitle = video?.title || prior.video_title;

  // Hourly per spec (4 rotations per variant, CTR winner). Old videos only have
  // daily buckets upstream, but reach-refresh's live-delta slots + daily-exact
  // rebalance make hourly attribution real for them too.
  const testRes = db.prepare(`
    INSERT INTO tests (video_id, video_title, test_type, test_format, duration_hours_per_variant, min_impressions, test_speed, run_days, run_duration_days, auto_winner, auto_placeholder, channel, category, chain_next)
    VALUES (?, ?, 'thumbnail', 'classic', 4, 500, 'hourly', 'mon,tue,wed,thu,fri,sat,sun', 8, 'ctr', 'best', 'main', 'retest', ?)
  `).run(videoId, videoTitle, chainTitle ? 'title' : null);
  const testId = Number(testRes.lastInsertRowid);
  // Remember the exact challenger title the user reviewed, so the chained title
  // test uses that instead of re-generating a fresh (possibly different) one.
  if (chainTitle && chainChallenger?.trim()) db.prepare(`UPDATE tests SET chain_challenger = ? WHERE id = ?`).run(chainChallenger.trim(), testId);
  priorVariants.forEach((v, i) =>
    db.prepare(`INSERT INTO test_variants (test_id, label, thumbnail_path, title, is_control) VALUES (?, ?, ?, ?, ?)`)
      .run(testId, String.fromCharCode(65 + i), v.thumbnail_path, v.title || null, i === 0 ? 1 : 0));

  let started = false;
  try {
    try {
      const { getVideoDetails, downloadThumbnail } = await import('./youtube-api.js');
      const details = await getVideoDetails(videoId);
      const thumbUrl = details?.snippet?.thumbnails?.maxres?.url || details?.snippet?.thumbnails?.high?.url;
      const blob = thumbUrl ? await downloadThumbnail(videoId, thumbUrl) : null;
      db.prepare('UPDATE tests SET original_thumbnail_blob = ?, original_title = ? WHERE id = ?').run(blob, details?.snippet?.title || videoTitle || null, testId);
    } catch (e: any) { console.log('[retest-thumb] could not capture original:', e?.message); }
    const now = new Date(); now.setMinutes(0, 0, 0); now.setHours(now.getHours() + 1);
    db.prepare(`UPDATE tests SET status = 'running', started_at = ? WHERE id = ?`).run(now.toISOString(), testId);
    started = true;
  } catch (e: any) { console.error('[retest-thumb] start failed:', e?.message); }

  try { (await import('./activity.js')).logActivity(userId, started ? 'test_started' : 'test_created', `thumbnail re-test (revive)${chainTitle ? ' + title chain' : ''}: ${videoTitle}`); } catch {}
  return { ok: true, test_id: testId, reused: priorVariants.length, chained: !!chainTitle };
}

/** Spawn the chained title test for any completed thumbnail test flagged
 *  chain_next='title' that hasn't spawned one yet. The title test pits the
 *  current title against a fresh AI suggestion. Returns how many were spawned. */
export async function processTitleChains(): Promise<number> {
  ensureChainSchema();
  const db = getDb();
  const pending = db.prepare(`
    SELECT id, video_id, video_title, chain_challenger FROM tests
    WHERE chain_next = 'title' AND status = 'completed' AND video_id IS NOT NULL`).all() as any[];
  let spawned = 0;
  for (const t of pending) {
    try {
      // Skip if a title test for this video already started after the thumbnail one.
      const existing = db.prepare(`SELECT id FROM tests WHERE video_id = ? AND test_type = 'title' AND id > ?`).get(t.video_id, t.id);
      if (existing) { db.prepare(`UPDATE tests SET chain_next = 'title:done' WHERE id = ?`).run(t.id); continue; }
      const current = (db.prepare('SELECT title FROM yt.videos WHERE video_id = ?').get(t.video_id) as any)?.title || t.video_title;
      // Use the title the user reviewed in the modal; otherwise generate one now.
      let challenger = t.chain_challenger?.trim() || null;
      if (!challenger) {
        const { suggestTitleForVideo } = await import('./title-suggester.js');
        challenger = (await suggestTitleForVideo(t.video_id))?.suggested_title || null;
      }
      if (!challenger || !current) { db.prepare(`UPDATE tests SET chain_next = 'title:skipped' WHERE id = ?`).run(t.id); continue; }
      const res = db.prepare(`
        INSERT INTO tests (video_id, video_title, test_type, test_format, duration_hours_per_variant, min_impressions, test_speed, run_days, run_duration_days, auto_winner, auto_placeholder, channel, category)
        VALUES (?, ?, 'title', 'classic', 4, 500, 'hourly', 'mon,tue,wed,thu,fri,sat,sun', 8, 'ctr', 'best', 'main', 'retest')`).run(t.video_id, current);
      const titleTestId = Number(res.lastInsertRowid);
      [current, challenger].forEach((title, i) => db.prepare(`INSERT INTO test_variants (test_id, label, title, is_control) VALUES (?, ?, ?, ?)`).run(titleTestId, String.fromCharCode(65 + i), title, i === 0 ? 1 : 0));
      const now = new Date(); now.setMinutes(0, 0, 0); now.setHours(now.getHours() + 1);
      db.prepare(`UPDATE tests SET status = 'running', started_at = ? WHERE id = ?`).run(now.toISOString(), titleTestId);
      db.prepare(`UPDATE tests SET chain_next = 'title:done' WHERE id = ?`).run(t.id);
      spawned++;
      console.log(`[retest-chain] spawned title test ${titleTestId} after thumbnail test ${t.id} (${t.video_title})`);
    } catch (e: any) { console.error(`[retest-chain] ${t.id} failed:`, e?.message); }
  }
  return spawned;
}
