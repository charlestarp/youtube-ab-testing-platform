/**
 * YouTube Studio scraper — real-time metrics via Playwright.
 * Scrapes impressions, CTR, views, retention, watch time, subs, traffic, devices.
 * Runs hourly for recent videos, every 5 min for videos with active tests.
 */

import { getProfile, saveProfile } from './browser-session.js';
import { getDb } from '../db/client.js';

export interface StudioSnapshot {
  videoId: string;
  scrapedAt: string;
  impressions: number;
  ctr: number;
  views: number;
  uniqueViewers: number;
  watchTimeHours: number;
  avgViewDurationSec: number;
  avgViewPct: number;
  subscribersNet: number;
  likes: number;
  engagedViews: number;
  estimatedEarnings: number;
  likeRate: number;
  retentionCurve: number[];
  trafficSources: Record<string, number>;
  deviceBreakdown: { device: string; percentage: number }[];
  realTimeViews: {
    last48Hours?: number;
    last48HoursTimeline?: number[];
    last60Minutes?: number;
    last60MinutesTimeline?: number[];
  };
  typicalViews: number;
  typicalRange: { low: number; high: number };
}

/**
 * Extract analytics data from YouTube Studio's JSON API responses.
 */
function extractStudioData(json: any, snapshot: Partial<StudioSnapshot>) {
  if (!json?.cards || !Array.isArray(json.cards)) return;

  for (const card of json.cards) {
    const cfg = card.config || {};

    // Key Metrics (views, unique viewers, watch time, avg watch time, subs, impressions, CTR)
    if (cfg.keyMetricCardConfig && card.keyMetricCardData?.keyMetricTabs) {
      for (const tab of card.keyMetricCardData.keyMetricTabs) {
        const metric = tab.primaryContent?.metric;
        const total = tab.primaryContent?.total;
        if (total === undefined) continue;

        switch (metric) {
          case 'EXTERNAL_VIEWS':
            snapshot.views = total;
            const typical = tab.primaryContent?.typicalPerformanceTotal;
            if (typical) {
              snapshot.typicalViews = typical.typicalValue;
              snapshot.typicalRange = { low: typical.typicalRange?.lowerBound, high: typical.typicalRange?.upperBound };
            }
            break;
          case 'ESTIMATED_UNIQUE_VIEWERS': snapshot.uniqueViewers = total; break;
          case 'EXTERNAL_WATCH_TIME': snapshot.watchTimeHours = total / 3600000; break;
          case 'AVERAGE_WATCH_TIME': snapshot.avgViewDurationSec = total / 1000; break;
          case 'SUBSCRIBERS_NET_CHANGE': snapshot.subscribersNet = total; break;
          case 'ENGAGED_VIEWS': snapshot.engagedViews = total; break;
          case 'TOTAL_ESTIMATED_EARNINGS': snapshot.estimatedEarnings = total; break;
          // Impressions and CTR (from Reach tab)
          case 'IMPRESSIONS': snapshot.impressions = total; break;
          case 'IMPRESSIONS_CTR': snapshot.ctr = total; break;
          case 'VIDEO_THUMBNAIL_IMPRESSIONS': snapshot.impressions = total; break;
          case 'VIDEO_THUMBNAIL_IMPRESSIONS_VTR': snapshot.ctr = total; break;
        }
      }
    }

    // Retention curve
    if (cfg.audienceRetentionHighlightsCardConfig && card.audienceRetentionHighlightsCardData) {
      const videoData = card.audienceRetentionHighlightsCardData.videosData?.[0];
      if (videoData?.retentionValues) {
        snapshot.retentionCurve = videoData.retentionValues;
        if (videoData.metricTotals?.avgPercentageWatched !== undefined) {
          // YouTube returns this as a fraction (0.41 = 41%), store as percentage
          const raw = videoData.metricTotals.avgPercentageWatched;
          snapshot.avgViewPct = raw < 1 ? raw * 100 : raw;
        }
      }
    }

    // Real-time views (48h and 60min)
    if (cfg.latestActivityCardConfig && card.latestActivityCardData?.datas) {
      if (!snapshot.realTimeViews) snapshot.realTimeViews = {};
      for (const d of card.latestActivityCardData.datas) {
        const period = d.timePeriod || '';
        const counts = d.mainChartData?.metricColumns?.[0]?.counts?.values;
        if (period.includes('48_HOURS') && counts) {
          snapshot.realTimeViews.last48Hours = counts.reduce((a: number, b: number) => a + b, 0);
          snapshot.realTimeViews.last48HoursTimeline = counts;
        }
        if (period.includes('60_MINUTES') && counts) {
          snapshot.realTimeViews.last60Minutes = counts.reduce((a: number, b: number) => a + b, 0);
          snapshot.realTimeViews.last60MinutesTimeline = counts;
        }
      }
    }

    // Like rate
    if (cfg.channelComparisonCardConfig && card.channelComparisonCardData?.channelData) {
      for (const col of card.channelComparisonCardData.channelData.metricColumns || []) {
        if (col.metric?.type === 'LIKES_PER_LIKES_PLUS_DISLIKES_PERCENT') {
          snapshot.likeRate = (col.percentages?.values?.[0] || 0) / 100;
        }
      }
    }

    // Device breakdown
    if (cfg.stackedBarCardConfig && card.stackedBarCardData?.overviewCardData) {
      const cd = card.stackedBarCardData.overviewCardData.cardData;
      const dims = cd?.dimensionColumns?.[0];
      if (dims?.dimension?.type === 'DEVICE_PLATFORM_TYPE') {
        const devices = dims.enumValues?.values || [];
        const values = card.stackedBarCardData.overviewCardData.values || [];
        if (devices.length > 0 && devices.length === values.length) {
          snapshot.deviceBreakdown = devices.map((d: string, i: number) => ({
            device: d.charAt(0) + d.slice(1).toLowerCase(),
            percentage: values[i] || 0,
          }));
        }
      }
    }

    // Traffic sources
    if (cfg.tableCardConfig && card.tableCardData) {
      const dims = card.tableCardData.cardData?.dimensionColumns?.[0];
      if (dims?.dimension?.type === 'TRAFFIC_SOURCE_TYPE') {
        const sources = dims.enumValues?.values || [];
        const metrics = card.tableCardData.cardData?.metricColumns?.[0]?.counts?.values || [];
        if (sources.length > 0) {
          snapshot.trafficSources = {};
          sources.forEach((s: string, i: number) => {
            snapshot.trafficSources![s] = metrics[i] || 0;
          });
        }
      }
    }
  }
}

/**
 * Scrape a single video's analytics from YouTube Studio.
 */
const CLIPS_CHANNEL_ID = process.env.YOUTUBE_CLIPS_CHANNEL_ID || 'UC36A0yALoD0LeRr7NoCCZtg';
const MAIN_CHANNEL_ID = process.env.YOUTUBE_CHANNEL_ID || 'UCkhy7g4GvHuzhbzTVjc8izQ';
let _currentStudioChannel: string | null = null;

async function scrapeVideoStudio(videoId: string): Promise<Partial<StudioSnapshot>> {
  const session = await getProfile('youtube-studio');
  const { page } = session;

  // Check if this video belongs to the clips channel
  const db = getDb();
  const isClipsVideo = db.prepare("SELECT 1 FROM tests WHERE video_id = ? AND video_id IN (SELECT video_id FROM competitor_videos WHERE competitor_id = (SELECT id FROM competitors WHERE channel_id = ?))").get(videoId, CLIPS_CHANNEL_ID)
    || db.prepare("SELECT 1 FROM tests t WHERE t.video_id = ? AND EXISTS (SELECT 1 FROM studio_snapshots s WHERE s.video_id = t.video_id AND s.impressions = 0 AND s.views > 0)").get(videoId);

  // Switch channel in Studio if needed
  const targetChannel = isClipsVideo ? CLIPS_CHANNEL_ID : MAIN_CHANNEL_ID;
  if (_currentStudioChannel !== targetChannel) {
    try {
      await page.goto(`https://studio.youtube.com/channel/${targetChannel}`, { waitUntil: 'networkidle', timeout: 15000 });
      await page.waitForTimeout(2000);
      _currentStudioChannel = targetChannel;
      console.log(`[studio-scraper] Switched to channel ${targetChannel === CLIPS_CHANNEL_ID ? 'Clips' : 'Main'}`);
    } catch {}
  }

  const snapshot: Partial<StudioSnapshot> = { videoId, scrapedAt: new Date().toISOString() };

  const responseHandler = async (response: any) => {
    const url = response.url();
    const ct = response.headers()['content-type'] || '';
    if (!ct.includes('json')) return;
    if (url.includes('log_event') || url.includes('heartbeat') || url.includes('generate_204')) return;
    try {
      let text = await response.text();
      if (text.length < 500) return;
      if (text.startsWith(")]}'")) text = text.substring(text.indexOf('\n') + 1);
      const json = JSON.parse(text);
      extractStudioData(json, snapshot);

      // Debug: log all metric names found
      if (json.cards) {
        for (const card of json.cards) {
          const cfg = card.config || {};
          if (cfg.keyMetricCardConfig && card.keyMetricCardData?.keyMetricTabs) {
            for (const tab of card.keyMetricCardData.keyMetricTabs) {
              const metric = tab.primaryContent?.metric;
              const total = tab.primaryContent?.total;
              if (metric) console.log(`[studio-debug] ${videoId} metric: ${metric} = ${total}`);
            }
          }
        }
      }
    } catch {}
  };

  page.on('response', responseHandler);

  try {
    // Overview tab (views, watch time, subs, real-time, typical performance)
    await page.goto(`https://studio.youtube.com/video/${videoId}/analytics/tab-overview`, {
      waitUntil: 'domcontentloaded', timeout: 30000,
    });
    await page.waitForTimeout(5000);

    // Reach tab (impressions, CTR, traffic sources)
    // Add extra response capture for debug
    const reachResponses: any[] = [];
    const reachHandler = async (response: any) => {
      const ct = response.headers()['content-type'] || '';
      if (!ct.includes('json')) return;
      try {
        let text = await response.text();
        if (text.length < 500) return;
        if (text.startsWith(")]}'")) text = text.substring(text.indexOf('\n') + 1);
        const json = JSON.parse(text);
        if (json.cards) reachResponses.push(json);
      } catch {}
    };
    page.on('response', reachHandler);

    await page.goto(`https://studio.youtube.com/video/${videoId}/analytics/tab-reach`, {
      waitUntil: 'networkidle', timeout: 30000,
    });
    await page.waitForTimeout(8000);

    // Dump reach tab data for debugging
    if (reachResponses.length > 0) {
      const fs = await import('fs');
      const debugDir = `${process.cwd()}/data/yt-studio-debug`;
      fs.mkdirSync(debugDir, { recursive: true });
      for (let i = 0; i < reachResponses.length; i++) {
        fs.writeFileSync(`${debugDir}/${videoId}_reach_${i}.json`, JSON.stringify(reachResponses[i], null, 2));
      }
      console.log(`[studio-scraper] Dumped ${reachResponses.length} reach tab responses for ${videoId}`);
    }
    page.off('response', reachHandler);

    // Engagement tab (retention curve, avg view duration)
    await page.goto(`https://studio.youtube.com/video/${videoId}/analytics/tab-engagement`, {
      waitUntil: 'networkidle', timeout: 45000,
    });
    await page.waitForTimeout(12000);

    // If no retention yet, scroll the page to trigger lazy loading of the retention card
    if (!snapshot.retentionCurve) {
      try {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(5000);
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.waitForTimeout(3000);
      } catch {}
    }

    // Audience tab (device breakdown, like rate)
    await page.goto(`https://studio.youtube.com/video/${videoId}/analytics/tab-audience`, {
      waitUntil: 'domcontentloaded', timeout: 30000,
    });
    await page.waitForTimeout(4000);

    await saveProfile('youtube-studio');
  } catch (err: any) {
    console.error(`[studio-scraper] Failed for ${videoId}: ${err.message}`);
  }

  page.off('response', responseHandler);

  return snapshot;
}

/**
 * Save a studio snapshot to the database.
 */
function saveSnapshot(snapshot: Partial<StudioSnapshot>) {
  if (!snapshot.videoId) return;
  const db = getDb();

  db.prepare(`
    INSERT INTO studio_snapshots (video_id, scraped_at, impressions, ctr, views, unique_viewers,
      watch_time_hours, avg_view_duration_sec, avg_view_pct, subscribers_net, likes, engaged_views,
      estimated_earnings, like_rate, retention_json, traffic_sources_json, device_breakdown_json,
      realtime_views_json, typical_views, typical_range_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    snapshot.videoId,
    snapshot.scrapedAt || new Date().toISOString(),
    snapshot.impressions || 0,
    snapshot.ctr || 0,
    snapshot.views || 0,
    snapshot.uniqueViewers || 0,
    snapshot.watchTimeHours || 0,
    snapshot.avgViewDurationSec || 0,
    snapshot.avgViewPct || 0,
    snapshot.subscribersNet || 0,
    snapshot.likes || 0,
    snapshot.engagedViews || 0,
    snapshot.estimatedEarnings || 0,
    snapshot.likeRate || 0,
    snapshot.retentionCurve ? JSON.stringify(snapshot.retentionCurve) : null,
    snapshot.trafficSources ? JSON.stringify(snapshot.trafficSources) : null,
    snapshot.deviceBreakdown ? JSON.stringify(snapshot.deviceBreakdown) : null,
    snapshot.realTimeViews ? JSON.stringify(snapshot.realTimeViews) : null,
    snapshot.typicalViews || 0,
    snapshot.typicalRange ? JSON.stringify(snapshot.typicalRange) : null,
  );
}

/**
 * Run the studio scraper for videos with active tests (every 5 min)
 * and recent videos (every hour).
 */
export async function runStudioScraper(options?: { activeTestsOnly?: boolean; videoIds?: string[] }): Promise<{ scraped: number; errors: number }> {
  const db = getDb();
  let scraped = 0;
  let errors = 0;

  // Get videos to scrape
  let videoIds: string[];

  if (options?.videoIds) {
    videoIds = options.videoIds;
  } else if (options?.activeTestsOnly) {
    // Only videos with running tests
    const tests = db.prepare("SELECT video_id FROM tests WHERE status = 'running'").all() as any[];
    videoIds = tests.map(t => t.video_id);
  } else {
    // Recent videos (last 14 days) from youtube.db
    try {
      const recent = db.prepare(`
        SELECT video_id FROM yt.videos
        WHERE publish_date >= date('now', '-14 days')
        ORDER BY publish_date DESC LIMIT 20
      `).all() as any[];
      videoIds = recent.map(v => v.video_id);
    } catch {
      videoIds = [];
    }

    // Also add any running test videos
    const tests = db.prepare("SELECT video_id FROM tests WHERE status = 'running'").all() as any[];
    for (const t of tests) {
      if (!videoIds.includes(t.video_id)) videoIds.push(t.video_id);
    }
  }

  if (videoIds.length === 0) {
    console.log('[studio-scraper] No videos to scrape');
    return { scraped: 0, errors: 0 };
  }

  console.log(`[studio-scraper] Scraping ${videoIds.length} videos`);

  for (const videoId of videoIds) {
    try {
      const snapshot = await scrapeVideoStudio(videoId);

      if (snapshot.views !== undefined || snapshot.impressions !== undefined || snapshot.retentionCurve) {
        saveSnapshot(snapshot);
        scraped++;
        console.log(`[studio-scraper] ${videoId}: views=${snapshot.views}, imp=${snapshot.impressions}, ctr=${snapshot.ctr?.toFixed(2)}, retention=${snapshot.retentionCurve ? snapshot.retentionCurve.length + 'pts' : 'none'}`);
      } else {
        console.warn(`[studio-scraper] No data for ${videoId} — may need YouTube Studio login`);
        errors++;
      }

      // Rate limit
      await new Promise(r => setTimeout(r, 5000 + Math.random() * 3000));
    } catch (err: any) {
      console.error(`[studio-scraper] Error for ${videoId}: ${err.message}`);
      errors++;
    }
  }

  return { scraped, errors };
}
