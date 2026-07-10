import { FastifyInstance } from 'fastify';
import { authMiddleware } from '../middleware/auth.js';
import {
  computeTestConfidence,
  computeTagUplift,
  computePortfolio,
  computeBrandMentions,
} from '../services/learnings.js';
import { computeTitleAbUplift, type AbTitleTag } from '../services/title-insights.js';
import type { ContentType } from '../services/content-type.js';
import { computeDataIntegrity } from '../services/data-integrity.js';

export async function learningsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware);

  // GET /learnings?type=podcast|TNTL -- the "what we've learned" payload.
  // Omit type for everything pooled; pass a type to see that content type only.
  app.get('/learnings', async (request) => {
    const q = (request.query as any)?.type;
    const type = q === 'podcast' || q === 'TNTL' ? q : undefined;
    const tests = computeTestConfidence(type);
    const portfolio = computePortfolio(tests);
    const tags = computeTagUplift(3, type);
    const mentions = computeBrandMentions();

    const proven = tags.filter(t => t.verdict === 'proven');
    const promising = tags.filter(t => t.verdict === 'promising');
    // "busted" = genuinely underperformed. "inconclusive" = coin flip, not enough
    // data yet (NOT a failure). Keep them separate so a small unproven win is not
    // mislabelled as busted.
    const busted = tags.filter(t => t.verdict === 'weak');
    const inconclusive = tags.filter(t => t.verdict === 'coinflip');

    // Title A/B pattern uplift (head-to-head, same video, title changed).
    // Flatten from per-type to a single list respecting the content type filter.
    const titleAbRaw = computeTitleAbUplift(2);
    const titleAbFlat: AbTitleTag[] = type
      ? (titleAbRaw[type as ContentType] || [])
      : [...(titleAbRaw.podcast || []), ...(titleAbRaw.TNTL || [])];
    const provenTitles = titleAbFlat.filter((t: AbTitleTag) => t.verdict === 'proven');
    const promisingTitles = titleAbFlat.filter((t: AbTitleTag) => t.verdict === 'promising');
    const bustedTitles = titleAbFlat.filter((t: AbTitleTag) => t.verdict === 'weak');
    const inconclusiveTitles = titleAbFlat.filter((t: AbTitleTag) => t.verdict === 'coinflip');

    // Biggest confident wins, for the highlight reel.
    const topWins = tests
      .filter(t => t.tier === 'confident')
      .sort((a, b) => b.lift_pct - a.lift_pct)
      .slice(0, 8);

    return { portfolio, proven, promising, busted, inconclusive, provenTitles, promisingTitles, bustedTitles, inconclusiveTitles, topWins, tests, mentions };
  });

  // GET /learnings/portfolio -- lightweight summary for the dashboard
  app.get('/learnings/portfolio', async () => {
    return computePortfolio(computeTestConfidence());
  });

  // GET /data-integrity -- audit of measurement data-quality issues
  app.get('/data-integrity', async () => computeDataIntegrity());

  // GET /metric-health -- live scorecard of every data pipeline (stale/zero/impossible)
  app.get('/metric-health', async () => {
    const { computeMetricHealth } = await import('../services/metric-health.js');
    return computeMetricHealth();
  });

  // GET /deep-audit -- latest nightly Studio ground-truth comparison (?run=1 recomputes now)
  app.get('/deep-audit', async (request) => {
    const { runDeepAudit, readLatestReport } = await import('../services/deep-audit.js');
    if ((request.query as any)?.run === '1') return runDeepAudit();
    return readLatestReport() || { rows: [], note: 'no nightly report yet; pass ?run=1 to compute now' };
  });
}
