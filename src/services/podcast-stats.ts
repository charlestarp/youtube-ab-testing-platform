/**
 * Pulls an episode's CURRENT reach from the podcast analytics DB
 * (podcast.example.com, ~/Projects/podcast-analytics/data/podcast.db), matched
 * by YouTube video_id via its episode_yt_match table. Gives the AI the full
 * "where is this episode at right now" picture: audio listens + unique
 * listeners + Acast/Spotify video views + a performance index vs the channel.
 *
 * Opened read-only in its own connection so it never touches the analytics app.
 */
import Database from 'better-sqlite3';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const DB_PATH = process.env.PODCAST_ANALYTICS_DB || join(homedir(), 'Projects/podcast-analytics/data/podcast.db');

let db: Database.Database | null | false = null; // null=unopened, false=unavailable
function conn(): Database.Database | null {
  if (db === false) return null;
  if (db) return db;
  try {
    if (!existsSync(DB_PATH)) { db = false; return null; }
    db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
    return db;
  } catch { db = false; return null; }
}

export interface PodcastStats {
  title: string | null;
  listens: number;
  unique_listeners: number;
  video_views: number;        // Acast video
  spotify_video_views: number;
  perf_index: number | null;  // vs channel norm; ~1.0 = average
  yt_views: number | null;    // current YouTube views from the analytics sync
}

export function getPodcastStats(videoId: string): PodcastStats | null {
  const d = conn();
  if (!d) return null;
  try {
    const ep = d.prepare(`
      SELECT e.title, e.total_listens AS listens, e.total_unique_listeners AS uniq,
             e.video_views, e.spotify_video_views, e.perf_index
      FROM episode_yt_match m JOIN episodes e ON e.episode_id = m.episode_id
      WHERE m.video_id = ?
    `).get(videoId) as any;
    if (!ep) return null;
    let yt_views: number | null = null;
    try { yt_views = (d.prepare(`SELECT view_count FROM yt_videos WHERE video_id = ?`).get(videoId) as any)?.view_count ?? null; } catch {}
    return {
      title: ep.title ?? null,
      listens: ep.listens || 0,
      unique_listeners: ep.uniq || 0,
      video_views: ep.video_views || 0,
      spotify_video_views: ep.spotify_video_views || 0,
      perf_index: ep.perf_index ?? null,
      yt_views,
    };
  } catch {
    return null;
  }
}
