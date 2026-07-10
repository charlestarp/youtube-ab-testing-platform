/**
 * Auto-tagger — applies the EXISTING tag vocabulary to variant thumbnails with
 * Claude Vision, so tag analytics has data on every test instead of the ~40
 * hand-tagged ones. It never invents tags: the model may only pick from the
 * tags already in `thumbnail_tags`.
 *
 * The trick for the people tags: the model is told Toni is the woman and Ryan
 * is the man, so "toni left" / "ryan right" fall out of face position + who.
 */

import Anthropic from '@anthropic-ai/sdk';
import { logAiUsage } from '../lib/ai-usage-log.js';
import { readFileSync, existsSync } from 'fs';
import { getDb } from '../db/client.js';
import { config } from '../config.js';

const MODEL = 'claude-sonnet-4-6';

// Vision provider: 'claude' (default, most accurate) or 'ollama' (local, free).
// Set TAG_VISION_PROVIDER=ollama to tag on the Mac Studio's GPU at no API cost.
const VISION_PROVIDER = (process.env.TAG_VISION_PROVIDER || 'claude').toLowerCase();
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_VISION_MODEL = process.env.OLLAMA_VISION_MODEL || 'qwen2.5vl:72b';

// Hard per-image timeout so one stuck inference can never hang the whole batch
// (this is what stalled the 72B run). Aborts the call; the variant then errors
// and the batch moves on.
const VISION_TIMEOUT_MS = Number(process.env.VISION_TIMEOUT_MS || 90000);

/** Run the vision prompt over an image, dispatching to the chosen provider. */
async function visionComplete(base64: string, mime: string, prompt: string, provider = VISION_PROVIDER): Promise<string> {
  if (provider === 'ollama') {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), VISION_TIMEOUT_MS);
    try {
      const res = await fetch(`${OLLAMA_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: ac.signal,
        body: JSON.stringify({
          model: OLLAMA_VISION_MODEL,
          messages: [{ role: 'user', content: prompt, images: [base64] }],
          stream: false,
          keep_alive: '10m',
          options: { temperature: 0, num_predict: 800 },
        }),
      });
      if (!res.ok) throw new Error(`Ollama ${res.status}: ${(await res.text()).slice(0, 120)}`);
      const j: any = await res.json();
      return (j?.message?.content || '').trim();
    } catch (e: any) {
      if (e?.name === 'AbortError') throw new Error(`Ollama timed out after ${VISION_TIMEOUT_MS}ms`);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
  // Claude (default)
  const client = new Anthropic({ apiKey: config.anthropicApiKey, timeout: VISION_TIMEOUT_MS, maxRetries: 2 });
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 800, // room for the tag array + verbatim tweet_text (300 truncated long tweets)
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: mime as any, data: base64 } },
      { type: 'text', text: prompt },
    ] }],
  });
  try { logAiUsage({ app: 'yt-testing', feature: 'auto-tagger', user: 'unknown', model: MODEL, usage: resp.usage }); } catch {}
  return resp.content.filter(b => b.type === 'text').map((b: any) => b.text).join('').trim();
}

// Extract the first complete, brace-balanced JSON object from a string (ignores
// any trailing second object or prose the model may append).
function firstJsonObject(s: string): string | null {
  const start = s.indexOf('{');
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return s.slice(start, i + 1); }
  }
  return null;
}

interface TagRow { id: number; name: string; category: string | null; }

export function loadVocab(): TagRow[] {
  return getDb().prepare('SELECT id, name, category FROM thumbnail_tags ORDER BY category, name').all() as TagRow[];
}

export function buildPrompt(vocab: TagRow[]): string {
  const byCat = new Map<string, string[]>();
  for (const t of vocab) {
    const c = t.category || 'other';
    byCat.set(c, [...(byCat.get(c) || []), t.name]);
  }
  const catLines = [...byCat.entries()].map(([c, names]) => `- ${c}: ${names.join(', ')}`).join('\n');

  return `You tag a YouTube thumbnail for the podcast "Toni and Ryan" using ONLY the tags below. Do not invent tags.

WHO IS WHO:
- Toni is the woman: brown hair with a fringe, big glasses.
- Ryan is the man: short hair, beard.

TAG VOCABULARY (pick only from these exact names):
${catLines}

HOW TO CHOOSE:
- people: FIRST count who is actually present.
  - If ONLY Toni appears (Ryan is not in the thumbnail), tag "toni only" and NEVER "toni left" or "toni right".
  - If ONLY Ryan appears, tag "ryan only" and NEVER "ryan left" or "ryan right".
  - If BOTH appear, tag "toni and ryan" AND each person's side based on the horizontal position of their FACE: "toni left" or "toni right", "ryan left" or "ryan right". Use "both left" only when both faces sit in the left half.
  - The left/right tags describe which side of the frame the face is on, they are NOT for a single centred person. If one person is roughly centred, use the "only" tag (and you may add "centre").
  - "toni orange shirt" only if Toni is clearly in an orange top. "guest" if a third person who is not Toni or Ryan is present.
- background: "red background" or "white background" only when the backdrop is clearly that solid colour. "full image background" if a single photo fills the whole frame behind everything.
- tweet: the joke is usually a tweet (Twitter/X post) overlaid on the thumbnail. If a tweet IS shown: (a) transcribe its BODY text VERBATIM into the "tweet_text" field of your answer; (b) tag its length by the body text: 1 line = "short tweet", 2 to 3 lines = "medium tweet", 4 or more lines = "long tweet" (exactly one length); (c) tag EXACTLY ONE type, deciding in this order and stopping at the first match: "tweet question" if it asks a question; else "tweet list" if it is a numbered or bulleted list; else "statement quote" if it quotes what someone actually said (e.g. "my mum said..." or words in quotation marks); else "tweet statement" for a plain declarative statement. NEVER apply more than one tweet type; (d) add "tweet highlight" if any word or phrase is emphasised (highlighted, underlined, circled, different colour), and "tweet image" if the tweet has an embedded photo or media. If NO tweet is shown at all, use "no tweet" and leave tweet_text empty.
- text: this category is about CAPTION / graphic text added on top, SEPARATE from the tweet. IMPORTANT: only use "no text" when the thumbnail has NO text of any kind, meaning no tweet AND no caption words. NEVER tag "no text" together with any tweet tag, because a tweet is text (that would contradict). If a tweet is present but there is no extra caption beyond it, simply do not add any tag from this category. "yellow text"/"red font highlight" for the colour of added caption words. "small text" if the caption text is small. "emoji" if an emoji is used. "arrow or circle" if an arrow or circle annotation is drawn on the image.
- layout: "centre" if the subject is centred, "vertical feed ui" if it mimics a phone/TikTok feed.
- expression: tag EACH host's facial expression SEPARATELY, per person. For Toni (the woman with glasses) use exactly one of "toni shocked" / "toni laughing" / "toni excited" / "toni smiling" / "toni sad" / "toni neutral". For Ryan (the man with the beard) use the matching "ryan ..." tag. Only tag a person's expression if that person is actually visible. Pick the single closest expression for each: shocked = wide-eyed/open-mouth surprise, laughing = clearly mid-laugh, excited = big energetic grin, smiling = gentle smile, sad = down/upset, neutral = flat/no strong expression.
- content: "sexual reference" for innuendo or sexual content, "non-obvious joke" if the gag needs the title to land.
- Only include a tag you are confident about. Most thumbnails get 2 to 5 tags. Do not force a tag from every category.

Return EXACTLY ONE JSON object and nothing else, no commentary, no corrections, no second object. Two keys: "tags" (an array of the exact tag names from the vocabulary, with NO category prefix) and "tweet_text" (the verbatim tweet body text, or "" if there is no tweet). Example: {"tags":["white background","toni only","medium tweet","tweet question"],"tweet_text":"why do men always..."}`;
}

// Sniff the real type from magic bytes — some files have a .jpg name but PNG bytes.
function mediaType(buf: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' {
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return 'image/jpeg';
}

export interface AutoTagResult {
  variant_id: number;
  applied: string[];
  skipped: string[]; // returned by model but not in vocab
  error?: string;
}

/** Tag a single variant. Writes variant_tags rows (idempotent). dryRun skips the write. */
export async function autoTagVariant(variantId: number, opts: { dryRun?: boolean; provider?: string } = {}): Promise<AutoTagResult> {
  const db = getDb();
  const variant = db.prepare('SELECT id, thumbnail_path FROM test_variants WHERE id = ?').get(variantId) as any;
  if (!variant?.thumbnail_path || !existsSync(variant.thumbnail_path)) {
    return { variant_id: variantId, applied: [], skipped: [], error: 'no thumbnail file' };
  }

  const vocab = loadVocab();
  const byName = new Map(vocab.map(t => [t.name.toLowerCase(), t]));

  let imgBuf = readFileSync(variant.thumbnail_path);
  let mime = mediaType(imgBuf);
  // Downscale big thumbnails (full-res 4K PNGs, often 4-8MB) to a sane JPEG.
  // Claude caps images at 5MB on the BASE64 size (~1.37x the raw bytes), so a
  // 3.7MB+ raw file already exceeds the cap even though it looks under 5MB.
  // Threshold at 3.5MB raw so those get resized too. If sharp fails, LOG it —
  // silently sending the original guarantees a "Could not process image" reject.
  if (imgBuf.length > 3_500_000 || mime === 'image/png') {
    try {
      const sharp = (await import('sharp')).default;
      imgBuf = Buffer.from(await sharp(imgBuf).resize({ width: 1568, withoutEnlargement: true }).jpeg({ quality: 84 }).toBuffer());
      mime = 'image/jpeg';
    } catch (e: any) {
      console.error(`[auto-tagger] sharp resize failed for variant ${variantId}:`, e?.message);
    }
  }
  // Last-resort guard: if it is still over Claude's limit, skip with a clear
  // error instead of sending it and getting an opaque 400.
  if (imgBuf.length > 4_800_000) {
    return { variant_id: variantId, applied: [], skipped: [], error: `image too large after processing (${(imgBuf.length / 1e6).toFixed(1)}MB) — sharp may have failed` } as any;
  }
  const base64 = imgBuf.toString('base64');
  const text = await visionComplete(base64, mime, buildPrompt(vocab), opts.provider);
  let names: string[] = [];
  let tweetText = '';
  try {
    // Extract the FIRST complete JSON object (the model sometimes appends a
    // "wait, let me correct that" second object; grabbing first-{ to last-}
    // would splice both together and fail to parse).
    const objStr = firstJsonObject(text);
    if (objStr) {
      const parsed = JSON.parse(objStr);
      names = Array.isArray(parsed.tags) ? parsed.tags : [];
      tweetText = typeof parsed.tweet_text === 'string' ? parsed.tweet_text.trim() : '';
    } else {
      // Fallback: a bare array (old format).
      const a = text.indexOf('['), b = text.indexOf(']', a);
      names = JSON.parse(text.slice(a, b + 1));
    }
  } catch {
    return { variant_id: variantId, applied: [], skipped: [], error: `unparseable: ${text.slice(0, 80)}` };
  }

  const applied: string[] = [];
  const skipped: string[] = [];
  const insert = db.prepare("INSERT OR IGNORE INTO variant_tags (variant_id, tag_id, source) VALUES (?, ?, 'ai')");
  for (const raw of names) {
    const tag = byName.get(String(raw).toLowerCase().trim());
    if (!tag) { skipped.push(String(raw)); continue; }
    if (!opts.dryRun) insert.run(variantId, tag.id);
    applied.push(tag.name);
  }
  if (!opts.dryRun) db.prepare('UPDATE test_variants SET tweet_text = ? WHERE id = ?').run(tweetText || null, variantId);
  return { variant_id: variantId, applied, skipped };
}

const TWEET_PROMPT = `Look at this YouTube thumbnail. If it shows a tweet (a Twitter/X post screenshot), count the lines of the tweet's BODY text and classify:
- 1 line = "short tweet"
- 2 to 3 lines = "medium tweet"
- 4 or more lines = "long tweet"
If there is no tweet shown, answer "none".
Reply with ONLY one of: short tweet, medium tweet, long tweet, none.`;

/**
 * Re-classify tweet-length tags to the 1 / 2-3 / 4+ line rule. Only touches
 * AI-applied tweet tags (leaves hand-tagged ones alone). Returns what changed.
 */
export async function reclassifyTweets(opts: { dryRun?: boolean } = {}): Promise<{ variant_id: number; from: string[]; to: string | null }[]> {
  const db = getDb();
  const tweetTags = db.prepare(`SELECT id, name FROM thumbnail_tags WHERE name IN ('short tweet','medium tweet','long tweet')`).all() as any[];
  const idByName = new Map(tweetTags.map(t => [t.name, t.id]));
  const nameById = new Map(tweetTags.map(t => [t.id, t.name]));
  const tweetIds = tweetTags.map(t => t.id);

  // Variants that currently have an AI-applied tweet tag.
  const rows = db.prepare(`
    SELECT DISTINCT v.id, v.thumbnail_path FROM test_variants v
    JOIN variant_tags vt ON vt.variant_id = v.id
    WHERE vt.tag_id IN (${tweetIds.map(() => '?').join(',')}) AND vt.source = 'ai'
      AND v.thumbnail_path IS NOT NULL AND v.thumbnail_path != ''
  `).all(...tweetIds) as any[];

  const changes: { variant_id: number; from: string[]; to: string | null }[] = [];

  for (const v of rows) {
    if (!existsSync(v.thumbnail_path)) continue;
    let buf = readFileSync(v.thumbnail_path);
    let mime = mediaType(buf);
    if (buf.length > 4_500_000) {
      try { const sharp = (await import('sharp')).default; buf = Buffer.from(await sharp(buf).resize({ width: 1280, withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer()); mime = 'image/jpeg'; } catch { /* keep original */ }
    }
    let answer = 'none';
    try {
      answer = (await visionComplete(buf.toString('base64'), mime, TWEET_PROMPT)).toLowerCase().trim();
    } catch { continue; }

    const target = ['short tweet', 'medium tweet', 'long tweet'].find(t => answer.includes(t)) || null;
    const current = db.prepare(`SELECT tag_id FROM variant_tags WHERE variant_id = ? AND tag_id IN (${tweetIds.map(() => '?').join(',')}) AND source='ai'`).all(v.id, ...tweetIds) as any[];
    const from = current.map(c => nameById.get(c.tag_id)).filter(Boolean) as string[];

    if (from.length === 1 && from[0] === target) continue; // already correct
    changes.push({ variant_id: v.id, from, to: target });
    if (opts.dryRun) continue;

    // Remove the old AI tweet tags, add the correct one.
    for (const c of current) db.prepare(`DELETE FROM variant_tags WHERE variant_id=? AND tag_id=? AND source='ai'`).run(v.id, c.tag_id);
    if (target) db.prepare(`INSERT OR IGNORE INTO variant_tags (variant_id, tag_id, source) VALUES (?, ?, 'ai')`).run(v.id, idByName.get(target));
  }
  return changes;
}

/** Backfill untagged thumbnail variants. Returns per-variant results. */
export async function autoTagBatch(opts: { limit?: number; onlyUntagged?: boolean; dryRun?: boolean; concurrency?: number; provider?: string } = {}): Promise<AutoTagResult[]> {
  const db = getDb();
  const onlyUntagged = opts.onlyUntagged !== false;
  const rows = db.prepare(`
    SELECT v.id FROM test_variants v
    WHERE v.active = 1 AND v.thumbnail_path IS NOT NULL AND v.thumbnail_path != ''
      ${onlyUntagged ? 'AND v.id NOT IN (SELECT variant_id FROM variant_tags)' : ''}
    ORDER BY v.id
    ${opts.limit ? 'LIMIT ' + Number(opts.limit) : ''}
  `).all() as any[];

  const ids = rows.map(r => r.id);
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 4, 8));
  const results: AutoTagResult[] = [];
  let consecutiveFails = 0;
  const t0 = Date.now();
  console.log(`[auto-tagger] starting: ${ids.length} thumbnails, provider=${opts.provider || VISION_PROVIDER}, concurrency=${concurrency}`);
  for (let i = 0; i < ids.length; i += concurrency) {
    const slice = ids.slice(i, i + concurrency);
    const batch = await Promise.all(slice.map(id =>
      autoTagVariant(id, { dryRun: opts.dryRun, provider: opts.provider }).catch(e => ({ variant_id: id, applied: [], skipped: [], error: String(e?.message || e) } as AutoTagResult))
    ));
    results.push(...batch);

    // Progress heartbeat every batch so a stall is visible in the logs.
    const done = results.length, errs = results.filter(r => r.error).length;
    console.log(`[auto-tagger] ${done}/${ids.length} done (${errs} errors, ${Math.round((Date.now() - t0) / 1000)}s)`);

    // Circuit breaker: if the backend fails many in a row, stop rather than
    // grind (e.g. Ollama died or the model is unloadable). Never hang.
    consecutiveFails = batch.every(r => r.error) ? consecutiveFails + batch.length : 0;
    if (consecutiveFails >= 8) {
      console.error(`[auto-tagger] ABORTING: ${consecutiveFails} consecutive failures (backend down?). Tagged ${done - errs} before stop.`);
      break;
    }
  }
  return results;
}
