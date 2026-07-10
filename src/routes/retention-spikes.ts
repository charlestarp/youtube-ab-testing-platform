import { FastifyInstance } from 'fastify';
import { google } from 'googleapis';
import { getDb } from '../db/client.js';
import { authMiddleware } from '../middleware/auth.js';
import { getApiKey } from '../services/youtube-api.js';

// Channel ID per user spec — main Toni and Ryan channel for Retention Spikes
const SPIKES_CHANNEL_ID = process.env.RETENTION_SPIKES_CHANNEL_ID || 'UCkhy7g4GvHuzhbzTVjc8izQ';

function parseDuration(iso: string): number {
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  return (parseInt(match[1] || '0') * 3600) + (parseInt(match[2] || '0') * 60) + parseInt(match[3] || '0');
}

function formatTimecode(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) {
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

interface Spike {
  position: number;
  timecode: string;
  retention_value: number;
  above_typical_pct: number;
  context_before: number | null;
  context_after: number | null;
}

/**
 * Detect retention spikes — moments where viewers re-watch or engagement bumps.
 * Works with absolute retention % (which naturally decays over time).
 *
 * Algorithm:
 * 1. Compute a smoothed baseline (rolling average over 20% window)
 * 2. Compute delta = actual - smoothed at each point
 * 3. Find local maxima of delta (points above the local baseline by >= 0.5%)
 * 4. These represent re-watch spikes / retention bumps
 */
function detectSpikes(retention: number[], durationSeconds: number, topN = 10): Spike[] {
  const peaks: Spike[] = [];
  const len = retention.length;
  if (len < 10 || durationSeconds <= 0) return peaks;

  // 1. Smoothed baseline using a Gaussian-ish rolling average
  const windowHalf = Math.max(5, Math.floor(len * 0.08)); // 8% window
  const smoothed: number[] = new Array(len);
  for (let i = 0; i < len; i++) {
    let sum = 0, count = 0;
    const start = Math.max(0, i - windowHalf);
    const end = Math.min(len - 1, i + windowHalf);
    for (let j = start; j <= end; j++) {
      sum += retention[j];
      count++;
    }
    smoothed[i] = sum / count;
  }

  // 2. Delta from smoothed baseline
  const delta: number[] = retention.map((v, i) => v - smoothed[i]);

  // 3. Find local maxima where delta > 0.3
  // Skip first 10% (intro peak is not clippable) and last 2% (outro noise)
  const peakWindow = 3;
  const startIdx = Math.max(peakWindow, Math.floor(len * 0.10));
  const endIdx = Math.min(len - peakWindow, Math.floor(len * 0.98));
  for (let i = startIdx; i < endIdx; i++) {
    const d = delta[i];
    if (d < 0.3) continue; // must be noticeably above baseline

    let isPeak = true;
    for (let k = 1; k <= peakWindow; k++) {
      if (delta[i - k] > d) { isPeak = false; break; }
      if (delta[i + k] > d) { isPeak = false; break; }
    }
    if (!isPeak) continue;

    const timeSec = (i / len) * durationSeconds;

    peaks.push({
      position: i,
      timecode: formatTimecode(timeSec),
      retention_value: Math.round(retention[i] * 100) / 100,
      above_typical_pct: Math.round(d * 100) / 100,
      context_before: i > 0 ? retention[i - 1] : null,
      context_after: i < len - 1 ? retention[i + 1] : null,
    });
  }

  // Sort by delta (above_typical_pct) descending — biggest spikes first
  peaks.sort((a, b) => b.above_typical_pct - a.above_typical_pct);
  return peaks.slice(0, topN);
}

function findAbsoluteMax(retention: number[], durationSeconds: number): Spike | null {
  if (retention.length === 0 || durationSeconds <= 0) return null;
  // Skip first 10% of video (intro typically has highest retention, not clippable)
  const startIdx = Math.floor(retention.length * 0.10);
  let maxIdx = startIdx;
  let maxVal = retention[startIdx];
  for (let i = startIdx + 1; i < retention.length; i++) {
    if (retention[i] > maxVal) {
      maxVal = retention[i];
      maxIdx = i;
    }
  }
  const timeSec = (maxIdx / retention.length) * durationSeconds;
  return {
    position: maxIdx,
    timecode: formatTimecode(timeSec),
    retention_value: Math.round(maxVal * 100) / 100,
    above_typical_pct: 0,
    context_before: maxIdx > 0 ? retention[maxIdx - 1] : null,
    context_after: maxIdx < retention.length - 1 ? retention[maxIdx + 1] : null,
  };
}

async function fetchChannelVideosFromApi(days: number) {
  const publishedAfter = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const yt = google.youtube({ version: 'v3', auth: getApiKey() });

  // Search for recent channel uploads
  const searchRes = await yt.search.list({
    part: ['snippet'],
    channelId: SPIKES_CHANNEL_ID,
    type: ['video'],
    order: 'date',
    maxResults: 50,
    publishedAfter,
  });

  const items = searchRes.data.items || [];
  const videoIds = items.map(i => i.id?.videoId).filter(Boolean) as string[];
  if (videoIds.length === 0) return [];

  // Get video details in batches of 50
  const details: any[] = [];
  for (let i = 0; i < videoIds.length; i += 50) {
    const batch = videoIds.slice(i, i + 50);
    const detailRes = await yt.videos.list({
      part: ['contentDetails', 'statistics', 'snippet'],
      id: batch,
    });
    details.push(...(detailRes.data.items || []));
  }

  const detailMap = new Map<string, any>();
  for (const d of details) {
    if (d.id) detailMap.set(d.id, d);
  }

  return items.map(item => {
    const vid = item.id?.videoId || '';
    const d = detailMap.get(vid);
    const dur = parseDuration(d?.contentDetails?.duration || '');
    return {
      video_id: vid,
      title: item.snippet?.title || d?.snippet?.title || '',
      published_at: item.snippet?.publishedAt || d?.snippet?.publishedAt || '',
      duration_seconds: dur,
      is_short: dur > 0 && dur <= 180 ? 1 : 0,
      view_count: parseInt(d?.statistics?.viewCount || '0'),
      like_count: parseInt(d?.statistics?.likeCount || '0'),
      comment_count: parseInt(d?.statistics?.commentCount || '0'),
      thumbnail_url: item.snippet?.thumbnails?.high?.url || item.snippet?.thumbnails?.default?.url || '',
    };
  });
}

function ensureChannelVideosTable() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS channel_videos (
      video_id TEXT PRIMARY KEY,
      title TEXT,
      published_at TEXT,
      duration_seconds INTEGER,
      is_short INTEGER DEFAULT 0,
      view_count INTEGER,
      like_count INTEGER,
      comment_count INTEGER,
      thumbnail_url TEXT,
      synced_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_channel_videos_published ON channel_videos(published_at);
  `);
}

async function syncChannelVideos(days = 30): Promise<{ synced: number }> {
  ensureChannelVideosTable();
  const db = getDb();
  const videos = await fetchChannelVideosFromApi(days);

  const upsert = db.prepare(`
    INSERT INTO channel_videos (video_id, title, published_at, duration_seconds, is_short,
      view_count, like_count, comment_count, thumbnail_url, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(video_id) DO UPDATE SET
      title = excluded.title,
      published_at = excluded.published_at,
      duration_seconds = excluded.duration_seconds,
      is_short = excluded.is_short,
      view_count = excluded.view_count,
      like_count = excluded.like_count,
      comment_count = excluded.comment_count,
      thumbnail_url = excluded.thumbnail_url,
      synced_at = datetime('now')
  `);

  const tx = db.transaction((rows: any[]) => {
    for (const v of rows) {
      upsert.run(v.video_id, v.title, v.published_at, v.duration_seconds, v.is_short,
        v.view_count, v.like_count, v.comment_count, v.thumbnail_url);
    }
  });
  tx(videos);

  return { synced: videos.length };
}

export async function retentionSpikesRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware);
  ensureChannelVideosTable();

  // GET /retention-spikes/videos?days=7 — list recent videos with retention availability
  app.get('/retention-spikes/videos', async (request) => {
    const { days } = request.query as { days?: string };
    const dayCount = Math.max(1, Math.min(60, parseInt(days || '7')));
    const db = getDb();

    // Auto-sync if no rows or data is stale (>1 hour old)
    let stale = false;
    try {
      const latest = db.prepare('SELECT MAX(synced_at) as latest FROM channel_videos').get() as any;
      if (!latest?.latest) {
        stale = true;
      } else {
        // SQLite datetime('now') returns 'YYYY-MM-DD HH:MM:SS' in UTC — parse as UTC
        const iso = String(latest.latest).replace(' ', 'T') + 'Z';
        const ts = new Date(iso).getTime();
        if (Number.isNaN(ts)) stale = true;
        else if (Date.now() - ts > 60 * 60 * 1000) stale = true;
      }
    } catch {
      stale = true;
    }

    if (stale) {
      try {
        await syncChannelVideos(30);
      } catch (err: any) {
        console.log(`[retention-spikes] Auto-sync failed: ${err.message}`);
      }
    }

    const cutoff = new Date(Date.now() - dayCount * 24 * 60 * 60 * 1000).toISOString();
    const rows = db.prepare(`
      SELECT video_id, title, published_at, duration_seconds, is_short,
             view_count, like_count, comment_count, thumbnail_url
      FROM channel_videos
      WHERE published_at >= ?
      ORDER BY published_at DESC
    `).all(cutoff) as any[];

    // Filter out Shorts (<=180s / 3 minutes — YouTube Shorts max)
    const longVideos = rows.filter(r => !r.is_short && r.duration_seconds > 180);

    // Find the latest snapshot with retention_json for each video
    const snapStmt = db.prepare(`
      SELECT id, scraped_at, views, impressions, ctr, retention_json, avg_view_pct
      FROM studio_snapshots
      WHERE video_id = ? AND retention_json IS NOT NULL AND retention_json != ''
      ORDER BY scraped_at DESC LIMIT 1
    `);

    return longVideos.map(v => {
      const snap = snapStmt.get(v.video_id) as any;
      return {
        video_id: v.video_id,
        title: v.title,
        published_at: v.published_at,
        duration_seconds: v.duration_seconds,
        thumbnail_url: v.thumbnail_url,
        view_count: v.view_count,
        like_count: v.like_count,
        comment_count: v.comment_count,
        has_retention_data: !!snap,
        latest_snapshot_id: snap?.id || null,
        latest_snapshot_at: snap?.scraped_at || null,
        views: snap?.views || v.view_count || 0,
        impressions: snap?.impressions || 0,
        ctr: snap?.ctr || 0,
        avg_view_pct: snap?.avg_view_pct || 0,
      };
    });
  });

  // POST /retention-spikes/sync — manual sync of channel_videos (last 30 days)
  app.post('/retention-spikes/sync', async () => {
    try {
      const result = await syncChannelVideos(30);
      return { ok: true, ...result };
    } catch (err: any) {
      return { ok: false, detail: err.message };
    }
  });

  // GET /retention-spikes/pending-videos — videos that need retention data (for extension polling)
  app.get('/retention-spikes/pending-videos', async () => {
    const db = getDb();
    // Get videos from last 30 days without retention data
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const rows = db.prepare(`
      SELECT cv.video_id, cv.title
      FROM channel_videos cv
      WHERE cv.published_at >= ?
        AND cv.is_short = 0
        AND cv.duration_seconds > 180
        AND NOT EXISTS (
          SELECT 1 FROM studio_snapshots ss
          WHERE ss.video_id = cv.video_id AND ss.retention_json IS NOT NULL
        )
      ORDER BY cv.published_at DESC
      LIMIT 20
    `).all(cutoff);
    return rows;
  });

  // POST /retention-spikes/scrape/:video_id — trigger studio scrape for a single video
  app.post('/retention-spikes/scrape/:video_id', async (request, reply) => {
    const { video_id } = request.params as { video_id: string };
    if (!video_id) {
      reply.code(400).send({ detail: 'video_id required' });
      return;
    }
    try {
      const { runStudioScraper } = await import('../services/studio-scraper.js');
      const result = await runStudioScraper({ videoIds: [video_id] });
      return { ok: true, ...result };
    } catch (err: any) {
      console.error(`[retention-spikes] Scrape failed for ${video_id}: ${err.message}`);
      reply.code(500).send({ detail: err.message });
    }
  });

  // GET /retention-spikes/analysis/:video_id — spike analysis for a single video
  app.get('/retention-spikes/analysis/:video_id', async (request, reply) => {
    const { video_id } = request.params as { video_id: string };
    if (!video_id) {
      reply.code(400).send({ detail: 'video_id required' });
      return;
    }
    const db = getDb();

    const video = db.prepare(`
      SELECT video_id, title, duration_seconds, thumbnail_url, view_count, published_at
      FROM channel_videos WHERE video_id = ?
    `).get(video_id) as any;

    const snap = db.prepare(`
      SELECT id, scraped_at, retention_json, views, impressions, ctr, avg_view_pct
      FROM studio_snapshots
      WHERE video_id = ? AND retention_json IS NOT NULL AND retention_json != ''
      ORDER BY scraped_at DESC LIMIT 1
    `).get(video_id) as any;

    if (!snap) {
      reply.code(404).send({ detail: 'No retention data for this video yet' });
      return;
    }

    let retention: number[] = [];
    try {
      retention = JSON.parse(snap.retention_json);
      if (!Array.isArray(retention)) retention = [];
    } catch {
      retention = [];
    }

    const duration = video?.duration_seconds || 0;
    const spikes = detectSpikes(retention, duration, 10);
    const absoluteMax = findAbsoluteMax(retention, duration);

    const avgRetention = retention.length
      ? Math.round((retention.reduce((a, b) => a + b, 0) / retention.length) * 100) / 100
      : 0;

    return {
      video_id,
      title: video?.title || '',
      thumbnail_url: video?.thumbnail_url || '',
      published_at: video?.published_at || '',
      duration_seconds: duration,
      scraped_at: snap.scraped_at,
      views: snap.views || 0,
      impressions: snap.impressions || 0,
      ctr: snap.ctr || 0,
      avg_view_pct: snap.avg_view_pct || 0,
      retention_points: retention.length,
      retention_curve: retention,
      avg_retention: avgRetention,
      spikes,
      absolute_max: absoluteMax,
    };
  });
}
