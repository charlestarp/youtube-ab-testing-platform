/**
 * Keeps tagging current automatically. Runs on a timer: tags any NEW video
 * titles (that arrived via the daily sync) and any NEW test-variant thumbnails
 * that have not been tagged yet. Untagged-only, so the ongoing cost is tiny
 * (just the handful of new items since last run), and it never re-bills the
 * whole back catalogue.
 */
import { tagAllVideos, tagAllVariants } from './title-tagger.js';
import { autoTagBatch } from './auto-tagger.js';

let running = false;

export async function runTagMaintenance(): Promise<void> {
  if (running) return;
  running = true;
  try {
    // New video titles (regex tags are free; semantic tags hit the API only for
    // the new titles). Untagged-only keeps it cheap.
    try {
      const t = await tagAllVideos({ semantic: true, onlyUntagged: true });
      if (t.subjects > 0) console.log(`[tag-maintenance] tagged ${t.subjects} new title(s): ${t.rule_tags} rule + ${t.semantic_tags} semantic`);
    } catch (e: any) { console.error('[tag-maintenance] title tagging failed:', e?.message); }

    // New A/B title-test variants (question/number/name-drop/curiosity/confession...).
    try {
      const v = await tagAllVariants({ semantic: true, onlyUntagged: true });
      if (v.subjects > 0) console.log(`[tag-maintenance] tagged ${v.subjects} new title variant(s): ${v.rule_tags} rule + ${v.semantic_tags} semantic`);
    } catch (e: any) { console.error('[tag-maintenance] title-variant tagging failed:', e?.message); }

    // New thumbnails (Claude Vision), untagged variants only.
    try {
      const res = await autoTagBatch({ onlyUntagged: true, concurrency: 3 });
      const tagged = res.filter(r => !r.error && r.applied.length).length;
      if (tagged > 0) console.log(`[tag-maintenance] tagged ${tagged} new thumbnail(s)`);
    } catch (e: any) { console.error('[tag-maintenance] thumbnail tagging failed:', e?.message); }
  } finally {
    running = false;
  }
}

/** Start the recurring maintenance: shortly after boot, then every 6 hours. */
export function startTagMaintenance(): void {
  setTimeout(() => { runTagMaintenance(); }, 3 * 60 * 1000); // 3 min after boot
  setInterval(() => { runTagMaintenance(); }, 6 * 60 * 60 * 1000); // every 6h
}
