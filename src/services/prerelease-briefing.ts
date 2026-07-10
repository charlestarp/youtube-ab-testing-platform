/**
 * Pre-release briefing. As soon as a new episode is transcribed in pre-release,
 * work out the best title options, a thumbnail concept, and (if it's a tweet
 * thumbnail) what the tweet should say — grounded in the transcript, our A/B
 * winners, the winning thumbnail formula, and competitors. Each episode is
 * appended, day-labelled (Monday/Tuesday/...), to ONE weekly chat so that by the
 * time Charles opens it, the whole week is there ready to pitch to the room.
 *
 * Uses Sonnet (few episodes a week, quality matters). Runs in-process so the
 * TARPGPT session token is available.
 */
import Anthropic from '@anthropic-ai/sdk';
import { getDb } from '../db/client.js';
import { config } from '../config.js';
import { logAiUsage } from '../lib/ai-usage-log.js';
import { computeTitleAbUplift } from './title-insights.js';
import { computeTagUplift } from './learnings.js';

const MODEL = 'claude-sonnet-4-6';
const OWNER_ID = 1;

export function ensurePitchSchema(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS prerelease_pitches (
      episode_id INTEGER PRIMARY KEY,
      conversation_id INTEGER,
      day_label TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS prerelease_queue (
      episode_id INTEGER PRIMARY KEY,
      added_at TEXT DEFAULT (datetime('now'))
    );
  `);
}

/** Queue the episodes Charles selected in TARPGPT. Each gets pitched as soon as
 *  it is transcribed (ready), so a still-transcoding one lands in the chat later. */
export function queueEpisodes(ids: number[]): void {
  ensurePitchSchema();
  const db = getDb();
  const ins = db.prepare(`INSERT OR IGNORE INTO prerelease_queue (episode_id, added_at) VALUES (?, datetime('now'))`);
  for (const id of ids) if (Number(id)) ins.run(Number(id));
}

function tarpgptToken(): string | null {
  try { return (getDb().prepare("SELECT token FROM podcast.sessions ORDER BY created_at DESC LIMIT 1").get() as any)?.token || null; } catch { return null; }
}

async function fetchReadyEpisodes(): Promise<{ id: number; title: string; date: string }[]> {
  const token = tarpgptToken();
  if (!token) return [];
  try {
    const res = await fetch('http://localhost:8000/api/prerelease/episodes', { headers: { Cookie: 'session=' + token } });
    if (!res.ok) return [];
    return (await res.json() as any[]).filter(e => e.upload_status === 'ready').map(e => ({ id: e.id, title: e.title, date: e.date }));
  } catch { return []; }
}

async function fetchTranscript(id: number): Promise<string> {
  const token = tarpgptToken();
  if (!token) return '';
  try {
    const res = await fetch(`http://localhost:8000/api/prerelease/episodes/${id}/segments`, { headers: { Cookie: 'session=' + token } });
    if (!res.ok) return '';
    const segs = await res.json() as any[];
    return segs.map(s => `${s.speaker}: ${s.text}`).join('\n').slice(0, 12000);
  } catch { return ''; }
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function dayLabel(dateStr: string): string {
  try { const d = new Date(dateStr); if (!isNaN(d.getTime())) return DAYS[d.getDay()]; } catch {}
  return dateStr || 'This week';
}
function weekTitle(): string {
  const now = new Date();
  const monday = new Date(now); monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  return `Pre-release ideas — week of ${monday.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })}`;
}

function findOrCreateWeeklyConversation(): number {
  const db = getDb();
  const title = weekTitle();
  const existing = db.prepare(`SELECT id FROM producer_conversations WHERE user_id = ? AND title = ? ORDER BY id DESC LIMIT 1`).get(OWNER_ID, title) as any;
  if (existing) return existing.id;
  const r = db.prepare(`INSERT INTO producer_conversations (user_id, title, model) VALUES (?, ?, 'claude-opus-4-8')`).run(OWNER_ID, title);
  return Number(r.lastInsertRowid);
}

async function generatePitch(ep: { title: string; date: string }, transcript: string, day: string): Promise<string> {
  const db = getDb();
  const ab = ((computeTitleAbUplift(2) as any).podcast || []).filter((a: any) => a.tests >= 2);
  const winners = [...ab].sort((a: any, b: any) => b.avg_uplift_pct - a.avg_uplift_pct).filter((a: any) => a.avg_uplift_pct > 0 || a.win_rate >= 0.5).slice(0, 6);
  const losers = [...ab].filter((a: any) => a.avg_uplift_pct < 0 && a.win_rate < 0.5).slice(0, 4);
  const thumbTags = computeTagUplift(2, 'podcast').filter(t => t.tests >= 2);
  const byCat = new Map<string, any>();
  for (const t of thumbTags) { const c = t.category || 'other'; const cur = byCat.get(c); if (!cur || t.avg_uplift_pct > cur.avg_uplift_pct) byCat.set(c, t); }
  const thumbFormula = [...byCat.entries()].map(([c, t]) => `${c}: ${t.name}`).join(', ');
  const ourTop = (db.prepare(`SELECT title FROM yt.videos WHERE category = 'podcast' AND view_count > 0 ORDER BY view_count DESC LIMIT 12`).all() as any[]).map(r => r.title);
  const compTop = (db.prepare(`SELECT title FROM competitor_videos WHERE duration_seconds >= 1500 AND views > 0 ORDER BY views DESC LIMIT 10`).all() as any[]).map(r => r.title);

  const prompt = `You are The Producer for the Toni and Ryan podcast (Australian comedy). This is a PRE-RELEASE episode. Give Charles a tight pitch he can take into the room.

EPISODE (${day}): "${ep.title}"

TITLE ATTRIBUTES THAT WIN HEAD-TO-HEAD on our podcast (lean in): ${winners.map((w: any) => `${w.name} (${w.avg_uplift_pct >= 0 ? '+' : ''}${w.avg_uplift_pct}%)`).join(', ') || 'n/a'}
THAT LOSE (avoid): ${losers.map((l: any) => l.name).join(', ') || 'none'}
OUR REAL TOP TITLES (match this VOICE, these are titles we'd actually publish): ${ourTop.map(t => `"${t}"`).join(' · ')}
COMPETITOR TITLES for a fresh angle (never copy): ${compTop.map(t => `"${t}"`).join(' · ')}
WINNING THUMBNAIL FORMULA (build the concept from this): ${thumbFormula || 'n/a'}

TRANSCRIPT:
${transcript}

Rules: titles must be REAL titles we would publish, in our voice, grounded in a concrete moment from the transcript — never generic, never a plot summary, never a bare quote fragment. NEVER prefix a title with "PODCAST:", "TNTL:" or any label; the winning attributes (confession, colon setup, etc.) are patterns to embody NATURALLY, not words to paste on. The thumbnail is usually a tweet overlay.

Reply in this exact markdown shape, nothing else:
## ${day} — ${ep.title}
**Title options**
- (option 1) — one short line on why
- (option 2) — why
- (option 3) — why
**Top pick:** (the strongest one)
**Thumbnail:** one concrete concept built from the winning formula and this episode
**Tweet says:** the exact text the tweet overlay should show (a real line from or inspired by the episode)`;

  const client = new Anthropic({ apiKey: config.anthropicApiKey });
  const resp = await client.messages.create({ model: MODEL, max_tokens: 900, messages: [{ role: 'user', content: prompt }] });
  try { logAiUsage({ app: 'yt-testing', feature: 'prerelease-briefing', user: 'auto', model: MODEL, usage: resp.usage }); } catch {}
  return resp.content.filter(b => b.type === 'text').map((b: any) => b.text).join('').trim();
}

/** Baseline the current backlog: mark every ready episode as already seen (no
 *  pitch) and clear this week's briefing chat, so ONLY episodes that go into
 *  pre-release from now on get pitched. Returns how many were baselined. */
export async function baselinePrereleaseBacklog(): Promise<number> {
  ensurePitchSchema();
  const db = getDb();
  const episodes = await fetchReadyEpisodes();
  const ins = db.prepare(`INSERT OR IGNORE INTO prerelease_pitches (episode_id, conversation_id, day_label, created_at) VALUES (?, NULL, 'baseline', datetime('now'))`);
  for (const e of episodes) ins.run(e.id);
  // Wipe any pitches already dropped into this week's chat (the backlog run).
  const conv = db.prepare(`SELECT id FROM producer_conversations WHERE user_id = ? AND title LIKE 'Pre-release ideas%' ORDER BY id DESC LIMIT 1`).get(OWNER_ID) as any;
  if (conv) db.prepare(`DELETE FROM producer_messages WHERE conversation_id = ?`).run(conv.id);
  console.log(`[prerelease-briefing] baselined ${episodes.length} existing episode(s) — only new ones will be pitched`);
  return episodes.length;
}

/** Generate a pitch for any newly-ready pre-release episode and append it,
 *  day-labelled, to this week's briefing chat. Returns how many were added. */
export async function runPrereleaseBriefing(): Promise<{ pitched: number; conversationId: number | null }> {
  ensurePitchSchema();
  const db = getDb();
  const episodes = await fetchReadyEpisodes();
  // Existing weekly chat (for the deep-link target even when nothing is new).
  const existing = db.prepare(`SELECT id FROM producer_conversations WHERE user_id = ? AND title = ? ORDER BY id DESC LIMIT 1`).get(OWNER_ID, weekTitle()) as any;
  if (!episodes.length) return { pitched: 0, conversationId: existing?.id ?? null };
  // Only pitch episodes Charles queued from TARPGPT, and only once each.
  const queued = new Set((db.prepare('SELECT episode_id FROM prerelease_queue').all() as any[]).map(r => r.episode_id));
  const fresh = episodes.filter(e => queued.has(e.id) && !db.prepare('SELECT 1 FROM prerelease_pitches WHERE episode_id = ?').get(e.id));
  if (!fresh.length) return { pitched: 0, conversationId: existing?.id ?? null };

  const convId = findOrCreateWeeklyConversation();
  let n = 0;
  for (const ep of fresh) {
    try {
      const transcript = await fetchTranscript(ep.id);
      if (!transcript) continue;
      const day = dayLabel(ep.date);
      const pitch = await generatePitch(ep, transcript, day);
      if (!pitch) continue;
      db.prepare(`INSERT INTO producer_messages (conversation_id, role, content, created_at) VALUES (?, 'assistant', ?, datetime('now'))`).run(convId, pitch);
      db.prepare(`UPDATE producer_conversations SET updated_at = datetime('now') WHERE id = ?`).run(convId);
      db.prepare(`INSERT OR REPLACE INTO prerelease_pitches (episode_id, conversation_id, day_label, created_at) VALUES (?, ?, ?, datetime('now'))`).run(ep.id, convId, day);
      n++;
      console.log(`[prerelease-briefing] pitched ${day}: "${ep.title}"`);
    } catch (e: any) { console.error(`[prerelease-briefing] ${ep.id} failed:`, e?.message); }
  }
  return { pitched: n, conversationId: convId };
}
