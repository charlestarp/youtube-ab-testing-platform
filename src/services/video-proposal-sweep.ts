import { getDb } from '../db/client.js';
import { generateVideoProposalPack, videoProposalExists } from './episode-proposals.js';
import { classifyContent } from './content-type.js';

// Find channel_videos published in last 45 days with no running/completed test
// and no existing proposal, then generate a proposal pack for each.
// Runs once on startup and then daily. Capped at 3 per run to keep costs modest.
export async function scanAndGenerateVideoProposals(): Promise<void> {
  const db = getDb();

  let videos: { video_id: string; title: string; duration_seconds: number | null }[] = [];
  try {
    videos = db.prepare(`
      SELECT cv.video_id, cv.title, cv.duration_seconds
      FROM channel_videos cv
      WHERE cv.published_at >= datetime('now', '-45 days')
        AND cv.is_short = 0
        AND cv.title IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM tests t
          WHERE t.video_id = cv.video_id
            AND t.status IN ('running', 'completed', 'paused')
        )
      ORDER BY cv.published_at DESC
      LIMIT 10
    `).all() as any[];
  } catch (e: any) {
    console.error('[video-proposals] DB query failed:', e?.message);
    return;
  }

  let generated = 0;
  for (const v of videos) {
    if (generated >= 3) break;
    if (!v.title?.trim()) continue;
    if (videoProposalExists(v.video_id)) continue;

    try {
      const contentType = classifyContent(v.title, null);
      await generateVideoProposalPack(v.video_id, v.title, contentType);
      console.log(`[video-proposals] generated pack for ${v.video_id} "${v.title}"`);
      generated++;
    } catch (e: any) {
      console.error(`[video-proposals] failed for ${v.video_id}: ${e?.message}`);
    }
  }

  if (generated > 0) console.log(`[video-proposals] sweep complete: ${generated} packs generated`);
}
