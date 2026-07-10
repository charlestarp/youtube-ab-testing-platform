/**
 * YouTube video sync — fetches latest videos from YouTube Data API
 * and writes to the shared youtube.db (same DB TARPGPT uses).
 * Runs daily to keep videos up to date.
 */

import { google } from 'googleapis';
import Database from 'better-sqlite3';
import { config } from '../config.js';

const PLAYLISTS = {
  podcast: 'PLxUiuoZDlKOeSluhzc5PiTNyP-0D3aWsk',
  reaction: 'PLxUiuoZDlKOdyiO5F6qVlfvd6y2XCm0n2',
};

function parseDuration(iso: string): number {
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  return (parseInt(match[1] || '0') * 3600) +
         (parseInt(match[2] || '0') * 60) +
         parseInt(match[3] || '0');
}

export async function syncVideoMetadata(): Promise<{ synced: number; total: number }> {
  if ((!config.youtubeApiKey && config.youtubeApiKeys.length === 0) || !config.youtubeDbPath) {
    console.log('[yt-sync] Missing API key or DB path, skipping');
    return { synced: 0, total: 0 };
  }

  const { getApiKey } = await import('./youtube-api.js');
  const yt = google.youtube({ version: 'v3', auth: getApiKey() });

  // Open the shared youtube.db directly (not through ATTACH)
  const db = new Database(config.youtubeDbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  const upsert = db.prepare(`
    INSERT INTO videos (video_id, title, description, publish_date, thumbnail_url,
                        duration_seconds, view_count, like_count, comment_count,
                        tags_json, category, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(video_id) DO UPDATE SET
      title = excluded.title,
      view_count = excluded.view_count,
      like_count = excluded.like_count,
      comment_count = excluded.comment_count,
      thumbnail_url = excluded.thumbnail_url,
      fetched_at = datetime('now')
  `);

  let totalSynced = 0;
  let totalVideos = 0;

  for (const [category, playlistId] of Object.entries(PLAYLISTS)) {
    // Fetch all video IDs from playlist
    const videoIds: string[] = [];
    let pageToken: string | undefined;

    do {
      const res = await yt.playlistItems.list({
        part: ['contentDetails'],
        playlistId,
        maxResults: 50,
        pageToken,
      });
      for (const item of res.data.items || []) {
        const vid = item.contentDetails?.videoId;
        if (vid) videoIds.push(vid);
      }
      pageToken = res.data.nextPageToken || undefined;
    } while (pageToken);

    // Fetch video details in batches of 50
    for (let i = 0; i < videoIds.length; i += 50) {
      const batch = videoIds.slice(i, i + 50);
      const res = await yt.videos.list({
        part: ['snippet', 'contentDetails', 'statistics'],
        id: batch,
      });

      for (const v of res.data.items || []) {
        const dur = parseDuration(v.contentDetails?.duration || '');
        if (dur <= 60) continue; // Skip shorts

        const snippet = v.snippet!;
        const stats = v.statistics!;

        upsert.run(
          v.id,
          snippet.title,
          (snippet.description || '').slice(0, 500),
          snippet.publishedAt?.split('T')[0] || '',
          snippet.thumbnails?.high?.url || snippet.thumbnails?.default?.url || '',
          dur,
          parseInt(stats.viewCount || '0'),
          parseInt(stats.likeCount || '0'),
          parseInt(stats.commentCount || '0'),
          JSON.stringify(snippet.tags || []),
          category,
        );
        totalSynced++;
      }
    }
    totalVideos += videoIds.length;
  }

  db.close();
  console.log(`[yt-sync] Synced ${totalSynced} videos (${totalVideos} total in playlists)`);
  return { synced: totalSynced, total: totalVideos };
}
