import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import multipart from '@fastify/multipart';
import { config } from './config.js';
import { getDb, closeDb } from './db/client.js';
import { authRoutes } from './routes/auth.js';
import { testRoutes } from './routes/tests.js';
import { videoRoutes } from './routes/videos.js';
import { scheduleRoutes } from './routes/schedules.js';
import { competitorRoutes } from './routes/competitors.js';
import { commentRoutes } from './routes/comments.js';
import { chatRoutes } from './routes/chat.js';
import { analyticsRoutes } from './routes/analytics.js';
import { youtubeAuthRoutes } from './routes/youtube-auth.js';
import { getAccessToken, getClipsAccessToken } from './services/youtube-auth.js';
import { adminRoutes } from './routes/admin.js';
import { thumbnailRoutes } from './routes/thumbnails.js';
import { retentionSpikesRoutes } from './routes/retention-spikes.js';
import { retentionRoutes } from './routes/retention.js';
import { scoreRoutes } from './routes/score.js';
import { tagRoutes } from './routes/tags.js';
import { learningsRoutes } from './routes/learnings.js';
import { titleInsightsRoutes } from './routes/title-insights.js';
import { producerRoutes } from './routes/producer.js';
import { feedbackRoutes } from './routes/feedback.js';
import { researchRoutes } from './routes/research.js';
import { mergeHourlyRows, aggregateMergedHours } from './services/hourly-merge.js';
import type { HourlyRow } from './services/hourly-merge.js';
import { refreshAllRunningTests } from './services/reach-refresh.js';
import { startTagMaintenance } from './services/tag-maintenance.js';
import { authMiddleware } from './middleware/auth.js';
import fstatic from '@fastify/static';

const app = Fastify({
  connectionTimeout: 300000, // 5 min
  keepAliveTimeout: 300000,
  logger: {
    level: config.isDev ? 'info' : 'warn',
    transport: config.isDev ? { target: 'pino-pretty' } : undefined,
  },
});

// Plugins
await app.register(cookie, { secret: config.sessionSecret });
await app.register(cors, {
  origin: config.isDev ? true : ['https://app.example.com', 'https://api.example.com'],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Cookie', 'Authorization'],
  maxAge: 86400,
});
await app.register(formbody);
await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024, files: 10 } }); // 50MB per file, up to 10 files

// No-cache headers for API responses + fleet-standard security headers on everything
app.addHook('onSend', async (_request, reply) => {
  reply.header('Cache-Control', 'no-store, no-cache, must-revalidate');
  reply.header('Pragma', 'no-cache');
  reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('X-Frame-Options', 'SAMEORIGIN');
  reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  reply.header('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=()');
  reply.header('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  reply.header('Cross-Origin-Resource-Policy', 'same-site');
  reply.header('Content-Security-Policy', "default-src * data: blob: 'unsafe-inline' 'unsafe-eval'; frame-ancestors 'self'; base-uri 'self'; object-src 'none'");
});

// Page-view beacon: the web app posts here on each navigation so the activity
// log shows where people are, not just what they change.
app.post('/api/activity/view', { preHandler: authMiddleware }, async (request) => {
  try {
    const { path } = request.body as { path?: string };
    const { logActivity } = await import('./services/activity.js');
    if (path && typeof path === 'string') logActivity((request as any).user?.id, 'page_view', path.slice(0, 120));
  } catch {}
  return { ok: true };
});

// Activity log: record every successful mutating action by a signed-in user.
app.addHook('onResponse', async (request, reply) => {
  try {
    const user = (request as any).user;
    if (!user?.id) return;
    const method = request.method;
    if (!['POST', 'PATCH', 'PUT', 'DELETE'].includes(method)) return;
    if (reply.statusCode >= 400) return;
    const url = request.url || '';
    // Skip noisy machine traffic and the page-view beacon (logged separately).
    if (/\/(studio|health|activity\/view|admin\/activity|reach-refresh|run-cycle)/.test(url)) return;
    const { describeAction, logActivity } = await import('./services/activity.js');
    const d = describeAction(method, url);
    if (d) logActivity(user.id, d.action, d.detail);
  } catch { /* logging must never break a response */ }
});

// Serve uploaded thumbnails (original full-size)
await app.register(fstatic, {
  root: config.uploadsDir,
  prefix: '/api/uploads/',
  decorateReply: false,
});

// Serve resized thumbnail previews (cached on disk)
import { existsSync, mkdirSync as mkdirSyncFs, createReadStream } from 'fs';
import { resolve } from 'path';
const thumbCacheDir = resolve(config.uploadsDir, '.cache');
mkdirSyncFs(thumbCacheDir, { recursive: true });

// Lazy sharp loader — sharp crashes the process at startup on Node 25 (code signature).
// Loading it on first use means the crash is isolated to the thumb route, not the whole server.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _sharp: any | null | false = null; // null=not loaded, false=broken (sharp type varies by @types/sharp version)
async function getSharp() {
  if (_sharp === false) return null;
  if (_sharp) return _sharp;
  try {
    const mod = await import('sharp');
    _sharp = mod.default;
    return _sharp;
  } catch {
    _sharp = false;
    console.error('[thumb] sharp failed to load — serving originals unresized');
    return null;
  }
}

app.get('/api/thumb/:filename', async (request, reply) => {
  const { filename } = request.params as { filename: string };
  const { w } = request.query as { w?: string };
  const width = Math.min(parseInt(w || '400'), 800);
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, '');
  const original = resolve(config.uploadsDir, safe);
  if (!existsSync(original)) { reply.code(404).send('Not found'); return; }

  const cacheKey = `${safe}_${width}.jpg`;
  const cached = resolve(thumbCacheDir, cacheKey);

  if (!existsSync(cached)) {
    const sharp = await getSharp();
    if (sharp) {
      try {
        await sharp(original).resize(width, undefined, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80 }).toFile(cached);
      } catch {
        reply.header('Cache-Control', 'public, max-age=3600');
        reply.header('Content-Type', 'image/jpeg');
        return reply.send(createReadStream(original));
      }
    } else {
      // sharp unavailable — serve original unresized
      reply.header('Cache-Control', 'public, max-age=3600');
      reply.header('Content-Type', 'image/jpeg');
      return reply.send(createReadStream(original));
    }
  }

  reply.header('Cache-Control', 'public, max-age=31536000, immutable');
  reply.header('Content-Type', 'image/jpeg');
  return reply.send(createReadStream(cached));
});

// Health check
app.get('/health', async () => {
  const db = getDb();
  const result = db.prepare('SELECT 1 as ok').get() as any;
  return { status: 'ok', db: result.ok === 1 };
});

// Routes
await app.register(authRoutes, { prefix: '/api' });
await app.register(testRoutes, { prefix: '/api' });
await app.register(videoRoutes, { prefix: '/api' });
await app.register(scheduleRoutes, { prefix: '/api' });
await app.register(competitorRoutes, { prefix: '/api' });
await app.register(commentRoutes, { prefix: '/api' });
await app.register(chatRoutes, { prefix: '/api' });
await app.register(analyticsRoutes, { prefix: '/api' });
await app.register(youtubeAuthRoutes, { prefix: '/api' });
await app.register(adminRoutes, { prefix: '/api' });
await app.register(thumbnailRoutes, { prefix: '/api' });
await app.register(retentionSpikesRoutes, { prefix: '/api' });
await app.register(retentionRoutes, { prefix: '/api' });
await app.register(scoreRoutes, { prefix: '/api' });
await app.register(tagRoutes, { prefix: '/api' });
await app.register(learningsRoutes, { prefix: '/api' });
await app.register(titleInsightsRoutes, { prefix: '/api' });
await app.register(producerRoutes, { prefix: '/api' });
await app.register(feedbackRoutes, { prefix: '/api' });
await app.register(researchRoutes, { prefix: '/api' });

// Studio session alert — sends email when session expires
app.post('/api/studio/alert', async (request, reply) => {
  const authHeader = request.headers.authorization;
  const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const token = request.cookies?.session || bearerToken;
  // Accept either a user session or the internal watchdog token
  const isInternal = config.internalToken && token === config.internalToken;
  if (!isInternal) {
    if (!token) { reply.code(401).send({ detail: 'Not authenticated' }); return; }
    const alertDb = getDb();
    const alertSession = alertDb.prepare("SELECT 1 FROM sessions WHERE token = ? AND expires_at > datetime('now')").get(token);
    if (!alertSession) { reply.code(401).send({ detail: 'Invalid session' }); return; }
  }
  const body = request.body as any;
  const alertType = body?.type || 'session_expired';
  try {
    const { sendEmail } = await import('./services/email.js');
    if (alertType === 'stuck_rotation') {
      await sendEmail(
        'team@example.com',
        'YT Testing: Stuck Rotation Detected',
        `<h2>Hourly test rotation is stuck</h2>
         <p>A variant has been live for more than 2.5 hours on an hourly-speed test.</p>
         <p>Detail: <code>${body?.detail || 'unknown'}</code></p>
         <p>The test runner may have crashed or the rotation logic is stuck.</p>
         <p><a href="https://app.example.com/tests">View Tests</a></p>`
      );
    } else {
      await sendEmail(
        'team@example.com',
        'YT Testing: Studio Session Expired',
        `<h2>No recent analytics data</h2>
         <p>No data has been collected in the past 6 hours. Tests are still rotating but data will backfill when you open YouTube Studio.</p>
         <p><b>To collect data:</b> Open <a href="https://studio.youtube.com">YouTube Studio</a> in Chrome. The extension will pull all hourly data automatically.</p>
         <p><a href="https://app.example.com/tests">View Tests</a></p>`
      );
    }
    console.log(`[studio-alert] Email sent (type=${alertType})`);
  } catch (err: any) {
    console.log('[studio-alert] Email failed:', err.message);
  }
  return { ok: true };
});

// Capture endpoint — records the EXACT thumbnail-change request the browser makes,
// so we can replicate it server-side (no browser). Writes to data/thumb-capture.json.
app.post('/api/studio/capture-thumb', async (request, reply) => {
  const authHeader = request.headers.authorization;
  const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const token = request.cookies?.session || bearerToken;
  if (!token) { reply.code(401).send({ detail: 'Not authenticated' }); return; }
  const db = getDb();
  const session = db.prepare("SELECT 1 FROM sessions WHERE token = ? AND expires_at > datetime('now')").get(token);
  if (!session) { reply.code(401).send({ detail: 'Invalid session' }); return; }
  const body = request.body as any;
  const fs = await import('fs');
  const file = resolve(process.cwd(), 'data/thumb-capture.json');
  let arr: any[] = [];
  try { arr = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  arr.push({ ...body, server_received_at: new Date().toISOString() });
  fs.writeFileSync(file, JSON.stringify(arr, null, 2));
  console.log(`[capture-thumb] ${body?.url} method=${body?.method} bodyLen=${(body?.body || '').length} video=${body?.video_id}`);
  return { ok: true };
});

// Extension snapshot endpoint — receives data from Chrome extension
app.post('/api/studio/ext-snapshot', async (request, reply) => {
  const authHeader = request.headers.authorization;
  const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const token = request.cookies?.session || bearerToken;
  if (!token) { reply.code(401).send({ detail: 'Not authenticated' }); return; }
  const db = getDb();
  const session = db.prepare("SELECT 1 FROM sessions WHERE token = ? AND expires_at > datetime('now')").get(token);
  if (!session) { reply.code(401).send({ detail: 'Invalid session' }); return; }
  const body = request.body as any;
  if (!body?.video_id) { reply.code(400).send({ detail: 'video_id required' }); return; }

  // Reject snapshots with no meaningful data — prevents 0-impression rows that pollute getSnapshot
  const bodyImp = body.impressions || 0;
  const bodyViews = body.views || 0;
  if (bodyImp === 0 && bodyViews === 0) {
    console.log(`[ext-snapshot] ${body.video_id}: skipping — both impressions and views are 0`);
    return { ok: true, skipped: true };
  }

  // Fetch likes, comments, subs from YouTube API + compute avg_view_pct
  let avgViewPct = body.avg_view_pct || 0;
  let likes = body.likes || 0;
  let comments = 0;
  try {
    const { getApiKey } = await import('./services/youtube-api.js');
    const { google } = await import('googleapis');
    const yt = google.youtube({ version: 'v3', auth: getApiKey() });
    const res = await yt.videos.list({ part: ['statistics', 'contentDetails'], id: [body.video_id] });
    const item = res.data.items?.[0];
    if (item) {
      likes = parseInt(item.statistics?.likeCount || '0');
      comments = parseInt(item.statistics?.commentCount || '0');

      // Compute avg view pct from duration
      if (!avgViewPct && body.avg_view_duration_sec > 0) {
        const dur = item.contentDetails?.duration || '';
        const m = dur.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
        if (m) {
          const totalSec = (parseInt(m[1] || '0') * 3600) + (parseInt(m[2] || '0') * 60) + parseInt(m[3] || '0');
          if (totalSec > 0) avgViewPct = Math.round((body.avg_view_duration_sec / totalSec) * 10000) / 100;
        }
      }
    }
  } catch (ytErr: any) {
    console.log(`[ext-snapshot] YouTube API error for ${body.video_id}: ${ytErr.message}`);
  }

  const retentionJson = body.retention_values && Array.isArray(body.retention_values) && body.retention_values.length > 0
    ? JSON.stringify(body.retention_values) : null;

  db.prepare(`
    INSERT INTO studio_snapshots (video_id, views, impressions, ctr, watch_time_hours, avg_view_duration_sec, avg_view_pct, likes, comments, subscribers_net, retention_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(body.video_id, body.views || 0, body.impressions, body.ctr || 0, body.watch_time_hours || 0, body.avg_view_duration_sec || 0, avgViewPct, likes, comments, body.subscribers_net || 0, retentionJson);
  console.log(`[ext-snapshot] ${body.video_id}: imp=${body.impressions} views=${body.views} ctr=${body.ctr} avp=${avgViewPct}% likes=${likes} comments=${comments} retention=${retentionJson ? body.retention_values.length + 'pts' : 'none'}`);
  return { ok: true };
});

// Hourly data endpoint — receives 48h hourly breakdown from extension
// Maps each hour to the active variant and fills measurements
app.post('/api/studio/hourly-data', async (request, reply) => {
  const authHeader = request.headers.authorization;
  const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const token = request.cookies?.session || bearerToken;
  if (!token) { reply.code(401).send({ detail: 'Not authenticated' }); return; }
  const db0 = getDb();
  const session = db0.prepare("SELECT 1 FROM sessions WHERE token = ? AND expires_at > datetime('now')").get(token);
  if (!session) { reply.code(401).send({ detail: 'Invalid session' }); return; }

  const body = request.body as any;
  if (!body?.video_id || !body?.timestamps) {
    reply.code(400).send({ detail: 'video_id and timestamps required' });
    return;
  }

  const db = getDb();

  // Extract metrics arrays
  const metrics = body.metrics || {};
  const views = metrics.EXTERNAL_VIEWS || body.views || [];
  const impressions = metrics.VIDEO_THUMBNAIL_IMPRESSIONS || [];
  const watchTime = metrics.EXTERNAL_WATCH_TIME || [];
  const avgWatchTime = metrics.AVERAGE_WATCH_TIME || [];
  const subs = metrics.SUBSCRIBERS_NET_CHANGE || [];

  console.log(`[hourly-data] Received: ${body.video_id} timestamps=${body.timestamps?.length} metrics=${Object.keys(metrics).join(',') || 'none'}`);

  // Find running OR recently completed tests for this video (completed in last 24h with zero data)
  const runningTests = db.prepare(`
    SELECT t.*, tv.id as variant_id, tv.label, tv.active_since
    FROM tests t
    JOIN test_variants tv ON tv.test_id = t.id
    WHERE t.video_id = ?
      AND t.ctr_locked = 0
      AND (t.status = 'running'
        OR (t.status = 'completed' AND t.completed_at > datetime('now', '-24 hours')))
    ORDER BY t.id, tv.label
  `).all(body.video_id) as any[];

  if (runningTests.length === 0) {
    return { ok: true, message: 'no active or recent tests for this video' };
  }

  // Group variants by test
  const testMap: Record<number, any[]> = {};
  for (const row of runningTests) {
    if (!testMap[row.id]) testMap[row.id] = [];
    testMap[row.id].push(row);
  }

  // Get all measurements with activation times for mapping
  for (const [testId, variants] of Object.entries(testMap)) {
    const measurements = db.prepare(`
      SELECT tm.*, tv.label FROM test_measurements tm
      JOIN test_variants tv ON tv.id = tm.variant_id
      WHERE tm.test_id = ?
      AND (tm.realtime_views_json IS NULL OR tm.realtime_views_json NOT LIKE '%"type":"activation_baseline"%')
      ORDER BY tm.measured_at
    `).all(parseInt(testId)) as any[];

    // Build timeline: which variant was active during each hour
    // Use the rotation_slot data to determine time ranges
    const slots: { variantId: number; label: string; start: number; end: number; measurementId: number }[] = [];

    for (const m of measurements) {
      try {
        const json = JSON.parse(m.realtime_views_json || '{}');
        if (json.activated_at && json.completed_at) {
          slots.push({
            variantId: m.variant_id,
            label: m.label,
            start: new Date(json.activated_at).getTime(),
            end: new Date(json.completed_at).getTime(),
            measurementId: m.id,
          });
        }
      } catch {}
    }

    // Also add current active variant
    for (const v of variants) {
      if (v.active_since) {
        slots.push({
          variantId: v.variant_id,
          label: v.label,
          start: new Date(v.active_since).getTime(),
          end: Date.now(),
          measurementId: 0, // currently active, no measurement yet
        });
      }
    }

    // Map hourly metrics to slots using the shared merge logic.
    // Build HourlyRow objects from the incoming request data for merging.
    const ctrValues = metrics.VIDEO_THUMBNAIL_IMPRESSIONS_VTR || [];

    const incomingRows: HourlyRow[] = [];
    for (let i = 0; i < body.timestamps.length; i++) {
      const raw = body.timestamps[i];
      const ts = typeof raw === 'string' ? raw : new Date(raw).toISOString();
      incomingRows.push({
        hour_ts: ts,
        impressions: impressions[i] || 0,
        views: views[i] || 0,
        ctr: ctrValues[i] || 0,
        watch_time_ms: watchTime[i] || 0,
        avg_watch_time_ms: avgWatchTime[i] || 0,
        subscribers_net: subs[i] || 0,
      });
    }

    const mergedHours = mergeHourlyRows(incomingRows);

    // GUARD (2026-07-08): if the incoming series is COARSE (daily buckets — what
    // YouTube serves for aged videos), NEVER map it onto hourly rotation slots: a
    // daily bucket starting inside a slot would dump the whole day's impressions
    // onto that one hour (the 5k-in-one-slot poisoning). Coarse-video tests are
    // measured by the live-delta sampler instead; the extension data still lands
    // in hourly_metrics for the record.
    let coarseIncoming = false;
    if (body.timestamps.length >= 3) {
      const ts = body.timestamps.map((r: any) => typeof r === 'string' ? new Date(r).getTime() : r).sort((a: number, b: number) => a - b);
      const gaps = [] as number[];
      for (let i = 1; i < ts.length; i++) gaps.push(ts[i] - ts[i - 1]);
      gaps.sort((a, b) => a - b);
      coarseIncoming = gaps[Math.floor(gaps.length / 2)] > 2 * 3600_000;
    }

    // Build a timestamp lookup for mapping to slots
    const hourTimestamps: Record<string, number> = {};
    for (let i = 0; i < body.timestamps.length; i++) {
      const raw = body.timestamps[i];
      const ts = typeof raw === 'string' ? raw : new Date(raw).toISOString();
      const hourKey = ts.substring(0, 13);
      const hourStart = typeof raw === 'string' ? new Date(raw).getTime() : raw;
      // Keep the earliest timestamp for each hour bucket
      if (!hourTimestamps[hourKey] || hourStart < hourTimestamps[hourKey]) {
        hourTimestamps[hourKey] = hourStart;
      }
    }

    const slotData: Record<number, { imp: number; views: number; watchMs: number; subs: number; count: number; avgWatchMs: number; clicks: number; hasScreenData: boolean }> = {};
    for (const [hourKey, merged] of coarseIncoming ? [] : Object.entries(mergedHours)) {
      const hourStart = hourTimestamps[hourKey] || new Date(hourKey + ':00:00.000Z').getTime();

      for (const slot of slots) {
        if (hourStart >= slot.start && hourStart < slot.end && slot.measurementId > 0) {
          if (!slotData[slot.measurementId]) {
            slotData[slot.measurementId] = { imp: 0, views: 0, watchMs: 0, subs: 0, count: 0, avgWatchMs: 0, clicks: 0, hasScreenData: false };
          }
          const sd = slotData[slot.measurementId];
          sd.imp += merged.imp;
          sd.views += merged.views;
          // Accumulate clicks from real CTR (get_screen) when available
          if (merged.hasScreenData) {
            sd.clicks += merged.imp * (merged.ctr / 100);
            sd.hasScreenData = true;
          }
          sd.watchMs += merged.watchMs;
          sd.subs += merged.subs;
          sd.avgWatchMs = merged.avgWatchMs || sd.avgWatchMs;
          sd.count++;
        }
      }
    }

    // Update measurements with hourly extension data.
    // Only overwrite slots that completed more than 2 hours ago so YouTube's data
    // has time to settle. This prevents constant re-writes as YouTube reprocesses.
    const settlementAgo = Date.now() - 30 * 60 * 1000; // 30 min settlement
    for (const [measId, sd] of Object.entries(slotData)) {
      const existing = db.prepare('SELECT tm.impressions, tm.ctr, tm.measured_at, tm.realtime_views_json, tv.active FROM test_measurements tm JOIN test_variants tv ON tv.id = tm.variant_id WHERE tm.id = ?').get(parseInt(measId)) as any;
      // Never touch soft-removed (greyed-out) variants — they are frozen reference data.
      if (!existing || existing.active === 0 || (!sd.imp && !sd.views)) continue;

      // Only update if the slot completed more than 2 hours ago
      try {
        const json = JSON.parse(existing.realtime_views_json || '{}');
        const completedAt = json.completed_at ? new Date(json.completed_at).getTime() : 0;
        if (completedAt > settlementAgo) continue; // too recent, let it settle
      } catch {}

      if (sd.imp > 0 || sd.views > 0) {
        // Sanity check: reject if impressions seem like a cumulative baseline dump
        // Large channels can get 20k+ impressions per hour, so threshold must be generous
        if (sd.imp > 500000 && sd.count <= 2) {
          console.log(`[hourly-data] Rejecting backfill #${measId}: imp=${sd.imp} too high for ${sd.count} hour(s) -- likely baseline data`);
          // Flag as activation_baseline so it's excluded from aggregations
          db.prepare(`
            UPDATE test_measurements SET realtime_views_json = json_set(COALESCE(realtime_views_json, '{}'), '$.type', 'activation_baseline')
            WHERE id = ?
          `).run(parseInt(measId));
          continue;
        }
        // CTR: use real YouTube CTR from get_screen data when available, views/imp as fallback
        // Real VTR from get_screen only. With no screen data this batch, PRESERVE the
        // existing CTR — never clobber a real VTR with views/impressions (inflates it).
        const ctr = sd.hasScreenData && sd.imp > 0
          ? Math.round((sd.clicks / sd.imp) * 10000) / 100
          : (existing.ctr || 0);
        const wtHours = sd.watchMs / 3600000;
        const avd = sd.views > 0 ? wtHours * 3600 / sd.views : 0;
        db.prepare(`
          UPDATE test_measurements SET impressions = ?, views = ?, ctr = ?,
            watch_time_hours = ?, avg_view_duration = ?, subs_gained = ?
          WHERE id = ?
        `).run(sd.imp, sd.views, ctr, wtHours, avd, sd.subs, parseInt(measId));
        console.log(`[hourly-data] Backfilled #${measId}: imp=${sd.imp} views=${sd.views} ctr=${ctr}% wt=${wtHours.toFixed(1)}h avd=${Math.round(avd)}s`);
      }
    }
  }

  // Store all hourly metrics.
  // Smart upsert: preserve existing non-zero values when incoming data has zeros.
  // This prevents get_screen data (no watch_time) from overwriting get_cards watch_time,
  // and vice versa for CTR.
  const upsert = db.prepare(`
    INSERT INTO hourly_metrics (video_id, hour_ts, impressions, views, ctr, watch_time_ms, avg_watch_time_ms, subscribers_net)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(video_id, hour_ts) DO UPDATE SET
      impressions = CASE WHEN excluded.impressions > 0 THEN excluded.impressions ELSE hourly_metrics.impressions END,
      views = CASE WHEN excluded.views > 0 THEN excluded.views ELSE hourly_metrics.views END,
      ctr = CASE WHEN excluded.ctr > 0 THEN excluded.ctr ELSE hourly_metrics.ctr END,
      watch_time_ms = CASE WHEN excluded.watch_time_ms > 0 THEN excluded.watch_time_ms ELSE hourly_metrics.watch_time_ms END,
      avg_watch_time_ms = CASE WHEN excluded.avg_watch_time_ms > 0 THEN excluded.avg_watch_time_ms ELSE hourly_metrics.avg_watch_time_ms END,
      subscribers_net = CASE WHEN excluded.subscribers_net != 0 THEN excluded.subscribers_net ELSE hourly_metrics.subscribers_net END,
      updated_at = datetime('now')
  `);

  const ctrVals = metrics.VIDEO_THUMBNAIL_IMPRESSIONS_VTR || [];
  let skippedCumulative = 0;
  for (let i = 0; i < body.timestamps.length; i++) {
    const hourTs = new Date(body.timestamps[i]).toISOString();
    let hourImp = impressions[i] || 0;
    let hourViews = views[i] || 0;
    const hourCtr = ctrVals[i] || 0;
    let hourWatchTime = watchTime[i] || 0;

    // Sanity check: reject per-hour values that look like cumulative totals.
    // Imp threshold: 500k/hour (popular videos can get 50k+ on launch day; 500k filters lifetime dumps).
    // Watch time threshold: 36 billion ms = 10 million hours/hour (essentially impossible per-hour value).
    // Previous threshold of 36M ms (10h/hour) was rejecting ALL data — popular podcasts
    // get ~674M ms/hour of watch time legitimately.
    if (hourImp > 500000 || hourWatchTime > 36_000_000_000) {
      skippedCumulative++;
      // Zero out the suspicious values but keep CTR (which is already per-hour from reach)
      hourImp = 0;
      hourViews = 0;
      hourWatchTime = 0;
    }

    upsert.run(body.video_id, hourTs, hourImp, hourViews,
      hourCtr, hourWatchTime, avgWatchTime[i] || 0, subs[i] || 0);
  }
  if (skippedCumulative > 0) {
    console.log(`[hourly-data] ${body.video_id}: rejected ${skippedCumulative} cumulative-looking hour(s)`);
  }

  // Backfill test measurements using real hourly data from the DB.
  // Uses the shared merge logic from hourly-merge.ts.
  // Processes running and recently completed tests (not just running).
  const backfillTests = db.prepare(`
    SELECT DISTINCT t.id, t.video_id FROM tests t
    JOIN test_variants tv ON tv.test_id = t.id
    WHERE t.video_id = ? AND (t.status = 'running'
      OR (t.status = 'completed' AND t.completed_at > datetime('now', '-7 days')))
  `).all(body.video_id) as any[];

  for (const test of backfillTests) {
    const measurements = db.prepare(`
      SELECT tm.id, tm.variant_id, tm.impressions, tm.ctr, tm.watch_time_hours, tm.realtime_views_json
      FROM test_measurements tm
      WHERE tm.test_id = ?
      AND tm.realtime_views_json LIKE '%"type":"rotation_slot"%'
      ORDER BY tm.measured_at
    `).all(test.id) as any[];

    const backfillSettlementAgo = Date.now() - 30 * 60 * 1000; // 30 min settlement
    for (const m of measurements) {
      try {
        const json = JSON.parse(m.realtime_views_json || '{}');
        if (!json.activated_at || !json.completed_at) continue;
        // Same 2-hour settlement as the in-memory path — let YouTube data settle
        const slotCompletedAt = new Date(json.completed_at).getTime();
        if (slotCompletedAt > backfillSettlementAgo) continue;
        const startTs = json.activated_at;
        const endTs = json.completed_at;

        // Query hourly_metrics for this time range
        const hourRows = db.prepare(`
          SELECT hour_ts, impressions, views, ctr, watch_time_ms, avg_watch_time_ms, subscribers_net
          FROM hourly_metrics WHERE video_id = ? AND hour_ts >= ? AND hour_ts < ?
          ORDER BY hour_ts
        `).all(test.video_id, startTs, endTs) as HourlyRow[];

        if (hourRows.length === 0) continue;

        // Use shared merge logic
        const hourMerged = mergeHourlyRows(hourRows);
        const agg = aggregateMergedHours(hourMerged);

        if (agg.totalImp > 0 || agg.totalViews > 0) {
          // Use real CTR from get_screen (via totalClicks which = imp * screenCtr per hour)
          // Falls back to views/imp only when no get_screen data exists
          const mergedCtr = agg.totalClicks > 0 && agg.totalScreenImp > 0
            ? Math.round((agg.totalClicks / agg.totalScreenImp) * 10000) / 100
            : (agg.totalImp > 0 && agg.totalViews > 0 ? Math.round((agg.totalViews / agg.totalImp) * 10000) / 100 : 0);
          const watchHours = agg.totalWatchMs / 3600000;

          // Only update if we have better data than what's already there.
          // Skip if existing already has both impressions AND watch time (in-memory first-pass
          // backfill already ran and produced accurate slot data — don't overwrite it with the
          // hourly_metrics path which has zeroed-out rows from the cumulative rejection filter).
          const existingIsComplete = m.impressions > 0 && m.watch_time_hours > 0;
          if (existingIsComplete) continue;

          const existingHasGoodCtr = m.ctr > 0 && m.watch_time_hours > 0;
          const newHasGoodCtr = mergedCtr > 0 && watchHours > 0;
          const newIsBetter = newHasGoodCtr || (!existingHasGoodCtr && (agg.totalImp > 0 || agg.totalViews > 0));

          if (newIsBetter || m.impressions === 0) {
            const computedAvd = agg.totalViews > 0 ? watchHours * 3600 / agg.totalViews : 0;
            db.prepare(`
              UPDATE test_measurements SET impressions = ?, views = ?, ctr = ?,
                watch_time_hours = ?, avg_view_duration = ?, subs_gained = ?
              WHERE id = ?
            `).run(agg.totalImp, agg.totalViews, mergedCtr, watchHours, computedAvd, agg.totalSubs, m.id);

            console.log(`[hourly-data] Backfilled #${m.id}: imp=${agg.totalImp} views=${agg.totalViews} ctr=${mergedCtr}% wt=${watchHours.toFixed(1)}h avd=${Math.round(computedAvd)}s (${agg.hourCount} hours merged)`);
          }
        }
      } catch (backfillErr: any) {
        console.error(`[hourly-data] Backfill error for measurement ${m.id}: ${backfillErr.message}`);
      }
    }
  }

  const metricCount = Object.keys(metrics).length;
  console.log(`[hourly-data] ${body.video_id}: stored ${body.timestamps.length} points x ${metricCount} metrics`);
  return { ok: true };
});

// Studio snapshots endpoint
app.get('/api/studio/:videoId', async (request, reply) => {
  const token = request.cookies?.session;
  if (!token) { reply.code(401).send({ detail: 'Not authenticated' }); return; }
  const db = getDb();
  const validSession = db.prepare("SELECT 1 FROM sessions WHERE token = ? AND expires_at > datetime('now')").get(token);
  if (!validSession) { reply.code(401).send({ detail: 'Invalid session' }); return; }
  const { videoId } = request.params as { videoId: string };
  const { limit } = request.query as { limit?: string };
  const snapshots = db.prepare(
    'SELECT * FROM studio_snapshots WHERE video_id = ? ORDER BY scraped_at DESC LIMIT ?'
  ).all(videoId, parseInt(limit || '48'));
  return snapshots;
});

// Manual studio scrape trigger
app.post('/api/studio/scrape', async (request, reply) => {
  const token = request.cookies?.session;
  if (!token) { reply.code(401).send({ detail: 'Not authenticated' }); return; }
  const scrapeDb = getDb();
  if (!scrapeDb.prepare("SELECT 1 FROM sessions WHERE token = ? AND expires_at > datetime('now')").get(token)) { reply.code(401).send({ detail: 'Invalid session' }); return; }
  const { runStudioScraper: scrape } = await import('./services/studio-scraper.js');
  const result = await scrape();
  return result;
});

// Manual sync endpoint
app.post('/api/sync', async (request, reply) => {
  const token = request.cookies?.session;
  if (!token) { reply.code(401).send({ detail: 'Not authenticated' }); return; }
  const syncDb = getDb();
  if (!syncDb.prepare("SELECT 1 FROM sessions WHERE token = ? AND expires_at > datetime('now')").get(token)) { reply.code(401).send({ detail: 'Invalid session' }); return; }

  const { syncVideoMetadata } = await import('./services/youtube-sync.js');
  const result = await syncVideoMetadata();
  return result;
});

// Backfill ALL test measurements using merged hourly data from the DB.
// Re-processes every rotation_slot measurement with the correct merge logic.
app.post('/api/admin/backfill-measurements', async (request, reply) => {
  const token = request.cookies?.session;
  if (!token) { reply.code(401).send({ detail: 'Not authenticated' }); return; }
  const db = getDb();
  const adminSession = db.prepare("SELECT u.role FROM sessions s JOIN users u ON s.user_id = u.id WHERE s.token = ? AND s.expires_at > datetime('now')").get(token) as any;
  if (!adminSession) { reply.code(401).send({ detail: 'Invalid session' }); return; }
  if (adminSession.role !== 'admin') { reply.code(403).send({ detail: 'Admin required' }); return; }
  const body = request.body as any;
  const testFilter = body?.test_id ? `AND t.id = ${parseInt(body.test_id)}` : '';
  const dryRun = body?.dry_run === true;

  const allTests = db.prepare(`
    SELECT DISTINCT t.id, t.video_id, t.status, t.video_title FROM tests t
    WHERE 1=1 ${testFilter}
    ORDER BY t.id
  `).all() as any[];

  const results: any[] = [];
  let updated = 0, skipped = 0, noData = 0;

  for (const test of allTests) {
    const measurements = db.prepare(`
      SELECT tm.id, tm.variant_id, tm.impressions, tm.views, tm.ctr,
        tm.watch_time_hours, tm.avg_view_duration, tm.subs_gained, tm.realtime_views_json
      FROM test_measurements tm
      WHERE tm.test_id = ?
      AND tm.realtime_views_json LIKE '%"type":"rotation_slot"%'
      ORDER BY tm.measured_at
    `).all(test.id) as any[];

    for (const m of measurements) {
      try {
        const json = JSON.parse(m.realtime_views_json || '{}');
        if (!json.activated_at || !json.completed_at) { skipped++; continue; }

        const hourRows = db.prepare(`
          SELECT hour_ts, impressions, views, ctr, watch_time_ms, avg_watch_time_ms, subscribers_net
          FROM hourly_metrics WHERE video_id = ? AND hour_ts >= ? AND hour_ts < ?
          ORDER BY hour_ts
        `).all(test.video_id, json.activated_at, json.completed_at) as HourlyRow[];

        if (hourRows.length === 0) { noData++; continue; }

        const hourMerged = mergeHourlyRows(hourRows);
        const agg = aggregateMergedHours(hourMerged);

        if (agg.totalImp === 0 && agg.totalViews === 0) { noData++; continue; }

        // Use real CTR from get_screen (via totalClicks) when available, views/imp fallback
        const mergedCtr = agg.totalClicks > 0 && agg.totalScreenImp > 0
          ? Math.round((agg.totalClicks / agg.totalScreenImp) * 10000) / 100
          : (agg.totalImp > 0 && agg.totalViews > 0 ? Math.round((agg.totalViews / agg.totalImp) * 10000) / 100 : 0);
        const watchHours = agg.totalWatchMs / 3600000;

        // Check if anything changed
        const ctrChanged = Math.abs(mergedCtr - (m.ctr || 0)) > 0.01;
        const impChanged = agg.totalImp !== (m.impressions || 0);
        const wtChanged = Math.abs(watchHours - (m.watch_time_hours || 0)) > 0.001;

        if (ctrChanged || impChanged || wtChanged) {
          const change = {
            measurement_id: m.id,
            test_id: test.id,
            video: test.video_id,
            old: { imp: m.impressions, views: m.views, ctr: m.ctr, wt: m.watch_time_hours },
            new: { imp: agg.totalImp, views: agg.totalViews, ctr: mergedCtr, wt: watchHours },
            hours_merged: agg.hourCount,
          };
          results.push(change);

          if (!dryRun) {
            db.prepare(`
              UPDATE test_measurements SET impressions = ?, views = ?, ctr = ?,
                watch_time_hours = ?, avg_view_duration = ?, subs_gained = ?
              WHERE id = ?
            `).run(agg.totalImp, agg.totalViews, mergedCtr, watchHours, agg.lastAvgWatchMs / 1000, agg.totalSubs, m.id);
          }
          updated++;
        } else {
          skipped++;
        }
      } catch (e: any) {
        results.push({ measurement_id: m.id, error: e.message });
      }
    }
  }

  console.log(`[backfill] ${dryRun ? 'DRY RUN: ' : ''}Processed ${allTests.length} tests: ${updated} updated, ${skipped} unchanged, ${noData} no hourly data`);

  return {
    dry_run: dryRun,
    tests_processed: allTests.length,
    updated,
    skipped,
    no_hourly_data: noData,
    changes: results,
  };
});

// Auto-sync YouTube videos every 6 hours
async function runAutoSync() {
  try {
    const { syncVideoMetadata } = await import('./services/youtube-sync.js');
    await syncVideoMetadata();
  } catch (err: any) {
    console.error(`[auto-sync] Failed: ${err.message}`);
  }
}

// Test runner — runs on the minute, only acts on the hour boundary
let _lastRunHour = -1;
let _forceNextRun = true; // Run immediately on startup to catch up missed rotations
async function runTestRunner() {
  const now = new Date();
  const currentHour = now.getHours() + now.getDate() * 24;

  if (_forceNextRun) {
    _forceNextRun = false;
    _lastRunHour = currentHour;
  } else {
    if (currentHour === _lastRunHour) return;
    if (now.getMinutes() > 5) return;
    _lastRunHour = currentHour;
  }
  console.log(`[test-runner] Hour boundary reached: ${now.toISOString()}`);

  try {
    const { runTestCycle } = await import('./services/test-runner.js');
    await runTestCycle();
  } catch (err: any) {
    console.error(`[test-runner] Failed: ${err.message}`);
  }
}

// Competitor sync — every 6 hours
async function runCompetitorSync() {
  try {
    const { syncCompetitors } = await import('./services/competitor-sync.js');
    await syncCompetitors();
  } catch (err: any) {
    console.error(`[competitor-sync] Failed: ${err.message}`);
  }
}

// Studio scraper — DISABLED. Data now comes from Chrome extension content script.
// The extension sends data to /api/studio/ext-snapshot when user visits YouTube Studio.
async function runStudioScraper(_activeTestsOnly = false) {
  // No-op — extension handles all scraping
}

// Thumbnail analyzer — daily batch
async function runThumbnailAnalyzer() {
  try {
    const { analyzeAllThumbnails } = await import('./services/thumbnail-analyzer.js');
    await analyzeAllThumbnails(20);
  } catch (err: any) {
    console.error(`[thumb-analyzer] Failed: ${err.message}`);
  }
}

// Comment scraper — every 2 hours
async function runCommentScraper() {
  try {
    const { scrapeComments } = await import('./services/comment-scraper.js');
    await scrapeComments();
  } catch (err: any) {
    console.error(`[comments] Failed: ${err.message}`);
  }
}

// Graceful shutdown
const shutdown = async () => {
  app.log.info('Shutting down...');
  await app.close();
  closeDb();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Prevent Playwright ProtocolError from crashing the server
process.on('unhandledRejection', (err: any) => {
  console.error(`[unhandled-rejection] ${err?.message || err}`);
});

// Start
try {
  // Initialize DB (creates tables, attaches youtube.db)
  getDb();

  await app.listen({ port: config.port, host: config.host });
  console.log(`YT Testing API running on http://${config.host}:${config.port}`);

  // Background tasks
  setTimeout(runAutoSync, 30_000);           // Initial video sync after 30s
  setInterval(runAutoSync, 6 * 60 * 60_000); // Then every 6 hours
  setTimeout(runTestRunner, 10_000);           // Run test cycle immediately on startup (10s delay for DB init)
  setInterval(runTestRunner, 60_000);          // Test runner checks every minute, acts on the hour
  setTimeout(runCompetitorSync, 60_000);     // Competitor sync after 1 min
  setInterval(runCompetitorSync, 6 * 60 * 60_000); // Then every 6 hours
  setTimeout(runCommentScraper, 120_000);    // Comment scraper after 2 min
  setInterval(runCommentScraper, 2 * 60 * 60_000); // Then every 2 hours
  setTimeout(() => runStudioScraper(false), 180_000); // Studio scraper after 3 min
  setInterval(() => runStudioScraper(false), 60 * 60_000); // Full scrape every hour
  setInterval(() => runStudioScraper(true), 5 * 60_000);   // Active tests every 5 min
  setTimeout(runThumbnailAnalyzer, 300_000);                // Thumbnail analysis after 5 min
  setInterval(runThumbnailAnalyzer, 24 * 60 * 60_000);     // Then daily
  startTagMaintenance();                                    // Auto-tag new titles + thumbnails (untagged only)
  // Proactive title suggestions for recently published videos, grounded in our
  // A/B winners + competitors + thumbnail + transcript. Low volume, so daily.
  const suggestSweep = () => import('./services/title-suggester.js').then(m => m.runTitleSuggestionSweep()).catch(e => console.error('[title-suggester] sweep failed:', e?.message));
  setTimeout(suggestSweep, 6 * 60_000);                     // 6 min after boot
  setInterval(suggestSweep, 24 * 60 * 60_000);              // Then daily
  // Revival candidates: rank older videos worth re-testing to win back views.
  const reviveSweep = () => import('./services/revive-scorer.js').then(m => m.scoreReviveCandidates(25)).catch(e => console.error('[revive] sweep failed:', e?.message));
  setTimeout(reviveSweep, 9 * 60_000);                      // 9 min after boot
  setInterval(reviveSweep, 24 * 60 * 60_000);               // Then daily
  // Per-test learning notes: create the column + auto-write a lesson for every
  // completed test (deterministic). Also underpins the save_test_learning tool.
  const learnSweep = () => import('./services/test-learning.js').then(m => m.backfillTestLearnings()).catch(e => console.error('[test-learning] sweep failed:', e?.message));
  setTimeout(learnSweep, 2 * 60_000);                       // 2 min after boot
  setInterval(learnSweep, 6 * 60 * 60_000);                 // Then every 6h
  // Chained re-tests: auto-start a title test once a flagged thumbnail test ends.
  const chainSweep = () => import('./services/retest-chain.js').then(m => m.processTitleChains()).catch(e => console.error('[retest-chain] sweep failed:', e?.message));
  setTimeout(chainSweep, 4 * 60_000);                       // 4 min after boot
  setInterval(chainSweep, 15 * 60_000);                     // Then every 15 min
  const briefSweep = () => import("./services/prerelease-briefing.js").then(m => m.runPrereleaseBriefing()).catch(e => console.error("[prerelease-briefing] sweep failed:", e?.message));
  setTimeout(briefSweep, 7 * 60_000);
  setInterval(briefSweep, 10 * 60_000);
  // Video proposal sweep: generate packaging proposals for new videos with no test yet.
  const videoProposalSweep = () => import('./services/video-proposal-sweep.js').then(m => m.scanAndGenerateVideoProposals()).catch(e => console.error('[video-proposals] sweep failed:', e?.message));
  setTimeout(videoProposalSweep, 12 * 60_000);               // 12 min after boot (after video sync settles)
  setInterval(videoProposalSweep, 24 * 60 * 60_000);         // Then daily
  // Retention-transcript overlay: map retention curves to transcript moments.
  const retentionOverlaySweep = () => import('./services/retention-overlay.js').then(m => m.runRetentionOverlaySweep()).catch(e => console.error('[retention-overlay] sweep failed:', e?.message));
  setTimeout(retentionOverlaySweep, 5 * 60_000);             // 5 min after boot
  setInterval(retentionOverlaySweep, 6 * 60 * 60_000);       // Then every 6 hours (runs fast, just processes new retention data)
  const warmStudio = () => import('./services/youtube-studio-upload.js').then(m => m.keepStudioSessionWarm()).catch(() => {});
  setTimeout(warmStudio, 120_000);                          // Keep Firefox Studio login warm 2 min after boot
  setInterval(warmStudio, 3 * 60 * 60_000);                 // Then every 3 hours so the session never idles out
  // Daily channel stats snapshot (subscriber count, total views, video count).
  const runChannelStats = () => import('./services/channel-stats.js').then(m => m.captureChannelStats()).catch(e => console.error('[channel-stats] failed:', e?.message));
  setTimeout(runChannelStats, 15_000);                      // Shortly after boot (captures today's row)
  setInterval(runChannelStats, 24 * 60 * 60_000);           // Then once daily

  // Competitor intelligence — run weekly (low priority, no API quota for growth job)
  const runCompetitorGrowth = () => import('./services/competitor-growth.js').then(m => m.computeCompetitorGrowth()).catch(e => console.error('[competitor-growth] failed:', e?.message));
  const runCompetitorDiscovery = () => import('./services/competitor-discovery.js').then(m => m.runDiscoverySuggestions()).catch(e => console.error('[competitor-discovery] failed:', e?.message));
  setTimeout(runCompetitorGrowth, 90_000);                         // 90s after boot so videos are synced first
  setInterval(runCompetitorGrowth, 7 * 24 * 60 * 60_000);         // Then weekly
  setTimeout(runCompetitorDiscovery, 3 * 60_000);                  // 3 min after boot
  setInterval(runCompetitorDiscovery, 7 * 24 * 60 * 60_000);      // Then weekly

  // Authoritative variant CTR. Pulls YouTube's real Reach hourly CTR server-side
  // (no browser/extension) and writes it to test_variants.ctr_override, which the
  // frontend prefers. This is the SINGLE source for the CTR shown on running tests —
  // noisy extension/realtime data can never clobber it. Refreshed so it stays live.
  const runReachRefresh = async () => {
    try {
      const results = await refreshAllRunningTests();
      for (const r of results) {
        console.log(`[reach-refresh] test ${r.testId} ${r.videoId}: ${r.perVariant.map(v => `${v.label}=${v.ctr}%`).join(' ')} (blended ${r.blendedCtr}%)`);
      }
    } catch (e: any) { console.error('[reach-refresh] failed:', e?.message); }
    // After the data refresh: re-check winners of tests still settling (YouTube
    // underreports the final ~2 hours at completion time) and send the one-time
    // settled final report for tests whose 48h window just closed.
    try {
      const { settledSweep } = await import('./services/settled-results.js');
      await settledSweep();
    } catch (e: any) { console.error('[settled-results] sweep failed:', e?.message); }
    // Snapshot-delta engagement fill: daily-bucket videos skip the live-delta
    // sampler, so their slots get likes/comments from studio_snapshots instead.
    try {
      const { fillEngagementFromSnapshots } = await import('./services/engagement-fill.js');
      fillEngagementFromSnapshots();
    } catch (e: any) { console.error('[engagement-fill] failed:', e?.message); }
    // Metric-health audit: catches dead data pipes (stale, zero-flatlined,
    // impossible values) within one cycle and emails on FAIL (6h rate limit).
    try {
      const { metricHealthSweep } = await import('./services/metric-health.js');
      await metricHealthSweep();
    } catch (e: any) { console.error('[metric-health] sweep failed:', e?.message); }
  };
  setTimeout(runReachRefresh, 25_000);                      // shortly after boot
  setInterval(runReachRefresh, 20 * 60_000);                // every 20 min — keeps CTR live as YouTube settles each hour

  // Nightly deep audit: our stored numbers vs Studio's own, 3am Melbourne.
  let _lastDeepAuditDay = '';
  const deepAuditTick = async () => {
    const parts = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Melbourne', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: 'numeric' }).formatToParts(new Date());
    const get = (t: string) => parts.find(p => p.type === t)?.value || '';
    const day = `${get('year')}-${get('month')}-${get('day')}`;
    const hour = parseInt(get('hour'));
    if (hour !== 3 || _lastDeepAuditDay === day) return;
    _lastDeepAuditDay = day;
    try {
      const { nightlyDeepAudit } = await import('./services/deep-audit.js');
      await nightlyDeepAudit();
    } catch (e: any) { console.error('[deep-audit] nightly run failed:', e?.message); }
  };
  setInterval(deepAuditTick, 15 * 60_000);

  // Keep the Google OAuth token warm. The app is in "Testing" mode, where an unused
  // refresh token lapses (~7 days) — which is why "can't see videos" kept happening.
  // Exercising it every 12h (well inside the window) keeps it alive indefinitely,
  // the same way socials' constant API use keeps its token alive. No re-auth needed.
  const keepTokenAlive = async () => {
    try { await getAccessToken(); console.log('[token-keepalive] analytics token refreshed'); }
    catch (e: any) { console.error('[token-keepalive] analytics refresh failed:', e?.message); }
    try { await getClipsAccessToken(); } catch { /* clips channel optional / not connected */ }
  };
  setTimeout(keepTokenAlive, 45_000);                       // shortly after boot
  setInterval(keepTokenAlive, 12 * 60 * 60_000);            // every 12 hours

  // Prune stale data — old studio snapshots and hourly metrics
  setInterval(() => {
    try {
      const db = getDb();
      const snapDel = db.prepare("DELETE FROM studio_snapshots WHERE scraped_at < datetime('now', '-30 days')").run();
      if (snapDel.changes > 0) console.log(`[cleanup] Pruned ${snapDel.changes} old studio snapshots`);
      const hourDel = db.prepare("DELETE FROM hourly_metrics WHERE hour_ts < datetime('now', '-90 days')").run();
      if (hourDel.changes > 0) console.log(`[cleanup] Pruned ${hourDel.changes} old hourly metrics`);
    } catch (err: any) {
      console.error(`[cleanup] Failed: ${err.message}`);
    }
  }, 24 * 60 * 60_000); // Daily

  // Data health check — alert if extension hasn't sent data for running tests
  let _lastAlertSent = 0;
  setInterval(async () => {
    const db = getDb();
    // Only check tests that have actually started (not scheduled for the future)
    const runningTests = db.prepare(`
      SELECT id, video_id, video_title, started_at FROM tests
      WHERE status = 'running'
      AND replace(replace(started_at,'T',' '),'.000Z','') <= datetime('now')
    `).all() as any[];
    if (runningTests.length === 0) return;

    for (const test of runningTests) {
      // Check last snapshot for this video
      const lastSnap = db.prepare(
        "SELECT MAX(scraped_at) as last FROM studio_snapshots WHERE video_id = ?"
      ).get(test.video_id) as any;

      const lastHourly = db.prepare(
        "SELECT MAX(hour_ts) as last FROM hourly_metrics WHERE video_id = ? AND impressions > 0"
      ).get(test.video_id) as any;

      // The internal API (reach-refresh) fills CTR/impressions on the slot rows
      // without the extension. If that is recent, the winner metric is flowing,
      // so a quiet extension is NOT worth alarming about.
      const lastMetric = db.prepare(
        "SELECT MAX(measured_at) as last FROM test_measurements WHERE test_id = ? AND impressions > 0"
      ).get(test.id) as any;

      // Parse timestamps safely — SQLite datetime('now') gives 'YYYY-MM-DD HH:MM:SS' (UTC, no Z),
      // but hourly_metrics hour_ts may have ISO format with T and Z already.
      function parseUtcTimestamp(ts: string): number {
        if (!ts) return 0;
        let normalized = ts.replace(' ', 'T');
        if (!normalized.endsWith('Z') && !normalized.includes('+')) normalized += 'Z';
        return new Date(normalized).getTime();
      }
      const snapAge = lastSnap?.last ? (Date.now() - parseUtcTimestamp(lastSnap.last)) / 60000 : 999;
      const hourlyAge = lastHourly?.last ? (Date.now() - parseUtcTimestamp(lastHourly.last)) / 60000 : 999;
      const metricAge = lastMetric?.last ? (Date.now() - parseUtcTimestamp(lastMetric.last)) / 60000 : 999;

      // Grace period: a freshly-started test has never collected anything yet, so
      // every age above defaults to 999 and would fire instantly. Don't alarm until
      // the test has had time to complete its first rotation slot + reach-refresh lag.
      const runningMin = test.started_at ? (Date.now() - parseUtcTimestamp(test.started_at)) / 60000 : 999999;
      if (runningMin < 180) continue;

      // Only alarm when the WINNER METRIC is genuinely stale everywhere: no
      // extension snapshot, no extension hourly, AND no internal-API CTR in 6h.
      // A quiet extension while the internal API keeps filling CTR is fine.
      if (snapAge > 360 && hourlyAge > 360 && metricAge > 360 && Date.now() - _lastAlertSent > 6 * 3600000) {
        console.log(`[health] WARNING: No CTR data from any source for running test "${test.video_title}" in ${Math.round(metricAge)} minutes`);
        try {
          const { sendEmail } = await import('./services/email.js');
          await sendEmail(
            'team@example.com',
            `YT Testing Alert: "${test.video_title?.slice(0, 40)}" is not collecting data`,
            `<p><strong>${test.video_title}</strong> (${test.video_id}) has recorded no CTR or impressions from ANY source in ${Math.round(metricAge)} minutes, so this A/B test is not collecting its winner metric.</p>
            <p>Since the live-slot refresh writes real data every ~20 minutes for every running test, this usually means the internal-API pull itself is failing for this video. Check pm2 logs for [reach-refresh] errors. Only if OTHER running tests are also stale is it likely the Firefox Studio session (check for a session email).</p>
            <p>Last internal-API CTR: ${lastMetric?.last || 'never'}<br>Last extension snapshot: ${lastSnap?.last || 'never'}</p>`
          );
          _lastAlertSent = Date.now();
        } catch (err: any) {
          console.error('[health] Failed to send alert:', err.message);
        }
      }
    }
  }, 10 * 60_000); // Check every 10 minutes
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
