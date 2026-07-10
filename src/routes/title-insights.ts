import { FastifyInstance } from 'fastify';
import { authMiddleware } from '../middleware/auth.js';
import { computeTitleCorpus, computeTitleAbUplift } from '../services/title-insights.js';
import { computeTagUplift } from '../services/learnings.js';
import { tagAllVideos, tagAllVariants, ensureTitleSchema } from '../services/title-tagger.js';

function splitTags(tags: any[]) {
  const usable = tags.filter(t => (t.tests || 0) >= 2);
  const ranked = [...usable].sort((a, b) => b.avg_uplift_pct - a.avg_uplift_pct);
  return {
    total: usable.length,
    winners: ranked.filter(t => t.avg_uplift_pct > 0 || t.win_rate >= 0.5).slice(0, 8),
    losers: ranked.filter(t => t.avg_uplift_pct < 0 && t.win_rate < 0.5).slice(0, 6),
  };
}

export async function titleInsightsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware);

  // GET /title-insights -- corpus + A/B title-tag analysis, split by content type
  app.get('/title-insights', async () => {
    ensureTitleSchema();
    return { corpus: computeTitleCorpus(), ab: computeTitleAbUplift() };
  });

  // GET /what-works -- unified titles + thumbnails, split by content type, with a
  // time window (7 / 30 / all). Recomputes live, so it keeps updating as tests
  // complete and new videos/competitor videos come in.
  app.get('/what-works', async (request) => {
    ensureTitleSchema();
    const { since } = request.query as { since?: string };
    const sinceDays = since === '7' ? 7 : since === '30' ? 30 : undefined;
    const titleAb = computeTitleAbUplift(2, sinceDays);
    return {
      since: sinceDays || null,
      titles: { podcast: splitTags(titleAb.podcast || []), TNTL: splitTags(titleAb.TNTL || []) },
      thumbnails: {
        podcast: splitTags(computeTagUplift(2, 'podcast', sinceDays)),
        TNTL: splitTags(computeTagUplift(2, 'TNTL', sinceDays)),
      },
    };
  });

  // GET /growth -- one synthesised view: where we trail the benchmark by format,
  // and the specific proven levers to close it. All computed (free).
  app.get('/growth', async () => {
    const { getDb } = await import('../db/client.js');
    const db = getDb();
    const our = (cat: string) => { const r = db.prepare(`SELECT AVG(view_count) a FROM yt.videos WHERE category = ? AND view_count > 0`).get(cat) as any; return Math.round(r?.a || 0); };
    const comp = (min: number, max: number) => { const r = db.prepare(`SELECT AVG(views) a FROM competitor_videos WHERE duration_seconds >= ? AND duration_seconds < ? AND views > 0`).get(min, max) as any; return Math.round(r?.a || 0); };
    const ourPodcast = our('podcast'), ourReaction = our('reaction');
    const benchPodcast = comp(1500, 99999), benchClip = comp(90, 1500);
    const titleAb = computeTitleAbUplift(2);
    const top = (arr: any[]) => [...arr].filter(t => t.tests >= 2).sort((a, b) => b.avg_uplift_pct - a.avg_uplift_pct).filter(t => t.avg_uplift_pct > 0 || t.win_rate >= 0.5).slice(0, 4).map(t => ({ name: t.name, uplift: t.avg_uplift_pct }));
    return {
      formats: [
        { format: 'Podcast (full episodes)', ours: ourPodcast, benchmark: benchPodcast, ratio: ourPodcast > 0 ? +(benchPodcast / ourPodcast).toFixed(1) : null },
        { format: 'Reaction / clips', ours: ourReaction, benchmark: benchClip, ratio: ourReaction > 0 ? +(benchClip / ourReaction).toFixed(1) : null },
      ],
      levers: {
        titlePodcast: top(titleAb.podcast || []),
        titleTNTL: top(titleAb.TNTL || []),
        thumbPodcast: top(computeTagUplift(2, 'podcast')),
        thumbTNTL: top(computeTagUplift(2, 'TNTL')),
      },
    };
  });

  // POST /title-insights/retag -- (re)tag all video titles and title variants
  app.post('/title-insights/retag', async (request) => {
    const body = (request.body || {}) as { semantic?: boolean };
    const semantic = body.semantic !== false;
    const videos = await tagAllVideos({ semantic });
    const variants = await tagAllVariants({ semantic });
    return { videos, variants };
  });
}
