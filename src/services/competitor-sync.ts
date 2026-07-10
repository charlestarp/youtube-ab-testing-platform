/**
 * Competitor sync — fetches channel stats and recent videos for tracked competitors.
 */

import { getDb } from '../db/client.js';
import { getChannelDetails, getChannelVideos, searchChannels } from './youtube-api.js';

// Seed competitors
const SEED_CHANNELS = [
  { handle: '@ShtsNGigsPodcast', name: "Sh*ts N Gigs" },
  { handle: '@TheBasementYard', name: 'The Basement Yard' },
];

export async function syncCompetitors(): Promise<void> {
  const db = getDb();
  const competitors = db.prepare('SELECT * FROM competitors').all() as any[];

  if (competitors.length === 0) {
    console.log('[competitor-sync] No competitors tracked yet. Use the API to add channels.');
    return;
  }

  for (const comp of competitors) {
    try {
      // Update channel stats
      const details = await getChannelDetails(comp.channel_id);
      if (details) {
        db.prepare(`
          UPDATE competitors SET
            name = ?, handle = ?, subscriber_count = ?, video_count = ?,
            thumbnail = ?, last_synced_at = datetime('now')
          WHERE id = ?
        `).run(details.name, details.handle, details.subscriberCount, details.videoCount, details.thumbnail || null, comp.id);
      }

      // Fetch recent videos
      const videos = await getChannelVideos(comp.channel_id, 1000);
      const upsert = db.prepare(`
        INSERT INTO competitor_videos (competitor_id, video_id, title, published_at, thumbnail_url, views, likes, comments, duration_seconds)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(video_id) DO UPDATE SET
          views = excluded.views, likes = excluded.likes, comments = excluded.comments,
          fetched_at = datetime('now')
      `);

      for (const v of videos) {
        if (v.durationSeconds <= 60) continue; // skip shorts
        upsert.run(comp.id, v.videoId, v.title, v.publishedAt, v.thumbnailUrl,
          v.views, v.likes, v.comments, v.durationSeconds);
      }

      console.log(`[competitor-sync] Synced ${comp.name}: ${videos.length} videos`);
    } catch (err: any) {
      console.error(`[competitor-sync] Error syncing ${comp.name}: ${err.message}`);
    }
  }
}

/**
 * Auto-discover similar comedy podcast channels.
 */
export async function discoverSimilarChannels(): Promise<number> {
  const db = getDb();
  const queries = ['comedy podcast youtube', 'funny podcast', 'comedy podcast channel'];
  let discovered = 0;

  for (const q of queries) {
    try {
      const channels = await searchChannels(q, 10);
      for (const ch of channels) {
        if (!ch.channelId) continue;
        // Skip if already tracked
        const existing = db.prepare('SELECT id FROM competitors WHERE channel_id = ?').get(ch.channelId);
        if (existing) continue;

        // Get full details to check subscriber count (only track channels > 50k)
        const details = await getChannelDetails(ch.channelId);
        if (!details || details.subscriberCount < 50000) continue;

        db.prepare(`
          INSERT OR IGNORE INTO competitors (channel_id, name, handle, subscriber_count, video_count, is_auto_discovered)
          VALUES (?, ?, ?, ?, ?, 1)
        `).run(ch.channelId, details.name, details.handle, details.subscriberCount, details.videoCount);
        discovered++;
      }
    } catch (err: any) {
      console.error(`[discover] Error: ${err.message}`);
    }
  }

  console.log(`[competitor-sync] Discovered ${discovered} new channels`);
  return discovered;
}
