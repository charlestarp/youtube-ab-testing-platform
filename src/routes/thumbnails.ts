import { FastifyInstance } from 'fastify';
import { getDb } from '../db/client.js';
import { authMiddleware } from '../middleware/auth.js';

export async function thumbnailRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware);

  // GET /thumbnails/insights -- our channel insights (optional content_type=podcast|reaction)
  app.get('/thumbnails/insights', async (request) => {
    const { content_type } = request.query as { content_type?: string };
    const { getThumbnailInsights } = await import('../services/thumbnail-analyzer.js');
    return getThumbnailInsights(content_type);
  });

  // GET /thumbnails/competitor-insights -- competitor insights
  app.get('/thumbnails/competitor-insights', async () => {
    const { getCompetitorThumbnailInsights } = await import('../services/thumbnail-analyzer.js');
    return getCompetitorThumbnailInsights();
  });

  // GET /thumbnails/comparison -- side-by-side us vs competitors
  app.get('/thumbnails/comparison', async () => {
    const { getThumbnailComparison } = await import('../services/thumbnail-analyzer.js');
    return getThumbnailComparison();
  });

  // GET /thumbnails/analyzed -- list analyzed thumbnails with filters
  app.get('/thumbnails/analyzed', async (request) => {
    const { sort, expression, color, limit } = request.query as {
      sort?: string; expression?: string; color?: string; limit?: string;
    };
    const db = getDb();
    let sql = 'SELECT ta.*, v.publish_date FROM thumbnail_analysis ta LEFT JOIN yt.videos v ON ta.video_id = v.video_id WHERE 1=1';
    const params: any[] = [];

    if (expression) { sql += ' AND ta.expression = ?'; params.push(expression); }
    if (color) { sql += ' AND ta.primary_color = ?'; params.push(color); }

    const sortCol = sort === 'ctr' ? 'ta.ctr' : sort === 'date' ? 'ta.analyzed_at' : 'ta.views';
    sql += ` ORDER BY ${sortCol} DESC LIMIT ?`;
    params.push(parseInt(limit || '100'));

    return db.prepare(sql).all(...params);
  });

  // POST /thumbnails/analyze -- trigger analysis for our thumbnails
  app.post('/thumbnails/analyze', async (request) => {
    const { limit } = (request.body || {}) as { limit?: number };
    const { analyzeAllThumbnails } = await import('../services/thumbnail-analyzer.js');
    const result = await analyzeAllThumbnails(limit || 20);
    return result;
  });

  // POST /thumbnails/analyze-competitors -- trigger competitor thumbnail analysis (per channel)
  app.post('/thumbnails/analyze-competitors', async (request) => {
    const { per_channel } = (request.body || {}) as { per_channel?: number };
    const { analyzeCompetitorThumbnails } = await import('../services/thumbnail-analyzer.js');
    const result = await analyzeCompetitorThumbnails(per_channel || 50);
    return result;
  });

  // POST /thumbnails/analyze-one -- analyze a specific video
  app.post('/thumbnails/analyze-one', async (request) => {
    const { video_id } = request.body as { video_id: string };
    if (!video_id) return { detail: 'video_id required' };

    const db = getDb();
    const video = db.prepare('SELECT video_id, title, thumbnail_url, view_count FROM yt.videos WHERE video_id = ?').get(video_id) as any;
    if (!video) return { detail: 'Video not found' };

    let ctr = 0;
    try {
      const snap = db.prepare('SELECT ctr FROM studio_snapshots WHERE video_id = ? ORDER BY scraped_at DESC LIMIT 1').get(video_id) as any;
      if (snap) ctr = snap.ctr;
    } catch {}

    const { analyzeThumbnail } = await import('../services/thumbnail-analyzer.js');
    const result = await analyzeThumbnail(video.video_id, video.thumbnail_url, video.title, video.view_count, ctr);
    return result || { detail: 'Analysis failed' };
  });

  // GET /thumbnails/stats -- summary stats
  app.get('/thumbnails/stats', async () => {
    const db = getDb();
    const total = (db.prepare('SELECT COUNT(*) as c FROM thumbnail_analysis').get() as any).c;
    const unanalyzed = (db.prepare(`
      SELECT COUNT(*) as c FROM yt.videos v
      LEFT JOIN thumbnail_analysis ta ON v.video_id = ta.video_id
      WHERE ta.id IS NULL AND v.duration_seconds > 180 AND v.thumbnail_url IS NOT NULL
    `).get() as any).c;

    let compTotal = 0;
    let compUnanalyzed = 0;
    try {
      compTotal = (db.prepare('SELECT COUNT(*) as c FROM competitor_thumbnail_analysis').get() as any).c;
      compUnanalyzed = (db.prepare(`
        SELECT COUNT(*) as c FROM competitor_videos cv
        LEFT JOIN competitor_thumbnail_analysis cta ON cv.video_id = cta.video_id
        WHERE cta.id IS NULL AND cv.duration_seconds > 180 AND cv.thumbnail_url IS NOT NULL
      `).get() as any).c;
    } catch {}

    return {
      total_analyzed: total,
      unanalyzed,
      total_videos: total + unanalyzed,
      competitor_analyzed: compTotal,
      competitor_unanalyzed: compUnanalyzed,
    };
  });
}
