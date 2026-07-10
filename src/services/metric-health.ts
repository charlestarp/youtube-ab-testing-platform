/**
 * Standing metric-health audit. The settled-CTR bug (2026-07-10) proved wrong
 * data can sit on the site looking plausible; this sweep checks every metric
 * pipeline for the three ways data lies: it stops flowing (stale), it flatlines
 * at zero while the site still renders it, or it goes impossible. Runs after
 * every reach-refresh cycle; emails an alert (rate-limited) on any FAIL.
 * Full scorecard at GET /api/learnings/metric-health.
 */

import { getDb } from '../db/client.js';

export interface HealthCheck {
  id: string;
  name: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
}

export interface MetricHealthReport {
  generated_at: string;
  overall: 'ok' | 'warn' | 'fail';
  checks: HealthCheck[];
}

export function computeMetricHealth(): MetricHealthReport {
  const db = getDb();
  const checks: HealthCheck[] = [];
  const add = (id: string, name: string, status: HealthCheck['status'], detail: string) => checks.push({ id, name, status, detail });

  // started_at is ISO ("...T...Z") while datetime('now') is "YYYY-MM-DD HH:MM:SS";
  // normalise before comparing or the 'T' sorts after the space and lies.
  const ISO = (col: string) => `replace(replace(${col},'T',' '),'.000Z','')`;

  // 1. Live CTR pipeline freshness: running tests must have a slot row touched recently.
  const running = (db.prepare(`SELECT COUNT(*) c FROM tests WHERE status='running' AND ${ISO('started_at')} <= datetime('now')`).get() as any).c;
  if (running > 0) {
    const latest = (db.prepare(`
      SELECT MAX(m.measured_at) t FROM test_measurements m
      JOIN tests ts ON ts.id = m.test_id WHERE ts.status='running'
    `).get() as any).t;
    const ageMin = latest ? (Date.now() - new Date(latest).getTime()) / 60000 : Infinity;
    add('reach_freshness', 'Live CTR refresh (reach-refresh)',
      ageMin < 45 ? 'ok' : 'fail',
      latest ? `newest running-test measurement is ${Math.round(ageMin)} min old (${running} running)` : `no measurements at all for ${running} running test(s)`);
  } else {
    add('reach_freshness', 'Live CTR refresh (reach-refresh)', 'ok', 'no running tests');
  }

  // 2. Extension hourly feed freshness (source for watch time, subs, backfill).
  const hmLatest = (db.prepare(`SELECT MAX(hour_ts) t FROM hourly_metrics`).get() as any).t;
  const hmAgeH = hmLatest ? (Date.now() - new Date(hmLatest).getTime()) / 3600000 : Infinity;
  add('hourly_feed', 'Extension hourly feed',
    hmAgeH < 8 ? 'ok' : hmAgeH < 24 ? 'warn' : 'fail',
    hmLatest ? `newest hourly_metrics row is ${hmAgeH.toFixed(1)}h old` : 'hourly_metrics is empty');

  // 3. Subscribers flowing: the channel gains subs daily; a fully-zero 48h window
  // means the SUBSCRIBERS_NET_CHANGE feed died, not that nobody subscribed.
  const subs48 = (db.prepare(`SELECT COUNT(*) c FROM hourly_metrics WHERE hour_ts > datetime('now','-48 hours') AND subscribers_net != 0`).get() as any).c;
  add('subs_flowing', 'Subscribers per hour',
    subs48 > 0 ? 'ok' : 'fail',
    `${subs48} nonzero subscriber-hours in the last 48h`);

  // 4. Likes/comments flowing on running tests: a big video gains likes every
  // hour; all-zero across every mature running test means getVideoStats
  // (public Data API) is failing quietly (how tests 194/195 finished with 0 likes).
  const lc = db.prepare(`
    SELECT COALESCE(SUM(m.likes),0) likes, COALESCE(SUM(m.comments),0) comments, COALESCE(SUM(m.impressions),0) imp
    FROM test_measurements m JOIN tests t ON t.id = m.test_id
    WHERE t.status='running' AND ${ISO('t.started_at')} < datetime('now','-3 hours')
  `).get() as any;
  if (lc.imp > 5000) {
    add('likes_flowing', 'Likes/comments per slot',
      (lc.likes > 0 || lc.comments > 0) ? 'ok' : 'fail',
      `${lc.likes} likes / ${lc.comments} comments across running tests with ${lc.imp} impressions`);
  } else {
    add('likes_flowing', 'Likes/comments per slot', 'ok', 'not enough running-test traffic to judge (needs 5k+ impressions)');
  }

  // 5. Zero-flatline sweep: metric columns that historically carry values but
  // have been 100% zero on real slot rows for 48h are dead pipes, not quiet days.
  const REAL = `(m.realtime_views_json LIKE '%"type":"rotation_slot"%' OR m.realtime_views_json LIKE '%"type":"reconstructed_vtr"%')`;
  for (const col of ['views', 'ctr', 'watch_time_hours', 'avg_view_duration', 'avg_view_pct']) {
    const r = db.prepare(`
      SELECT COUNT(*) n, SUM(m.${col} != 0) nz FROM test_measurements m
      WHERE ${REAL} AND m.measured_at > datetime('now','-48 hours') AND m.impressions > 100
    `).get() as any;
    if (r.n >= 5 && r.nz === 0) add(`zero_${col}`, `Column ${col}`, 'fail', `all ${r.n} real slot rows (48h, imp>100) have ${col}=0`);
  }

  // 6. Suspect measurements written recently (flagged at capture or impossible CTR).
  const suspect = (db.prepare(`
    SELECT COUNT(*) c FROM test_measurements m
    WHERE m.measured_at > datetime('now','-48 hours') AND (
      m.realtime_views_json LIKE '%"suspect":true%'
      OR m.impressions < 0 OR m.views < 0
      OR (m.impressions > 100 AND CAST(m.views AS REAL)/m.impressions > 0.25))
  `).get() as any).c;
  add('suspect_rows', 'Suspect measurements (48h)', suspect === 0 ? 'ok' : 'warn', `${suspect} flagged/impossible rows`);

  // 7. Winners stuck unapplied: the thumbnail on YouTube is not the declared winner.
  const stuck = (db.prepare(`
    SELECT COUNT(*) c FROM tests WHERE status='completed' AND winner_applied=0
      AND winner_variant_id IS NOT NULL AND completed_at < datetime('now','-6 hours') AND completed_at > datetime('now','-4 days')
  `).get() as any).c;
  add('winner_applied', 'Winners pushed live', stuck === 0 ? 'ok' : 'fail', `${stuck} completed test(s) with winner not applied after 6h`);

  // 8. Settled reports going out (email pipe alive).
  const unsent = (db.prepare(`
    SELECT COUNT(*) c FROM tests WHERE status='completed' AND COALESCE(settled_report_sent,0)=0
      AND completed_at <= datetime('now','-50 hours') AND completed_at > datetime('now','-72 hours')
  `).get() as any).c;
  add('settled_reports', 'Settled final reports', unsent === 0 ? 'ok' : 'warn', `${unsent} report(s) overdue`);

  // 9. Tests flagged as having broken hourly attribution.
  const noHourly = (db.prepare(`SELECT COUNT(*) c FROM tests WHERE status='running' AND COALESCE(hourly_available,1)=0`).get() as any).c;
  add('hourly_attribution', 'Hourly attribution', noHourly === 0 ? 'ok' : 'warn', `${noHourly} running test(s) without hourly resolution (daily-only videos)`);

  const overall = checks.some(c => c.status === 'fail') ? 'fail' : checks.some(c => c.status === 'warn') ? 'warn' : 'ok';
  return { generated_at: new Date().toISOString(), overall, checks };
}

// Alert email, rate-limited to one per 6h (module state; a restart may re-alert
// once, which is acceptable for a fail condition that is still true).
let _lastAlertAt = 0;

export async function metricHealthSweep(): Promise<void> {
  const report = computeMetricHealth();
  const fails = report.checks.filter(c => c.status === 'fail');
  const warns = report.checks.filter(c => c.status === 'warn');
  if (fails.length > 0) console.error(`[metric-health] FAIL: ${fails.map(f => `${f.id} (${f.detail})`).join('; ')}`);
  if (warns.length > 0) console.warn(`[metric-health] warn: ${warns.map(f => f.id).join(', ')}`);
  if (fails.length === 0) return;
  if (Date.now() - _lastAlertAt < 6 * 3600_000) return;
  _lastAlertAt = Date.now();
  try {
    const { sendEmail } = await import('./email.js');
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const row = (c: HealthCheck) => `<tr>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;font-weight:700;color:${c.status === 'fail' ? '#d84a4a' : c.status === 'warn' ? '#c98a1b' : '#3a9c5f'}">${c.status.toUpperCase()}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee">${esc(c.name)}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;color:#666">${esc(c.detail)}</td></tr>`;
    await sendEmail(process.env.NOTIFICATION_EMAIL || 'team@example.com',
      `YT Testing data problem: ${fails.map(f => f.name).join(', ')}`, `
      <div style="font-family:Helvetica Neue,sans-serif;max-width:640px;margin:0 auto;padding:40px 20px">
        <h2 style="color:#d84a4a">Data pipeline problem detected</h2>
        <p>The metric-health audit found ${fails.length} failing pipeline${fails.length === 1 ? '' : 's'}. Data shown on the site for these metrics is stale or frozen until this is fixed.</p>
        <table style="border-collapse:collapse;width:100%;font-size:13px">${report.checks.map(row).join('')}</table>
        <p style="font-size:12px;color:#888;margin-top:10px">Full scorecard: api.example.com/api/learnings/metric-health. Alerts are limited to one per 6 hours.</p>
      </div>`);
  } catch (e: any) {
    console.error(`[metric-health] alert email failed: ${e.message}`);
  }
}
