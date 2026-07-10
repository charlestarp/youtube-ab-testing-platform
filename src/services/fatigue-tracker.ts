/**
 * Title / Thumbnail Fatigue Tracker — detects when a pattern starts declining.
 *
 * Two surfaces are tracked SEPARATELY:
 *   - title   — words and title-format patterns (question, all caps, etc.)
 *   - thumbnail — visual attributes from thumbnail_analysis (expression, colour, layout, etc.)
 *
 * And podcast vs Try Not To Laugh (TNTL) are NEVER pooled — each pattern is
 * scored inside its own content bucket, because TNTL and podcast pull wildly
 * different view counts. Every item carries a plain-English `reason` explaining
 * why it looks fatigued (or fresh) so you know why to change it.
 */

import { getDb } from '../db/client.js';
import { classifyContent, ContentType, CONTENT_LABEL } from './content-type.js';

export interface FatiguePattern {
  pattern: string;
  kind: 'title' | 'thumbnail';
  type: 'title_word' | 'title_format' | 'thumbnail_attribute';
  contentType: ContentType;
  attribute?: string; // for thumbnails: which attribute (expression, layout, ...)
  recentAvgViews: number;
  historicalAvgViews: number;
  recentAvgCtr: number;      // 0 when unknown
  historicalAvgCtr: number;  // 0 when unknown
  changePercent: number;
  status: 'growing' | 'stable' | 'declining' | 'fatigued';
  videoCount: number;   // total videos carrying the pattern (recent + historical)
  recentCount: number;  // videos in the recent window carrying the pattern
  recentTotal: number;  // total videos in the recent window for this bucket
  reason: string;
  recommendation: string;
}

const RECENT_DAYS = 90;
const STOP_WORDS = new Set(['the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'her', 'was', 'one', 'our', 'out', 'has', 'his', 'how', 'its', 'may', 'new', 'now', 'old', 'see', 'way', 'who', 'did', 'get', 'got', 'had', 'him', 'let', 'say', 'she', 'too', 'use', 'try', 'laugh']);

function avg(nums: number[]): number {
  return nums.length ? nums.reduce((s, n) => s + n, 0) / nums.length : 0;
}

function statusFrom(changePercent: number): FatiguePattern['status'] {
  if (changePercent < -30) return 'fatigued';
  if (changePercent < -10) return 'declining';
  if (changePercent > 20) return 'growing';
  return 'stable';
}

function verb(changePercent: number): string {
  return changePercent < 0 ? 'fell' : changePercent > 0 ? 'rose' : 'held';
}

// ---------------------------------------------------------------------------
// Titles
// ---------------------------------------------------------------------------

function analyzeTitleFatigue(videos: any[], contentType: ContentType, cutoff: string): FatiguePattern[] {
  const label = CONTENT_LABEL[contentType];
  const recent = videos.filter((v: any) => v.publish_date >= cutoff);
  const historical = videos.filter((v: any) => v.publish_date < cutoff);
  if (recent.length < 3 || historical.length < 5) return [];

  const recentTotal = recent.length;
  const out: FatiguePattern[] = [];

  // --- Word patterns ---
  const wordCounts = new Map<string, { recent: number[]; historical: number[] }>();
  for (const v of videos) {
    const words = new Set<string>(
      v.title.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/)
        .filter((w: string) => w.length > 3 && !STOP_WORDS.has(w))
    );
    const isRecent = v.publish_date >= cutoff;
    for (const word of words) {
      if (!wordCounts.has(word)) wordCounts.set(word, { recent: [], historical: [] });
      const entry = wordCounts.get(word)!;
      if (isRecent) entry.recent.push(v.view_count);
      else entry.historical.push(v.view_count);
    }
  }

  for (const [word, data] of wordCounts) {
    if (data.recent.length < 2 || data.historical.length < 3) continue;
    const recentAvg = avg(data.recent);
    const historicalAvg = avg(data.historical);
    const changePercent = Math.round(((recentAvg - historicalAvg) / historicalAvg) * 100);
    const status = statusFrom(changePercent);
    if (status === 'stable') continue;

    const reason = `"${word}" ran in ${data.recent.length} of your last ${recentTotal} ${label} titles. Avg views ${verb(changePercent)} from ${Math.round(historicalAvg).toLocaleString()} to ${Math.round(recentAvg).toLocaleString()} (${changePercent > 0 ? '+' : ''}${changePercent}%).`;

    let recommendation: string;
    if (status === 'fatigued') recommendation = `The word "${word}" is worn out on ${label} titles. Retire it for a bit and test fresh angles.`;
    else if (status === 'declining') recommendation = `The word "${word}" is slipping on ${label} titles. Start testing alternatives.`;
    else recommendation = `The word "${word}" is pulling well on ${label} titles. Keep leaning on it.`;

    out.push({
      pattern: word, kind: 'title', type: 'title_word', contentType,
      recentAvgViews: Math.round(recentAvg), historicalAvgViews: Math.round(historicalAvg),
      recentAvgCtr: 0, historicalAvgCtr: 0,
      changePercent, status,
      videoCount: data.recent.length + data.historical.length,
      recentCount: data.recent.length, recentTotal,
      reason, recommendation,
    });
  }

  // --- Format patterns ---
  const formatPatterns = [
    { name: 'Question titles', test: (t: string) => t.includes('?') },
    { name: 'ALL CAPS words', test: (t: string) => /[A-Z]{3,}/.test(t) },
    { name: 'Number in title', test: (t: string) => /\d/.test(t) },
    { name: 'Colon separator', test: (t: string) => t.includes(':') },
    { name: 'Exclamation mark', test: (t: string) => t.includes('!') },
  ];

  for (const fp of formatPatterns) {
    const recentMatches = recent.filter((v: any) => fp.test(v.title));
    const historicalMatches = historical.filter((v: any) => fp.test(v.title));
    if (recentMatches.length < 2 || historicalMatches.length < 2) continue;

    const recentAvg = avg(recentMatches.map((v: any) => v.view_count));
    const historicalAvg = avg(historicalMatches.map((v: any) => v.view_count));
    const changePercent = Math.round(((recentAvg - historicalAvg) / historicalAvg) * 100);
    const status = statusFrom(changePercent);
    if (status === 'stable') continue;

    const reason = `The ${fp.name} format ran on ${recentMatches.length} of your last ${recentTotal} ${label} videos. Avg views ${verb(changePercent)} from ${Math.round(historicalAvg).toLocaleString()} to ${Math.round(recentAvg).toLocaleString()} (${changePercent > 0 ? '+' : ''}${changePercent}%).`;

    let recommendation: string;
    if (status === 'fatigued') recommendation = `The ${fp.name} format is losing steam for ${label}. Time to switch it up.`;
    else if (status === 'declining') recommendation = `The ${fp.name} format is declining for ${label}. Start testing alternatives.`;
    else recommendation = `The ${fp.name} format is working well for ${label}. Keep using it.`;

    out.push({
      pattern: fp.name, kind: 'title', type: 'title_format', contentType,
      recentAvgViews: Math.round(recentAvg), historicalAvgViews: Math.round(historicalAvg),
      recentAvgCtr: 0, historicalAvgCtr: 0,
      changePercent, status,
      videoCount: recentMatches.length + historicalMatches.length,
      recentCount: recentMatches.length, recentTotal,
      reason, recommendation,
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Thumbnails
// ---------------------------------------------------------------------------

const THUMB_ATTRS: { key: string; label: string }[] = [
  { key: 'expression', label: 'expression' },
  { key: 'primary_color', label: 'primary colour' },
  { key: 'face_size', label: 'face size' },
  { key: 'layout', label: 'layout' },
  { key: 'background_type', label: 'background' },
  { key: 'brightness', label: 'brightness' },
  { key: 'text_size', label: 'text size' },
];

function analyzeThumbnailFatigue(rows: any[], contentType: ContentType, cutoff: string): FatiguePattern[] {
  const label = CONTENT_LABEL[contentType];
  const recentRows = rows.filter((r: any) => r.publish_date >= cutoff);
  if (recentRows.length < 3 || rows.length - recentRows.length < 5) return [];

  const recentTotal = recentRows.length;
  const out: FatiguePattern[] = [];

  for (const attr of THUMB_ATTRS) {
    // value -> recent/historical views + ctr
    const byValue = new Map<string, { rViews: number[]; hViews: number[]; rCtr: number[]; hCtr: number[] }>();
    for (const r of rows) {
      const value = r[attr.key];
      if (value === null || value === undefined || value === '' || value === 'none') continue;
      const key = String(value);
      if (!byValue.has(key)) byValue.set(key, { rViews: [], hViews: [], rCtr: [], hCtr: [] });
      const entry = byValue.get(key)!;
      const isRecent = r.publish_date >= cutoff;
      if (isRecent) { entry.rViews.push(r.views); if (r.ctr > 0) entry.rCtr.push(r.ctr); }
      else { entry.hViews.push(r.views); if (r.ctr > 0) entry.hCtr.push(r.ctr); }
    }

    for (const [value, data] of byValue) {
      if (data.rViews.length < 2 || data.hViews.length < 3) continue;
      const recentAvg = avg(data.rViews);
      const historicalAvg = avg(data.hViews);
      const changePercent = Math.round(((recentAvg - historicalAvg) / historicalAvg) * 100);
      const status = statusFrom(changePercent);
      if (status === 'stable') continue;

      const recentCtr = Math.round(avg(data.rCtr) * 100) / 100;
      const historicalCtr = Math.round(avg(data.hCtr) * 100) / 100;
      let ctrPart = '';
      if (recentCtr > 0 && historicalCtr > 0) {
        const cverb = recentCtr < historicalCtr ? 'fell' : recentCtr > historicalCtr ? 'rose' : 'held';
        ctrPart = `, and CTR ${cverb} from ${historicalCtr}% to ${recentCtr}%`;
      }

      const reason = `The "${value}" ${attr.label} showed up on ${data.rViews.length} of your last ${recentTotal} ${label} thumbnails. Avg views ${verb(changePercent)} from ${Math.round(historicalAvg).toLocaleString()} to ${Math.round(recentAvg).toLocaleString()}${ctrPart} (${changePercent > 0 ? '+' : ''}${changePercent}%).`;

      let recommendation: string;
      if (status === 'fatigued') recommendation = `The "${value}" ${attr.label} is wearing out on ${label} thumbnails. Try a different ${attr.label} on the next few.`;
      else if (status === 'declining') recommendation = `The "${value}" ${attr.label} is starting to slip on ${label} thumbnails. Worth testing alternatives.`;
      else recommendation = `The "${value}" ${attr.label} is pulling well on ${label} thumbnails. Keep using it.`;

      out.push({
        pattern: value, kind: 'thumbnail', type: 'thumbnail_attribute', contentType, attribute: attr.label,
        recentAvgViews: Math.round(recentAvg), historicalAvgViews: Math.round(historicalAvg),
        recentAvgCtr: recentCtr, historicalAvgCtr: historicalCtr,
        changePercent, status,
        videoCount: data.rViews.length + data.hViews.length,
        recentCount: data.rViews.length, recentTotal,
        reason, recommendation,
      });
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Detect fatiguing title and thumbnail patterns, split by content type.
 * Returns a flat list; each item is tagged with `kind` (title|thumbnail) and
 * `contentType` (podcast|TNTL) so the UI can group into the four lenses.
 */
export function detectFatigue(): FatiguePattern[] {
  const db = getDb();
  const cutoff = new Date(Date.now() - RECENT_DAYS * 86400000).toISOString().split('T')[0];

  const patterns: FatiguePattern[] = [];

  // --- Titles ---
  const videos = db.prepare(`
    SELECT title, view_count, publish_date, category FROM yt.videos
    WHERE publish_date IS NOT NULL
    ORDER BY publish_date DESC LIMIT 400
  `).all() as any[];

  for (const ct of ['podcast', 'TNTL'] as ContentType[]) {
    const bucket = videos.filter((v: any) => classifyContent(v.title, v.category) === ct);
    if (bucket.length >= 20) patterns.push(...analyzeTitleFatigue(bucket, ct, cutoff));
  }

  // --- Thumbnails ---
  let thumbRows: any[] = [];
  try {
    thumbRows = db.prepare(`
      SELECT ta.expression, ta.primary_color, ta.face_size, ta.layout, ta.background_type,
             ta.brightness, ta.text_size, ta.views, ta.ctr,
             v.publish_date, v.title, v.category
      FROM thumbnail_analysis ta
      JOIN yt.videos v ON ta.video_id = v.video_id
      WHERE v.publish_date IS NOT NULL
    `).all() as any[];
  } catch { thumbRows = []; }

  for (const ct of ['podcast', 'TNTL'] as ContentType[]) {
    const bucket = thumbRows.filter((r: any) => classifyContent(r.title, r.category) === ct);
    if (bucket.length >= 10) patterns.push(...analyzeThumbnailFatigue(bucket, ct, cutoff));
  }

  // Sort: fatigued first, then declining, then growing; within a status by size of move
  const statusOrder = { fatigued: 0, declining: 1, growing: 2, stable: 3 };
  return patterns.sort((a, b) => {
    if (statusOrder[a.status] !== statusOrder[b.status]) return statusOrder[a.status] - statusOrder[b.status];
    return Math.abs(b.changePercent) - Math.abs(a.changePercent);
  });
}
