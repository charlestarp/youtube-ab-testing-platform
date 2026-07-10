/**
 * Load competitor thumbnail vision results (produced in-chat by session agents,
 * NOT the app API key) from JSONL files into competitor_thumbnail_analysis.
 *
 * Each JSONL line: { video_id, expression, mouth_open, eyebrows_raised,
 *   face_count, face_size, faces:[{position,gender,expression,mouth_open}],
 *   primary_color, secondary_color, brightness, contrast, has_text,
 *   text_content, text_color, text_size, all_caps_text, layout,
 *   background_type, has_border, has_emoji }
 *
 * Usage: tsx src/scripts/load-competitor-thumbs.ts <dir-with-jsonl>
 * channel_name/title/thumbnail_url/views are joined from competitor_videos.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDb } from '../db/client.js';

const dir = process.argv[2];
if (!dir) { console.error('usage: load-competitor-thumbs.ts <dir>'); process.exit(1); }

const db = getDb();
const meta = db.prepare(`
  SELECT cv.title, cv.thumbnail_url, cv.views, c.name AS channel_name
  FROM competitor_videos cv JOIN competitors c ON cv.competitor_id = c.id
  WHERE cv.video_id = ?`);
const upsert = db.prepare(`
  INSERT INTO competitor_thumbnail_analysis (
    video_id, channel_name, title, thumbnail_url, views,
    expression, mouth_open, eyebrows_raised, face_count, face_size,
    primary_color, secondary_color, brightness, contrast,
    has_text, text_content, text_color, text_size, all_caps_text,
    layout, background_type, has_border, has_emoji, analysis_json, faces_json
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(video_id) DO UPDATE SET
    expression=excluded.expression, mouth_open=excluded.mouth_open,
    eyebrows_raised=excluded.eyebrows_raised, face_count=excluded.face_count,
    face_size=excluded.face_size, primary_color=excluded.primary_color,
    secondary_color=excluded.secondary_color, brightness=excluded.brightness,
    contrast=excluded.contrast, has_text=excluded.has_text,
    text_content=excluded.text_content, text_color=excluded.text_color,
    text_size=excluded.text_size, all_caps_text=excluded.all_caps_text,
    layout=excluded.layout, background_type=excluded.background_type,
    has_border=excluded.has_border, has_emoji=excluded.has_emoji,
    analysis_json=excluded.analysis_json, faces_json=excluded.faces_json,
    analyzed_at=datetime('now')`);
const b = (v: any) => (v === true || v === 1 || v === 'true' ? 1 : 0);

let loaded = 0, skipped = 0;
for (const f of readdirSync(dir).filter(f => f.endsWith('.jsonl'))) {
  for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let a: any;
    try { a = JSON.parse(t); } catch { skipped++; continue; }
    if (!a.video_id || !a.expression) { skipped++; continue; }
    const m = meta.get(a.video_id) as any;
    if (!m) { skipped++; continue; }
    upsert.run(
      a.video_id, m.channel_name, m.title, m.thumbnail_url, m.views,
      a.expression, b(a.mouth_open), b(a.eyebrows_raised), a.face_count || 0, a.face_size || 'none',
      a.primary_color, a.secondary_color, a.brightness, a.contrast,
      b(a.has_text), a.text_content || '', a.text_color || '', a.text_size || 'none', b(a.all_caps_text),
      a.layout, a.background_type, b(a.has_border), b(a.has_emoji),
      JSON.stringify(a), JSON.stringify(a.faces || []),
    );
    loaded++;
  }
}
console.log(`loaded ${loaded}, skipped ${skipped}`);
