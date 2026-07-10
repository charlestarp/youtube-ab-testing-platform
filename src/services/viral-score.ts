/**
 * Viral Potential Score — scores new title/thumbnail combos against
 * patterns from top-performing videos.
 */

import { getDb } from '../db/client.js';

export interface ViralScoreResult {
  score: number;        // 0-100
  factors: ViralFactor[];
  similarTopVideos: { title: string; views: number; similarity: string }[];
  prediction: string;   // "2.3x more views than average"
  flags: string[];      // YouTube policy warnings
  videoType: 'podcast' | 'tntl';
  avgViews: number;
}

export interface ViralFactor {
  name: string;
  score: number;       // 0-100
  insight: string;
}

/**
 * Score a proposed title against historical patterns.
 */
export function scoreTitle(proposedTitle: string): ViralScoreResult {
  const db = getDb();

  // Detect video type
  const isTNTL = /try not to laugh/i.test(proposedTitle);
  const videoType = isTNTL ? 'tntl' : 'podcast';

  // Get the right comparison set — last 3 months for accurate recent averages
  const threeMonthsAgo = new Date(Date.now() - 90 * 86400000).toISOString().split('T')[0];
  const allVideos = isTNTL
    ? db.prepare("SELECT title, view_count FROM yt.videos WHERE title LIKE '%TRY NOT TO LAUGH%' AND duration_seconds > 180 AND publish_date >= ? ORDER BY publish_date DESC").all(threeMonthsAgo) as any[]
    : db.prepare("SELECT title, view_count FROM yt.videos WHERE title NOT LIKE '%TRY NOT TO LAUGH%' AND duration_seconds > 180 AND publish_date >= ? ORDER BY publish_date DESC").all(threeMonthsAgo) as any[];

  // If not enough recent data, expand to 6 months
  if (allVideos.length < 15) {
    const sixMonthsAgo = new Date(Date.now() - 180 * 86400000).toISOString().split('T')[0];
    const expanded = isTNTL
      ? db.prepare("SELECT title, view_count FROM yt.videos WHERE title LIKE '%TRY NOT TO LAUGH%' AND duration_seconds > 180 AND publish_date >= ? ORDER BY publish_date DESC").all(sixMonthsAgo) as any[]
      : db.prepare("SELECT title, view_count FROM yt.videos WHERE title NOT LIKE '%TRY NOT TO LAUGH%' AND duration_seconds > 180 AND publish_date >= ? ORDER BY publish_date DESC").all(sixMonthsAgo) as any[];
    if (expanded.length > allVideos.length) allVideos.length = 0, allVideos.push(...expanded);
  }

  if (allVideos.length < 10) {
    return { score: 50, factors: [], similarTopVideos: [], prediction: 'Not enough data', flags: [], videoType, avgViews: 0 };
  }

  const avgViews = allVideos.reduce((s: number, v: any) => s + v.view_count, 0) / allVideos.length;
  const top20 = [...allVideos].sort((a, b) => b.view_count - a.view_count).slice(0, Math.ceil(allVideos.length * 0.2));
  const top20AvgViews = top20.reduce((s: number, v: any) => s + v.view_count, 0) / top20.length;

  // YouTube policy flag detection
  const flags: string[] = [];
  const titleLower = proposedTitle.toLowerCase();
  const flaggedWords = [
    { words: ['squirt', 'orgasm', 'cum', 'penis', 'vagina', 'dildo', 'vibrator'], reason: 'Sexual content — may be age-restricted or demonetized' },
    { words: ['kill', 'murder', 'suicide', 'dead body'], reason: 'Violence — may trigger restricted mode' },
    { words: ['drug', 'cocaine', 'meth', 'weed', 'heroin'], reason: 'Drug references — may be demonetized' },
    { words: ['naked', 'nude', 'topless', 'porn'], reason: 'Nudity references — may be age-restricted' },
    { words: ['fuck', 'shit', 'bitch', 'ass'], reason: 'Strong language in title — may limit recommendations' },
  ];
  for (const { words, reason } of flaggedWords) {
    if (words.some(w => titleLower.includes(w))) {
      flags.push(reason);
    }
  }
  // Check for clickbait patterns YouTube may suppress
  if (/you won't believe|gone wrong|gone sexual|not clickbait/i.test(proposedTitle)) {
    flags.push('Clickbait pattern — YouTube may reduce recommendations');
  }

  const factors: ViralFactor[] = [];

  // Factor 1: Title length (word count)
  const wordCount = proposedTitle.split(/\s+/).length;
  const titleLengths = allVideos.map((v: any) => ({ words: v.title.split(/\s+/).length, views: v.view_count }));
  const shortTitles = titleLengths.filter(t => t.words <= 5);
  const mediumTitles = titleLengths.filter(t => t.words >= 6 && t.words <= 10);
  const longTitles = titleLengths.filter(t => t.words > 10);
  const shortAvg = shortTitles.reduce((s, t) => s + t.views, 0) / (shortTitles.length || 1);
  const mediumAvg = mediumTitles.reduce((s, t) => s + t.views, 0) / (mediumTitles.length || 1);
  const longAvg = longTitles.reduce((s, t) => s + t.views, 0) / (longTitles.length || 1);

  let lengthCategory: string;
  let lengthScore: number;
  if (wordCount <= 5) { lengthCategory = 'short'; lengthScore = shortAvg >= mediumAvg ? 80 : 60; }
  else if (wordCount <= 10) { lengthCategory = 'medium'; lengthScore = 70; } // Medium is always solid
  else { lengthCategory = 'long'; lengthScore = longAvg >= mediumAvg ? 60 : 40; }

  factors.push({
    name: 'Title Length',
    score: lengthScore,
    insight: `${wordCount} words (${lengthCategory}). Short (1-5) avg ${Math.round(shortAvg).toLocaleString()}, medium (6-10) avg ${Math.round(mediumAvg).toLocaleString()}, long (11+) avg ${Math.round(longAvg).toLocaleString()} views.`,
  });

  // Factor 2: Question mark
  const hasQuestion = proposedTitle.includes('?');
  const qTitles = allVideos.filter((v: any) => v.title.includes('?'));
  const noQTitles = allVideos.filter((v: any) => !v.title.includes('?'));
  const qAvg = qTitles.reduce((s: number, v: any) => s + v.view_count, 0) / (qTitles.length || 1);
  const noQAvg = noQTitles.reduce((s: number, v: any) => s + v.view_count, 0) / (noQTitles.length || 1);
  const questionScore = hasQuestion ? (qAvg > noQAvg ? 85 : 45) : (noQAvg > qAvg ? 70 : 55);
  factors.push({
    name: 'Question Format',
    score: questionScore,
    insight: hasQuestion
      ? `Questions avg ${Math.round(qAvg).toLocaleString()} views (${qAvg > noQAvg ? 'above' : 'below'} non-questions at ${Math.round(noQAvg).toLocaleString()}).`
      : `Statements avg ${Math.round(noQAvg).toLocaleString()} views.`,
  });

  // Factor 3: Emotional/curiosity words
  const emotionalWords = ['worst', 'best', 'never', 'always', 'shocking', 'secret', 'crazy', 'insane',
    'hilarious', 'embarrassing', 'awkward', 'try not to', 'caught', 'exposed', 'truth', 'confession'];
  const emotionalMatches = emotionalWords.filter(w => titleLower.includes(w));
  const hasEmotional = emotionalMatches.length > 0;
  const emotionalVideos = allVideos.filter((v: any) => emotionalWords.some(w => v.title.toLowerCase().includes(w)));
  const emotionalAvg = emotionalVideos.reduce((s: number, v: any) => s + v.view_count, 0) / (emotionalVideos.length || 1);
  const emotionScore = hasEmotional ? Math.min(90, 60 + emotionalMatches.length * 15) : 40;
  factors.push({
    name: 'Emotional Trigger',
    score: emotionScore,
    insight: hasEmotional
      ? `Contains "${emotionalMatches.join('", "')}". Emotional titles avg ${Math.round(emotionalAvg).toLocaleString()} views.`
      : 'No strong emotional triggers detected. Consider adding curiosity or emotion.',
  });

  // Factor 4: Name mention (Toni/Ryan in title)
  const hasName = /toni|ryan/i.test(proposedTitle);
  const nameVideos = allVideos.filter((v: any) => /toni|ryan/i.test(v.title));
  const noNameVideos = allVideos.filter((v: any) => !/toni|ryan/i.test(v.title));
  const nameAvg = nameVideos.reduce((s: number, v: any) => s + v.view_count, 0) / (nameVideos.length || 1);
  const noNameAvg = noNameVideos.reduce((s: number, v: any) => s + v.view_count, 0) / (noNameVideos.length || 1);
  const nameScore = hasName ? (nameAvg > noNameAvg ? 75 : 55) : 60;
  factors.push({
    name: 'Name in Title',
    score: nameScore,
    insight: hasName
      ? `Titles with names avg ${Math.round(nameAvg).toLocaleString()} views.`
      : `Titles without names avg ${Math.round(noNameAvg).toLocaleString()} views.`,
  });

  // Factor 5: Numbers in title
  const hasNumber = /\d/.test(proposedTitle);
  const numVideos = allVideos.filter((v: any) => /\d/.test(v.title));
  const numAvg = numVideos.reduce((s: number, v: any) => s + v.view_count, 0) / (numVideos.length || 1);
  const numScore = hasNumber ? (numAvg > avgViews ? 75 : 50) : 55;
  factors.push({
    name: 'Numbers',
    score: numScore,
    insight: hasNumber
      ? `Titles with numbers avg ${Math.round(numAvg).toLocaleString()} views.`
      : 'No numbers. Listicle-style titles can drive clicks.',
  });

  // Overall score
  const overallScore = Math.round(factors.reduce((s, f) => s + f.score, 0) / factors.length);

  // Find similar top videos
  const titleWords = new Set(titleLower.split(/\s+/).filter(w => w.length > 3));
  const similarTop = top20
    .map((v: any) => {
      const vWords = new Set(v.title.toLowerCase().split(/\s+/).filter((w: string) => w.length > 3));
      const overlap = [...titleWords].filter(w => vWords.has(w)).length;
      return { title: v.title, views: v.view_count, overlap, similarity: `${overlap} shared words` };
    })
    .filter(v => v.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap)
    .slice(0, 5);

  // Prediction
  const multiplier = overallScore / 50;
  const predictedViews = Math.round(avgViews * multiplier);
  const prediction = `Estimated ${multiplier.toFixed(1)}x average (${predictedViews.toLocaleString()} views vs ${Math.round(avgViews).toLocaleString()} avg)`;

  return { score: overallScore, factors, similarTopVideos: similarTop, prediction, flags, videoType, avgViews: Math.round(avgViews) };
}
