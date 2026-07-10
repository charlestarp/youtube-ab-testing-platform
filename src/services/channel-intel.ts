import { getDb } from '../db/client.js';

// ---------------------------------------------------------------------------
// Channel Intelligence — a single text block summarising what actually works
// on the Toni and Ryan channel, computed from real performance data:
//   1. CTR leaders/laggards (YouTube Studio scraped snapshots)
//   2. A/B title test results — winning vs losing wording with CTR deltas
//   3. View-count leaders/laggards across the podcast back-catalogue
//   4. Title pattern + topic-word stats
// Cached in memory + DB, refreshed daily. Injected into the system prompt of
// the title chat with Anthropic prompt caching (cache_control) since it's long.
// ---------------------------------------------------------------------------

const TTL_MS = 24 * 60 * 60 * 1000;
let memCache: { content: string; generatedAt: number } | null = null;

export function getChannelIntel(): string {
  const now = Date.now();
  if (memCache && now - memCache.generatedAt < TTL_MS) return memCache.content;

  const db = getDb();

  // Try DB cache (survives restarts)
  try {
    const row = db.prepare('SELECT content, generated_at FROM channel_intel_cache WHERE id = 1').get() as any;
    if (row) {
      const age = now - new Date(row.generated_at + 'Z').getTime();
      if (age < TTL_MS) {
        memCache = { content: row.content, generatedAt: now - age };
        return row.content;
      }
    }
  } catch {}

  const content = buildChannelIntel();
  memCache = { content, generatedAt: now };
  try {
    db.prepare(
      "INSERT INTO channel_intel_cache (id, content, generated_at) VALUES (1, ?, datetime('now')) " +
      "ON CONFLICT(id) DO UPDATE SET content = excluded.content, generated_at = excluded.generated_at"
    ).run(content);
  } catch {}
  return content;
}

const isTNTL = (t: string) => /^try not to laugh/i.test(t || '');

function buildChannelIntel(): string {
  const db = getDb();
  const parts: string[] = [];
  const today = new Date().toISOString().slice(0, 10);
  parts.push(`# TONI AND RYAN CHANNEL INTELLIGENCE (computed from real performance data, ${today})`);
  parts.push(
    'All numbers below come from this channel\'s own YouTube Studio data and A/B tests. ' +
    'TNTL = "TRY NOT TO LAUGH" compilation videos — a separate content type from podcast episodes. ' +
    'When titling PODCAST episodes, weight the PODCAST data; TNTL data is only useful as general wording evidence.'
  );

  // ---- 1. CTR leaders / laggards (Studio snapshots) ----
  try {
    const rows = db.prepare(`
      SELECT cv.title, s.impressions, s.ctr
      FROM channel_videos cv
      JOIN (
        SELECT video_id, impressions, ctr FROM studio_snapshots
        WHERE id IN (SELECT MAX(id) FROM studio_snapshots GROUP BY video_id)
      ) s ON s.video_id = cv.video_id
      WHERE s.impressions >= 5000 AND cv.is_short = 0 AND cv.duration_seconds > 180 AND s.ctr > 0
      ORDER BY s.ctr DESC
    `).all() as { title: string; impressions: number; ctr: number }[];

    const podcast = rows.filter(r => !isTNTL(r.title));
    const fmt = (r: any) => `- "${r.title}" — ${r.ctr.toFixed(2)}% CTR (${r.impressions.toLocaleString()} impressions)`;
    if (podcast.length > 0) {
      parts.push('## PODCAST EPISODES — MEASURED CTR (browse/home impressions, 5k+ impression floor, best to worst)');
      parts.push(podcast.map(fmt).join('\n'));
    }
    const tntl = rows.filter(r => isTNTL(r.title)).slice(0, 10);
    if (tntl.length > 0) {
      parts.push('## TNTL COMPILATIONS — MEASURED CTR (for reference only, different content type)');
      parts.push(tntl.map(fmt).join('\n'));
    }
  } catch {}

  // ---- 2. A/B test results — winning vs losing title wording ----
  try {
    const tests = db.prepare(`
      SELECT t.id, t.video_title, t.completed_at, t.winner_variant_id
      FROM tests t
      WHERE t.status = 'completed' AND t.winner_variant_id IS NOT NULL AND t.test_type IN ('title','both')
      ORDER BY t.completed_at DESC LIMIT 25
    `).all() as any[];

    const variantStmt = db.prepare(`
      SELECT tv.id, tv.title,
        (SELECT ROUND(AVG(m.ctr), 2) FROM test_measurements m WHERE m.variant_id = tv.id AND m.impressions > 100) AS avg_ctr
      FROM test_variants tv WHERE tv.test_id = ? AND tv.title IS NOT NULL
    `);

    const lines: string[] = [];
    for (const t of tests) {
      const variants = (variantStmt.all(t.id) as any[]).filter(v => v.avg_ctr != null);
      if (variants.length < 2) continue;
      const winner = variants.find(v => v.id === t.winner_variant_id);
      if (!winner) continue;
      const losers = variants.filter(v => v.id !== t.winner_variant_id);
      const tag = isTNTL(t.video_title || '') || variants.some(v => isTNTL(v.title)) ? 'TNTL' : 'PODCAST';
      lines.push(`[${tag}] WON: "${winner.title}" (${winner.avg_ctr}% CTR)`);
      for (const l of losers) {
        const d = winner.avg_ctr - l.avg_ctr;
        lines.push(`    LOST: "${l.title}" (${l.avg_ctr}% CTR, winner ${d >= 0 ? '+' : ''}${d.toFixed(2)} pts)`);
      }
    }
    if (lines.length > 0) {
      parts.push('## A/B TITLE TEST RESULTS — LITERAL EVIDENCE OF WHICH WORDING WINS (most recent first)');
      parts.push('These are head-to-head tests on the SAME video, so the CTR difference is purely the title wording.');
      parts.push(lines.join('\n'));
    }
  } catch {}

  // ---- 3. View-count leaders / laggards across the podcast back-catalogue ----
  try {
    const top = db.prepare(`
      SELECT title, view_count, publish_date FROM yt.videos
      WHERE category = 'podcast' AND view_count > 0
      ORDER BY view_count DESC LIMIT 20
    `).all() as any[];
    const bottom = db.prepare(`
      SELECT title, view_count, publish_date FROM yt.videos
      WHERE category = 'podcast' AND view_count > 0
        AND publish_date >= date('now', '-18 months') AND publish_date <= date('now', '-14 days')
      ORDER BY view_count ASC LIMIT 20
    `).all() as any[];
    const fmt = (r: any) => `- "${r.title}" — ${r.view_count.toLocaleString()} views (${(r.publish_date || '').slice(0, 10)})`;
    if (top.length > 0) {
      parts.push('## TOP 20 PODCAST EPISODES BY VIEWS (all time) — these titles are the style anchors');
      parts.push(top.map(fmt).join('\n'));
    }
    if (bottom.length > 0) {
      parts.push('## BOTTOM 20 PODCAST EPISODES BY VIEWS (last 18 months) — what to avoid');
      parts.push(bottom.map(fmt).join('\n'));
    }
  } catch {}

  // ---- 4. Title pattern + topic-word stats ----
  try {
    const vids = db.prepare(`
      SELECT title, view_count FROM yt.videos
      WHERE category = 'podcast' AND view_count > 0 AND publish_date >= date('now', '-24 months')
    `).all() as { title: string; view_count: number }[];

    if (vids.length >= 30) {
      const avg = (a: typeof vids) => a.reduce((s, v) => s + v.view_count, 0) / (a.length || 1);
      const overall = avg(vids);
      const buckets: [string, (t: string) => boolean][] = [
        ['1-4 words', t => t.split(/\s+/).length <= 4],
        ['5-7 words', t => { const n = t.split(/\s+/).length; return n >= 5 && n <= 7; }],
        ['8-10 words', t => { const n = t.split(/\s+/).length; return n >= 8 && n <= 10; }],
        ['11+ words', t => t.split(/\s+/).length >= 11],
        ['contains "?"', t => t.includes('?')],
        ['contains a number', t => /\d/.test(t)],
        ['mentions Toni or Ryan by name', t => /\b(toni|ryan)\b/i.test(t)],
        ['CONFESSION: prefix', t => /^confession/i.test(t)],
        ['ends with "..."', t => /\.\.\.$/.test(t.trim())],
      ];
      const lines = buckets.map(([label, test]) => {
        const matching = vids.filter(v => test(v.title));
        if (matching.length < 5) return null;
        const lift = ((avg(matching) / overall - 1) * 100).toFixed(0);
        return `- ${label}: ${matching.length} episodes, avg ${Math.round(avg(matching)).toLocaleString()} views (${Number(lift) >= 0 ? '+' : ''}${lift}% vs channel avg ${Math.round(overall).toLocaleString()})`;
      }).filter(Boolean);

      // Topic words that over/under-perform
      const stop = new Set(['the', 'a', 'an', 'to', 'of', 'in', 'on', 'and', 'is', 'it', 'this', 'that', 'for', 'with', 'we', 'you', 'your', 'our', 'his', 'her', 'was', 'are', 'be', 'has', 'have', 'not', 'at', 'by', 'from', 'or', 'as', 'but', 'what', 'who', 'how', 'why', 'when', 'i', 'my', 'me', 's', 't']);
      const wordStats = new Map<string, { count: number; views: number }>();
      for (const v of vids) {
        for (const w of new Set(v.title.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 2 && !stop.has(w)))) {
          const e = wordStats.get(w) || { count: 0, views: 0 };
          e.count++; e.views += v.view_count;
          wordStats.set(w, e);
        }
      }
      const words = [...wordStats.entries()]
        .filter(([, s]) => s.count >= 4)
        .map(([w, s]) => ({ w, count: s.count, lift: (s.views / s.count) / overall }))
        .sort((a, b) => b.lift - a.lift);
      const topWords = words.slice(0, 12).map(x => `"${x.w}" (${x.count} eps, ${x.lift >= 1 ? '+' : ''}${((x.lift - 1) * 100).toFixed(0)}%)`);
      const botWords = words.slice(-8).map(x => `"${x.w}" (${x.count} eps, ${((x.lift - 1) * 100).toFixed(0)}%)`);

      parts.push(`## TITLE PATTERN STATS (podcast episodes, last 24 months, n=${vids.length})`);
      parts.push(lines.join('\n'));
      if (topWords.length) parts.push(`Overperforming title words: ${topWords.join(', ')}`);
      if (botWords.length) parts.push(`Underperforming title words: ${botWords.join(', ')}`);
    }
  } catch {}

  return parts.join('\n\n');
}

export function refreshChannelIntel(): string {
  memCache = null;
  try { getDb().prepare('DELETE FROM channel_intel_cache WHERE id = 1').run(); } catch {}
  return getChannelIntel();
}
