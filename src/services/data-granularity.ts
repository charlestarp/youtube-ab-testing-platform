/**
 * YouTube only retains PER-HOUR impression data for a video's early life
 * (roughly the first ~2 weeks). After that, the Reach series — from the internal
 * API AND the extension, which share the same upstream — comes back in per-DAY
 * buckets only (verified 2026-07-08: vKWrWWCfWlA at 131 days old returns 24h
 * buckets from every period type; ICXIeWmrS_U at ~12 days returns hourly).
 *
 * An HOURLY-rotation A/B test on such a video can never be measured: the hourly
 * numbers do not exist upstream, so its slots sit at 0 forever (tests 186–190).
 * Tests on old videos must therefore run at 'daily' speed, where each variant
 * holds for whole days and every daily bucket is REAL data.
 */
import { fetchReachHourly } from './studio-fetch.js';

/** True when the video's Reach series is hourly-granularity (recent video). */
export async function videoHasHourlyData(videoId: string): Promise<boolean> {
  const p = await fetchReachHourly(videoId);
  const ts = p.timestamps;
  if (ts.length < 3) return false;
  // The gap between the most recent settled points is the live granularity.
  const a = new Date(ts[ts.length - 2]).getTime();
  const b = new Date(ts[ts.length - 3]).getTime();
  return (a - b) <= 2 * 3600_000;
}

/** The fastest test speed the video's REAL data can support. Falls back to
 *  'hourly' if the probe itself fails (existing behaviour, alerts will catch it). */
export async function speedForVideo(videoId: string): Promise<'hourly' | 'daily'> {
  try {
    return (await videoHasHourlyData(videoId)) ? 'hourly' : 'daily';
  } catch (e: any) {
    console.log(`[granularity] probe failed for ${videoId} (${e?.message}) — defaulting hourly`);
    return 'hourly';
  }
}
