import { getDb } from '../db/client.js';
import { config } from '../config.js';

const FALLBACK_CHANNEL_ID = 'UCkhy7g4GvHuzhbzTVjc8izQ';

export function ensureChannelStatsSchema(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS channel_stats (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      date        TEXT    NOT NULL UNIQUE,
      captured_at TEXT    NOT NULL DEFAULT (datetime('now')),
      subscriber_count       INTEGER NOT NULL,
      view_count             INTEGER NOT NULL,
      video_count            INTEGER NOT NULL,
      subscriber_count_exact INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_channel_stats_date ON channel_stats(date);
  `);
  // Migrate existing rows: add exact column if missing.
  try { db.prepare('SELECT subscriber_count_exact FROM channel_stats LIMIT 1').get(); }
  catch { db.exec('ALTER TABLE channel_stats ADD COLUMN subscriber_count_exact INTEGER'); }
}

export async function captureChannelStats(): Promise<void> {
  const channelId = config.youtubeChannelId || FALLBACK_CHANNEL_ID;
  const apiKey = config.youtubeApiKey;
  if (!apiKey) {
    console.log('[channel-stats] Skipped — YOUTUBE_API_KEY not set');
    return;
  }

  const url = `https://www.googleapis.com/youtube/v3/channels?part=statistics&id=${channelId}&key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`YouTube API ${res.status}`);
  const data = await res.json() as any;
  const stats = data.items?.[0]?.statistics;
  if (!stats) throw new Error('No statistics in channel response');

  // Try to get the exact (unrounded) count from Studio — the Data API rounds to 3 sig figs.
  let exactSubs: number | null = null;
  try {
    const { fetchExactSubscriberCount } = await import('./studio-fetch.js');
    exactSubs = await fetchExactSubscriberCount();
  } catch (e: any) {
    console.error('[channel-stats] Studio exact-sub fetch failed:', e?.message);
  }

  const date = new Date().toISOString().slice(0, 10);
  const db = getDb();
  ensureChannelStatsSchema();

  db.prepare(`
    INSERT INTO channel_stats (date, subscriber_count, view_count, video_count, subscriber_count_exact)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(date) DO UPDATE SET
      subscriber_count       = excluded.subscriber_count,
      view_count             = excluded.view_count,
      video_count            = excluded.video_count,
      subscriber_count_exact = COALESCE(excluded.subscriber_count_exact, subscriber_count_exact),
      captured_at            = datetime('now')
  `).run(
    date,
    parseInt(stats.subscriberCount || '0'),
    parseInt(stats.viewCount       || '0'),
    parseInt(stats.videoCount      || '0'),
    exactSubs,
  );

  const rounded = parseInt(stats.subscriberCount || '0');
  console.log(`[channel-stats] ${date}: ${rounded.toLocaleString()} subs${exactSubs ? ` (exact: ${exactSubs.toLocaleString()})` : ''}, ${parseInt(stats.videoCount || '0').toLocaleString()} videos`);
}
