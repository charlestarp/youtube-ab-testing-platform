/**
 * Nightly deep audit: our stored numbers vs YouTube Studio's own numbers.
 *
 * The metric-health sweep catches pipelines that stop or flatline; this catches
 * the quieter failure where data keeps flowing but DRIFTS from the truth
 * (mis-mapped hours, double counting, stale re-statements). For a sample of
 * videos it re-pulls Studio's per-hour series fresh and compares, hour for
 * hour, against what the site has stored. Emails the scorecard nightly.
 *
 * Sampled: videos with running tests, tests completed in the last 7 days,
 * capped at 8 videos (each costs ~3 internal API calls).
 */

import fs from 'fs';
import path from 'path';
import { getDb } from '../db/client.js';

export interface AuditRow {
  video_id: string;
  title: string;
  check: string;
  ours: number;
  studio: number;
  drift_pct: number | null;
  status: 'ok' | 'drift' | 'skip';
  note: string;
}

const REPORT_PATH = path.join(process.cwd(), 'data', 'deep-audit-latest.json');
const DRIFT_THRESHOLD = 10; // percent

function drift(ours: number, studio: number): number | null {
  if (studio <= 0) return null;
  return Math.round(Math.abs(ours - studio) / studio * 1000) / 10;
}

export async function runDeepAudit(): Promise<{ generated_at: string; rows: AuditRow[]; drifting: number }> {
  const db = getDb();
  const rows: AuditRow[] = [];

  const videos = db.prepare(`
    SELECT DISTINCT video_id, video_title FROM tests
    WHERE video_id IS NOT NULL AND (
      status = 'running'
      OR (status = 'completed' AND completed_at > datetime('now','-7 days')))
    ORDER BY id DESC LIMIT 8
  `).all() as any[];

  const { fetchReachHourly, fetchVideoPublicStats } = await import('./studio-fetch.js');

  for (const v of videos) {
    const title = (v.video_title || v.video_id).slice(0, 60);
    try {
      const payload = await fetchReachHourly(v.video_id);

      // 1. Per-hour impressions and views: our hourly_metrics vs Studio's fresh
      // series, summed over the hours BOTH sides have (common window only).
      const ourHours = new Map<string, { imp: number; views: number }>();
      for (const r of db.prepare('SELECT hour_ts, impressions, views FROM hourly_metrics WHERE video_id=?').all(v.video_id) as any[]) {
        ourHours.set(new Date(r.hour_ts).toISOString(), { imp: r.impressions, views: r.views });
      }
      // Window: last 7 days only. YouTube restates OLD history upward in later
      // reprocessing passes, so lifetime sums always drift a little on aged
      // videos; that is YouTube's behaviour, not a site bug. Recent hours are
      // where our capture is current and where tests actually run.
      const windowStart = Date.now() - 7 * 86400_000;
      let oursImp = 0, studioImp = 0, oursViews = 0, studioViews = 0, common = 0;
      for (let i = 0; i < payload.timestamps.length; i++) {
        const hMs = new Date(payload.timestamps[i]).getTime();
        if (hMs < windowStart) continue;
        const ours = ourHours.get(new Date(hMs).toISOString());
        if (!ours) continue;
        common++;
        oursImp += ours.imp; studioImp += payload.metrics.VIDEO_THUMBNAIL_IMPRESSIONS[i] || 0;
        oursViews += ours.views; studioViews += payload.metrics.EXTERNAL_VIEWS[i] || 0;
      }
      // 6+ common buckets: hourly-granularity videos give 168 in a week, but
      // aged videos degrade to DAILY buckets (~8 per week) and still deserve a
      // verdict — both sides store the same daily keys, so the sums compare 1:1.
      if (common >= 6 && studioImp > 1000) {
        const dImp = drift(oursImp, studioImp);
        rows.push({ video_id: v.video_id, title, check: 'hourly impressions (7d)', ours: oursImp, studio: studioImp, drift_pct: dImp, status: dImp !== null && dImp > DRIFT_THRESHOLD ? 'drift' : 'ok', note: `${common} common buckets` });
        const dViews = drift(oursViews, studioViews);
        rows.push({ video_id: v.video_id, title, check: 'hourly views (7d)', ours: oursViews, studio: studioViews, drift_pct: dViews, status: dViews !== null && dViews > DRIFT_THRESHOLD ? 'drift' : 'ok', note: `${common} common buckets` });
      } else {
        rows.push({ video_id: v.video_id, title, check: 'hourly impressions (7d)', ours: 0, studio: studioImp, drift_pct: null, status: 'skip', note: `only ${common} common buckets / ${studioImp} studio imp in window — not enough overlap` });
      }

      // 2. Test slot totals vs Studio's accrual over the same test window. The
      // slots are BUILT from this series, so material drift means slot mapping
      // is broken (the class of bug behind tests 187/188/190 this week).
      // Completed tests only: a running test's slots legitimately lag the studio
      // window (live slot accrues in 20-min deltas, hours settle later), so
      // comparing mid-flight would flag every young test.
      const tests = db.prepare(`
        SELECT id, started_at, completed_at, status FROM tests WHERE video_id = ?
          AND status='completed' AND completed_at > datetime('now','-7 days')
      `).all(v.video_id) as any[];
      for (const t of tests) {
        // Timestamps come in both "…T…Z" (ISO) and "YYYY-MM-DD HH:MM:SS" (SQLite
        // datetime('now'), UTC without a marker); parse both as UTC.
        const utcMs = (s: string) => new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z').getTime();
        const startMs = utcMs(t.started_at);
        const endMs = t.completed_at ? utcMs(t.completed_at) : Date.now();
        let studioWindowImp = 0;
        for (let i = 0; i < payload.timestamps.length; i++) {
          const h = new Date(payload.timestamps[i]).getTime();
          if (h >= startMs && h < endMs) studioWindowImp += payload.metrics.VIDEO_THUMBNAIL_IMPRESSIONS[i] || 0;
        }
        const slotImp = (db.prepare(`
          SELECT COALESCE(SUM(impressions),0) s FROM test_measurements
          WHERE test_id=? AND (realtime_views_json IS NULL OR realtime_views_json NOT LIKE '%"type":"activation_baseline"%')
        `).get(t.id) as any).s;
        if (studioWindowImp > 1000) {
          const d = drift(slotImp, studioWindowImp);
          rows.push({ video_id: v.video_id, title, check: `test ${t.id} slot impressions`, ours: slotImp, studio: studioWindowImp, drift_pct: d, status: d !== null && d > 15 ? 'drift' : 'ok', note: t.status });
        }
      }

      // 3. Lifetime likes/comments: latest studio_snapshots vs Studio now.
      const stats = await fetchVideoPublicStats(v.video_id);
      const snap = db.prepare('SELECT likes, comments FROM studio_snapshots WHERE video_id=? ORDER BY id DESC LIMIT 1').get(v.video_id) as any;
      if (snap && stats.likes > 100) {
        const d = drift(snap.likes, stats.likes);
        rows.push({ video_id: v.video_id, title, check: 'snapshot likes', ours: snap.likes, studio: stats.likes, drift_pct: d, status: d !== null && d > DRIFT_THRESHOLD ? 'drift' : 'ok', note: 'latest studio_snapshot vs live' });
      }
    } catch (e: any) {
      rows.push({ video_id: v.video_id, title, check: 'fetch', ours: 0, studio: 0, drift_pct: null, status: 'skip', note: `audit fetch failed: ${e.message.slice(0, 80)}` });
    }
  }

  // Winner-on-YouTube verification: is the declared winner actually live?
  // Mismatches are healed (winner_applied=0 + immediate re-push) inside.
  try {
    const { verifyWinnersLive } = await import('./winner-verify.js');
    for (const w of await verifyWinnersLive(true)) {
      rows.push({
        video_id: w.video_id, title: w.title, check: `winner ${w.check} live (test ${w.test_id})`,
        ours: 0, studio: 0, drift_pct: null,
        status: w.status === 'mismatch' ? 'drift' : w.status === 'skip' ? 'skip' : 'ok',
        note: w.status === 'mismatch' ? `${w.note} — re-apply queued` : w.note,
      });
    }
  } catch (e: any) {
    rows.push({ video_id: '-', title: 'winner verification', check: 'winner live', ours: 0, studio: 0, drift_pct: null, status: 'skip', note: `sweep failed: ${e.message.slice(0, 80)}` });
  }

  const report = { generated_at: new Date().toISOString(), rows, drifting: rows.filter(r => r.status === 'drift').length };
  try { fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2)); } catch {}
  return report;
}

export async function nightlyDeepAudit(): Promise<void> {
  const report = await runDeepAudit();
  const drifting = report.rows.filter(r => r.status === 'drift');
  console.log(`[deep-audit] ${report.rows.length} checks, ${drifting.length} drifting`);
  try {
    const { sendEmail } = await import('./email.js');
    const esc = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const color = (s: string) => s === 'drift' ? '#d84a4a' : s === 'skip' ? '#999' : '#3a9c5f';
    const tr = (r: AuditRow) => `<tr>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;font-weight:700;color:${color(r.status)}">${r.status.toUpperCase()}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eee">${esc(r.title)}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eee">${esc(r.check)}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right">${r.ours.toLocaleString()}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right">${r.studio.toLocaleString()}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right">${r.drift_pct === null ? '' : r.drift_pct + '%'}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;color:#888">${esc(r.note)}</td></tr>`;
    const subject = drifting.length > 0
      ? `YT Testing deep audit: ${drifting.length} metric(s) drifting from Studio`
      : `YT Testing deep audit: all clear (${report.rows.filter(r => r.status === 'ok').length} checks match Studio)`;
    await sendEmail(process.env.NOTIFICATION_EMAIL || 'team@example.com', subject, `
      <div style="font-family:Helvetica Neue,sans-serif;max-width:760px;margin:0 auto;padding:40px 20px">
        <h2 style="color:${drifting.length ? '#d84a4a' : '#3a9c5f'}">Nightly deep audit</h2>
        <p>Our stored numbers compared against YouTube Studio's own figures, pulled fresh tonight. Drift over ${DRIFT_THRESHOLD}% is flagged.</p>
        <table style="border-collapse:collapse;width:100%;font-size:12px">
          <tr style="text-align:left;color:#888"><th style="padding:6px 8px"></th><th style="padding:6px 8px">Video</th><th style="padding:6px 8px">Check</th><th style="padding:6px 8px;text-align:right">Ours</th><th style="padding:6px 8px;text-align:right">Studio</th><th style="padding:6px 8px;text-align:right">Drift</th><th style="padding:6px 8px">Note</th></tr>
          ${report.rows.map(tr).join('')}
        </table>
        <p style="font-size:12px;color:#888;margin-top:10px">Live report: api.example.com/api/deep-audit. Runs nightly at 3am Melbourne.</p>
      </div>`);
  } catch (e: any) {
    console.error(`[deep-audit] email failed: ${e.message}`);
  }
}

export function readLatestReport(): any {
  try { return JSON.parse(fs.readFileSync(REPORT_PATH, 'utf-8')); } catch { return null; }
}
