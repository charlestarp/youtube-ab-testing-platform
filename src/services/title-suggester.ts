/**
 * Proactive title suggester. For a published video, proposes ONE alternative
 * title worth A/B testing — grounded in what actually wins on THIS channel
 * (A/B tag uplift), our real titles (voice), competitor concepts, and the
 * episode transcript. Uses Haiku (cheap) because it runs autonomously and often;
 * all the reasoning is pre-computed in code, so the model only has to synthesise.
 * Returns null when the current title is already strong (no random churn).
 */
import Anthropic from '@anthropic-ai/sdk';
import { getDb } from '../db/client.js';
import { config } from '../config.js';
import { classifyContent } from './content-type.js';
import { computeTitleAbUplift } from './title-insights.js';
import { computeTagUplift } from './learnings.js';
import { logAiUsage } from '../lib/ai-usage-log.js';

// Sonnet, not Haiku: this runs on only a handful of new videos a day, so quality
// matters more than the tiny per-run cost. Haiku is for genuinely high-volume jobs.
const MODEL = 'claude-sonnet-4-6';

export interface TitleSuggestion {
  video_id: string;
  current_title: string;
  suggested_title: string;
  reasoning: string;
  based_on: string;
  thumbnail_concept: string;
}

export function ensureSuggestionSchema(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS video_title_suggestions (
      video_id TEXT PRIMARY KEY,
      current_title TEXT,
      suggested_title TEXT,
      reasoning TEXT,
      based_on TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  try { getDb().exec(`ALTER TABLE video_title_suggestions ADD COLUMN thumbnail_concept TEXT`); } catch {}
}

export async function suggestTitleForVideo(videoId: string): Promise<TitleSuggestion | null> {
  const db = getDb();
  const video: any = db.prepare(`SELECT video_id, title, category FROM yt.videos WHERE video_id = ?`).get(videoId);
  if (!video) return null;
  const ctype = classifyContent(video.title, video.category); // 'podcast' | 'TNTL'

  // What WINS/LOSES head-to-head on this content type (controlled A/B signal).
  const ab = ((computeTitleAbUplift(2) as any)[ctype] || []).filter((a: any) => a.tests >= 2);
  const winners = [...ab].sort((a: any, b: any) => b.avg_uplift_pct - a.avg_uplift_pct).filter((a: any) => a.avg_uplift_pct > 0 || a.win_rate >= 0.5).slice(0, 6);
  const losers = [...ab].filter((a: any) => a.avg_uplift_pct < 0 && a.win_rate < 0.5).slice(0, 4);

  const cat = ctype === 'TNTL' ? 'reaction' : 'podcast';
  const ourTop = (db.prepare(`SELECT title FROM yt.videos WHERE category = ? AND view_count > 0 ORDER BY view_count DESC LIMIT 12`).all(cat) as any[]).map(r => r.title);
  const compTop = (db.prepare(`SELECT title FROM competitor_videos WHERE duration_seconds >= 1500 AND views > 0 ORDER BY views DESC LIMIT 12`).all() as any[]).map(r => r.title);

  // What THIS video's thumbnail shows, so the title complements it rather than
  // restating it. Prefer the winning variant from any thumbnail test on this video.
  let thumbTweet = '', thumbTags: string[] = [];
  try {
    const tv: any = db.prepare(`
      SELECT tv.id, tv.tweet_text FROM test_variants tv
      JOIN tests t ON t.id = tv.test_id
      WHERE t.video_id = ? AND tv.thumbnail_path IS NOT NULL AND tv.thumbnail_path != ''
      ORDER BY (tv.id = t.winner_variant_id) DESC, tv.id DESC LIMIT 1`).get(videoId);
    if (tv) {
      thumbTweet = tv.tweet_text || '';
      thumbTags = (db.prepare(`SELECT th.name FROM variant_tags vt JOIN thumbnail_tags th ON th.id = vt.tag_id WHERE vt.variant_id = ?`).all(tv.id) as any[]).map(r => r.name);
    }
  } catch {}

  // Transcript topic (match by title in podcast.db).
  let transcript = '';
  try {
    const norm = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const eps = db.prepare(`SELECT id, title FROM podcast.episodes WHERE is_prerelease = 0`).all() as any[];
    const t = norm(video.title);
    const m = eps.find(e => norm(e.title) === t) || eps.find(e => t && norm(e.title).includes(t));
    if (m) {
      const segs = db.prepare(`SELECT text FROM podcast.segments WHERE episode_id = ? ORDER BY start LIMIT 500`).all(m.id) as any[];
      transcript = segs.map(s => s.text).join(' ').slice(0, 8000);
    }
  } catch {}

  // Winning thumbnail formula for this content type (best A/B attribute per category).
  const thumbTags2 = computeTagUplift(2, ctype).filter(t => t.tests >= 2);
  const formulaByCat = new Map<string, any>();
  for (const t of thumbTags2) { const c = t.category || 'other'; const cur = formulaByCat.get(c); if (!cur || t.avg_uplift_pct > cur.avg_uplift_pct) formulaByCat.set(c, t); }
  const thumbFormula = [...formulaByCat.entries()].map(([cat, t]) => `${cat}: ${t.name}`).join(', ');

  const named = ctype === 'TNTL' ? 'TRY NOT TO LAUGH (reaction)' : 'PODCAST';
  const prompt = `You are the packaging strategist for the Toni and Ryan ${named} channel (Australian comedy). Decide if the current title should be A/B tested against a genuinely BETTER alternative, and give the thumbnail concept that best pairs with it.

WINNING THUMBNAIL FORMULA for ${named} (from A/B tests — build the thumbnail concept from these): ${thumbFormula || '(not enough thumbnail A/B data yet)'}

CURRENT TITLE: "${video.title}"

WHAT WINS HEAD-TO-HEAD ON THIS CHANNEL (real A/B tests — lean into these):
${winners.map((w: any) => `  ${w.name} [${w.category}]: ${w.avg_uplift_pct >= 0 ? '+' : ''}${w.avg_uplift_pct}% CTR, won ${Math.round(w.win_rate * 100)}% of ${w.tests}`).join('\n') || '  (not enough A/B data yet)'}
WHAT LOSES HEAD-TO-HEAD (avoid):
${losers.map((l: any) => `  ${l.name}: ${l.avg_uplift_pct}% CTR`).join('\n') || '  (none)'}

OUR REAL TOP TITLES (match this VOICE exactly — your suggestion must sound like one of these, a title we would actually publish):
${ourTop.map(t => `  "${t}"`).join('\n')}

COMPETITOR TITLES DOING WELL (for a fresh angle only — never copy, keep our voice):
${compTop.map(t => `  "${t}"`).join('\n')}

${thumbTweet || thumbTags.length ? `THE THUMBNAIL for this video shows:${thumbTweet ? ` a tweet reading "${thumbTweet}".` : ''}${thumbTags.length ? ` Visual: ${thumbTags.join(', ')}.` : ''}
Your title must COMPLEMENT this thumbnail, not restate it — if the thumbnail already shows the joke/tweet, the title should add mystery or a different angle so the two together make someone click.` : ''}

${transcript ? `EPISODE TRANSCRIPT (ground the title in a real moment from this):\n${transcript}` : ''}

RULES:
- The suggestion must be a REAL title we would publish, and must sound like our top titles above. The winning attributes are PATTERNS to embody NATURALLY, never labels to paste on. BANNED prefixes/labels: "CONFESSION:", "PODCAST:", "TNTL:", or any similar tag — the "confession" attribute means the STORY is a confession told naturally (e.g. "I Thought Toni Was Cheating"), NOT the literal word "CONFESSION". A "colon setup" means a natural setup:payoff, and don't force a colon on every title.
- Lean into the winning attributes; avoid the losing ones. Complement the thumbnail.
- Only suggest a change if it is CLEARLY better than the current title. If the current title is already strong and on-voice, set should_suggest false — do not churn for the sake of it.
- Ground it in a concrete moment from the transcript when available.

Reply with ONLY a JSON object: {"should_suggest": true/false, "title": "the alternative title", "reasoning": "one sentence on why it should beat the current, naming the winning attribute, thumbnail complement, or competitor angle it uses", "thumbnail_concept": "one concrete line describing the thumbnail to pair with it, built from the winning formula and grounded in this episode (e.g. 'White bg, Toni only looking shocked, the tweet \\'...\\' with a red highlight, arrow pointing at it')"}. If should_suggest is false, omit title and thumbnail_concept.`;

  const client = new Anthropic({ apiKey: config.anthropicApiKey });
  const resp = await client.messages.create({ model: MODEL, max_tokens: 400, messages: [{ role: 'user', content: prompt }] });
  try { logAiUsage({ app: 'yt-testing', feature: 'title-suggester', user: 'auto', model: MODEL, usage: resp.usage }); } catch {}
  const text = resp.content.filter(b => b.type === 'text').map((b: any) => b.text).join('');
  let parsed: any;
  try { parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)); } catch { return null; }
  if (!parsed?.should_suggest || !parsed.title) return null;

  const suggestion: TitleSuggestion = {
    video_id: videoId,
    current_title: video.title,
    suggested_title: String(parsed.title).trim(),
    reasoning: String(parsed.reasoning || '').trim(),
    based_on: winners.slice(0, 3).map((w: any) => w.name).join(', '),
    thumbnail_concept: String(parsed.thumbnail_concept || '').trim(),
  };
  ensureSuggestionSchema();
  db.prepare(`INSERT INTO video_title_suggestions (video_id, current_title, suggested_title, reasoning, based_on, thumbnail_concept, created_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(video_id) DO UPDATE SET current_title=excluded.current_title, suggested_title=excluded.suggested_title, reasoning=excluded.reasoning, based_on=excluded.based_on, thumbnail_concept=excluded.thumbnail_concept, created_at=datetime('now')`)
    .run(suggestion.video_id, suggestion.current_title, suggestion.suggested_title, suggestion.reasoning, suggestion.based_on, suggestion.thumbnail_concept);
  return suggestion;
}

/**
 * Autonomous sweep: suggest titles for videos published in the last `days` days
 * that don't already have a fresh (< 6 day) suggestion. Cheap (Haiku, ~a handful
 * of new videos per run). Returns how many suggestions were produced.
 */
export async function runTitleSuggestionSweep(days = 10): Promise<number> {
  ensureSuggestionSchema();
  const db = getDb();
  let recent: any[] = [];
  try {
    // Recently published videos PLUS the top revival candidates (older videos the
    // algorithm is already pushing but whose packaging is losing the click).
    recent = db.prepare(`
      SELECT v.video_id FROM yt.videos v
      WHERE v.publish_date >= date('now', ?)
        AND v.video_id NOT IN (SELECT video_id FROM video_title_suggestions WHERE created_at >= datetime('now','-6 days'))
      ORDER BY v.publish_date DESC LIMIT 25
    `).all(`-${days} days`) as any[];
    let revive: any[] = [];
    try {
      revive = db.prepare(`
        SELECT video_id FROM revive_candidates
        WHERE revive_score > 0.1
          AND video_id NOT IN (SELECT video_id FROM video_title_suggestions WHERE created_at >= datetime('now','-6 days'))
        ORDER BY revive_score DESC LIMIT 8`).all() as any[];
    } catch {}
    const seen = new Set(recent.map(r => r.video_id));
    for (const r of revive) if (!seen.has(r.video_id)) recent.push(r);
  } catch (e: any) { console.error('[title-suggester] recent query failed:', e?.message); return 0; }
  let made = 0;
  for (const r of recent) {
    try { if (await suggestTitleForVideo(r.video_id)) made++; } catch (e: any) { console.error(`[title-suggester] ${r.video_id} failed:`, e?.message); }
  }
  if (made > 0) console.log(`[title-suggester] produced ${made} title suggestion(s) across ${recent.length} recent videos`);
  return made;
}
