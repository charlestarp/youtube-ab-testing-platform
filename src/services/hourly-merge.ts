/**
 * Merge get_cards and get_screen hourly data from the hourly_metrics table.
 *
 * get_cards entries: have watch_time_ms > 0, CTR is cumulative lifetime (wrong for per-hour)
 * get_screen entries: have watch_time_ms = 0, CTR is real per-hour (correct)
 *
 * For each hour bucket, we take:
 *   - CTR, impressions, views from get_screen (if available)
 *   - watch_time_ms, avg_watch_time_ms from get_cards (if available)
 *   - subs from whichever source is available
 */

export interface HourlyRow {
  hour_ts: string;
  impressions: number;
  views: number;
  ctr: number;
  watch_time_ms: number;
  avg_watch_time_ms: number;
  subscribers_net: number;
}

export interface MergedHourBucket {
  imp: number;
  views: number;
  ctr: number;
  watchMs: number;
  avgWatchMs: number;
  subs: number;
  hasScreenData: boolean;
  hasCardsData: boolean;
}

/**
 * Merge hourly_metrics rows by hour bucket.
 * Identifies get_cards vs get_screen by watch_time_ms presence.
 * Returns merged buckets keyed by hour (YYYY-MM-DDTHH).
 */
export function mergeHourlyRows(hourRows: HourlyRow[]): Record<string, MergedHourBucket> {
  const hourMerged: Record<string, MergedHourBucket> = {};

  // Detect cumulative CTR echo: if >50% of screen-like rows share the exact same CTR,
  // that CTR is the lifetime cumulative rate, not real per-hour data. Discard it.
  // Even 2 rows with identical CTR but different impressions is suspicious for short slots.
  const screenLike = hourRows.filter(r => (r.watch_time_ms || 0) === 0 && (r.ctr || 0) > 0 && (r.impressions || 0) > 0 && r.ctr <= 30);
  let echoedCtr = 0;
  if (screenLike.length >= 2) {
    const ctrCounts: Record<number, number> = {};
    for (const r of screenLike) ctrCounts[r.ctr] = (ctrCounts[r.ctr] || 0) + 1;
    const [topCtr, topCount] = Object.entries(ctrCounts).sort((a, b) => b[1] - a[1])[0] || ['0', 0];
    if (topCount >= 2 && topCount / screenLike.length > 0.5) echoedCtr = parseFloat(topCtr);
  }

  for (const r of hourRows) {
    const hourKey = r.hour_ts.substring(0, 13); // e.g. "2026-05-08T09"
    const hasWatchTime = (r.watch_time_ms || 0) > 0;
    const hasCtr = (r.ctr || 0) > 0;

    // Classification:
    //   get_cards = has watch_time_ms > 0 (CTR is cumulative lifetime, wrong)
    //   get_screen = has ctr > 0 AND watch_time_ms = 0 AND impressions > 0 (real per-hour)
    //   Rows with ctr > 0 but impressions = 0 are lifetime cumulative echoes, not real data.
    //   Sanity: real YouTube CTR never exceeds 30%. Values above that are corrupted data.
    //   If the CTR matches the detected cumulative echo value, treat as non-screen data.
    const hasImpressions = (r.impressions || 0) > 0;
    const isCumulativeEcho = echoedCtr > 0 && Math.abs(r.ctr - echoedCtr) < 0.01;
    const isScreenData = !hasWatchTime && hasCtr && hasImpressions && (r.ctr <= 30) && !isCumulativeEcho;
    const isCardsData = hasWatchTime;

    if (!hourMerged[hourKey]) {
      hourMerged[hourKey] = {
        imp: r.impressions || 0,
        views: r.views || 0,
        ctr: r.ctr || 0,
        watchMs: r.watch_time_ms || 0,
        avgWatchMs: r.avg_watch_time_ms || 0,
        subs: r.subscribers_net || 0,
        hasScreenData: isScreenData,
        hasCardsData: isCardsData,
      };
    } else {
      const hm = hourMerged[hourKey];

      if (isScreenData && !hm.hasScreenData) {
        // First get_screen entry for this hour -- take CTR, impressions, views
        hm.ctr = r.ctr;
        hm.imp = r.impressions || 0;
        hm.views = r.views || 0;
        hm.hasScreenData = true;
      } else if (isScreenData && hm.hasScreenData) {
        // Multiple get_screen entries for same hour -- take the one with higher impressions
        if ((r.impressions || 0) > hm.imp) {
          hm.ctr = r.ctr;
          hm.imp = r.impressions || 0;
          hm.views = r.views || 0;
        }
      }

      if (isCardsData && !hm.hasCardsData) {
        // First get_cards entry -- take watch time
        hm.watchMs = r.watch_time_ms || 0;
        hm.avgWatchMs = r.avg_watch_time_ms || 0;
        hm.hasCardsData = true;
        // If no screen data yet, also use cards impressions/views as fallback
        if (!hm.hasScreenData) {
          hm.imp = r.impressions || 0;
          hm.views = r.views || 0;
          hm.ctr = r.ctr || 0;
        }
      } else if (isCardsData && hm.hasCardsData) {
        // Multiple cards entries -- take higher watch time
        if ((r.watch_time_ms || 0) > hm.watchMs) {
          hm.watchMs = r.watch_time_ms || 0;
          hm.avgWatchMs = r.avg_watch_time_ms || 0;
        }
      }

      // Subs: prefer screen data, fallback to cards
      if (isScreenData) {
        hm.subs = r.subscribers_net || 0;
      } else if (isCardsData && !hm.hasScreenData) {
        hm.subs = r.subscribers_net || 0;
      }
    }
  }

  return hourMerged;
}

/**
 * Aggregate merged hour buckets into slot totals.
 * Returns impressions, views, weighted CTR, watch time, avg watch time, subs.
 */
export function aggregateMergedHours(merged: Record<string, MergedHourBucket>): {
  totalImp: number;
  totalViews: number;
  totalClicks: number;
  totalScreenImp: number;
  totalWatchMs: number;
  totalSubs: number;
  lastAvgWatchMs: number;
  hourCount: number;
} {
  let totalImp = 0, totalViews = 0, totalClicks = 0, totalScreenImp = 0, totalWatchMs = 0, totalSubs = 0;
  let lastAvgWatchMs = 0;
  let hourCount = 0;

  for (const hm of Object.values(merged)) {
    totalImp += hm.imp;
    totalViews += hm.views;
    // CTR must be the impression-weighted average of the REAL per-hour VTR
    // (get_screen). Both numerator (clicks) and denominator (impressions) must
    // come ONLY from screen hours — otherwise impressions from cards-only hours
    // inflate the denominator and dilute CTR (the 2026-06 "2.8% instead of 8%" bug).
    if (hm.hasScreenData) {
      totalClicks += hm.imp * (hm.ctr / 100);
      totalScreenImp += hm.imp;
    }
    totalWatchMs += hm.watchMs;
    totalSubs += hm.subs;
    if (hm.avgWatchMs > 0) lastAvgWatchMs = hm.avgWatchMs;
    hourCount++;
  }

  return { totalImp, totalViews, totalClicks, totalScreenImp, totalWatchMs, totalSubs, lastAvgWatchMs, hourCount };
}
