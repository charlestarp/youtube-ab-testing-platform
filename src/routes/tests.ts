import { FastifyInstance } from 'fastify';
import { createWriteStream, mkdirSync } from 'fs';
import { resolve } from 'path';
import { pipeline } from 'stream/promises';
import { nanoid } from 'nanoid';
import { getDb } from '../db/client.js';
import { authMiddleware } from '../middleware/auth.js';
import { config } from '../config.js';
import { logActivity } from '../services/activity.js';
import type { Test, TestVariant, TestMeasurement } from '../types/index.js';

export async function testRoutes(app: FastifyInstance): Promise<void> {
  // All routes require auth
  app.addHook('preHandler', authMiddleware);

  // GET /tests -- list all tests
  app.get('/tests', async (request) => {
    const { status, type, limit, category } = request.query as { status?: string; type?: string; limit?: string; category?: string };
    const db = getDb();
    let sql = 'SELECT * FROM tests WHERE 1=1';
    const params: any[] = [];

    if (category && category !== 'all') { sql += ' AND category = ?'; params.push(category); } else if (!status && category !== 'all') { sql += " AND category = 'test'"; }
    if (status) { sql += ' AND status = ?'; params.push(status); sql += " AND replace(replace(started_at,'T',' '),'.000Z','') <= datetime('now')"; }
    if (type) { sql += ' AND test_type = ?'; params.push(type); }
    sql += ' ORDER BY COALESCE(created_at, started_at) DESC LIMIT ?';
    params.push(parseInt(limit || '1000'));

    const tests = db.prepare(sql).all(...params) as Test[];

    // Attach variant count and latest measurements
    const variantStmt = db.prepare('SELECT * FROM test_variants WHERE test_id = ? ORDER BY label');
    const measureStmt = db.prepare(`
      SELECT variant_id, MAX(measured_at) as last_measured,
             SUM(impressions) as total_impressions, SUM(views) as total_views
      FROM test_measurements WHERE test_id = ?
      AND (realtime_views_json LIKE '%"type":"rotation_slot"%' OR realtime_views_json LIKE '%"type":"reconstructed_vtr"%')
      AND NOT (ctr > 25)
      AND realtime_views_json NOT LIKE '%"suspect":true%'
      GROUP BY variant_id
    `);

    return tests.map(t => ({
      ...t,
      original_thumbnail_blob: undefined, // don't send blob in list
      variants: variantStmt.all(t.id),
      measurement_summary: measureStmt.all(t.id),
    }));
  });

  // GET /tests/needing-data -- completed tests with ANY zero measurement slots (for extension backfill)
  app.get('/tests/needing-data', async () => {
    const db = getDb();
    // Find tests completed in last 7 days that have at least one slot with 0 impressions
    const tests = db.prepare(`
      SELECT DISTINCT t.id, t.video_id, t.video_title, t.completed_at
      FROM tests t
      JOIN test_measurements tm ON tm.test_id = t.id
      WHERE t.status = 'completed'
        AND t.completed_at > datetime('now', '-7 days')
        AND tm.impressions = 0
        AND json_extract(tm.realtime_views_json, '$.type') = 'rotation_slot'
      ORDER BY t.completed_at DESC
      LIMIT 10
    `).all() as any[];
    return tests;
  });

  // POST /tests -- create a new test
  app.post('/tests', async (request) => {
    const body = request.body as any;
    const { video_id } = body;

    if (!video_id) return { detail: 'video_id required' };

    const db = getDb();
    const result = db.prepare(`
      INSERT INTO tests (video_id, video_title, video_thumbnail_url, test_type,
        duration_hours_per_variant, min_impressions, test_format, test_speed,
        run_days, run_duration_days, auto_winner, auto_placeholder,
        include_original, delay_after_publish_days, scheduled_start,
        metric_target, metric_target_value, channel, category)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      video_id,
      body.video_title || null,
      body.video_thumbnail_url || null,
      body.test_type || 'thumbnail',
      body.duration_hours_per_variant || 24,
      body.min_impressions || 500,
      body.test_format || 'classic',
      body.test_speed || 'hourly',
      body.run_days || 'mon,tue,wed,thu,fri,sat,sun',
      body.run_duration_days || 8,
      body.auto_winner || 'disabled',
      body.auto_placeholder || 'disabled',
      body.include_original ? 1 : 0,
      body.delay_after_publish_days || 0,
      body.scheduled_start || null,
      body.metric_target || 'time',
      body.metric_target_value || 0,
      body.channel || 'main',
      body.category || 'test',
    );

    logActivity(request.user?.id, 'test_created', `${body.test_type || 'thumbnail'} test: ${body.video_title || video_id}`);
    return { id: Number(result.lastInsertRowid) };
  });

  // GET /tests/:id -- test detail with variants and measurements
  app.get('/tests/:id', async (request) => {
    const { id } = request.params as { id: string };
    const db = getDb();

    const test = db.prepare('SELECT * FROM tests WHERE id = ?').get(parseInt(id)) as Test | undefined;
    if (!test) return { detail: 'Test not found' };

    const variants = db.prepare('SELECT * FROM test_variants WHERE test_id = ? ORDER BY label').all(test.id) as TestVariant[];
    const measurements = db.prepare(`
      SELECT * FROM test_measurements WHERE test_id = ?
      AND (realtime_views_json LIKE '%"type":"rotation_slot"%' OR realtime_views_json LIKE '%"type":"reconstructed_vtr"%')
      AND NOT (ctr > 25)
      AND realtime_views_json NOT LIKE '%"suspect":true%'
      ORDER BY measured_at
    `).all(test.id) as TestMeasurement[];

    // Attach tags to each variant
    const variantIds = variants.map(v => v.id);
    const tagRows = variantIds.length > 0
      ? db.prepare(`
          SELECT vt.variant_id, t.id, t.name, t.color, vt.source
          FROM variant_tags vt JOIN thumbnail_tags t ON t.id = vt.tag_id
          WHERE vt.variant_id IN (${variantIds.map(() => '?').join(',')})
        `).all(...variantIds) as any[]
      : [];
    const tagsByVariant: Record<number, any[]> = {};
    for (const row of tagRows) {
      if (!tagsByVariant[row.variant_id]) tagsByVariant[row.variant_id] = [];
      tagsByVariant[row.variant_id].push({ id: row.id, name: row.name, color: row.color, source: row.source });
    }
    const variantsWithTags = variants.map(v => ({ ...v, tags: tagsByVariant[v.id] || [] }));

    return {
      ...test,
      original_thumbnail_blob: undefined,
      variants: variantsWithTags,
      measurements,
    };
  });

  // POST /tests/:id/variants -- add a variant (multipart for thumbnail, JSON for title)
  app.post('/tests/:id/variants', async (request) => {
    const { id } = request.params as { id: string };
    const testId = parseInt(id);
    const db = getDb();

    const test = db.prepare('SELECT * FROM tests WHERE id = ?').get(testId) as Test | undefined;
    if (!test) return { detail: 'Test not found' };

    const variantCount = (db.prepare('SELECT COUNT(*) as c FROM test_variants WHERE test_id = ?').get(testId) as any).c;
    const label = String.fromCharCode(65 + variantCount); // A, B, C, D...

    // Check content type
    const contentType = request.headers['content-type'] || '';

    if (contentType.includes('multipart')) {
      // Thumbnail upload
      const data = await request.file();
      if (!data) return { detail: 'No file uploaded' };

      mkdirSync(config.uploadsDir, { recursive: true });
      const filename = `${testId}_${label}_${nanoid(8)}.jpg`;
      const filepath = resolve(config.uploadsDir, filename);
      await pipeline(data.file, createWriteStream(filepath));

      // Also get title from fields if present
      const title = (data.fields as any)?.title?.value || null;

      const result = db.prepare(`
        INSERT INTO test_variants (test_id, label, thumbnail_path, title, is_control)
        VALUES (?, ?, ?, ?, ?)
      `).run(testId, label, filepath, title, variantCount === 0 ? 1 : 0);
      const newId = Number(result.lastInsertRowid);

      // Tag the thumbnail immediately (fire-and-forget) so tags are ready right
      // away. The 6h maintenance job is now just a backstop for anything missed.
      import('../services/auto-tagger.js')
        .then(m => m.autoTagVariant(newId))
        .catch(e => console.error(`[tag-on-upload] variant ${newId} failed:`, e?.message));

      return { id: newId, label, thumbnail_path: filepath };
    } else {
      // Title-only variant
      const { title } = request.body as { title: string };
      if (!title) return { detail: 'title required for title variant' };

      const result = db.prepare(`
        INSERT INTO test_variants (test_id, label, title, is_control)
        VALUES (?, ?, ?, ?)
      `).run(testId, label, title, variantCount === 0 ? 1 : 0);

      // Tag the new title immediately (fire-and-forget); untagged-only so it just
      // picks up this variant. The 6h job remains a backstop.
      import('../services/title-tagger.js')
        .then(m => m.tagAllVariants({ semantic: true, onlyUntagged: true }))
        .catch(() => {});

      return { id: Number(result.lastInsertRowid), label };
    }
  });

  // POST /tests/:id/start -- start the test
  app.post('/tests/:id/start', async (request) => {
    const { id } = request.params as { id: string };
    const testId = parseInt(id);
    const db = getDb();

    const test = db.prepare('SELECT * FROM tests WHERE id = ?').get(testId) as Test | undefined;
    if (!test) return { detail: 'Test not found' };
    if (test.status !== 'pending' && test.status !== 'paused') {
      return { detail: `Cannot start test in ${test.status} status` };
    }

    const variants = db.prepare('SELECT * FROM test_variants WHERE test_id = ?').all(testId) as TestVariant[];
    if (variants.length < 2) return { detail: 'Need at least 2 variants to start a test' };

    // Save original thumbnail before starting (for rollback later)
    try {
      const { downloadThumbnail, getVideoDetails } = await import('../services/youtube-api.js');
      const details = await getVideoDetails(test.video_id);
      const thumbUrl = details?.snippet?.thumbnails?.maxres?.url || details?.snippet?.thumbnails?.high?.url;
      if (thumbUrl) {
        const blob = await downloadThumbnail(test.video_id, thumbUrl);
        db.prepare('UPDATE tests SET original_thumbnail_blob = ?, original_title = ? WHERE id = ?')
          .run(blob, details?.snippet?.title || null, testId);
      }
    } catch (err: any) {
      console.log(`[tests] Could not save original thumbnail: ${err.message}`);
    }

    // Determine start time:
    // 1. If the video is scheduled (private with publishAt), start when it goes live
    // 2. Otherwise, start at the next hour
    let startTime: string;

    try {
      const { getAccessToken } = await import('../services/youtube-auth.js');
      const accessToken = await getAccessToken();
      const auth = new (await import('googleapis')).google.auth.OAuth2();
      auth.setCredentials({ access_token: accessToken });
      const yt = (await import('googleapis')).google.youtube({ version: 'v3', auth });

      const videoRes = await yt.videos.list({ part: ['status'], id: [test.video_id] });
      const videoStatus = videoRes.data.items?.[0]?.status;
      const publishAt = videoStatus?.publishAt;

      if (publishAt && videoStatus?.privacyStatus === 'private') {
        // Video is scheduled — start the moment it goes live
        startTime = new Date(publishAt).toISOString();
        console.log(`[tests] Video scheduled for ${publishAt}, test starts at go-live: ${startTime}`);
      } else {
        // Video is already live — start at next hour
        const now = new Date();
        const nextHour = new Date(now);
        nextHour.setMinutes(0, 0, 0);
        nextHour.setHours(nextHour.getHours() + 1);
        startTime = nextHour.toISOString();
      }
    } catch {
      // Fallback: next hour
      const now = new Date();
      const nextHour = new Date(now);
      nextHour.setMinutes(0, 0, 0);
      nextHour.setHours(nextHour.getHours() + 1);
      startTime = nextHour.toISOString();
    }

    // Don't upload thumbnail yet — the test runner will do it when startTime arrives
    db.prepare("UPDATE tests SET status = 'running', started_at = ? WHERE id = ?").run(startTime, testId);
    logActivity(request.user?.id, 'test_started', `${test.test_type} test: ${test.video_title || test.video_id}`);

    return { ok: true, active_variant: variants[0].label, starts_at: startTime };
  });

  // POST /tests/:id/start-now -- force a running test to start immediately instead of waiting
  app.post('/tests/:id/start-now', async (request) => {
    const { id } = request.params as { id: string };
    const db = getDb();
    const test = db.prepare('SELECT * FROM tests WHERE id = ?').get(parseInt(id)) as Test | undefined;
    if (!test) return { detail: 'Test not found' };
    if (test.status !== 'running') return { detail: 'Test is not running' };
    // Only update started_at if the test hasn't actually started yet (no measurements exist)
    const hasMeasurements = (db.prepare('SELECT COUNT(*) as c FROM test_measurements WHERE test_id = ?').get(parseInt(id)) as any)?.c > 0;
    if (!hasMeasurements) {
      db.prepare("UPDATE tests SET started_at = ? WHERE id = ?").run(new Date().toISOString(), parseInt(id));
    }
    // Trigger the test cycle immediately so the thumbnail is uploaded now
    try {
      const { runTestCycle } = await import('../services/test-runner.js');
      await runTestCycle();
    } catch (err: any) {
      console.error(`[start-now] Test cycle failed: ${err.message}`);
    }
    return { ok: true };
  });

  // POST /tests/:id/pause -- pause test, restore original
  app.post('/tests/:id/pause', async (request) => {
    const { id } = request.params as { id: string };
    const db = getDb();

    // TODO: Restore original thumbnail/title via YouTube API

    const testId = parseInt(id);
    db.prepare("UPDATE tests SET status = 'paused' WHERE id = ? AND status = 'running'").run(testId);
    db.prepare("UPDATE test_variants SET active_since = NULL WHERE test_id = ?").run(testId);
    return { ok: true };
  });

  // DELETE /tests/:id/variants/:vid -- SOFT-remove a variant (keep the row, grey it
  // out in the UI, exclude it from rotation + winner scoring). Reversible.
  app.delete('/tests/:id/variants/:vid', async (request) => {
    const { id, vid } = request.params as { id: string; vid: string };
    const db = getDb();
    const activeCount = (db.prepare('SELECT COUNT(*) as c FROM test_variants WHERE test_id = ? AND active = 1').get(parseInt(id)) as any).c;
    if (activeCount <= 2) return { detail: 'Cannot remove — need at least 2 active variants' };
    db.prepare('UPDATE test_variants SET active = 0, active_since = NULL WHERE id = ? AND test_id = ?').run(parseInt(vid), parseInt(id));
    return { ok: true };
  });

  // POST /tests/:id/variants/:vid/restore -- bring a soft-removed variant back
  app.post('/tests/:id/variants/:vid/restore', async (request) => {
    const { id, vid } = request.params as { id: string; vid: string };
    const db = getDb();
    db.prepare('UPDATE test_variants SET active = 1 WHERE id = ? AND test_id = ?').run(parseInt(vid), parseInt(id));
    return { ok: true };
  });

  // POST /tests/:id/set-winner -- declare a winner and end the test
  app.post('/tests/:id/set-winner', async (request) => {
    const { id } = request.params as { id: string };
    const { variant_id } = request.body as { variant_id: number };
    const testId = parseInt(id);
    const db = getDb();

    const test = db.prepare('SELECT * FROM tests WHERE id = ?').get(testId) as any;
    if (!test) return { detail: 'Test not found' };

    // Apply the winning thumbnail to YouTube
    const winner = db.prepare('SELECT * FROM test_variants WHERE id = ?').get(variant_id) as any;
    if (winner && winner.thumbnail_path) {
      try {
        const { uploadThumbnail } = await import('../services/youtube-api.js');
        await uploadThumbnail(test.video_id, winner.thumbnail_path, test.channel || 'main');
      } catch (err: any) {
        console.error(`[tests] Failed to apply winner thumbnail: ${err.message}`);
      }
    }
    if (winner && winner.title) {
      try {
        const { updateVideoTitle } = await import('../services/youtube-api.js');
        await updateVideoTitle(test.video_id, winner.title);
      } catch (err: any) {
        console.error(`[tests] Failed to apply winner title: ${err.message}`);
      }
    }

    // winner_manual: a human made this call — the settled re-eval must not override it.
    db.prepare("UPDATE tests SET status = 'completed', completed_at = datetime('now'), winner_variant_id = ?, winner_manual = 1, winner_applied = 1 WHERE id = ?").run(variant_id, testId);
    logActivity(request.user?.id, 'test_completed', `${test.video_title || test.video_id} — winner ${winner?.label || '?'} (manual)`);

    // Resolve any open preflight predictions for this test
    try {
      const { resolveTestPredictions } = await import('../services/title-calibration.js');
      resolveTestPredictions(testId, variant_id);
    } catch {}

    // Send email notification
    try {
      const { sendTestCompleteEmail } = await import('../services/email.js');
      await sendTestCompleteEmail(test.video_title || test.video_id, winner?.label || '?', testId);
    } catch {}

    return { ok: true, winner: winner?.label };
  });

  // POST /tests/:id/complete -- force complete
  app.post('/tests/:id/complete', async (request) => {
    const { id } = request.params as { id: string };
    const db = getDb();

    const testId = parseInt(id);
    db.prepare("UPDATE tests SET status = 'completed', completed_at = datetime('now') WHERE id = ?").run(testId);
    db.prepare("UPDATE test_variants SET active_since = NULL WHERE test_id = ?").run(testId);
    return { ok: true };
  });

  // POST /tests/run-cycle -- manually trigger test runner cycle
  app.post('/tests/run-cycle', async () => {
    try {
      console.log('[tests/run-cycle] Importing test-runner...');
      const mod = await import('../services/test-runner.js');
      console.log('[tests/run-cycle] Module keys:', Object.keys(mod));
      if (mod.runTestCycle) {
        console.log('[tests/run-cycle] Calling runTestCycle...');
        await mod.runTestCycle();
        console.log('[tests/run-cycle] Done');
      } else {
        console.error('[tests/run-cycle] runTestCycle not found in module!');
      }
      return { ok: true };
    } catch (err: any) {
      console.error('[tests/run-cycle] Error:', err.message, err.stack);
      return { ok: false, error: err.message };
    }
  });

  // PATCH /tests/:id — edit pending test
  app.patch('/tests/:id', async (request) => {
    const { id } = request.params as { id: string };
    const body = request.body as any;
    const db = getDb();
    const test = db.prepare('SELECT * FROM tests WHERE id = ?').get(parseInt(id)) as any;
    if (!test) return { detail: 'Test not found' };
    if (test.status !== 'pending' && test.status !== 'scheduled') return { detail: 'Can only edit pending/scheduled tests' };
    if (body.scheduled_start) {
      db.prepare('UPDATE tests SET scheduled_start = ?, started_at = ? WHERE id = ?')
        .run(body.scheduled_start, body.started_at || body.scheduled_start, parseInt(id));
    }
    return { ok: true };
  });

  // POST /tests/:id/category -- move a test between the Tests and Retests sections.
  // Works for any test (including completed ones you want to queue for a redo).
  app.post('/tests/:id/category', async (request) => {
    const { id } = request.params as { id: string };
    const { category } = request.body as { category?: string };
    if (category !== 'test' && category !== 'retest') return { detail: 'category must be "test" or "retest"' };
    const db = getDb();
    const test = db.prepare('SELECT id FROM tests WHERE id = ?').get(parseInt(id)) as any;
    if (!test) return { detail: 'Test not found' };
    db.prepare('UPDATE tests SET category = ? WHERE id = ?').run(category, parseInt(id));
    return { ok: true, category };
  });

  // GET /title-suggestions — proactive title suggestions for recently published
  // videos (from the autonomous sweep), newest first, for the dashboard panel.
  app.get('/title-suggestions', async () => {
    const db = getDb();
    try {
      return db.prepare(`
        SELECT s.video_id, s.current_title, s.suggested_title, s.reasoning, s.thumbnail_concept, s.created_at,
               v.view_count, v.publish_date, v.thumbnail_url
        FROM video_title_suggestions s LEFT JOIN yt.videos v ON v.video_id = s.video_id
        ORDER BY s.created_at DESC LIMIT 20`).all();
    } catch { return []; }
  });

  // GET /revive/candidates — videos worth re-testing to win back views (high
  // impressions, low CTR, good retention), highest potential first.
  app.get('/revive/candidates', async () => {
    const db = getDb();
    try {
      return db.prepare(`
        SELECT r.video_id, r.title, r.impressions, r.ctr, r.avg_pct_watched, r.revive_score, r.reason,
               v.thumbnail_url, v.publish_date,
               EXISTS (SELECT 1 FROM tests t JOIN test_variants tv ON tv.test_id = t.id
                 WHERE t.video_id = r.video_id AND t.test_type IN ('thumbnail','both') AND t.status = 'completed'
                   AND tv.thumbnail_path IS NOT NULL AND tv.thumbnail_path != '') AS has_prior_thumb
        FROM revive_candidates r LEFT JOIN yt.videos v ON v.video_id = r.video_id
        WHERE r.revive_score > 0 ORDER BY r.revive_score DESC LIMIT 12`).all();
    } catch { return []; }
  });

  // POST /revive/score — rescore revival candidates now (runs in-process so the
  // Studio session auth is available).
  app.post('/revive/score', async () => {
    const { scoreReviveCandidates } = await import('../services/revive-scorer.js');
    const c = await scoreReviveCandidates(25);
    return { ok: true, scored: c.length, top: c.slice(0, 5) };
  });

  // POST /prerelease/brief — pitch any newly-ready pre-release episodes now.
  app.post("/prerelease/brief", async () => {
    const { runPrereleaseBriefing } = await import("../services/prerelease-briefing.js");
    const n = await runPrereleaseBriefing();
    return { ok: true, pitched: n };
  });

  // POST /prerelease/baseline — mark all current pre-release episodes as seen so only new ones get pitched.
  app.post("/prerelease/baseline", async () => {
    const { baselinePrereleaseBacklog } = await import("../services/prerelease-briefing.js");
    const n = await baselinePrereleaseBacklog();
    return { ok: true, baselined: n };
  });

  // POST /prerelease/queue — queue selected episodes (from TARPGPT) + pitch the ready ones now.
  app.post("/prerelease/queue", async (request) => {
    const { episode_ids } = (request.body || {}) as { episode_ids?: number[] };
    const { queueEpisodes, runPrereleaseBriefing } = await import("../services/prerelease-briefing.js");
    if (Array.isArray(episode_ids)) queueEpisodes(episode_ids.map(Number).filter(Boolean));
    const r = await runPrereleaseBriefing();
    return { ok: true, pitched: r.pitched, conversation_id: r.conversationId };
  });

  // POST /videos/:id/retest-thumbnail — re-run the thumbnails we already made for
  // this video (it's resurfacing). ?chainTitle=true also queues a title test to
  // auto-start once the thumbnail test finishes.
  app.post('/videos/:id/retest-thumbnail', async (request) => {
    const { id: videoId } = request.params as { id: string };
    const { chainTitle, thumbnails, chainChallenger } = (request.body || {}) as { chainTitle?: boolean; thumbnails?: string[]; chainChallenger?: string };
    const { retestThumbnailFromPrior } = await import('../services/retest-chain.js');
    return retestThumbnailFromPrior(videoId, !!chainTitle, request.user!.id, thumbnails, chainChallenger);
  });

  // GET /videos/:id/prior-thumbnails — the thumbnails from this video's most recent
  // thumbnail test, for the review modal to show and let you drop one.
  app.get('/videos/:id/prior-thumbnails', async (request) => {
    const { id: videoId } = request.params as { id: string };
    const db = getDb();
    const prior: any = db.prepare(`
      SELECT t.id FROM tests t WHERE t.video_id = ? AND t.test_type IN ('thumbnail','both') AND t.status = 'completed'
        AND EXISTS (SELECT 1 FROM test_variants tv WHERE tv.test_id = t.id AND tv.thumbnail_path IS NOT NULL AND tv.thumbnail_path != '')
      ORDER BY t.id DESC LIMIT 1`).get(videoId);
    if (!prior) return { thumbnails: [] };
    const rows = db.prepare(`
      SELECT label, thumbnail_path, is_control FROM test_variants
      WHERE test_id = ? AND thumbnail_path IS NOT NULL AND thumbnail_path != '' AND active = 1
      ORDER BY (is_control = 1) DESC, label`).all(prior.id) as any[];
    return { thumbnails: rows.map(r => ({ label: r.label, path: r.thumbnail_path, file: r.thumbnail_path.split('/').pop(), is_control: r.is_control })) };
  });

  // POST /videos/:id/suggest-title — generate/refresh a suggestion on demand.
  app.post('/videos/:id/suggest-title', async (request) => {
    const { id } = request.params as { id: string };
    const { suggestTitleForVideo } = await import('../services/title-suggester.js');
    const s = await suggestTitleForVideo(id);
    return s || { suggested_title: null, detail: 'Current title is already strong — no change suggested.' };
  });

  // POST /videos/:id/test-suggested-title — one click: create AND start a title
  // A/B test of the current title (control) vs the suggested one, then rotate.
  app.post('/videos/:id/test-suggested-title', async (request) => {
    const { id: videoId } = request.params as { id: string };
    const body = (request.body || {}) as { titles?: string[] };
    const db = getDb();
    const sug: any = db.prepare('SELECT current_title, suggested_title FROM video_title_suggestions WHERE video_id = ?').get(videoId);
    if (!sug) return { detail: 'No suggestion for this video.' };
    let video: any = null;
    try { video = db.prepare('SELECT title FROM yt.videos WHERE video_id = ?').get(videoId); } catch {}
    const videoTitle = video?.title || sug.current_title;
    // Use the edited titles from the review modal when provided (control first),
    // otherwise the stored current-vs-suggested pair.
    const edited = (body.titles || []).map(t => (t || '').trim()).filter(Boolean);
    const titles = edited.length >= 2 ? edited : [sug.current_title, sug.suggested_title];
    // Same shape as an AI-chat title test: classic, ctr auto-winner.
    const testRes = db.prepare(`
      INSERT INTO tests (video_id, video_title, test_type, test_format, duration_hours_per_variant, min_impressions, test_speed, run_days, run_duration_days, auto_winner, auto_placeholder, channel, category)
      VALUES (?, ?, 'title', 'classic', 4, 500, 'hourly', 'mon,tue,wed,thu,fri,sat,sun', 8, 'ctr', 'disabled', 'main', 'test')
    `).run(videoId, videoTitle);
    const testId = Number(testRes.lastInsertRowid);
    // Control = the first title (A), challengers = the rest.
    titles.forEach((title, i) =>
      db.prepare(`INSERT INTO test_variants (test_id, label, title, is_control) VALUES (?, ?, ?, ?)`).run(testId, String.fromCharCode(65 + i), title, i === 0 ? 1 : 0));
    let started = false;
    try {
      try {
        const { getVideoDetails, downloadThumbnail } = await import('../services/youtube-api.js');
        const details = await getVideoDetails(videoId);
        const thumbUrl = details?.snippet?.thumbnails?.maxres?.url || details?.snippet?.thumbnails?.high?.url;
        const blob = thumbUrl ? await downloadThumbnail(videoId, thumbUrl) : null;
        db.prepare('UPDATE tests SET original_thumbnail_blob = ?, original_title = ? WHERE id = ?').run(blob, details?.snippet?.title || sug.current_title || null, testId);
      } catch (e: any) { console.log('[suggested-test] could not capture original:', e?.message); }
      const now = new Date(); now.setMinutes(0, 0, 0); now.setHours(now.getHours() + 1);
      db.prepare(`UPDATE tests SET status = 'running', started_at = ? WHERE id = ?`).run(now.toISOString(), testId);
      started = true;
    } catch (e: any) { console.error('[suggested-test] start failed:', e?.message); }
    import('../services/title-tagger.js').then(m => m.tagAllVariants({ semantic: true, onlyUntagged: true })).catch(() => {});
    try { (await import('../services/activity.js')).logActivity(request.user!.id, started ? 'test_started' : 'test_created', `title test from suggestion: ${videoTitle}`); } catch {}
    // Consume the suggestion so it drops off the dashboard.
    try { db.prepare('DELETE FROM video_title_suggestions WHERE video_id = ?').run(videoId); } catch {}
    return { ok: true, test_id: testId, started };
  });

  // DELETE /tests/:id
  app.delete('/tests/:id', async (request) => {
    const { id } = request.params as { id: string };
    const db = getDb();
    db.prepare('DELETE FROM test_measurements WHERE test_id = ?').run(parseInt(id));
    db.prepare('DELETE FROM test_variants WHERE test_id = ?').run(parseInt(id));
    db.prepare('DELETE FROM tests WHERE id = ?').run(parseInt(id));
    return { ok: true };
  });
}
