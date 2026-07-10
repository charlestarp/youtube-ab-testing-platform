/**
 * Retention-transcript overlay.
 *
 * Maps each video's retention curve onto its podcast transcript timeline to surface
 * the moments where viewers drop hardest and where they hold or re-engage.
 * Writes results to retention_moments so the API can serve them cheaply.
 *
 * Only podcast-format videos get transcript quotes; TNTL videos still get drop/hold
 * timecodes and segment types based on position and keyword heuristics alone.
 */

import { getDb } from '../db/client.js';

function fmt(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

// ── Drop detection ───────────────────────────────────────────────────────────
// Finds the windows where the retention curve falls fastest (steepest smoothed slope).
function findDropMoments(
  retention: number[],
  duration: number,
  topN = 2,
): Array<{ idx: number; timeSec: number; retentionPct: number; deltaPct: number }> {
  const len = retention.length;
  if (len < 20 || duration <= 0) return [];

  // Per-bucket slopes
  const slopes: number[] = [];
  for (let i = 0; i < len - 1; i++) slopes.push(retention[i + 1] - retention[i]);

  // Smooth over ±4-bucket window
  const halfWin = 4;
  const smoothed: number[] = slopes.map((_, i) => {
    let sum = 0, cnt = 0;
    for (let j = Math.max(0, i - halfWin); j <= Math.min(slopes.length - 1, i + halfWin); j++) {
      sum += slopes[j]; cnt++;
    }
    return sum / cnt;
  });

  // Skip intro (first 7%) and outro (last 5%)
  const startIdx = Math.max(halfWin, Math.floor(len * 0.07));
  const endIdx   = Math.min(len - halfWin - 2, Math.floor(len * 0.95));

  // Find local minima of smoothed slope (steepest-drop peaks)
  const candidates: { idx: number; slope: number }[] = [];
  for (let i = startIdx; i <= endIdx; i++) {
    const s = smoothed[i];
    if (s >= -0.15) continue; // only meaningful drops
    const isLocalMin =
      (i === 0 || smoothed[i] <= smoothed[i - 1]) &&
      (i >= smoothed.length - 1 || smoothed[i] <= smoothed[i + 1]);
    if (isLocalMin) candidates.push({ idx: i, slope: s });
  }

  // Sort steepest first
  candidates.sort((a, b) => a.slope - b.slope);

  // Deduplicate: keep moments at least 60s apart
  const minGapBuckets = Math.max(2, Math.round((60 / duration) * len));
  const results: Array<{ idx: number; timeSec: number; retentionPct: number; deltaPct: number }> = [];
  for (const c of candidates) {
    if (results.length >= topN) break;
    if (results.some(r => Math.abs(r.idx - c.idx) < minGapBuckets)) continue;
    const timeSec = (c.idx / len) * duration;
    results.push({
      idx: c.idx,
      timeSec,
      retentionPct: Math.round(retention[c.idx] * 10) / 10,
      deltaPct: Math.round(c.slope * 10) / 10,
    });
  }
  return results;
}

// ── Hold detection ───────────────────────────────────────────────────────────
// Finds points where retention is noticeably above the rolling baseline —
// the viewer stuck around longer than the overall decay would predict.
function findHoldMoments(
  retention: number[],
  duration: number,
  topN = 2,
): Array<{ idx: number; timeSec: number; retentionPct: number; deltaPct: number }> {
  const len = retention.length;
  if (len < 20 || duration <= 0) return [];

  // Rolling-average baseline (8% window)
  const halfWin = Math.max(4, Math.floor(len * 0.04));
  const smoothed: number[] = retention.map((_, i) => {
    let sum = 0, cnt = 0;
    for (let j = Math.max(0, i - halfWin); j <= Math.min(len - 1, i + halfWin); j++) {
      sum += retention[j]; cnt++;
    }
    return sum / cnt;
  });

  const delta = retention.map((v, i) => v - smoothed[i]);

  const peakWin = 3;
  const startIdx = Math.max(peakWin, Math.floor(len * 0.10));
  const endIdx   = Math.min(len - peakWin - 1, Math.floor(len * 0.95));

  const candidates: { idx: number; delta: number }[] = [];
  for (let i = startIdx; i <= endIdx; i++) {
    const d = delta[i];
    if (d < 0.3) continue;
    let isPeak = true;
    for (let k = 1; k <= peakWin; k++) {
      if (delta[i - k] > d || delta[i + k] > d) { isPeak = false; break; }
    }
    if (isPeak) candidates.push({ idx: i, delta: d });
  }

  candidates.sort((a, b) => b.delta - a.delta);

  const minGapBuckets = Math.max(2, Math.round((60 / duration) * len));
  const results: Array<{ idx: number; timeSec: number; retentionPct: number; deltaPct: number }> = [];
  for (const c of candidates) {
    if (results.length >= topN) break;
    if (results.some(r => Math.abs(r.idx - c.idx) < minGapBuckets)) continue;
    const timeSec = (c.idx / len) * duration;
    results.push({
      idx: c.idx,
      timeSec,
      retentionPct: Math.round(retention[c.idx] * 10) / 10,
      deltaPct: Math.round(c.delta * 10) / 10,
    });
  }
  return results;
}

// ── Segment type classification ───────────────────────────────────────────────
// Simple position + keyword heuristics — no LLM required.
function classifySegment(timeSec: number, duration: number, text: string): string {
  const pos = duration > 0 ? timeSec / duration : 0;
  if (pos < 0.06) return 'intro';
  if (pos > 0.92) return 'outro';
  const low = (text || '').toLowerCase();
  if (/sponsored|use code|promo code|discount|coupon|head to|sign up|percent off|get \d+%/.test(low)) return 'sponsor';
  if (/last week|last episode|previous(ly)?|to recap|we talked about|we discussed/.test(low)) return 'recap';
  return 'discussion';
}

// ── Transcript helpers ────────────────────────────────────────────────────────
interface Segment {
  speaker: string;
  text: string;
  start: number;
  end: number;
}

function norm(s: string): string {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Pull podcast transcript segments for a video (by title matching).
// Returns null if no match or podcast DB not attached.
function fetchTranscriptSegments(videoTitle: string): Segment[] | null {
  const db = getDb();
  try {
    const episodes = db.prepare(`SELECT id, title, duration FROM podcast.episodes WHERE is_prerelease = 0`).all() as any[];
    const t = norm(videoTitle);
    const match = episodes.find(e => norm(e.title) === t) ||
                  episodes.find(e => t && norm(e.title).includes(t.slice(0, 30)));
    if (!match) return null;
    const segs = db.prepare(
      `SELECT speaker, text, start, COALESCE(end, start + 30) as end
       FROM podcast.segments WHERE episode_id = ? ORDER BY start`,
    ).all(match.id) as Segment[];
    return segs.length > 0 ? segs : null;
  } catch {
    return null;
  }
}

// Extract ~2-sentence quote from segments at a given time, plus surrounding context.
function quoteAt(segments: Segment[], timeSec: number, windowSec = 45): string | null {
  if (!segments.length) return null;
  const nearby = segments.filter(s => Math.abs((s.start + s.end) / 2 - timeSec) < windowSec);
  if (!nearby.length) {
    // Fall back to the closest segment
    const closest = segments.reduce((best, s) => {
      const d = Math.abs((s.start + s.end) / 2 - timeSec);
      return d < Math.abs((best.start + best.end) / 2 - timeSec) ? s : best;
    });
    return closest.text.slice(0, 180);
  }
  // Take up to 3 segments nearest the moment, combine
  nearby.sort((a, b) => Math.abs((a.start + a.end) / 2 - timeSec) - Math.abs((b.start + b.end) / 2 - timeSec));
  const combined = nearby.slice(0, 3).map(s => `${s.speaker}: ${s.text}`).join(' ');
  return combined.slice(0, 220);
}

// ── Core compute function ─────────────────────────────────────────────────────
export function computeAndStoreVideoMoments(
  videoId: string,
  videoTitle: string,
  retentionJson: string,
  durationSeconds: number,
): boolean {
  let retention: number[] = [];
  try {
    retention = JSON.parse(retentionJson);
    if (!Array.isArray(retention) || retention.length < 20) return false;
  } catch {
    return false;
  }

  const drops = findDropMoments(retention, durationSeconds, 2);
  const holds = findHoldMoments(retention, durationSeconds, 2);

  if (drops.length === 0 && holds.length === 0) return false;

  // Try to get transcript for quotes — best effort
  const segments = fetchTranscriptSegments(videoTitle);

  const db = getDb();

  // Replace all moments for this video atomically
  const del = db.prepare(`DELETE FROM retention_moments WHERE video_id = ?`);
  const ins = db.prepare(`
    INSERT INTO retention_moments (video_id, moment_type, time_sec, timecode, retention_pct, delta_pct, transcript_quote, segment_type, computed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  const run = db.transaction(() => {
    del.run(videoId);
    for (const d of drops) {
      const quote = segments ? quoteAt(segments, d.timeSec) : null;
      const seg = classifySegment(d.timeSec, durationSeconds, quote || '');
      ins.run(videoId, 'drop', d.timeSec, fmt(d.timeSec), d.retentionPct, d.deltaPct, quote, seg);
    }
    for (const h of holds) {
      const quote = segments ? quoteAt(segments, h.timeSec) : null;
      const seg = classifySegment(h.timeSec, durationSeconds, quote || '');
      ins.run(videoId, 'hold', h.timeSec, fmt(h.timeSec), h.retentionPct, h.deltaPct, quote, seg);
    }
  });

  try {
    run();
    return true;
  } catch (e: any) {
    console.error(`[retention-overlay] store failed for ${videoId}: ${e?.message}`);
    return false;
  }
}

// ── Sweep ─────────────────────────────────────────────────────────────────────
export async function runRetentionOverlaySweep(days = 45): Promise<void> {
  const db = getDb();

  // Videos from channel_videos with a recent studio snapshot that has retention_json
  let videos: any[] = [];
  try {
    videos = db.prepare(`
      SELECT cv.video_id, cv.title, cv.duration_seconds,
             ss.retention_json
      FROM channel_videos cv
      JOIN (
        SELECT video_id, retention_json,
               ROW_NUMBER() OVER (PARTITION BY video_id ORDER BY scraped_at DESC) as rn
        FROM studio_snapshots
        WHERE retention_json IS NOT NULL AND retention_json != '' AND retention_json != '[]'
      ) ss ON ss.video_id = cv.video_id AND ss.rn = 1
      WHERE cv.published_at >= datetime('now', '-' || ? || ' days')
        AND cv.is_short = 0
        AND cv.duration_seconds > 0
      ORDER BY cv.published_at DESC
      LIMIT 30
    `).all(days) as any[];
  } catch (e: any) {
    console.error('[retention-overlay] sweep query failed:', e?.message);
    return;
  }

  let computed = 0;
  for (const v of videos) {
    if (!v.retention_json || !v.duration_seconds) continue;
    try {
      const ok = computeAndStoreVideoMoments(v.video_id, v.title || '', v.retention_json, v.duration_seconds);
      if (ok) computed++;
    } catch (e: any) {
      console.error(`[retention-overlay] ${v.video_id} failed: ${e?.message}`);
    }
  }

  if (computed > 0) console.log(`[retention-overlay] sweep: ${computed}/${videos.length} videos processed`);
}

// ── Read-side helpers ─────────────────────────────────────────────────────────
export interface RetentionMoment {
  moment_type: 'drop' | 'hold';
  time_sec: number;
  timecode: string;
  retention_pct: number;
  delta_pct: number;
  transcript_quote: string | null;
  segment_type: string;
}

export interface VideoMoments {
  video_id: string;
  title: string;
  thumbnail_url: string | null;
  published_at: string | null;
  duration_seconds: number;
  drop_moments: RetentionMoment[];
  hold_moments: RetentionMoment[];
  has_transcript: boolean;
  computed_at: string;
}

export interface SegmentScorecard {
  segment_type: string;
  video_count: number;
  avg_drop_delta: number | null;
  avg_hold_delta: number | null;
  verdict: 'holds' | 'sheds' | 'neutral';
}

export function getVideoMoments(days = 45, limit = 8): VideoMoments[] {
  const db = getDb();

  const videos = db.prepare(`
    SELECT cv.video_id, cv.title, cv.thumbnail_url, cv.published_at, cv.duration_seconds,
           MAX(rm.computed_at) as computed_at
    FROM channel_videos cv
    JOIN retention_moments rm ON rm.video_id = cv.video_id
    WHERE cv.published_at >= datetime('now', '-' || ? || ' days')
    GROUP BY cv.video_id
    ORDER BY cv.published_at DESC
    LIMIT ?
  `).all(days, limit) as any[];

  return videos.map(v => {
    const moments = db.prepare(
      `SELECT moment_type, time_sec, timecode, retention_pct, delta_pct, transcript_quote, segment_type
       FROM retention_moments WHERE video_id = ? ORDER BY time_sec`,
    ).all(v.video_id) as any[];

    const drops = moments.filter(m => m.moment_type === 'drop');
    const holds = moments.filter(m => m.moment_type === 'hold');
    const hasTranscript = moments.some(m => m.transcript_quote);

    return {
      video_id: v.video_id,
      title: v.title || '',
      thumbnail_url: v.thumbnail_url || null,
      published_at: v.published_at || null,
      duration_seconds: v.duration_seconds || 0,
      drop_moments: drops,
      hold_moments: holds,
      has_transcript: hasTranscript,
      computed_at: v.computed_at || '',
    };
  });
}

export function getSegmentScorecard(): SegmentScorecard[] {
  const db = getDb();

  const rows = db.prepare(`
    SELECT segment_type,
      COUNT(DISTINCT video_id) as video_count,
      AVG(CASE WHEN moment_type = 'drop' THEN delta_pct END) as avg_drop_delta,
      AVG(CASE WHEN moment_type = 'hold' THEN delta_pct END) as avg_hold_delta
    FROM retention_moments
    GROUP BY segment_type
    HAVING video_count >= 2
    ORDER BY video_count DESC
  `).all() as any[];

  return rows.map(r => {
    const drop = r.avg_drop_delta != null ? Math.round(r.avg_drop_delta * 10) / 10 : null;
    const hold = r.avg_hold_delta != null ? Math.round(r.avg_hold_delta * 10) / 10 : null;
    let verdict: 'holds' | 'sheds' | 'neutral' = 'neutral';
    if (hold != null && (drop == null || hold > Math.abs(drop ?? 0) * 0.7)) verdict = 'holds';
    else if (drop != null && drop < -0.5) verdict = 'sheds';
    return {
      segment_type: r.segment_type,
      video_count: r.video_count,
      avg_drop_delta: drop,
      avg_hold_delta: hold,
      verdict,
    };
  });
}
