import { FastifyInstance } from 'fastify';
import { authMiddleware } from '../middleware/auth.js';

export async function retentionRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware);

  /**
   * GET /api/retention/moments
   * Returns drop/hold moments for recent videos, plus cross-video segment scorecard.
   * Used by the dashboard Retention section and the hub radar/brief.
   */
  app.get('/retention/moments', async (request) => {
    const { days, limit } = request.query as { days?: string; limit?: string };
    const { getVideoMoments, getSegmentScorecard } = await import('../services/retention-overlay.js');
    const videos = getVideoMoments(parseInt(days || '45'), parseInt(limit || '8'));
    const segment_scorecard = getSegmentScorecard();
    return { videos, segment_scorecard };
  });

  /**
   * GET /api/retention/moments/:video_id
   * Single video moments (hub or detail page use).
   */
  app.get('/retention/moments/:video_id', async (request, reply) => {
    const { video_id } = request.params as { video_id: string };
    const { getVideoMoments } = await import('../services/retention-overlay.js');
    const all = getVideoMoments(365, 200);
    const v = all.find(x => x.video_id === video_id);
    if (!v) { reply.code(404); return { detail: 'No retention moments for this video' }; }
    return v;
  });

  /**
   * POST /api/retention/moments/:video_id/compute
   * Trigger on-demand recompute for a specific video.
   */
  app.post('/retention/moments/:video_id/compute', async (request, reply) => {
    const { video_id } = request.params as { video_id: string };
    const { getDb } = await import('../db/client.js');
    const { computeAndStoreVideoMoments } = await import('../services/retention-overlay.js');
    const db = getDb();
    const row = db.prepare(`
      SELECT cv.video_id, cv.title, cv.duration_seconds, ss.retention_json
      FROM channel_videos cv
      JOIN studio_snapshots ss ON ss.video_id = cv.video_id
      WHERE cv.video_id = ? AND ss.retention_json IS NOT NULL AND ss.retention_json != ''
      ORDER BY ss.scraped_at DESC LIMIT 1
    `).get(video_id) as any;

    if (!row) { reply.code(404); return { detail: 'No retention data for this video' }; }
    const ok = computeAndStoreVideoMoments(row.video_id, row.title || '', row.retention_json, row.duration_seconds || 0);
    return { ok, video_id };
  });
}
