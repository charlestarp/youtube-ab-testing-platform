/**
 * SEO Gap Finder — identifies topics and keywords that competitors
 * rank for but we don't cover yet.
 */

import { getDb } from '../db/client.js';

export interface SEOGap {
  keyword: string;
  competitorVideos: { title: string; views: number; channel: string }[];
  ourCoverage: number; // number of our videos on this topic
  opportunity: 'high' | 'medium' | 'low';
  estimatedViews: number;
}

/**
 * Find topics competitors cover that we don't.
 */
export function findSEOGaps(): SEOGap[] {
  const db = getDb();

  // Get our video titles
  const ourVideos = db.prepare('SELECT title, view_count FROM yt.videos').all() as any[];
  const ourTitleWords = new Set<string>();
  const ourTitlePhrases = new Map<string, number>(); // phrase -> count

  for (const v of ourVideos) {
    const words = v.title.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter((w: string) => w.length > 3);
    words.forEach((w: string) => ourTitleWords.add(w));

    // Extract 2-3 word phrases
    for (let i = 0; i < words.length - 1; i++) {
      const phrase2 = `${words[i]} ${words[i + 1]}`;
      ourTitlePhrases.set(phrase2, (ourTitlePhrases.get(phrase2) || 0) + 1);
      if (i < words.length - 2) {
        const phrase3 = `${words[i]} ${words[i + 1]} ${words[i + 2]}`;
        ourTitlePhrases.set(phrase3, (ourTitlePhrases.get(phrase3) || 0) + 1);
      }
    }
  }

  // Get competitor videos
  const compVideos = db.prepare(`
    SELECT cv.title, cv.views, c.name as channel
    FROM competitor_videos cv
    JOIN competitors c ON cv.competitor_id = c.id
    WHERE cv.views > 10000
    ORDER BY cv.views DESC
  `).all() as any[];

  if (compVideos.length === 0) {
    return [];
  }

  // Extract competitor topics (phrases)
  const compPhrases = new Map<string, { videos: any[]; totalViews: number }>();

  for (const v of compVideos) {
    const words = v.title.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter((w: string) => w.length > 3);

    for (let i = 0; i < words.length - 1; i++) {
      const phrase = `${words[i]} ${words[i + 1]}`;
      if (!compPhrases.has(phrase)) compPhrases.set(phrase, { videos: [], totalViews: 0 });
      const entry = compPhrases.get(phrase)!;
      entry.videos.push({ title: v.title, views: v.views, channel: v.channel });
      entry.totalViews += v.views;
    }
  }

  // Find gaps: competitor phrases we don't use
  const gaps: SEOGap[] = [];
  const stopWords = new Set(['this', 'that', 'with', 'from', 'they', 'have', 'were', 'been',
    'their', 'what', 'when', 'where', 'which', 'about', 'would', 'there', 'could', 'other',
    'than', 'then', 'some', 'very', 'just', 'most', 'also', 'into', 'over', 'only']);

  for (const [phrase, data] of compPhrases) {
    const words = phrase.split(' ');
    if (words.some(w => stopWords.has(w))) continue;
    if (data.videos.length < 2) continue; // Need multiple competitors using it

    const ourCount = ourTitlePhrases.get(phrase) || 0;
    if (ourCount >= 2) continue; // We already cover this

    const avgViews = data.totalViews / data.videos.length;
    const opportunity = avgViews > 100000 ? 'high' : avgViews > 50000 ? 'medium' : 'low';

    gaps.push({
      keyword: phrase,
      competitorVideos: data.videos.slice(0, 3),
      ourCoverage: ourCount,
      opportunity,
      estimatedViews: Math.round(avgViews),
    });
  }

  // Sort by opportunity and estimated views
  return gaps
    .sort((a, b) => {
      const opOrder = { high: 0, medium: 1, low: 2 };
      if (opOrder[a.opportunity] !== opOrder[b.opportunity]) {
        return opOrder[a.opportunity] - opOrder[b.opportunity];
      }
      return b.estimatedViews - a.estimatedViews;
    })
    .slice(0, 30);
}
