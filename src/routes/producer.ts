import { FastifyInstance } from 'fastify';
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'fs';
import { getDb } from '../db/client.js';
import { authMiddleware } from '../middleware/auth.js';
import { config } from '../config.js';
import { getChannelIntel, refreshChannelIntel } from '../services/channel-intel.js';
import { ensureProducerSchema, buildIdentityPrompt, getProcessDoc, setProcessDoc, parseSuggestions, detectShowStart, annotateEpisodes } from '../services/producer.js';
import { generateProposalPack, getProposals, ensureProposalSchema } from '../services/episode-proposals.js';
import { ALL_TOOLS, executeProducerTool } from '../services/producer-tools.js';
import { classifyContent } from '../services/content-type.js';
import { getPodcastStats } from '../services/podcast-stats.js';
import { logAiUsage } from '../lib/ai-usage-log.js';

// Default to Sonnet 4.6: roughly 5x cheaper than Opus per token and still
// excellent for titles and strategy. Prompt caching (transcript + channel intel)
// keeps follow-up messages in a conversation very cheap.
const PRIMARY_MODEL = 'claude-sonnet-4-6';
const FALLBACK_MODEL = 'claude-haiku-4-5-20251001';
let activeModel = PRIMARY_MODEL;

// Charles defaults to Opus (best title taste); the rest of the team defaults to
// Sonnet (5x cheaper). A per-chat toggle still overrides this either way.
const OWNER_EMAIL = 'team@example.com';
function defaultModelForUser(user: any): string {
  return (user?.email || '').toLowerCase() === OWNER_EMAIL ? 'claude-opus-4-8' : PRIMARY_MODEL;
}

function feedbackBlock(convId: number): string {
  const db = getDb();
  const liked = (db.prepare(`SELECT title FROM producer_suggestions WHERE feedback=1 ORDER BY (conversation_id=?) DESC, id DESC LIMIT 25`).all(convId) as any[]).map(r => r.title);
  const rejected = (db.prepare(`SELECT title FROM producer_suggestions WHERE feedback=-1 ORDER BY (conversation_id=?) DESC, id DESC LIMIT 25`).all(convId) as any[]).map(r => r.title);
  // The STRONGEST taste signal: the titles Charles actually shipped. Locked-in
  // decisions first (his most recent explicit choices), then real recent podcast
  // titles from the catalogue. These are the house voice — match this shape, not
  // a generic idea (e.g. he picks "Ryan Brought A Magician Home", not "CONFESSION: ...").
  const chosen = (db.prepare(`SELECT title, day_slot FROM producer_locked_titles ORDER BY id DESC LIMIT 16`).all() as any[]);
  let published: string[] = [];
  try { published = (db.prepare(`SELECT title FROM yt.videos WHERE category='podcast' AND title IS NOT NULL AND publish_date IS NOT NULL ORDER BY publish_date DESC LIMIT 14`).all() as any[]).map(r => r.title); } catch {}

  let out = '';
  if (chosen.length || published.length) {
    out += '\n\nTITLES CHARLES ACTUALLY WENT WITH (his real taste — the exact shapes he ships. Match these; do not drift generic or lean on prefix reflexes he did not choose):';
    if (chosen.length) out += `\nRecently locked in: ${chosen.map(c => `"${c.title}"${c.day_slot ? ` (${c.day_slot})` : ''}`).join(', ')}`;
    if (published.length) out += `\nRecent published podcast titles: ${published.map(t => `"${t}"`).join(', ')}`;
  }
  if (liked.length || rejected.length) {
    out += '\n\nCHARLES\'S FEEDBACK ON PAST TITLE SUGGESTIONS (learn his taste):';
    if (liked.length) out += `\nApproved (more like these): ${liked.map(t => `"${t}"`).join(', ')}`;
    if (rejected.length) out += `\nRejected (avoid these): ${rejected.map(t => `"${t}"`).join(', ')}`;
  }
  return out;
}

export async function producerRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware);
  ensureProducerSchema();

  // ---- Process doc -------------------------------------------------------
  app.get('/producer/process-doc', async () => ({ content: getProcessDoc() }));
  app.put('/producer/process-doc', async (request) => {
    const { content } = request.body as { content: string };
    if (typeof content !== 'string' || content.trim().length < 20) return { detail: 'Process doc too short' };
    setProcessDoc(content, request.user!.id);
    return { ok: true };
  });

  // ---- Transcripts (optional, reusable) ----------------------------------
  app.post('/producer/transcripts', async (request, reply) => {
    const { title, transcript, episode_code } = request.body as { title?: string; transcript: string; episode_code?: string };
    if (!transcript || transcript.trim().length < 200) { reply.code(400); return { detail: 'Transcript too short — paste the full episode.' }; }
    const db = getDb();
    // Parse YYMMDD date code -> date + day slot.
    let episode_date: string | null = null, day_slot: string | null = null;
    const code = (episode_code || title || '').match(/(\d{2})(\d{2})(\d{2})/);
    if (code) {
      episode_date = `20${code[1]}-${code[2]}-${code[3]}`;
      const dow = new Date(episode_date + 'T00:00:00').getDay();
      day_slot = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][dow];
    }
    // Detect where the show actually starts (past the pre-show chatter).
    const showStart = await detectShowStart(transcript);
    const r = db.prepare(`INSERT INTO producer_transcripts (user_id, episode_code, episode_date, day_slot, title, transcript, show_start_char, show_start_note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(request.user!.id, episode_code || null, episode_date, day_slot, title || null, transcript, showStart?.char ?? null, showStart?.note ?? null);
    return { id: Number(r.lastInsertRowid), episode_date, day_slot, show_start_note: showStart?.note ?? null };
  });

  // ---- Conversations -----------------------------------------------------
  app.get('/producer/conversations', async (request) => {
    return getDb().prepare(`
      SELECT c.id, c.title, c.transcript_id, c.created_at, c.updated_at, t.title AS transcript_title, t.day_slot
      FROM producer_conversations c LEFT JOIN producer_transcripts t ON t.id = c.transcript_id
      WHERE c.user_id = ? ORDER BY c.updated_at DESC LIMIT 100
    `).all(request.user!.id);
  });

  app.post('/producer/conversations', async (request) => {
    const { title, transcript_id, video_id, video_title } = request.body as { title?: string; transcript_id?: number; video_id?: string; video_title?: string };
    const r = getDb().prepare(`INSERT INTO producer_conversations (user_id, title, transcript_id, video_id, video_title, model) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(request.user!.id, title || 'New chat', transcript_id ?? null, video_id ?? null, video_title ?? null, defaultModelForUser(request.user));
    return { id: Number(r.lastInsertRowid) };
  });

  // Attach (or change) the video a conversation is about.
  app.post('/producer/conversations/:id/attach-video', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { video_id, video_title } = request.body as { video_id: string; video_title?: string };
    const r = getDb().prepare(`UPDATE producer_conversations SET video_id = ?, video_title = ? WHERE id = ? AND user_id = ?`)
      .run(video_id, video_title ?? null, parseInt(id), request.user!.id);
    if (!r.changes) { reply.code(404); return { detail: 'Not found' }; }
    return { ok: true };
  });

  // Attach a whole EPISODE: the video, its full published transcript pulled from
  // the podcast DB, and its existing tests. This powers "select episode".
  app.post('/producer/conversations/:id/attach-episode', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { video_id } = request.body as { video_id: string };
    const db = getDb();
    const conv = db.prepare(`SELECT * FROM producer_conversations WHERE id = ? AND user_id = ?`).get(parseInt(id), request.user!.id) as any;
    if (!conv) { reply.code(404); return { detail: 'Not found' }; }

    let video: any = null;
    try { video = db.prepare(`SELECT video_id, title, category, publish_date FROM yt.videos WHERE video_id = ?`).get(video_id); } catch {}
    const title = video?.title || '';
    // Day of the week the episode went out (Monday–Thursday for the podcast), so
    // a multi-episode chat labels each one by its day instead of "Episode 1/2".
    const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    let dayLabel: string | null = null;
    try { if (video?.publish_date) { const d = new Date(video.publish_date); if (!isNaN(d.getTime())) dayLabel = DOW[d.getDay()]; } } catch {}
    // Primary video on the conversation = the most recently attached (header + back-compat).
    db.prepare(`UPDATE producer_conversations SET video_id = ?, video_title = ? WHERE id = ?`).run(video_id, title || null, conv.id);

    // Match the published transcript by normalised title.
    const norm = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    let transcript_loaded = false, episode_title: string | null = null;
    let transcriptId: number | null = null;
    try {
      const target = norm(title);
      const eps = db.prepare(`SELECT id, title FROM podcast.episodes WHERE is_prerelease = 0`).all() as any[];
      const match = eps.find(e => norm(e.title) === target) || eps.find(e => target && (norm(e.title).includes(target) || target.includes(norm(e.title))));
      if (match) {
        const segs = db.prepare(`SELECT speaker, text FROM podcast.segments WHERE episode_id = ? ORDER BY start`).all(match.id) as any[];
        if (segs.length) {
          const full = segs.map(s => `${s.speaker}: ${s.text}`).join('\n');
          const tr = db.prepare(`INSERT INTO producer_transcripts (user_id, title, transcript) VALUES (?, ?, ?)`).run(request.user!.id, match.title, full);
          transcriptId = Number(tr.lastInsertRowid);
          db.prepare(`UPDATE producer_conversations SET transcript_id = ? WHERE id = ?`).run(transcriptId, conv.id);
          transcript_loaded = true; episode_title = match.title;
        }
      }
    } catch (e: any) { console.error('[producer] transcript pull failed:', e?.message); }

    // Add to the multi-video set (dedupe by video_id; refresh title/transcript/day).
    db.prepare(`INSERT INTO producer_conversation_videos (conversation_id, video_id, video_title, transcript_id, day_label)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(conversation_id, video_id) DO UPDATE SET video_title = excluded.video_title, transcript_id = COALESCE(excluded.transcript_id, transcript_id), day_label = COALESCE(excluded.day_label, day_label)`)
      .run(conv.id, video_id, title || null, transcriptId, dayLabel);

    const tests = db.prepare(`
      SELECT t.id, t.test_type, t.status, t.winner_variant_id, v.label AS winner_label, v.title AS winner_title
      FROM tests t LEFT JOIN test_variants v ON v.id = t.winner_variant_id
      WHERE t.video_id = ? ORDER BY t.id DESC
    `).all(video_id) as any[];

    const podcast_stats = getPodcastStats(video_id);
    const videos = db.prepare(`SELECT video_id, video_title, day_label FROM producer_conversation_videos WHERE conversation_id = ? ORDER BY added_at`).all(conv.id);
    return { ok: true, video, transcript_loaded, episode_title, tests, podcast_stats, videos };
  });

  // List all videos attached to a conversation.
  app.get('/producer/conversations/:id/videos', async (request, reply) => {
    const { id } = request.params as { id: string };
    const db = getDb();
    const conv = db.prepare(`SELECT id FROM producer_conversations WHERE id = ? AND user_id = ?`).get(parseInt(id), request.user!.id) as any;
    if (!conv) { reply.code(404); return { detail: 'Not found' }; }
    const videos = db.prepare(`SELECT video_id, video_title, day_label, (transcript_id IS NOT NULL) AS has_transcript FROM producer_conversation_videos WHERE conversation_id = ? ORDER BY added_at`).all(conv.id);
    return { videos };
  });

  // Remove one video from a conversation's set.
  app.delete('/producer/conversations/:id/videos/:videoId', async (request, reply) => {
    const { id, videoId } = request.params as { id: string; videoId: string };
    const db = getDb();
    const conv = db.prepare(`SELECT id, video_id FROM producer_conversations WHERE id = ? AND user_id = ?`).get(parseInt(id), request.user!.id) as any;
    if (!conv) { reply.code(404); return { detail: 'Not found' }; }
    db.prepare(`DELETE FROM producer_conversation_videos WHERE conversation_id = ? AND video_id = ?`).run(conv.id, videoId);
    // If the primary was removed, repoint it to another attached video (or clear).
    if (conv.video_id === videoId) {
      const next = db.prepare(`SELECT video_id, video_title, transcript_id FROM producer_conversation_videos WHERE conversation_id = ? ORDER BY added_at DESC LIMIT 1`).get(conv.id) as any;
      db.prepare(`UPDATE producer_conversations SET video_id = ?, video_title = ?, transcript_id = ? WHERE id = ?`).run(next?.video_id ?? null, next?.video_title ?? null, next?.transcript_id ?? null, conv.id);
    }
    const videos = db.prepare(`SELECT video_id, video_title, day_label FROM producer_conversation_videos WHERE conversation_id = ? ORDER BY added_at`).all(conv.id);
    return { ok: true, videos };
  });

  // List pre-release episodes (from TARPGPT). These have a transcript but no
  // published video yet, so all the chat can work off is the transcript.
  app.get('/producer/prerelease', async () => {
    const db = getDb();
    const token = (db.prepare("SELECT token FROM podcast.sessions ORDER BY created_at DESC LIMIT 1").get() as any)?.token;
    if (!token) return [];
    try {
      const res = await fetch('http://localhost:8000/api/prerelease/episodes', { headers: { Cookie: 'session=' + token } });
      if (!res.ok) return [];
      const eps = await res.json() as any[];
      return eps
        .filter(e => e.upload_status === 'ready')
        .map(e => ({ id: e.id, title: e.title, date: e.date }));
    } catch { return []; }
  });

  // Attach a PRE-RELEASE episode: pull its transcript from TARPGPT and link it to
  // the conversation so the chat can read it (no video, no tests yet).
  app.post('/producer/conversations/:id/attach-prerelease', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { prerelease_id } = request.body as { prerelease_id: number };
    const db = getDb();
    const conv = db.prepare(`SELECT * FROM producer_conversations WHERE id = ? AND user_id = ?`).get(parseInt(id), request.user!.id) as any;
    if (!conv) { reply.code(404); return { detail: 'Not found' }; }
    const token = (db.prepare("SELECT token FROM podcast.sessions ORDER BY created_at DESC LIMIT 1").get() as any)?.token;
    if (!token) { reply.code(502); return { detail: 'No TARPGPT session available to pull pre-release episodes.' }; }
    try {
      const epRes = await fetch(`http://localhost:8000/api/prerelease/episodes/${prerelease_id}`, { headers: { Cookie: 'session=' + token } });
      const ep = epRes.ok ? await epRes.json() as any : null;
      const title = ep?.title || `Pre-release #${prerelease_id}`;
      const segRes = await fetch(`http://localhost:8000/api/prerelease/episodes/${prerelease_id}/segments`, { headers: { Cookie: 'session=' + token } });
      if (!segRes.ok) { reply.code(502); return { detail: 'Could not pull the pre-release transcript.' }; }
      const segments = await segRes.json() as any[];
      if (!segments.length) { reply.code(400); return { detail: 'That pre-release episode has no transcript yet.' }; }
      const full = segments.map(s => `${s.speaker}: ${s.text}`).join('\n');
      const tr = db.prepare(`INSERT INTO producer_transcripts (user_id, title, transcript) VALUES (?, ?, ?)`).run(request.user!.id, title, full);
      const trId = Number(tr.lastInsertRowid);
      db.prepare(`UPDATE producer_conversations SET transcript_id = ?, video_id = NULL, video_title = ? WHERE id = ?`)
        .run(trId, `${title} (pre-release)`, conv.id);
      // Add to the multi-episode set with a day label, so several pre-release
      // episodes can share a chat and show as Mon/Tue/Wed/Thu chips.
      // The AIR day is encoded in the title as YYMMDD (e.g. "Podcast 260713" =
      // 2026-07-13 = Monday). The recording date (ep.date) is often the same for
      // a whole week's batch, so prefer the title code and fall back to ep.date.
      const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      let dayLabel: string | null = null;
      try {
        const code = String(title).match(/(\d{2})(\d{2})(\d{2})/);
        const iso = code ? `20${code[1]}-${code[2]}-${code[3]}T00:00:00` : (ep?.date || '');
        const d = iso ? new Date(iso) : null;
        if (d && !isNaN(d.getTime())) dayLabel = DOW[d.getDay()];
      } catch {}
      db.prepare(`INSERT INTO producer_conversation_videos (conversation_id, video_id, video_title, transcript_id, day_label)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(conversation_id, video_id) DO UPDATE SET video_title = excluded.video_title, transcript_id = excluded.transcript_id, day_label = COALESCE(excluded.day_label, day_label)`)
        .run(conv.id, `pre:${prerelease_id}`, `${title} (pre-release)`, trId, dayLabel);
      const videos = db.prepare(`SELECT video_id, video_title, day_label FROM producer_conversation_videos WHERE conversation_id = ? ORDER BY added_at`).all(conv.id);
      return { ok: true, transcript_loaded: true, episode_title: title, prerelease: true, videos };
    } catch (e: any) {
      console.error('[producer] prerelease attach failed:', e?.message);
      reply.code(502); return { detail: 'Failed to pull the pre-release transcript.' };
    }
  });

  // Create (and optionally start) an A/B title test from chosen titles.
  // Video can come inline (body) or from the conversation. This powers the
  // in-chat "wire it up" flow.
  app.post('/producer/conversations/:id/create-test', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { titles: string[]; test_type?: string; video_id?: string; video_title?: string; start?: boolean };
    const db = getDb();
    const conv = db.prepare(`SELECT * FROM producer_conversations WHERE id = ? AND user_id = ?`).get(parseInt(id), request.user!.id) as any;
    if (!conv) { reply.code(404); return { detail: 'Not found' }; }
    const videoId = body.video_id || conv.video_id;
    const videoTitle = body.video_title || conv.video_title || null;
    if (!videoId) { reply.code(400); return { detail: 'Pick a video first.' }; }
    const chosen = (body.titles || []).map(t => (t || '').trim()).filter(Boolean);
    if (chosen.length < 1) { reply.code(400); return { detail: 'Pick at least one new title.' }; }

    // Always test against the ORIGINAL title as the control (variant A). Pull the
    // video's current YouTube title; fall back to the stored conversation title.
    let ogTitle: string | null = null;
    try { ogTitle = (db.prepare(`SELECT title FROM yt.videos WHERE video_id = ?`).get(videoId) as any)?.title ?? null; } catch {}
    ogTitle = ogTitle || videoTitle || null;
    const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]/g, '');
    const newOnly = ogTitle ? chosen.filter(t => norm(t) !== norm(ogTitle!)) : chosen;
    const clean = ogTitle ? [ogTitle, ...newOnly] : newOnly;
    if (clean.length < 2) { reply.code(400); return { detail: 'Need the original title plus at least one new option.' }; }

    // Remember the video on the conversation for context next time.
    db.prepare(`UPDATE producer_conversations SET video_id = ?, video_title = ? WHERE id = ?`).run(videoId, videoTitle, conv.id);

    const tt = body.test_type === 'both' ? 'both' : 'title';
    // Match the recommended defaults from the standard create form: classic
    // format, hourly, each variant shown 4 times (duration_hours_per_variant IS
    // the "times each" value the runner uses), CTR winner, placeholder disabled.
    const testRes = db.prepare(`
      INSERT INTO tests (video_id, video_title, test_type, test_format, duration_hours_per_variant, min_impressions, test_speed, run_days, run_duration_days, auto_winner, auto_placeholder, channel, category)
      VALUES (?, ?, ?, 'classic', 4, 500, 'hourly', 'mon,tue,wed,thu,fri,sat,sun', 8, 'ctr', 'disabled', 'main', 'test')
    `).run(videoId, videoTitle, tt);
    const testId = Number(testRes.lastInsertRowid);
    clean.forEach((title, i) => {
      db.prepare(`INSERT INTO test_variants (test_id, label, title, is_control) VALUES (?, ?, ?, ?)`)
        .run(testId, String.fromCharCode(65 + i), title, i === 0 ? 1 : 0);
    });
    // Tag the new titles immediately (fire-and-forget); untagged-only.
    import('../services/title-tagger.js')
      .then(m => m.tagAllVariants({ semantic: true, onlyUntagged: true }))
      .catch(() => {});

    // Start now: a title test needs no thumbnail, so it can run immediately.
    let started = false;
    if (body.start && tt === 'title') {
      try {
        // Capture the CURRENT YouTube title as the original, exactly like the normal /start
        // endpoint does. Without this the auto-winner "restore original" path has nothing to fall
        // back to, and the test isn't set up identically to a form-created test.
        try {
          const { getVideoDetails, downloadThumbnail } = await import('../services/youtube-api.js');
          const details = await getVideoDetails(videoId);
          const thumbUrl = details?.snippet?.thumbnails?.maxres?.url || details?.snippet?.thumbnails?.high?.url;
          const blob = thumbUrl ? await downloadThumbnail(videoId, thumbUrl) : null;
          db.prepare('UPDATE tests SET original_thumbnail_blob = ?, original_title = ? WHERE id = ?')
            .run(blob, details?.snippet?.title || ogTitle || null, testId);
        } catch (e: any) { console.log('[producer] could not capture original title:', e?.message); }

        const now = new Date(); now.setMinutes(0, 0, 0); now.setHours(now.getHours() + 1);
        db.prepare(`UPDATE tests SET status = 'running', started_at = ? WHERE id = ?`).run(now.toISOString(), testId);
        started = true;
      } catch (e: any) { console.error('[producer] start test failed:', e?.message); }
    }
    try { (await import('../services/activity.js')).logActivity(request.user!.id, started ? 'test_started' : 'test_created', `${tt} test via Ask AI: ${videoTitle || videoId}`); } catch {}
    return { ok: true, test_id: testId, variants: clean.length, started };
  });

  app.get('/producer/conversations/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const db = getDb();
    const conv = db.prepare(`SELECT * FROM producer_conversations WHERE id = ? AND user_id = ?`).get(parseInt(id), request.user!.id) as any;
    if (!conv) { reply.code(404); return { detail: 'Not found' }; }
    const messages = db.prepare(`SELECT id, role, content, created_at FROM producer_messages WHERE conversation_id = ? ORDER BY id`).all(conv.id);
    const suggestions = db.prepare(`SELECT id, message_id, title, rationale, slot, feedback FROM producer_suggestions WHERE conversation_id = ? ORDER BY id`).all(conv.id);
    const transcript = conv.transcript_id ? db.prepare(`SELECT id, title, day_slot, episode_date, LENGTH(transcript) AS chars FROM producer_transcripts WHERE id = ?`).get(conv.transcript_id) : null;
    let video = null;
    if (conv.video_id) {
      try { video = db.prepare(`SELECT video_id, title, view_count, category, publish_date FROM yt.videos WHERE video_id = ?`).get(conv.video_id) as any; } catch {}
      if (!video) video = { video_id: conv.video_id, title: conv.video_title };
    }
    return { conversation: conv, messages, suggestions, transcript, video };
  });

  app.delete('/producer/conversations/:id', async (request) => {
    const { id } = request.params as { id: string };
    const db = getDb();
    db.prepare(`DELETE FROM producer_messages WHERE conversation_id IN (SELECT id FROM producer_conversations WHERE id = ? AND user_id = ?)`).run(parseInt(id), request.user!.id);
    db.prepare(`DELETE FROM producer_conversations WHERE id = ? AND user_id = ?`).run(parseInt(id), request.user!.id);
    return { ok: true };
  });

  app.post('/producer/suggestions/:id/feedback', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { feedback } = request.body as { feedback: number };
    const r = getDb().prepare(`
      UPDATE producer_suggestions SET feedback = ?
      WHERE id = ? AND conversation_id IN (SELECT id FROM producer_conversations WHERE user_id = ?)
    `).run([1, -1, 0].includes(feedback) ? feedback : 0, parseInt(id), request.user!.id);
    if (!r.changes) { reply.code(404); return { detail: 'Not found' }; }
    return { ok: true };
  });

  app.post('/producer/refresh-intel', async () => ({ ok: true, chars: refreshChannelIntel().length }));

  // Rename a conversation.
  app.patch('/producer/conversations/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { title } = request.body as { title: string };
    const t = (title || '').trim().slice(0, 120);
    if (!t) { reply.code(400); return { detail: 'Title required' }; }
    const r = getDb().prepare(`UPDATE producer_conversations SET title = ? WHERE id = ? AND user_id = ?`).run(t, parseInt(id), request.user!.id);
    if (!r.changes) { reply.code(404); return { detail: 'Not found' }; }
    return { ok: true };
  });

  // Set the model for a conversation (sonnet = fast/cheap default, opus = deep).
  app.post('/producer/conversations/:id/model', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { model } = request.body as { model: string };
    const allowed = ['claude-sonnet-4-6', 'claude-opus-4-8'];
    if (!allowed.includes(model)) { reply.code(400); return { detail: 'Unknown model' }; }
    const r = getDb().prepare(`UPDATE producer_conversations SET model = ? WHERE id = ? AND user_id = ?`).run(model, parseInt(id), request.user!.id);
    if (!r.changes) { reply.code(404); return { detail: 'Not found' }; }
    return { ok: true };
  });

  // ---- Streaming turn (with tools) --------------------------------------
  app.post('/producer/conversations/:id/stream', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { message, images, documents, attach_transcript } = request.body as {
      message: string;
      images?: { media_type: string; data: string }[];
      documents?: { media_type: string; data: string; name?: string }[];
      attach_transcript?: string;
    };
    const db = getDb();
    const conv = db.prepare(`SELECT * FROM producer_conversations WHERE id = ? AND user_id = ?`).get(parseInt(id), request.user!.id) as any;
    if (!conv) { reply.code(404); return { detail: 'Not found' }; }
    const hasImages = Array.isArray(images) && images.length > 0;
    const hasDocs = Array.isArray(documents) && documents.length > 0;
    if ((!message || !message.trim()) && !hasImages && !hasDocs) { reply.code(400); return { detail: 'Empty message' }; }

    // A transcript uploaded with this turn (one or more .txt combined client-side).
    // Annotate each episode with its own day slot + show-start marker.
    if (attach_transcript && attach_transcript.trim().length > 150 && !conv.transcript_id) {
      const annotated = await annotateEpisodes(attach_transcript);
      const tr = db.prepare(`INSERT INTO producer_transcripts (user_id, transcript) VALUES (?, ?)`)
        .run(request.user!.id, annotated);
      db.prepare(`UPDATE producer_conversations SET transcript_id = ? WHERE id = ?`).run(Number(tr.lastInsertRowid), conv.id);
      conv.transcript_id = Number(tr.lastInsertRowid);
    }

    // Persist user turn, name the conversation from its first message.
    const userText = (message || '').trim() || (hasImages ? '[shared image(s)]' : hasDocs ? '[shared PDF]' : '');
    db.prepare(`INSERT INTO producer_messages (conversation_id, role, content) VALUES (?, 'user', ?)`).run(conv.id, userText);
    if (!conv.title || conv.title === 'New chat') {
      db.prepare(`UPDATE producer_conversations SET title = ? WHERE id = ?`).run((userText || 'Chat').slice(0, 60), conv.id);
    }
    db.prepare(`UPDATE producer_conversations SET updated_at = datetime('now') WHERE id = ?`).run(conv.id);

    const history = db.prepare(`SELECT role, content FROM producer_messages WHERE conversation_id = ? ORDER BY id`).all(conv.id) as { role: 'user' | 'assistant'; content: string }[];
    // Gather ALL attached videos (multi-select). Fall back to the conversation's
    // single primary video/transcript for older single-video chats.
    let attachedVideos = db.prepare(`SELECT video_id, video_title, transcript_id, day_label FROM producer_conversation_videos WHERE conversation_id = ? ORDER BY added_at`).all(conv.id) as any[];
    if (!attachedVideos.length && (conv.video_id || conv.transcript_id)) {
      attachedVideos = [{ video_id: conv.video_id, video_title: conv.video_title, transcript_id: conv.transcript_id, day_label: null }];
    }
    const multi = attachedVideos.length > 1;

    // Combine ALL attached transcripts into ONE cached block. Anthropic caps
    // cache_control at 4 blocks total (channel intel already uses one), so a
    // separate cached block per episode overflows the limit with 4+ episodes.
    let transcriptText = '';
    let videoContext = '';
    let winnerThumbBlock: Anthropic.ImageBlockParam | null = null;

    attachedVideos.forEach((av, idx) => {
      // Label by the episode's DAY (MONDAY/TUESDAY/...) when known, so the AI can
      // refer to "the Monday episode" etc.; fall back to EPISODE N.
      const label = av.day_label ? `${String(av.day_label).toUpperCase()} EPISODE` : (multi ? `EPISODE ${idx + 1}` : 'EPISODE');
      const tr = av.transcript_id ? db.prepare(`SELECT title, transcript, show_start_note FROM producer_transcripts WHERE id = ?`).get(av.transcript_id) as any : null;
      if (tr) {
        const showStartNote = tr.show_start_note ? `\n\nPRE-SHOW NOTE: the show begins at "${tr.show_start_note}"; do not anchor a title to anything before that marker.` : '';
        transcriptText += `${transcriptText ? '\n\n\n' : ''}${label} TRANSCRIPT${tr.title ? ` ("${tr.title}")` : ''}:\n\n${tr.transcript}\n\nEND OF ${label} TRANSCRIPT. This is the only source of truth about ${multi ? 'this episode' : 'the episode'}; never invent content not in it.${showStartNote}`;
      }
      if (av.video_id) {
        let v: any = null;
        try { v = db.prepare(`SELECT title, view_count, category, publish_date FROM yt.videos WHERE video_id = ?`).get(av.video_id); } catch {}
        const ctype = classifyContent(v?.title || av.video_title, v?.category);
        const tests = db.prepare(`
          SELECT t.id, t.test_type, t.status, t.winner_variant_id, w.label AS winner_label, w.title AS winner_title, w.thumbnail_path AS winner_thumb
          FROM tests t LEFT JOIN test_variants w ON w.id = t.winner_variant_id
          WHERE t.video_id = ? ORDER BY t.id DESC
        `).all(av.video_id) as any[];
        const testLines = tests.map(t => {
          let s = `${t.test_type} test (${t.status})`;
          if (t.winner_label) s += `, winner ${t.winner_label}${t.test_type !== 'thumbnail' && t.winner_title ? `: "${t.winner_title}"` : ''}`;
          return s;
        });
        if (!winnerThumbBlock) {
          const winThumb = tests.find(t => t.test_type !== 'title' && t.winner_thumb);
          if (winThumb?.winner_thumb) {
            try { const buf = readFileSync(winThumb.winner_thumb); const mt = buf[0] === 0x89 ? 'image/png' : 'image/jpeg'; winnerThumbBlock = { type: 'image', source: { type: 'base64', media_type: mt as any, data: buf.toString('base64') } }; } catch {}
          }
        }
        const ps = getPodcastStats(av.video_id);
        const perfLine = ps ? `  reach: ${ps.listens.toLocaleString()} listens, ${ps.video_views.toLocaleString()} Acast video views${ps.yt_views != null ? `, ${ps.yt_views.toLocaleString()} YT views` : ''}, perf ${ps.perf_index != null ? ps.perf_index.toFixed(2) + 'x norm' : 'n/a'}.\n` : '';
        videoContext += `\n${label}: "${v?.title || av.video_title || av.video_id}" — ${ctype}${v ? `, ${v.view_count?.toLocaleString() || '?'} YouTube views, published ${v.publish_date}` : ''}.\n${perfLine}${tests.length ? `  tests: ${testLines.join('; ')}\n` : '  no tests run yet.\n'}${tr ? `  transcript attached above.\n` : ''}`;
      }
    });
    if (videoContext) {
      videoContext = (multi
        ? `ATTACHED EPISODES (${attachedVideos.length}) — this chat covers ALL of them together. Compare them and give clean options per episode; keep them clearly labelled by episode.\n`
        : `ATTACHED EPISODE (this chat is about this specific video):\n`)
        + videoContext
        + `\nScore titles against each episode's own content type, not the blended average. Any title you propose can be turned into an A/B test with one click, so give clean final options.`;
    }
    // One cached transcript block for all attached episodes (stays under the
    // 4-block cache_control limit no matter how many episodes are attached).
    const transcriptBlocks: Anthropic.TextBlockParam[] = transcriptText
      ? [{ type: 'text', text: transcriptText, cache_control: { type: 'ephemeral' } }]
      : [];

    // SSE — hijack so Fastify does NOT run its normal send lifecycle (incl. the
    // global onSend header hook) against a reply whose head we write ourselves.
    // Without this, onSend races reply.raw and intermittently drops the live
    // stream to the client while the generation still completes and saves — the
    // "sent a message, nothing appeared until I refreshed" bug (2026-07-09).
    reply.hijack();
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    const send = (data: object) => { try { reply.raw.write(`data: ${JSON.stringify(data)}\n\n`); } catch {} };
    const keepAlive = setInterval(() => { try { reply.raw.write(': keepalive\n\n'); } catch {} }, 10000);

    try {
      const client = new Anthropic({ apiKey: config.anthropicApiKey });
      const system: Anthropic.TextBlockParam[] = [
        { type: 'text', text: buildIdentityPrompt() },
        { type: 'text', text: getChannelIntel(), cache_control: { type: 'ephemeral' } },
      ];

      // Build the message list. Attach the transcript(s) (cached) to the first user turn.
      const fbSuffix = feedbackBlock(conv.id);

      const messages: Anthropic.MessageParam[] = history.map((m, i) => {
        const isLast = i === history.length - 1;
        const content = isLast && m.role === 'user' && fbSuffix ? m.content + fbSuffix : m.content;
        const isLastUser = isLast && m.role === 'user';
        if ((i === 0 && m.role === 'user' && (transcriptBlocks.length || videoContext || winnerThumbBlock)) || (isLastUser && (hasImages || hasDocs))) {
          const blocks: (Anthropic.TextBlockParam | Anthropic.ImageBlockParam | Anthropic.DocumentBlockParam)[] = [];
          if (i === 0) for (const tb of transcriptBlocks) blocks.push(tb);
          if (i === 0 && winnerThumbBlock) blocks.push(winnerThumbBlock);
          if (i === 0 && videoContext) blocks.push({ type: 'text', text: videoContext.trim() });
          const attachedFiles = isLastUser && (hasImages || hasDocs);
          if (isLastUser && hasDocs) {
            for (const doc of documents!) {
              blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: doc.data } });
            }
          }
          if (isLastUser && hasImages) {
            for (const img of images!) {
              const mt = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(img.media_type) ? img.media_type : 'image/jpeg';
              blocks.push({ type: 'image', source: { type: 'base64', media_type: mt as any, data: img.data } });
            }
          }
          blocks.push({ type: 'text', text: attachedFiles ? (content || 'Here are the file(s) to look at.') : content });
          return { role: 'user', content: blocks };
        }
        return { role: m.role, content };
      });

      // Tool loop: stream, run any tools, continue until a plain answer.
      let fullText = '';
      let iterations = 0;
      // Use the conversation's chosen model (default Sonnet), with a fallback.
      // Respect an explicit per-chat toggle; otherwise use the user's default.
      const chosen = conv.model === 'claude-opus-4-8' ? 'claude-opus-4-8'
        : conv.model === 'claude-sonnet-4-6' ? 'claude-sonnet-4-6'
        : defaultModelForUser(request.user);
      const models = chosen === FALLBACK_MODEL ? [chosen] : [chosen, FALLBACK_MODEL];
      while (iterations++ < 8) {
        let final: Anthropic.Message | null = null;
        let lastErr: any;
        for (const model of models) {
          try {
            const stream = client.messages.stream({ model, max_tokens: 8000, system, messages, tools: ALL_TOOLS });
            // Belt-and-braces: strip em/en dashes even if the model slips.
            stream.on('text', (d) => { const clean = d.replace(/\s*[—–]\s*/g, ', '); fullText += clean; send({ type: 'text', delta: clean }); });
            final = await stream.finalMessage();
            activeModel = model;
            try { logAiUsage({ app: 'yt-testing', feature: 'producer', user: request.user?.email, model, usage: final.usage }); } catch {}
            break;
          } catch (err: any) {
            lastErr = err;
            if ((err instanceof Anthropic.NotFoundError || (err instanceof Anthropic.BadRequestError && /model/i.test(err.message))) && model !== FALLBACK_MODEL) continue;
            throw err;
          }
        }
        if (!final) throw lastErr;

        if (final.stop_reason === 'tool_use') {
          const toolUses = final.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
          send({ type: 'tools', names: toolUses.map(t => t.name) });
          // Any text the model wrote before calling tools is just narration
          // ("let me pull the data..."). Discard it so only the final answer
          // shows, and tell the client to clear the bubble.
          fullText = '';
          send({ type: 'reset' });
          messages.push({ role: 'assistant', content: final.content });
          const results: Anthropic.ToolResultBlockParam[] = [];
          for (const tu of toolUses) {
            let content = '';
            try { content = await executeProducerTool(tu.name, tu.input); } catch (e: any) { content = `Tool error: ${e?.message}`; }
            results.push({ type: 'tool_result', tool_use_id: tu.id, content });
          }
          messages.push({ role: 'user', content: results });
          continue; // stream the model's next step
        }
        break; // end_turn
      }

      // Persist assistant turn + parse suggestions.
      const msgRes = db.prepare(`INSERT INTO producer_messages (conversation_id, role, content) VALUES (?, 'assistant', ?)`).run(conv.id, fullText);
      const messageId = Number(msgRes.lastInsertRowid);
      const parsed = parseSuggestions(fullText);
      const ins = db.prepare(`INSERT INTO producer_suggestions (conversation_id, message_id, title, rationale, slot) VALUES (?, ?, ?, ?, ?)`);
      const suggestions = parsed.map(s => {
        const r = ins.run(conv.id, messageId, s.title, s.rationale, s.slot);
        return { id: Number(r.lastInsertRowid), title: s.title, rationale: s.rationale, slot: s.slot, feedback: 0 };
      });
      if (suggestions.length) send({ type: 'suggestions', message_id: messageId, suggestions });
      send({ type: 'done', message_id: messageId, model: activeModel });
    } catch (err: any) {
      console.error('[producer] stream error:', err);
      send({ type: 'error', message: err.message || 'Generation failed' });
    }
    clearInterval(keepAlive);
    reply.raw.end();
  });

  // ---- Episode proposals -------------------------------------------------
  ensureProposalSchema();

  // Generate a proposal pack from a stored transcript.
  app.post('/producer/transcripts/:id/propose', async (request, reply) => {
    const { id } = request.params as { id: string };
    const db = getDb();
    const transcript = db.prepare(`SELECT * FROM producer_transcripts WHERE id = ? AND user_id = ?`).get(parseInt(id), request.user!.id) as any;
    if (!transcript) { reply.code(404); return { detail: 'Transcript not found' }; }
    const { content_type } = request.body as { content_type?: string };
    const ct = (content_type === 'TNTL' ? 'TNTL' : 'podcast') as 'podcast' | 'TNTL';
    const pack = await generateProposalPack(transcript.id, transcript.transcript, transcript.title || null, ct);
    try { (await import('../services/activity.js')).logActivity(request.user!.id, 'proposal_generated', `Proposal for: ${pack.episode_title}`); } catch {}
    return pack;
  });

  // List proposal packs (pending by default).
  app.get('/producer/proposals', async (request) => {
    const { status } = request.query as { status?: string };
    return getProposals(status || 'pending');
  });

  // Create a title test from one proposal title.
  app.post('/producer/proposals/:id/create-test', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { title_index, video_id, video_title, start } = request.body as {
      title_index: number; video_id: string; video_title?: string; start?: boolean;
    };
    const db = getDb();
    const proposal = db.prepare(`SELECT * FROM episode_proposals WHERE id = ?`).get(parseInt(id)) as any;
    if (!proposal) { reply.code(404); return { detail: 'Proposal not found' }; }
    if (!video_id) { reply.code(400); return { detail: 'video_id required' }; }
    const titles: any[] = JSON.parse(proposal.titles_json || '[]');
    const chosen = titles[title_index];
    if (!chosen) { reply.code(400); return { detail: 'Invalid title_index' }; }

    let ogTitle: string | null = null;
    try { ogTitle = (db.prepare(`SELECT title FROM yt.videos WHERE video_id = ?`).get(video_id) as any)?.title ?? null; } catch {}
    ogTitle = ogTitle || video_title || null;
    const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]/g, '');
    const variants = ogTitle && norm(ogTitle) !== norm(chosen.title) ? [ogTitle, chosen.title] : [chosen.title];
    if (variants.length < 2) { reply.code(400); return { detail: 'Need the original title plus the new option.' }; }

    const testRes = db.prepare(`
      INSERT INTO tests (video_id, video_title, test_type, test_format, duration_hours_per_variant, min_impressions, test_speed, run_days, run_duration_days, auto_winner, auto_placeholder, channel, category)
      VALUES (?, ?, 'title', 'classic', 4, 500, 'hourly', 'mon,tue,wed,thu,fri,sat,sun', 8, 'ctr', 'disabled', 'main', 'test')
    `).run(video_id, video_title || ogTitle);
    const testId = Number(testRes.lastInsertRowid);
    variants.forEach((title, i) => {
      db.prepare(`INSERT INTO test_variants (test_id, label, title, is_control) VALUES (?, ?, ?, ?)`)
        .run(testId, String.fromCharCode(65 + i), title, i === 0 ? 1 : 0);
    });
    import('../services/title-tagger.js').then(m => m.tagAllVariants({ semantic: true, onlyUntagged: true })).catch(() => {});

    let started = false;
    if (start) {
      try {
        try {
          const { getVideoDetails, downloadThumbnail } = await import('../services/youtube-api.js');
          const details = await getVideoDetails(video_id);
          const thumbUrl = details?.snippet?.thumbnails?.maxres?.url || details?.snippet?.thumbnails?.high?.url;
          const blob = thumbUrl ? await downloadThumbnail(video_id, thumbUrl) : null;
          db.prepare('UPDATE tests SET original_thumbnail_blob = ?, original_title = ? WHERE id = ?')
            .run(blob, details?.snippet?.title || ogTitle || null, testId);
        } catch {}
        const now = new Date(); now.setMinutes(0, 0, 0); now.setHours(now.getHours() + 1);
        db.prepare(`UPDATE tests SET status = 'running', started_at = ? WHERE id = ?`).run(now.toISOString(), testId);
        started = true;
      } catch (e: any) { console.error('[producer] start test from proposal failed:', e?.message); }
    }

    // Mark proposal converted only when all titles have been used (simplification: mark on first use)
    db.prepare(`UPDATE episode_proposals SET status = 'converted' WHERE id = ?`).run(parseInt(id));
    try { (await import('../services/activity.js')).logActivity(request.user!.id, started ? 'test_started' : 'test_created', `title test from proposal: ${chosen.title}`); } catch {}
    return { ok: true, test_id: testId, started };
  });

  // Dismiss a proposal.
  app.post('/producer/proposals/:id/dismiss', async (request, reply) => {
    const { id } = request.params as { id: string };
    const r = getDb().prepare(`UPDATE episode_proposals SET status = 'dismissed' WHERE id = ?`).run(parseInt(id));
    if (!r.changes) { reply.code(404); return { detail: 'Not found' }; }
    return { ok: true };
  });
}
