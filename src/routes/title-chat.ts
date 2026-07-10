import { FastifyInstance } from 'fastify';
import Anthropic from '@anthropic-ai/sdk';
import { getDb } from '../db/client.js';
import { authMiddleware } from '../middleware/auth.js';
import { config } from '../config.js';
import { getChannelIntel, refreshChannelIntel } from '../services/channel-intel.js';
import { logAiUsage } from '../lib/ai-usage-log.js';

// ---------------------------------------------------------------------------
// Title Lab — episode title chat, rebuilt 2026-06.
//   - Full transcript sent once per session (prompt-cached, never truncated)
//   - Channel intelligence block (CTR data + A/B test evidence) in the system
//     prompt with cache_control, refreshed daily
//   - True token streaming via SSE
//   - Structured suggestions parsed server-side, stored with 👍/👎 feedback
//     that feeds back into future generations across sessions
// ---------------------------------------------------------------------------

const PRIMARY_MODEL = 'claude-opus-4-8';
const FALLBACK_MODEL = 'claude-sonnet-4-6';
let activeModel = PRIMARY_MODEL;

const IDENTITY_PROMPT = `You are the title writer for the Toni and Ryan podcast YouTube channel.

WHO THEY ARE — get this right or nothing else matters:
- Toni Lodge and Ryan Jon are an Australian comedy duo. This is a PODCAST: two friends having an unscripted, chaotic, funny conversation. Episodes are conversational — confessions, dumb arguments, listener stories, weird discoveries, oversharing.
- These are NOT produced YouTube videos. There is no challenge, no stunt, no "I spent 24 hours...". A title that sounds like MrBeast or a generic YouTuber is WRONG for this channel and will underperform — the audience clicks because it sounds like a genuinely funny conversation they want to be part of.
- The channel's winning titles read like podcast episodes: a specific story hook, a confession, a curiosity gap grounded in something real that was actually said in the episode. Specificity beats hype every time on this channel (see the channel intelligence data).

HARD BRAND RULES:
- Write "Toni and Ryan" in full if naming them. NEVER "T&R". NEVER use an ampersand (&) anywhere — always the word "and".
- Never fabricate episode content. Every title must be grounded in something that actually happens in the transcript. If you reference a moment, it must be quotable from the transcript.
- Flag any words YouTube may restrict or demonetise (sexual terms, violence etc.) with a warning rather than silently using them.
- Titles should match the tone of the episode — funny episodes get funny titles, not dramatic ones.
- Sentence case with main words capitalised (matching the channel's existing style), no emoji, no ALL-CAPS words unless the channel data shows that pattern winning (e.g. "CONFESSION:").

HOW TO WRITE SUGGESTIONS:
- Ground every suggestion in evidence: reference a similar real title from the channel intelligence block and its CTR or views (e.g. similar shape to "She Waited Till He Was Dead..." which did 6.36% CTR).
- Use the A/B test results as the strongest signal — they are head-to-head proof of which wording wins on this exact channel.
- Prefer the winning patterns: specific story details, "She/He/We + past-tense verb", confessions, superlatives grounded in reality ("The Worst...", "The Best..."), trailing "..." cliffhangers. Avoid the losing patterns shown in the data.
- 4 to 9 words is the sweet spot unless the data says otherwise.
- Vary the 8 options across distinct angles/moments of the episode — do not give 8 variations of one idea.

OUTPUT FORMAT — follow this EXACTLY when suggesting titles (the app parses it):
Start with one short paragraph (2-3 sentences max) naming the main topics/moments you found in the transcript, then a line containing only "### Suggestions", then exactly the requested number of suggestions, each formatted as:

1. **Title Goes Here**
   Why: one line of rationale tied to evidence from the channel data

After the list, add a single line "**Top pick:** ..." naming your favourite and why in one sentence.
When the user is just chatting (not asking for a fresh batch), reply conversationally — but any time you propose new titles, use the exact "### Suggestions" format above.`;

interface FeedbackContext { liked: string[]; rejected: string[] }

function getFeedbackContext(sessionId: number): FeedbackContext {
  const db = getDb();
  const liked = (db.prepare(
    "SELECT title FROM title_suggestions WHERE feedback = 1 ORDER BY (session_id = ?) DESC, id DESC LIMIT 25"
  ).all(sessionId) as any[]).map(r => r.title);
  const rejected = (db.prepare(
    "SELECT title FROM title_suggestions WHERE feedback = -1 ORDER BY (session_id = ?) DESC, id DESC LIMIT 25"
  ).all(sessionId) as any[]).map(r => r.title);
  return { liked, rejected };
}

function feedbackBlock(fb: FeedbackContext): string {
  if (!fb.liked.length && !fb.rejected.length) return '';
  let out = '\n\nCHARLES\'S FEEDBACK ON PAST SUGGESTIONS (learn his taste from this):';
  if (fb.liked.length) out += `\nApproved (more like these): ${fb.liked.map(t => `"${t}"`).join(', ')}`;
  if (fb.rejected.length) out += `\nRejected (avoid these styles): ${fb.rejected.map(t => `"${t}"`).join(', ')}`;
  return out;
}

// Parse "1. **Title**\n   Why: ..." blocks out of the assistant's reply
export function parseSuggestions(text: string): { title: string; rationale: string }[] {
  const out: { title: string; rationale: string }[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*\d+\.\s+\*\*(.+?)\*\*\s*$/);
    if (!m) continue;
    let rationale = '';
    for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
      const w = lines[j].match(/^\s*(?:Why|Evidence|Rationale):\s*(.+)$/i);
      if (w) { rationale = w[1].trim(); break; }
      if (/^\s*\d+\.\s+\*\*/.test(lines[j])) break;
    }
    out.push({ title: m[1].trim(), rationale });
  }
  return out;
}

async function streamClaude(
  client: Anthropic,
  params: Omit<Anthropic.MessageCreateParamsStreaming, 'model' | 'stream'>,
  onDelta: (text: string) => void,
): Promise<{ text: string; model: string; usage: Anthropic.Usage }> {
  const models = activeModel === PRIMARY_MODEL ? [PRIMARY_MODEL, FALLBACK_MODEL] : [activeModel];
  let lastErr: any;
  for (const model of models) {
    try {
      const stream = client.messages.stream({ ...params, model });
      stream.on('text', onDelta);
      const final = await stream.finalMessage();
      activeModel = model;
      const text = final.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map(b => b.text).join('');
      return { text, model, usage: final.usage };
    } catch (err) {
      lastErr = err;
      // Only fall back when the API rejects the model id itself, before any tokens stream
      if ((err instanceof Anthropic.NotFoundError ||
           (err instanceof Anthropic.BadRequestError && /model/i.test(err.message))) && model !== FALLBACK_MODEL) {
        console.warn(`[title-chat] Model ${model} rejected (${(err as Error).message}); falling back to ${FALLBACK_MODEL}`);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

export async function titleChatRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware);

  // POST /title-chat/sessions — start a session with a pasted transcript
  app.post('/title-chat/sessions', async (request, reply) => {
    const { episode_title, transcript } = request.body as { episode_title?: string; transcript: string };
    if (!transcript || transcript.trim().length < 200) {
      reply.code(400);
      return { detail: 'Transcript looks too short — paste the full episode transcript.' };
    }
    const db = getDb();
    const result = db.prepare(
      'INSERT INTO title_sessions (user_id, episode_title, transcript) VALUES (?, ?, ?)'
    ).run(request.user!.id, episode_title || null, transcript);
    return { id: Number(result.lastInsertRowid) };
  });

  // GET /title-chat/sessions
  app.get('/title-chat/sessions', async (request) => {
    const db = getDb();
    return db.prepare(`
      SELECT id, episode_title, created_at, updated_at, LENGTH(transcript) AS transcript_chars
      FROM title_sessions WHERE user_id = ? ORDER BY updated_at DESC LIMIT 50
    `).all(request.user!.id);
  });

  // GET /title-chat/sessions/:id — messages + suggestions
  app.get('/title-chat/sessions/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const db = getDb();
    const session = db.prepare(
      'SELECT id, episode_title, created_at, updated_at, LENGTH(transcript) AS transcript_chars FROM title_sessions WHERE id = ? AND user_id = ?'
    ).get(parseInt(id), request.user!.id) as any;
    if (!session) { reply.code(404); return { detail: 'Session not found' }; }
    const messages = db.prepare('SELECT id, role, content, created_at FROM title_messages WHERE session_id = ? ORDER BY id').all(session.id) as any[];
    const suggestions = db.prepare('SELECT id, message_id, title, rationale, feedback FROM title_suggestions WHERE session_id = ? ORDER BY id').all(session.id) as any[];
    return { session, messages, suggestions };
  });

  // DELETE /title-chat/sessions/:id
  app.delete('/title-chat/sessions/:id', async (request) => {
    const { id } = request.params as { id: string };
    getDb().prepare('DELETE FROM title_sessions WHERE id = ? AND user_id = ?').run(parseInt(id), request.user!.id);
    return { ok: true };
  });

  // POST /title-chat/suggestions/:id/feedback  { feedback: 1 | -1 | 0 }
  app.post('/title-chat/suggestions/:id/feedback', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { feedback } = request.body as { feedback: number };
    const result = getDb().prepare(`
      UPDATE title_suggestions SET feedback = ?
      WHERE id = ? AND session_id IN (SELECT id FROM title_sessions WHERE user_id = ?)
    `).run([1, -1, 0].includes(feedback) ? feedback : 0, parseInt(id), request.user!.id);
    if (result.changes === 0) { reply.code(404); return { detail: 'Suggestion not found' }; }
    return { ok: true };
  });

  // POST /title-chat/refresh-intel — force-refresh the channel intelligence block
  app.post('/title-chat/refresh-intel', async () => {
    const content = refreshChannelIntel();
    return { ok: true, chars: content.length };
  });

  // GET /title-chat/intel — inspect the current channel intelligence block
  app.get('/title-chat/intel', async () => ({ content: getChannelIntel(), model: activeModel }));

  // POST /title-chat/sessions/:id/stream — SSE chat turn
  // body: { message?: string, action?: 'suggest' | 'more_liked' }
  app.post('/title-chat/sessions/:id/stream', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { message, action } = request.body as { message?: string; action?: string };
    const db = getDb();
    const session = db.prepare('SELECT * FROM title_sessions WHERE id = ? AND user_id = ?').get(parseInt(id), request.user!.id) as any;

    if (!session) {
      reply.code(404);
      return { detail: 'Session not found' };
    }

    const fb = getFeedbackContext(session.id);

    // Build the user turn
    let userTurn: string;
    if (action === 'suggest') {
      userTurn = 'Read the full transcript and suggest 8 title options for this episode, each grounded in channel evidence.';
    } else if (action === 'more_liked') {
      const likedHere = (db.prepare('SELECT title FROM title_suggestions WHERE session_id = ? AND feedback = 1 ORDER BY id DESC LIMIT 15').all(session.id) as any[]).map(r => r.title);
      const rejectedHere = (db.prepare('SELECT title FROM title_suggestions WHERE session_id = ? AND feedback = -1 ORDER BY id DESC LIMIT 15').all(session.id) as any[]).map(r => r.title);
      userTurn = `Give me 8 NEW title options leaning into the styles I liked.\nLiked: ${likedHere.map(t => `"${t}"`).join(', ') || '(none marked yet — use my historical likes)'}\nRejected: ${rejectedHere.map(t => `"${t}"`).join(', ') || '(none)'}\nDo not repeat any previous suggestion.`;
    } else if (message && message.trim()) {
      userTurn = message.trim();
    } else {
      reply.code(400);
      return { detail: 'Provide a message or an action' };
    }

    // Persist user turn + load history
    db.prepare("INSERT INTO title_messages (session_id, role, content) VALUES (?, 'user', ?)").run(session.id, userTurn);
    db.prepare("UPDATE title_sessions SET updated_at = datetime('now') WHERE id = ?").run(session.id);
    const history = db.prepare('SELECT role, content FROM title_messages WHERE session_id = ? ORDER BY id').all(session.id) as { role: 'user' | 'assistant'; content: string }[];

    // First user message carries the FULL transcript (never truncated) with a
    // cache breakpoint so it's only billed at full price once per session.
    const transcriptBlock: Anthropic.TextBlockParam = {
      type: 'text',
      text: `FULL EPISODE TRANSCRIPT${session.episode_title ? ` ("${session.episode_title}")` : ''}:\n\n${session.transcript}\n\nEND OF TRANSCRIPT. This transcript is the only source of truth about the episode — never invent content that is not in it.`,
      cache_control: { type: 'ephemeral' },
    };

    // Feedback context is volatile (changes with every 👍/👎), so it rides on the
    // final user turn — after both cache breakpoints — instead of the system
    // prompt, keeping the cached system+transcript prefix byte-identical.
    const fbSuffix = feedbackBlock(fb);
    const messages: Anthropic.MessageParam[] = history.map((m, i) => {
      const isLast = i === history.length - 1;
      const content = isLast && m.role === 'user' && fbSuffix ? m.content + fbSuffix : m.content;
      if (i === 0 && m.role === 'user') {
        return { role: 'user', content: [transcriptBlock, { type: 'text', text: content }] };
      }
      return { role: m.role, content };
    });

    // SSE response
    reply.hijack(); // Fastify must not run onSend against our raw SSE reply (drops the live stream)
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (data: object) => { try { reply.raw.write(`data: ${JSON.stringify(data)}\n\n`); } catch {} };
    const keepAlive = setInterval(() => { try { reply.raw.write(': keepalive\n\n'); } catch {} }, 10000);

    try {
      const client = new Anthropic({ apiKey: config.anthropicApiKey });
      const system: Anthropic.TextBlockParam[] = [
        { type: 'text', text: IDENTITY_PROMPT },
        { type: 'text', text: getChannelIntel(), cache_control: { type: 'ephemeral' } },
      ];

      const { text, model, usage } = await streamClaude(
        client,
        { max_tokens: 8000, system, messages },
        (delta) => send({ type: 'text', delta }),
      );

      try { logAiUsage({ app: 'yt-testing', feature: 'title-lab', user: request.user?.email, model, usage }); } catch {}

      // Persist assistant turn
      const msgResult = db.prepare("INSERT INTO title_messages (session_id, role, content) VALUES (?, 'assistant', ?)").run(session.id, text);
      const messageId = Number(msgResult.lastInsertRowid);

      // Parse + persist suggestions, then tell the client about them
      const parsed = parseSuggestions(text);
      const insert = db.prepare('INSERT INTO title_suggestions (session_id, message_id, title, rationale) VALUES (?, ?, ?, ?)');
      const suggestions = parsed.map(s => {
        const r = insert.run(session.id, messageId, s.title, s.rationale);
        return { id: Number(r.lastInsertRowid), title: s.title, rationale: s.rationale, feedback: 0 };
      });
      if (suggestions.length > 0) send({ type: 'suggestions', message_id: messageId, suggestions });

      send({
        type: 'done',
        message_id: messageId,
        model,
        cache_read_tokens: (usage as any).cache_read_input_tokens ?? 0,
        cache_write_tokens: (usage as any).cache_creation_input_tokens ?? 0,
      });
    } catch (err: any) {
      console.error('[title-chat] stream error:', err);
      send({ type: 'error', message: err.message || 'Generation failed' });
    }

    clearInterval(keepAlive);
    reply.raw.end();
  });
}
