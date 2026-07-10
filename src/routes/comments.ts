import { FastifyInstance } from 'fastify';
import { getDb } from '../db/client.js';
import { authMiddleware } from '../middleware/auth.js';

export async function commentRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware);

  // GET /comments -- list comments with filters
  app.get('/comments', async (request) => {
    const { channel_id, sentiment, mentions_us, search, limit, offset } = request.query as any;
    const db = getDb();

    let sql = `SELECT c.*,
      COALESCE(v.title, cv.title) as video_title,
      COALESCE(v.thumbnail_url, cv.thumbnail_url) as video_thumbnail
      FROM comments c
      LEFT JOIN yt.videos v ON c.video_id = v.video_id
      LEFT JOIN competitor_videos cv ON c.video_id = cv.video_id
      WHERE 1=1`;
    const params: any[] = [];

    if (channel_id) { sql += ' AND c.channel_id = ?'; params.push(channel_id); }
    if (sentiment) { sql += ' AND c.sentiment = ?'; params.push(sentiment); }
    if (mentions_us === '1') { sql += ' AND c.mentions_us = 1'; }
    if (search) { sql += ' AND c.content LIKE ?'; params.push(`%${search}%`); }

    sql += ' ORDER BY c.published_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit || '100'), parseInt(offset || '0'));

    return db.prepare(sql).all(...params);
  });

  // GET /comments/topics -- trending topics
  app.get('/comments/topics', async () => {
    const db = getDb();
    return db.prepare('SELECT * FROM comment_topics ORDER BY count DESC LIMIT 50').all();
  });

  // GET /comments/mentions -- comments mentioning Toni and Ryan
  app.get('/comments/mentions', async (request) => {
    const { limit } = request.query as { limit?: string };
    const db = getDb();
    return db.prepare(`
      SELECT c.*,
        COALESCE(v.title, cv.title) as video_title,
        COALESCE(v.thumbnail_url, cv.thumbnail_url) as video_thumbnail
      FROM comments c
      LEFT JOIN yt.videos v ON c.video_id = v.video_id
      LEFT JOIN competitor_videos cv ON c.video_id = cv.video_id
      WHERE c.mentions_us = 1 ORDER BY c.published_at DESC LIMIT ?
    `).all(parseInt(limit || '50'));
  });

  // GET /comments/stats -- sentiment breakdown
  app.get('/comments/stats', async () => {
    const db = getDb();
    const total = (db.prepare('SELECT COUNT(*) as c FROM comments').get() as any).c;
    const bysentiment = db.prepare(
      'SELECT sentiment, COUNT(*) as count FROM comments GROUP BY sentiment'
    ).all();
    const recentMentions = (db.prepare(
      "SELECT COUNT(*) as c FROM comments WHERE mentions_us = 1 AND published_at > datetime('now', '-7 days')"
    ).get() as any).c;

    return { total, by_sentiment: bysentiment, recent_mentions: recentMentions };
  });

  // POST /comments/scrape -- manual trigger
  app.post('/comments/scrape', async () => {
    const { scrapeComments } = await import('../services/comment-scraper.js');
    const result = await scrapeComments();
    return result;
  });
}
