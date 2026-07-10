/**
 * One-shot / scheduled runner: pull real Reach CTR server-side and feed the ingestion.
 *   npx tsx src/scripts/pull-reach.ts <videoId> [--post] [--verify <testId>]
 * Without --post it just prints (dry run + verification). With --post it sends the
 * aligned per-hour rows to /api/studio/hourly-data so C/D update from real data.
 */
import Database from 'better-sqlite3';
import path from 'path';
import { fetchReachHourly } from '../services/studio-fetch';

const videoId = process.argv[2];
const doPost = process.argv.includes('--post');
const verifyIdx = process.argv.indexOf('--verify');
const verifyTestId = verifyIdx >= 0 ? parseInt(process.argv[verifyIdx + 1]) : null;
if (!videoId) { console.error('usage: pull-reach <videoId> [--post] [--verify <testId>]'); process.exit(1); }

(async () => {
  const p = await fetchReachHourly(videoId);
  console.log(`channel=${p.channel_id} | lifetime imp=${p.total_impressions} blended CTR=${p.total_ctr}%`);
  console.log(`hours with data: ${p.timestamps.length}`);
  for (let i = 0; i < p.timestamps.length; i++) {
    console.log(`  ${p.timestamps[i]}  imp=${p.metrics.VIDEO_THUMBNAIL_IMPRESSIONS[i]}  views=${p.metrics.EXTERNAL_VIEWS[i]}  ctr=${p.metrics.VIDEO_THUMBNAIL_IMPRESSIONS_VTR[i]}%`);
  }

  if (verifyTestId) {
    const db = new Database(path.join(process.cwd(), 'data/testing.db'), { readonly: true });
    const variants = db.prepare('SELECT id,label,active,active_since FROM test_variants WHERE test_id=?').all(verifyTestId) as any[];
    const meas = db.prepare(`SELECT variant_id, realtime_views_json FROM test_measurements WHERE test_id=?`).all(verifyTestId) as any[];
    const slots: { vid: number; label: string; start: number; end: number }[] = [];
    const labelOf: Record<number, string> = {}; for (const v of variants) labelOf[v.id] = v.label;
    for (const m of meas) { try { const j = JSON.parse(m.realtime_views_json || '{}'); if (j.activated_at && j.completed_at) slots.push({ vid: m.variant_id, label: labelOf[m.variant_id], start: new Date(j.activated_at).getTime(), end: new Date(j.completed_at).getTime() }); } catch {} }
    for (const v of variants) if (v.active_since) slots.push({ vid: v.id, label: v.label, start: new Date(v.active_since).getTime(), end: Date.now() });
    const agg: Record<string, { clicks: number; imp: number }> = {};
    for (let i = 0; i < p.timestamps.length; i++) {
      const hourStart = new Date(p.timestamps[i]).getTime();
      const imp = p.metrics.VIDEO_THUMBNAIL_IMPRESSIONS[i]; const ctr = p.metrics.VIDEO_THUMBNAIL_IMPRESSIONS_VTR[i];
      const slot = slots.find(s => hourStart >= s.start && hourStart < s.end);
      if (!slot) continue;
      if (!agg[slot.label]) agg[slot.label] = { clicks: 0, imp: 0 };
      agg[slot.label].clicks += imp * (ctr / 100); agg[slot.label].imp += imp;
    }
    console.log('\n=== per-variant CTR computed from REAL hourly data ===');
    for (const label of Object.keys(agg).sort()) { const a = agg[label]; console.log(`  ${label}: ${a.imp > 0 ? (a.clicks / a.imp * 100).toFixed(2) : '0'}%  (imp=${Math.round(a.imp)})`); }
    db.close();
  }

  if (doPost) {
    const fs = await import('fs');
    const dbPath = path.join(process.cwd(), 'data/testing.db');
    const db = new Database(dbPath, { readonly: true });
    const sess = db.prepare("SELECT token FROM sessions WHERE expires_at > datetime('now') ORDER BY expires_at DESC LIMIT 1").get() as any;
    db.close();
    if (!sess) { console.error('no valid session token to POST with'); process.exit(2); }
    const r = await fetch('http://localhost:4700/api/studio/hourly-data', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sess.token}` },
      body: JSON.stringify({ video_id: p.video_id, timestamps: p.timestamps, metrics: p.metrics }),
    });
    console.log('\nPOST /api/studio/hourly-data ->', r.status, await r.text());
  }
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
