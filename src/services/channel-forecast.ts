import { getDb } from '../db/client.js';

export interface ForecastLever {
  id: string;
  label: string;
  description: string;
  subs_boost_days: number;   // positive = days sooner to 1M
  views_boost_days: number;  // positive = days sooner to 100k avg
}

export interface ChannelForecast {
  computed_at: string;
  data_days: number;
  confidence: 'low' | 'medium' | 'high';
  note: string;

  current_subs: number;
  subs_goal: number;
  subs_needed: number;
  daily_rates: { p25: number; median: number; p75: number };
  subs_forecast: {
    pessimistic_date: string | null;
    baseline_date: string | null;
    optimistic_date: string | null;
  };

  longform_uploads_per_week: number;
  compilation_pct: number;
  recent_compilation_avg_views: number;
  recent_standard_avg_views: number;
  current_30ep_avg: number;
  views_goal: number;
  views_forecast: {
    baseline_date: string | null;
    note: string;
  };

  levers: ForecastLever[];
  best_lever: ForecastLever | null;
}

const SUBS_GOAL = 1_000_000;
const VIEWS_GOAL = 65_000;

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (idx - lo) * ((sorted[hi] ?? sorted[lo]) - sorted[lo]);
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + Math.round(n));
  return r;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Title-pattern classification: compilation/viral format vs standard podcast episode.
function isCompilation(title: string): boolean {
  return /TRY NOT TO (LAUGH|CRINGE)|TOP \d+|BEST OF|COMPILATION|FUNNIEST MOMENTS|RANKED|REACTS?( TO)?|WORST.*EVER|FAILS? COMP/i.test(title);
}

// Sliding-window simulation: how many days until rolling avg of last 30 long-form episodes hits goal?
// current: views of last 30 videos (newest first).
function simulateViewsGoal(
  current: number[],
  newVideoAvg: number,
  uploadsPerWeek: number,
  goal: number,
): number | null {
  if (newVideoAvg <= 0 || uploadsPerWeek <= 0) return null;
  const window = [...current].slice(0, 30);
  while (window.length < 30) window.push(newVideoAvg); // pad if fewer than 30 videos exist
  const daysPerUpload = 7 / uploadsPerWeek;
  let days = 0;
  for (let i = 0; i < 400; i++) {
    const avg = window.reduce((s, v) => s + v, 0) / window.length;
    if (avg >= goal) return days;
    window.unshift(newVideoAvg);
    window.pop();
    days += daysPerUpload;
  }
  return null; // won't reach goal at this pace
}

export function computeForecast(currentSubs?: number): ChannelForecast {
  const db = getDb();
  const now = new Date();

  // ── Subscribers data ────────────────────────────────────────────────────
  const statsRow = db.prepare(
    `SELECT subscriber_count, subscriber_count_exact FROM channel_stats ORDER BY date DESC LIMIT 1`
  ).get() as any;
  const baseSubs = currentSubs
    ?? statsRow?.subscriber_count_exact
    ?? statsRow?.subscriber_count
    ?? 812_000;
  const subsNeeded = Math.max(0, SUBS_GOAL - baseSubs);

  // Daily net subscriber gain, aggregated from studio_snapshots over last 60 days.
  // Note: studio_snapshots.subscribers_net is per-video YouTube attribution —
  // summing across videos may exceed true channel net on high-virality days.
  const subsRows = db.prepare(`
    SELECT DATE(scraped_at) as day, SUM(subscribers_net) as net_subs
    FROM studio_snapshots
    WHERE scraped_at >= datetime('now', '-60 days')
    GROUP BY DATE(scraped_at)
    ORDER BY day
  `).all() as { day: string; net_subs: number }[];

  const dataDays = subsRows.length;
  const positiveDays = subsRows.filter(r => r.net_subs > 0).map(r => r.net_subs).sort((a, b) => a - b);

  const p25 = positiveDays.length >= 4 ? percentile(positiveDays, 0.25) : 400;
  const median = positiveDays.length >= 2 ? percentile(positiveDays, 0.5) : 1000;
  const p75 = positiveDays.length >= 4 ? percentile(positiveDays, 0.75) : 5000;

  const project = (rate: number): string | null => {
    if (subsNeeded <= 0) return isoDate(now);
    if (rate <= 0) return null;
    return isoDate(addDays(now, subsNeeded / rate));
  };

  // ── Long-form video views ────────────────────────────────────────────────
  // Last 30 long-form episodes for the rolling-avg goal; only those >21 days
  // old for the "mature" format averages (younger ones still accumulating).
  const last30 = db.prepare(`
    SELECT title, view_count, published_at
    FROM channel_videos
    WHERE is_short = 0 AND view_count > 0
    ORDER BY published_at DESC
    LIMIT 30
  `).all() as { title: string; view_count: number; published_at: string }[];

  const matureVideos = db.prepare(`
    SELECT title, view_count
    FROM channel_videos
    WHERE is_short = 0 AND view_count > 0
      AND published_at <= datetime('now', '-21 days')
    ORDER BY published_at DESC
    LIMIT 30
  `).all() as { title: string; view_count: number }[];

  const matureComp = matureVideos.filter(v => isCompilation(v.title));
  const matureStd  = matureVideos.filter(v => !isCompilation(v.title));
  const compAvg    = matureComp.length ? matureComp.reduce((s, v) => s + v.view_count, 0) / matureComp.length : 0;
  const stdAvg     = matureStd.length  ? matureStd.reduce( (s, v) => s + v.view_count, 0) / matureStd.length  : 0;

  // Current rolling-30 avg uses ALL last 30, including very recent (true current state).
  const current30Avg = last30.length ? last30.reduce((s, v) => s + v.view_count, 0) / last30.length : 0;
  // Compilation share in last 30.
  const compCount      = last30.filter(v => isCompilation(v.title)).length;
  const compilationPct = last30.length ? compCount / last30.length : 0;

  // Upload cadence: long-form per week over last 30 days.
  const recentCount = (db.prepare(
    `SELECT COUNT(*) as c FROM channel_videos WHERE is_short=0 AND published_at >= datetime('now','-30 days')`
  ).get() as { c: number }).c;
  const uploadsPerWeek = Math.max(1, (recentCount / 30) * 7);

  // New-video expected avg at current format mix.
  const blendedNewAvg = compilationPct * compAvg + (1 - compilationPct) * stdAvg || current30Avg;
  const baselineDays = simulateViewsGoal(last30.map(v => v.view_count), blendedNewAvg, uploadsPerWeek, VIEWS_GOAL);
  const viewsBaselineDate = baselineDays !== null ? isoDate(addDays(now, baselineDays)) : null;

  // ── Scenario levers ──────────────────────────────────────────────────────
  // Lever A: push compilation share to 50%
  const compLeverPct    = Math.max(compilationPct, 0.5);
  const compBlended     = compLeverPct * compAvg + (1 - compLeverPct) * stdAvg || current30Avg;
  const compLeverDays   = simulateViewsGoal(last30.map(v => v.view_count), compBlended, uploadsPerWeek, VIEWS_GOAL);
  const compViewsBoost  = baselineDays !== null && compLeverDays !== null ? Math.max(0, Math.round(baselineDays - compLeverDays)) : 0;
  // Viral compilations also lift subs rate; interpolate toward p75 based on share increase.
  const compShare       = compilationPct;
  const compSubsBoost   = compShare < 0.5 && subsNeeded > 0
    ? Math.max(0, Math.round(subsNeeded / median - subsNeeded / (median + (0.5 - compShare) * (p75 - median))))
    : 0;

  // Lever B: +1 long-form per week
  const cadencePlusOne     = uploadsPerWeek + 1;
  const cadenceLeverDays   = simulateViewsGoal(last30.map(v => v.view_count), blendedNewAvg, cadencePlusOne, VIEWS_GOAL);
  const cadenceViewsBoost  = baselineDays !== null && cadenceLeverDays !== null ? Math.max(0, Math.round(baselineDays - cadenceLeverDays)) : 0;
  const cadenceSubsBoost   = subsNeeded > 0
    ? Math.max(0, Math.round(subsNeeded / median - subsNeeded / (median * (cadencePlusOne / uploadsPerWeek))))
    : 0;

  const levers: ForecastLever[] = [
    {
      id: 'compilation_mix',
      label: `≥50% compilations (currently ${Math.round(compilationPct * 100)}%)`,
      description: `Publishing more TRY NOT TO LAUGH / TRY NOT TO CRINGE style videos lifts the 30-ep avg and generates more viral subs.`,
      subs_boost_days: compSubsBoost,
      views_boost_days: compViewsBoost,
    },
    {
      id: 'upload_cadence',
      label: `+1 upload/week (${Math.round(uploadsPerWeek)} → ${Math.ceil(cadencePlusOne)}/wk)`,
      description: `One extra long-form video per week refreshes the rolling window faster and drives proportionally more impressions.`,
      subs_boost_days: cadenceSubsBoost,
      views_boost_days: cadenceViewsBoost,
    },
  ];

  const bestLever = levers.slice().sort(
    (a, b) => (b.views_boost_days + b.subs_boost_days) - (a.views_boost_days + a.subs_boost_days)
  )[0] ?? null;

  const confidence: 'low' | 'medium' | 'high' = dataDays >= 90 ? 'high' : dataDays >= 45 ? 'medium' : 'low';

  return {
    computed_at: now.toISOString(),
    data_days: dataDays,
    confidence,
    note: dataDays < 45
      ? `Only ${dataDays} days of sub data — error bands are wide. Estimates tighten with more history.`
      : '',

    current_subs: baseSubs,
    subs_goal: SUBS_GOAL,
    subs_needed: subsNeeded,
    daily_rates: { p25: Math.round(p25), median: Math.round(median), p75: Math.round(p75) },
    subs_forecast: {
      pessimistic_date: project(p25),
      baseline_date: project(median),
      optimistic_date: project(p75),
    },

    longform_uploads_per_week: Math.round(uploadsPerWeek * 10) / 10,
    compilation_pct: Math.round(compilationPct * 100),
    recent_compilation_avg_views: Math.round(compAvg),
    recent_standard_avg_views: Math.round(stdAvg),
    current_30ep_avg: Math.round(current30Avg),
    views_goal: VIEWS_GOAL,
    views_forecast: {
      baseline_date: current30Avg >= VIEWS_GOAL ? isoDate(now) : viewsBaselineDate,
      note: current30Avg >= VIEWS_GOAL
        ? 'Already at goal'
        : `At ${Math.round(uploadsPerWeek)}/wk, ${Math.round(compilationPct * 100)}% compilations (avg ${Math.round(compAvg).toLocaleString()} views) vs ${Math.round(stdAvg).toLocaleString()} for standard eps.`,
    },

    levers,
    best_lever: bestLever,
  };
}
