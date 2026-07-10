/**
 * Revive scorer. Finds published videos worth re-testing to get MORE views after
 * the first few days. The goldmine profile (from YouTube revival research): the
 * algorithm is already showing it (high impressions) but the packaging is losing
 * the click (low CTR) while the content is good (high retention). Fix the
 * packaging and you unlock impressions the video already earns.
 *
 * Only looks at videos past their 30-day discovery window (repackaging younger
 * videos disturbs discovery). Pulls impressions / CTR / retention per video from
 * the internal Studio API. Bounded + cached so the cost stays small.
 */
import { getDb } from '../db/client.js';
import { fetchReachHourly } from './studio-fetch.js';

export interface ReviveCandidate {
  video_id: string;
  title: string;
  impressions: number;
  ctr: number;
  avg_pct_watched: number;
  revive_score: number;
  reason: string;
}

export function ensureReviveSchema(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS revive_candidates (
      video_id TEXT PRIMARY KEY,
      title TEXT,
      impressions INTEGER,
      ctr REAL,
      avg_pct_watched REAL,
      revive_score REAL,
      reason TEXT,
      scored_at TEXT DEFAULT (datetime('now'))
    );
  `);
}

const sum = (a: number[] = []) => a.reduce((s, x) => s + (x || 0), 0);

/**
 * Score revival potential across a batch of revival-age videos and store the
 * candidates. Returns the ranked list (highest potential first).
 */
export async function scoreReviveCandidates(limit = 25): Promise<ReviveCandidate[]> {
  ensureReviveSchema();
  const db = getDb();
  // Revival-age videos (past discovery, not ancient), top by views — those have
  // impressions worth reviving.
  const vids = db.prepare(`
    SELECT video_id, title, duration_seconds, view_count FROM yt.videos
    WHERE publish_date <= date('now', '-30 days') AND publish_date >= date('now', '-150 days')
      AND view_count > 0 AND duration_seconds > 0
    ORDER BY view_count DESC LIMIT ?`).all(limit) as any[];
  if (!vids.length) return [];

  const measured: any[] = [];
  for (let i = 0; i < vids.length; i++) {
    const v = vids[i];
    // Space the Studio calls out — firing them in a tight loop trips rate-limiting
    // and Studio returns a login page (no channel id).
    if (i > 0) await new Promise(res => setTimeout(res, 1800));
    try {
      const r: any = await fetchReachHourly(v.video_id);
      const imp = r.total_impressions || 0;
      const views = sum(r.metrics?.EXTERNAL_VIEWS);
      const watchHrs = sum(r.metrics?.EXTERNAL_WATCH_TIME_HOURS);
      const avd = views > 0 ? (watchHrs * 3600) / views : 0;
      const pctWatched = v.duration_seconds > 0 ? Math.min(1, avd / v.duration_seconds) : 0;
      if (imp > 0) measured.push({ ...v, imp, ctr: r.total_ctr || 0, pctWatched });
    } catch (e: any) { console.error(`[revive] ${v.video_id} reach failed:`, e?.message); }
  }
  if (!measured.length) return [];

  // Batch reference points.
  const med = (arr: number[]) => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] || 0; };
  const medCtr = med(measured.map(m => m.ctr));
  const maxImp = Math.max(...measured.map(m => m.imp));
  const maxPct = Math.max(...measured.map(m => m.pctWatched)) || 1;

  const scored: ReviveCandidate[] = measured.map(m => {
    const impNorm = m.imp / maxImp;                              // how much reach it already gets
    const ctrGap = medCtr > 0 ? Math.max(0, (medCtr - m.ctr) / medCtr) : 0; // how far below median CTR (opportunity)
    const retNorm = m.pctWatched / maxPct;                       // how good the content is
    const revive_score = +(impNorm * (0.25 + ctrGap) * (0.35 + retNorm)).toFixed(3);
    const reasonBits: string[] = [];
    if (impNorm > 0.4) reasonBits.push('already getting good reach');
    if (m.ctr < medCtr) reasonBits.push(`CTR ${m.ctr.toFixed(1)}% below the ${medCtr.toFixed(1)}% median`);
    if (retNorm > 0.6) reasonBits.push(`strong retention (${Math.round(m.pctWatched * 100)}% watched)`);
    const reason = reasonBits.length ? reasonBits.join(', ') + ' — repackage to unlock the clicks.' : 'candidate for a packaging refresh.';
    return { video_id: m.video_id, title: m.title, impressions: m.imp, ctr: +m.ctr.toFixed(2), avg_pct_watched: +m.pctWatched.toFixed(3), revive_score, reason };
  }).sort((a, b) => b.revive_score - a.revive_score);

  const up = db.prepare(`INSERT INTO revive_candidates (video_id, title, impressions, ctr, avg_pct_watched, revive_score, reason, scored_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(video_id) DO UPDATE SET title=excluded.title, impressions=excluded.impressions, ctr=excluded.ctr, avg_pct_watched=excluded.avg_pct_watched, revive_score=excluded.revive_score, reason=excluded.reason, scored_at=datetime('now')`);
  for (const c of scored) up.run(c.video_id, c.title, c.impressions, c.ctr, c.avg_pct_watched, c.revive_score, c.reason);
  return scored;
}
