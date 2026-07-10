import { FastifyInstance } from 'fastify';
import { authMiddleware } from '../middleware/auth.js';
import { config } from '../config.js';

const FALLBACK_CHANNEL_ID = 'UCkhy7g4GvHuzhbzTVjc8izQ';

// 60-second in-memory cache for the live-subs endpoint.
let _liveSubsCache: { subscribers_exact: number; subs_per_second: number; source: string; fetched_at: string } | null = null;
let _liveSubsCachedAt = 0;
import { scoreTitle } from '../services/viral-score.js';
import { getGrowthProjections } from '../services/growth-projections.js';
import { findSEOGaps } from '../services/seo-finder.js';
import { detectFatigue } from '../services/fatigue-tracker.js';
import { getChannelBenchmarks } from '../services/benchmarks.js';
import { getDb } from '../db/client.js';
import { computeForecast } from '../services/channel-forecast.js';

// 10-minute cache for the forecast (DB-heavy computation).
let _forecastCache: ReturnType<typeof computeForecast> | null = null;
let _forecastCachedAt = 0;

export async function analyticsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware);

  // POST /analytics/viral-score — score a proposed title
  app.post('/analytics/viral-score', async (request) => {
    const { title } = request.body as { title: string };
    if (!title) return { detail: 'title required' };
    return scoreTitle(title);
  });

  // GET /analytics/growth — growth projections
  app.get('/analytics/growth', async () => {
    return getGrowthProjections();
  });

  // GET /analytics/seo-gaps — SEO gap analysis
  app.get('/analytics/seo-gaps', async () => {
    return findSEOGaps();
  });

  // GET /analytics/fatigue — fatigue detection
  app.get('/analytics/fatigue', async () => {
    return detectFatigue();
  });

  // GET /analytics/benchmarks — channel benchmarks
  app.get('/analytics/benchmarks', async () => {
    return getChannelBenchmarks();
  });

  // GET /analytics/channel-stats — daily sub/view snapshots + 2026 goal tracker
  app.get('/analytics/channel-stats', async () => {
    const db = getDb();

    // Latest snapshot and 60-day history (for sparkline)
    let latest: any = null;
    let history: any[] = [];
    try {
      latest  = db.prepare(`SELECT * FROM channel_stats ORDER BY date DESC LIMIT 1`).get();
      history = db.prepare(`SELECT * FROM channel_stats ORDER BY date DESC LIMIT 60`).all() as any[];
    } catch { /* table not yet created */ }

    // Rolling avg views of the 30 most recently published podcast videos
    let podcastAvg30 = 0;
    try {
      const row = db.prepare(`
        SELECT AVG(view_count) AS avg_views
        FROM (
          SELECT view_count FROM yt.videos
          WHERE category = 'podcast' AND view_count > 0
          ORDER BY publish_date DESC
          LIMIT 30
        )
      `).get() as any;
      podcastAvg30 = Math.round(row?.avg_views || 0);
    } catch {}

    // Goal constants
    const SUBS_GOAL  = 1_000_000;
    const VIEWS_GOAL =    65_000;
    const DEADLINE   = new Date('2026-12-31T23:59:59Z');
    const now        = new Date();
    const daysLeft   = Math.max(0, Math.ceil((DEADLINE.getTime() - now.getTime()) / 86_400_000));
    const monthsLeft = daysLeft / 30.44;

    const currentSubs = (latest?.subscriber_count as number) || 0;

    // Compound monthly growth rate needed: goal = current * (1+r)^months
    function monthlyGrowthNeeded(current: number, goal: number, months: number): number | null {
      if (current <= 0 || months <= 0) return null;
      if (current >= goal) return 0;
      return parseFloat((Math.pow(goal / current, 1 / months) - 1).toFixed(4));
    }

    const subsGrowthNeeded  = monthlyGrowthNeeded(currentSubs,   SUBS_GOAL,  monthsLeft);
    const viewsGrowthNeeded = monthlyGrowthNeeded(podcastAvg30, VIEWS_GOAL, monthsLeft);

    return {
      latest,
      history,
      goals: {
        subs_goal:    SUBS_GOAL,
        views_goal:   VIEWS_GOAL,
        deadline:     '2026-12-31',
        days_left:    daysLeft,
        months_left:  parseFloat(monthsLeft.toFixed(1)),
        current_subs: currentSubs,
        podcast_avg_views_30ep: podcastAvg30,
        subs_monthly_growth_needed:  subsGrowthNeeded,
        views_monthly_growth_needed: viewsGrowthNeeded,
      },
    };
  });

  // GET /channel/live-subs — exact subscriber count from Studio with 60s cache.
  // Primary: Firefox Studio session (exact). Fallback: Data API (rounded to 3 sig figs).
  app.get('/channel/live-subs', async (_req, reply) => {
    const now = Date.now();
    if (_liveSubsCache && now - _liveSubsCachedAt < 60_000) {
      return _liveSubsCache;
    }

    let count: number | null = null;
    let source = 'studio';

    // Try Studio first — exact, unrounded.
    try {
      const { fetchExactSubscriberCount } = await import('../services/studio-fetch.js');
      count = await fetchExactSubscriberCount();
    } catch (e: any) {
      console.error('[live-subs] Studio fetch failed:', e?.message);
    }

    // Fall back to Data API (will be rounded by YouTube).
    if (count === null) {
      source = 'data_api';
      try {
        const channelId = config.youtubeChannelId || FALLBACK_CHANNEL_ID;
        const key = config.youtubeApiKey;
        const res = await fetch(`https://www.googleapis.com/youtube/v3/channels?part=statistics&id=${channelId}&key=${encodeURIComponent(key)}`);
        const data = await res.json() as any;
        const raw = data.items?.[0]?.statistics?.subscriberCount;
        if (raw) count = parseInt(raw);
      } catch (e: any) {
        console.error('[live-subs] Data API fallback failed:', e?.message);
      }
    }

    if (count === null) {
      reply.code(503);
      return { detail: 'Subscriber count temporarily unavailable' };
    }

    // Derive a per-second growth rate from our own daily subscriber history so the
    // goals card can tick a LIVE counter between YouTube's rounded updates — exactly
    // how public live sub counters (and TARP Command / chief) work: known count +
    // real growth rate. Honest estimate: real base, real trend, interpolated forward.
    let subsPerSecond = 0;
    try {
      const db = getDb();
      const span: any = db.prepare(`SELECT MIN(subscriber_count) lo, MAX(subscriber_count) hi,
        (julianday(MAX(date)) - julianday(MIN(date))) days FROM channel_stats
        WHERE date >= date('now','-30 days') AND subscriber_count > 0`).get();
      if (span && span.days > 0 && span.hi > span.lo) subsPerSecond = (span.hi - span.lo) / (span.days * 86400);
      // Rounded daily snapshots can show no 30-day delta; widen to 90d for a rate.
      if (!subsPerSecond) {
        const s90: any = db.prepare(`SELECT MIN(subscriber_count) lo, MAX(subscriber_count) hi,
          (julianday(MAX(date)) - julianday(MIN(date))) days FROM channel_stats
          WHERE date >= date('now','-90 days') AND subscriber_count > 0`).get();
        if (s90 && s90.days > 0 && s90.hi > s90.lo) subsPerSecond = (s90.hi - s90.lo) / (s90.days * 86400);
      }
    } catch { /* fall through to the forecast rate */ }
    // Still no rate (rounded history has no delta) → use the forecast's median
    // daily rate, derived from real 30-day history. Same fallback chief uses.
    if (!subsPerSecond) {
      try {
        const perDay = (computeForecast(count).daily_rates as any)?.median;
        if (perDay > 0) subsPerSecond = perDay / 86400;
      } catch { /* ticker holds steady if no rate anywhere */ }
    }

    _liveSubsCache = { subscribers_exact: count, subs_per_second: subsPerSecond, source, fetched_at: new Date().toISOString() };
    _liveSubsCachedAt = now;
    return _liveSubsCache;
  });

  // GET /channel/forecast — goal-date forecast for subscribers and avg long-form views.
  // Cached for 10 minutes; pass ?refresh=1 to bust.
  app.get('/channel/forecast', async (request) => {
    const { refresh } = request.query as { refresh?: string };
    const now = Date.now();
    if (!refresh && _forecastCache && now - _forecastCachedAt < 10 * 60_000) {
      return _forecastCache;
    }
    // Inject the live exact sub count if available and fresher than the cache.
    const currentSubs = _liveSubsCache?.subscribers_exact ?? undefined;
    _forecastCache = computeForecast(currentSubs);
    _forecastCachedAt = now;
    return _forecastCache;
  });
}
