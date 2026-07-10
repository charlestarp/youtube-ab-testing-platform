/**
 * Competitor discovery — suggests comparable comedy-podcast channels via the
 * YouTube Data API. Writes to competitor_suggestions for human review; never
 * auto-adds to competitors.
 */
import { getDb } from '../db/client.js';
import { searchChannels, getChannelDetails } from './youtube-api.js';

// Targeted queries for channels comparable to Toni and Ryan.
const SEARCH_QUERIES = [
  'comedy podcast duo funny australia',
  'comedy chat podcast two hosts',
  'funny conversation podcast youtube',
  'comedy podcast friends funny stories',
  'comedy podcast oversharing confessions',
];

const MIN_SUBS  = 100_000;   // too small = not a useful benchmark
const MAX_SUBS  = 5_000_000; // too big = different tier entirely

export function ensureDiscoverySchema(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS competitor_suggestions (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id       TEXT UNIQUE NOT NULL,
      name             TEXT NOT NULL,
      handle           TEXT,
      subscriber_count INTEGER DEFAULT 0,
      video_count      INTEGER DEFAULT 0,
      thumbnail        TEXT,
      reason           TEXT,
      suggested_at     TEXT NOT NULL DEFAULT (datetime('now')),
      status           TEXT NOT NULL DEFAULT 'pending'
    );
    CREATE INDEX IF NOT EXISTS idx_comp_sug_status ON competitor_suggestions(status);
  `);
}

export async function runDiscoverySuggestions(): Promise<number> {
  const db = getDb();
  ensureDiscoverySchema();

  // IDs already being tracked or already suggested (any status).
  const trackedIds = new Set(
    (db.prepare('SELECT channel_id FROM competitors').all() as any[]).map(r => r.channel_id)
  );
  const suggestedIds = new Set(
    (db.prepare('SELECT channel_id FROM competitor_suggestions').all() as any[]).map(r => r.channel_id)
  );

  let added = 0;
  for (const query of SEARCH_QUERIES) {
    try {
      const results = await searchChannels(query, 10);
      for (const r of results) {
        if (!r.channelId || trackedIds.has(r.channelId) || suggestedIds.has(r.channelId)) continue;

        // Fetch stats so we can size-filter without storing junk.
        const details = await getChannelDetails(r.channelId);
        if (!details) continue;
        if (details.subscriberCount < MIN_SUBS || details.subscriberCount > MAX_SUBS) continue;

        db.prepare(`
          INSERT OR IGNORE INTO competitor_suggestions
            (channel_id, name, handle, subscriber_count, video_count, thumbnail, reason)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          details.channelId, details.name, details.handle,
          details.subscriberCount, details.videoCount,
          details.thumbnail || null,
          `Matched search: "${query}"`,
        );
        suggestedIds.add(details.channelId);
        added++;
      }
    } catch (err: any) {
      console.error(`[competitor-discovery] query "${query}" failed: ${err.message}`);
    }
  }

  console.log(`[competitor-discovery] ${added} new suggestions written`);
  return added;
}
