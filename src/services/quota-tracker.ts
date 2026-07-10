/**
 * YouTube API quota tracker.
 * Logs each API call with its unit cost and provides daily usage stats.
 */

import { getDb } from '../db/client.js';

const UNIT_COSTS: Record<string, number> = {
  'thumbnails.set': 50,
  'videos.update': 50,
  'videos.list': 1,
  'search.list': 100,
  'channels.list': 1,
  'playlistItems.list': 1,
  'commentThreads.list': 1,
};

export function logQuota(action: string, testId?: number, videoId?: string): void {
  const db = getDb();
  const units = UNIT_COSTS[action] || 1;
  db.prepare('INSERT INTO quota_log (action, units, test_id, video_id) VALUES (?, ?, ?, ?)').run(
    action, units, testId || null, videoId || null
  );
}

export function getTodayUsage(): { total: number; remaining: number; breakdown: { action: string; units: number; count: number }[] } {
  const db = getDb();
  const today = new Date().toISOString().split('T')[0];

  const total = (db.prepare(
    "SELECT COALESCE(SUM(units), 0) as total FROM quota_log WHERE created_at >= ?"
  ).get(today + 'T00:00:00') as any).total;

  const breakdown = db.prepare(`
    SELECT action, SUM(units) as units, COUNT(*) as count
    FROM quota_log WHERE created_at >= ?
    GROUP BY action ORDER BY units DESC
  `).all(today + 'T00:00:00') as any[];

  return { total, remaining: 10000 - total, breakdown };
}

export function getQuotaHistory(days = 7): { date: string; units: number }[] {
  const db = getDb();
  return db.prepare(`
    SELECT date(created_at) as date, SUM(units) as units
    FROM quota_log WHERE created_at >= date('now', '-' || ? || ' days')
    GROUP BY date(created_at) ORDER BY date
  `).all(days) as any[];
}
