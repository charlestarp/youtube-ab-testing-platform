/**
 * Video Performance Benchmarks — compare each video against channel averages
 * and identify outliers (overperformers and underperformers).
 *
 * IMPORTANT: podcast and Try Not To Laugh (TNTL) are NEVER pooled. TNTL videos
 * average far more views, so a blended "channel average" is meaningless for
 * podcast decisions. Each content type is a separate benchmark bucket.
 */

import { getDb } from '../db/client.js';
import { classifyContent, ContentType, CONTENT_LABEL } from './content-type.js';

export interface VideoBenchmark {
  videoId: string;
  title: string;
  publishDate: string;
  views: number;
  avgViews: number;
  percentile: number;
  performance: 'viral' | 'above_avg' | 'average' | 'below_avg' | 'underperformer';
  viewsVsAvg: number; // percentage difference from average
}

export interface BenchmarkBucket {
  contentType: ContentType;
  label: string;
  videoCount: number;
  avgViews: number;
  medianViews: number;
  avgLikes: number;
  avgComments: number;
  topPerformers: VideoBenchmark[];
  underperformers: VideoBenchmark[];
  recentTrend: 'improving' | 'stable' | 'declining';
  benchmarks: {
    viral: number;    // views threshold for "viral" (top 5%)
    above: number;    // above average threshold (top 25%)
    below: number;    // below average threshold (bottom 25%)
  };
  enoughData: boolean;
}

export interface ChannelBenchmarks {
  podcast: BenchmarkBucket;
  TNTL: BenchmarkBucket;
}

function emptyBucket(contentType: ContentType, videoCount: number): BenchmarkBucket {
  return {
    contentType,
    label: CONTENT_LABEL[contentType],
    videoCount,
    avgViews: 0, medianViews: 0, avgLikes: 0, avgComments: 0,
    topPerformers: [], underperformers: [],
    recentTrend: 'stable',
    benchmarks: { viral: 0, above: 0, below: 0 },
    enoughData: false,
  };
}

function computeBucket(videos: any[], contentType: ContentType): BenchmarkBucket {
  if (videos.length < 10) return emptyBucket(contentType, videos.length);

  const viewsSorted = [...videos].sort((a, b) => a.view_count - b.view_count);
  const avgViews = videos.reduce((s: number, v: any) => s + v.view_count, 0) / videos.length;
  const medianViews = viewsSorted[Math.floor(viewsSorted.length / 2)].view_count;
  const avgLikes = videos.reduce((s: number, v: any) => s + v.like_count, 0) / videos.length;
  const avgComments = videos.reduce((s: number, v: any) => s + v.comment_count, 0) / videos.length;

  // Percentile thresholds
  const viralThreshold = viewsSorted[Math.floor(viewsSorted.length * 0.95)]?.view_count || avgViews * 3;
  const aboveThreshold = viewsSorted[Math.floor(viewsSorted.length * 0.75)]?.view_count || avgViews * 1.2;
  const belowThreshold = viewsSorted[Math.floor(viewsSorted.length * 0.25)]?.view_count || avgViews * 0.5;

  // Benchmark each video against its own content-type average
  const benchmarked: VideoBenchmark[] = videos.map((v: any) => {
    const percentile = viewsSorted.filter((sv: any) => sv.view_count <= v.view_count).length / viewsSorted.length * 100;
    let performance: VideoBenchmark['performance'];
    if (v.view_count >= viralThreshold) performance = 'viral';
    else if (v.view_count >= aboveThreshold) performance = 'above_avg';
    else if (v.view_count >= belowThreshold) performance = 'average';
    else if (v.view_count >= belowThreshold * 0.5) performance = 'below_avg';
    else performance = 'underperformer';

    return {
      videoId: v.video_id,
      title: v.title,
      publishDate: v.publish_date,
      views: v.view_count,
      avgViews: Math.round(avgViews),
      percentile: Math.round(percentile),
      performance,
      viewsVsAvg: Math.round(((v.view_count - avgViews) / avgViews) * 100),
    };
  });

  const topPerformers = benchmarked.filter(v => v.performance === 'viral' || v.performance === 'above_avg')
    .sort((a, b) => b.views - a.views).slice(0, 10);
  const underperformers = benchmarked.filter(v => v.performance === 'underperformer' || v.performance === 'below_avg')
    .sort((a, b) => a.views - b.views).slice(0, 10);

  // Recent trend: compare last 30 days avg to prior 30 days (within this content type)
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
  const sixtyDaysAgo = new Date(Date.now() - 60 * 86400000).toISOString().split('T')[0];
  const last30 = videos.filter((v: any) => v.publish_date >= thirtyDaysAgo);
  const prior30 = videos.filter((v: any) => v.publish_date >= sixtyDaysAgo && v.publish_date < thirtyDaysAgo);
  const last30Avg = last30.reduce((s: number, v: any) => s + v.view_count, 0) / (last30.length || 1);
  const prior30Avg = prior30.reduce((s: number, v: any) => s + v.view_count, 0) / (prior30.length || 1);
  const recentTrend = last30.length === 0 || prior30.length === 0 ? 'stable'
    : last30Avg > prior30Avg * 1.1 ? 'improving' : last30Avg < prior30Avg * 0.9 ? 'declining' : 'stable';

  return {
    contentType,
    label: CONTENT_LABEL[contentType],
    videoCount: videos.length,
    avgViews: Math.round(avgViews),
    medianViews,
    avgLikes: Math.round(avgLikes),
    avgComments: Math.round(avgComments),
    topPerformers,
    underperformers,
    recentTrend,
    benchmarks: {
      viral: viralThreshold,
      above: aboveThreshold,
      below: belowThreshold,
    },
    enoughData: true,
  };
}

export function getChannelBenchmarks(): ChannelBenchmarks {
  const db = getDb();

  const videos = db.prepare(`
    SELECT video_id, title, publish_date, view_count, like_count, comment_count, category
    FROM yt.videos ORDER BY publish_date DESC LIMIT 400
  `).all() as any[];

  const podcastVideos = videos.filter((v: any) => classifyContent(v.title, v.category) === 'podcast');
  const tntlVideos = videos.filter((v: any) => classifyContent(v.title, v.category) === 'TNTL');

  return {
    podcast: computeBucket(podcastVideos, 'podcast'),
    TNTL: computeBucket(tntlVideos, 'TNTL'),
  };
}
