import { FastifyInstance } from 'fastify';
import { getDb } from '../db/client.js';
import { authMiddleware } from '../middleware/auth.js';

// The 1,020-channel research dataset (Social Blade history + metadata), loaded via
// scripts/load_research_data.py. Powers the redesigned competitor intelligence pages.
export async function researchRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware);

  // GET /research/channels — browsable/sortable list of all pulled channels
  //   ?sort=subs|growth|views|videos  ?q=search  ?core=1  ?limit= ?offset=
  app.get('/research/channels', async (request) => {
    const db = getDb();
    const { sort = 'subs', q, core, limit = '200', offset = '0' } = request.query as any;
    const where: string[] = [];
    const params: any[] = [];
    if (q) { where.push('(name LIKE ? OR handle LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
    if (core === '1') where.push('is_core = 1');
    // growth sort needs a real base to avoid tiny-base % artifacts
    let orderBy = 'subs DESC';
    if (sort === 'growth') { where.push('has_history = 1 AND subs_start_365 >= 20000'); orderBy = 'growth_365_pct DESC'; }
    else if (sort === 'views') orderBy = 'views DESC';
    else if (sort === 'videos') orderBy = 'videos DESC';
    const sql = `SELECT channel_id, name, handle, youtube_url, subs, views, videos, country,
      channel_type, created, grade, avatar, source, is_core, growth_365_pct, has_history
      FROM research_channels ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY ${orderBy} LIMIT ? OFFSET ?`;
    params.push(parseInt(limit), parseInt(offset));
    const rows = db.prepare(sql).all(...params);
    const total = (db.prepare(`SELECT COUNT(*) c FROM research_channels ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`)
      .get(...params.slice(0, params.length - 2)) as any).c;
    return { total, count: rows.length, channels: rows };
  });

  // GET /research/core — the pinned Core competitor set
  app.get('/research/core', async () => {
    const db = getDb();
    return db.prepare(`SELECT channel_id, name, handle, youtube_url, subs, views, videos,
      country, channel_type, created, grade, avatar, growth_365_pct
      FROM research_channels WHERE is_core = 1 ORDER BY subs DESC`).all();
  });

  // POST /research/core/:id — pin/unpin a channel as core (build toward Core 20)
  app.post('/research/core/:id', async (request) => {
    const db = getDb();
    const { id } = request.params as any;
    const { core } = request.body as any;
    db.prepare('UPDATE research_channels SET is_core = ? WHERE channel_id = ?').run(core ? 1 : 0, id);
    return { ok: true };
  });

  // GET /research/channels/:id — deep dive: profile + 3yr history curve
  app.get('/research/channels/:id', async (request) => {
    const db = getDb();
    const { id } = request.params as any;
    const channel = db.prepare('SELECT * FROM research_channels WHERE channel_id = ?').get(id);
    if (!channel) return { error: 'not found' };
    const history = db.prepare(`SELECT date, subs, views, videos FROM research_channel_history
      WHERE channel_id = ? ORDER BY date`).all(id);
    // monthly downsample for charting + biggest sub-jump months
    const monthly: Record<string, any> = {};
    for (const h of history as any[]) monthly[(h.date || '').slice(0, 7)] = h;
    const ms = Object.entries(monthly).sort();
    const jumps = ms.slice(1).map(([m], i) => ({
      month: m, subs_gained: ((ms[i + 1][1] as any).subs || 0) - ((ms[i][1] as any).subs || 0),
    })).filter(j => j.subs_gained > 0).sort((a, b) => b.subs_gained - a.subs_gained).slice(0, 5);
    return { channel, history, monthly: ms.map(([m, v]) => ({ month: m, ...(v as any) })), top_jumps: jumps };
  });

  // GET /research/stats — dataset summary + benchmark leaders (min-base guarded)
  app.get('/research/stats', async () => {
    const db = getDb();
    const summary = db.prepare(`SELECT COUNT(*) channels, SUM(is_core) core,
      SUM(has_history) with_history FROM research_channels`).get();
    const fastest = db.prepare(`SELECT name, handle, youtube_url, subs, growth_365_pct
      FROM research_channels WHERE has_history = 1 AND subs_start_365 >= 20000
      ORDER BY growth_365_pct DESC LIMIT 15`).all();
    return { summary, fastest };
  });
}
