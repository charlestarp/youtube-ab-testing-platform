/**
 * Growth Projections — project subscriber milestones and channel growth
 * based on current trends.
 */

import { getDb } from '../db/client.js';

export interface GrowthProjection {
  currentSubs: number;
  avgSubsPerDay: number;
  avgSubsPerWeek: number;
  avgViewsPerVideo: number;
  avgViewsPerDay: number;
  postsPerWeek: number;
  milestones: { target: number; estimatedDate: string; daysAway: number }[];
  weeklyTrend: { week: string; subs: number; views: number; videos: number }[];
  insights: string[];
}

export function getGrowthProjections(): GrowthProjection {
  const db = getDb();

  // Get daily analytics for last 90 days
  const dailyAnalytics = db.prepare(`
    SELECT date, SUM(views) as total_views, SUM(subscribers_gained) as total_subs
    FROM yt.video_analytics
    WHERE date >= date('now', '-90 days')
    GROUP BY date ORDER BY date
  `).all() as any[];

  // Get video publishing frequency
  const recentVideos = db.prepare(`
    SELECT publish_date, view_count FROM yt.videos
    WHERE publish_date >= date('now', '-90 days')
    ORDER BY publish_date
  `).all() as any[];

  const allVideos = db.prepare('SELECT view_count FROM yt.videos').all() as any[];
  const avgViewsPerVideo = allVideos.reduce((s: number, v: any) => s + v.view_count, 0) / (allVideos.length || 1);

  // Calculate daily averages
  const totalSubs = dailyAnalytics.reduce((s: number, d: any) => s + (d.total_subs || 0), 0);
  const totalViews = dailyAnalytics.reduce((s: number, d: any) => s + (d.total_views || 0), 0);
  const dayCount = dailyAnalytics.length || 1;
  const avgSubsPerDay = totalSubs / dayCount;
  const avgViewsPerDay = totalViews / dayCount;
  const postsPerWeek = (recentVideos.length / (dayCount / 7)) || 0;

  // Estimate current subscriber count (we don't have this directly, so estimate from channel analytics)
  // Use a reasonable estimate based on channel data
  const channelAnalytics = db.prepare(`
    SELECT subscribers FROM yt.channel_analytics ORDER BY date DESC LIMIT 1
  `).all() as any[];
  const currentSubs = channelAnalytics[0]?.subscribers || 0;

  // Project milestones
  const milestoneTargets = [100000, 250000, 500000, 750000, 1000000, 2000000, 5000000];
  const milestones = milestoneTargets
    .filter(t => t > currentSubs)
    .map(target => {
      const subsNeeded = target - currentSubs;
      const daysAway = avgSubsPerDay > 0 ? Math.ceil(subsNeeded / avgSubsPerDay) : Infinity;
      const estimatedDate = daysAway < 10000
        ? new Date(Date.now() + daysAway * 86400000).toISOString().split('T')[0]
        : 'Unknown';
      return { target, estimatedDate, daysAway };
    })
    .filter(m => m.daysAway < 3650); // Only show milestones within 10 years

  // Weekly trend
  const weeklyTrend: { week: string; subs: number; views: number; videos: number }[] = [];
  for (let i = 12; i >= 0; i--) {
    const weekStart = new Date(Date.now() - i * 7 * 86400000);
    const weekEnd = new Date(weekStart.getTime() + 7 * 86400000);
    const startStr = weekStart.toISOString().split('T')[0];
    const endStr = weekEnd.toISOString().split('T')[0];

    const weekData = dailyAnalytics.filter((d: any) => d.date >= startStr && d.date < endStr);
    const weekVideos = recentVideos.filter((v: any) => v.publish_date >= startStr && v.publish_date < endStr);

    weeklyTrend.push({
      week: startStr,
      subs: weekData.reduce((s: number, d: any) => s + (d.total_subs || 0), 0),
      views: weekData.reduce((s: number, d: any) => s + (d.total_views || 0), 0),
      videos: weekVideos.length,
    });
  }

  // Growth insights
  const insights: string[] = [];

  if (avgSubsPerDay > 0) {
    insights.push(`Growing at ~${Math.round(avgSubsPerDay * 7)} subscribers per week.`);
  }

  if (postsPerWeek > 0) {
    insights.push(`Publishing ${postsPerWeek.toFixed(1)} videos per week on average.`);
  }

  // Check if growth is accelerating or decelerating
  if (weeklyTrend.length >= 4) {
    const recent = weeklyTrend.slice(-4);
    const firstHalf = (recent[0].subs + recent[1].subs) / 2;
    const secondHalf = (recent[2].subs + recent[3].subs) / 2;
    if (secondHalf > firstHalf * 1.1) {
      insights.push('Growth is accelerating — subscriber gains are trending up.');
    } else if (secondHalf < firstHalf * 0.9) {
      insights.push('Growth is slowing — consider testing new content formats or thumbnail styles.');
    } else {
      insights.push('Growth rate is steady.');
    }
  }

  const viewToSubRatio = avgViewsPerDay / (avgSubsPerDay || 1);
  insights.push(`Views-to-subscriber ratio: ${Math.round(viewToSubRatio)}:1 (lower is better for conversion).`);

  return {
    currentSubs,
    avgSubsPerDay,
    avgSubsPerWeek: avgSubsPerDay * 7,
    avgViewsPerVideo,
    avgViewsPerDay,
    postsPerWeek,
    milestones,
    weeklyTrend,
    insights,
  };
}
