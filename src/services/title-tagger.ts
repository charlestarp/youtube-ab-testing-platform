/**
 * Title tagging — the title-side counterpart to the thumbnail auto-tagger.
 *
 * Tags every title (both A/B title-test variants AND published videos that were
 * never tested) with a vocabulary of title ATTRIBUTES. Objective attributes are
 * detected by transparent text rules (free, instant); a few semantic ones come
 * from one batched Claude text call. Everything is stamped with content type
 * (podcast vs TNTL) so the two are analysed separately.
 */

import Anthropic from '@anthropic-ai/sdk';
import { logAiUsage } from '../lib/ai-usage-log.js';
import { getDb } from '../db/client.js';
import { config } from '../config.js';
import { classifyContent, type ContentType } from './content-type.js';

const MODEL = 'claude-sonnet-4-6';

// ---- Vocabulary -----------------------------------------------------------
// Rule tags are detected here; semantic tags are decided by Claude.
interface RuleTag { name: string; category: string; test: (t: string) => boolean; }

const CAPS_WORD = /\b[A-Z][A-Z'']{2,}\b/;         // an all-caps word, 3+ chars
const RULE_TAGS: RuleTag[] = [
  { name: 'question', category: 'structure', test: t => /\?/.test(t) },
  { name: 'exclamation', category: 'structure', test: t => /!/.test(t) },
  { name: 'colon setup', category: 'structure', test: t => /:/.test(t) },
  { name: 'has number', category: 'structure', test: t => /\d/.test(t) },
  { name: 'listicle', category: 'structure', test: t => /\b(top\s+\d+|\d+\s+(ways|things|times|reasons|signs|types|rules|lies))\b/i.test(t) },
  { name: 'all caps word', category: 'style', test: t => CAPS_WORD.test(t) },
  { name: 'second person', category: 'style', test: t => /\b(you|your|you're|yourself|you've)\b/i.test(t) },
  { name: 'name drop', category: 'style', test: t => /\b(toni|ryan)\b/i.test(t) || /@\w+/.test(t) || /\bwith\s+[A-Z]/.test(t) },
  { name: 'location tag', category: 'style', test: t => /live from/i.test(t) || /\|\s*[A-Z]/.test(t) },
  { name: 'negative framing', category: 'angle', test: t => /\b(worst|terrible|awful|banned|ruin(ed|s)?|hate|never|can'?t|cringe|fail(s|ed)?|wrong|illegal|broke the law|nightmare|disaster|toxic)\b/i.test(t) },
  { name: 'long title', category: 'length', test: t => t.trim().split(/\s+/).length >= 9 },
  { name: 'short title', category: 'length', test: t => t.trim().split(/\s+/).length <= 4 },
];

// Semantic tags decided by Claude (harder to capture with a regex).
const SEMANTIC_TAGS: { name: string; category: string; hint: string }[] = [
  { name: 'curiosity gap', category: 'angle', hint: 'withholds the payoff so you must click (e.g. "what happened next", "you won\'t believe")' },
  { name: 'confession', category: 'angle', hint: 'admits to something embarrassing, secret, or taboo the hosts did' },
  { name: 'controversy', category: 'angle', hint: 'divisive, scandalous, or argument-baiting' },
  { name: 'wholesome', category: 'angle', hint: 'heartwarming, sweet, or feel-good' },
  { name: 'relatable', category: 'angle', hint: 'an everyday situation the viewer has lived through' },
];

export function ruleTags(title: string): string[] {
  const t = title || '';
  return RULE_TAGS.filter(r => r.test(t)).map(r => r.name);
}

// ---- Schema ---------------------------------------------------------------
export function ensureTitleSchema(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS title_tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      category TEXT,
      is_semantic INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS title_tag_map (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      video_id TEXT,
      variant_id INTEGER,
      tag_id INTEGER NOT NULL,
      content_type TEXT,
      source TEXT DEFAULT 'rule',
      UNIQUE(video_id, variant_id, tag_id)
    );
    CREATE INDEX IF NOT EXISTS idx_ttm_video ON title_tag_map(video_id);
    CREATE INDEX IF NOT EXISTS idx_ttm_variant ON title_tag_map(variant_id);
    CREATE INDEX IF NOT EXISTS idx_ttm_ctype ON title_tag_map(content_type);
  `);
  // Seed vocabulary.
  const up = db.prepare('INSERT OR IGNORE INTO title_tags (name, category, is_semantic) VALUES (?, ?, ?)');
  for (const r of RULE_TAGS) up.run(r.name, r.category, 0);
  for (const s of SEMANTIC_TAGS) up.run(s.name, s.category, 1);
}

function tagIdMap(): Map<string, number> {
  return new Map((getDb().prepare('SELECT id, name FROM title_tags').all() as any[]).map(r => [r.name, r.id]));
}

// ---- Semantic pass (batched Claude call) ----------------------------------
async function semanticBatch(titles: { key: string; title: string }[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (titles.length === 0) return out;
  const client = new Anthropic({ apiKey: config.anthropicApiKey });
  const list = SEMANTIC_TAGS.map(s => `- "${s.name}": ${s.hint}`).join('\n');

  const BATCH = 30;
  for (let i = 0; i < titles.length; i += BATCH) {
    const slice = titles.slice(i, i + BATCH);
    const numbered = slice.map((t, j) => `${j + 1}. ${t.title}`).join('\n');
    const prompt = `For each YouTube title, decide which of these angle tags apply. Only include a tag if it clearly fits. A title may have zero, one, or several.

TAGS:
${list}

TITLES:
${numbered}

Reply ONLY with a JSON object mapping each number to an array of tag names, e.g. {"1":["curiosity gap"],"2":[],"3":["confession","relatable"]}. No prose.`;
    try {
      const resp = await client.messages.create({ model: MODEL, max_tokens: 1500, messages: [{ role: 'user', content: prompt }] });
      try { logAiUsage({ app: 'yt-testing', feature: 'title-tagger', user: 'unknown', model: MODEL, usage: resp.usage }); } catch {}
      const text = resp.content.filter(b => b.type === 'text').map((b: any) => b.text).join('');
      const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
      const valid = new Set(SEMANTIC_TAGS.map(s => s.name));
      slice.forEach((t, j) => {
        const arr = (json[String(j + 1)] || []).filter((n: string) => valid.has(n));
        out.set(t.key, arr);
      });
    } catch { /* skip this batch's semantic tags */ }
  }
  return out;
}

function writeTags(subject: { video_id?: string; variant_id?: number }, ctype: ContentType, tagNames: string[], source: string, ids: Map<string, number>) {
  const db = getDb();
  const ins = db.prepare(`INSERT OR IGNORE INTO title_tag_map (video_id, variant_id, tag_id, content_type, source) VALUES (?, ?, ?, ?, ?)`);
  for (const name of tagNames) {
    const tid = ids.get(name);
    if (tid) ins.run(subject.video_id ?? null, subject.variant_id ?? null, tid, ctype, source);
  }
}

// ---- Public backfills ------------------------------------------------------
export interface TitleTagStats { subjects: number; rule_tags: number; semantic_tags: number }

/** Tag every published video title from youtube.db. */
export async function tagAllVideos(opts: { semantic?: boolean; onlyUntagged?: boolean } = {}): Promise<TitleTagStats> {
  ensureTitleSchema();
  const db = getDb();
  const ids = tagIdMap();
  const videos = db.prepare(`
    SELECT video_id, title, category FROM yt.videos
    WHERE title IS NOT NULL AND title != ''
    ${opts.onlyUntagged ? 'AND video_id NOT IN (SELECT DISTINCT video_id FROM title_tag_map WHERE video_id IS NOT NULL)' : ''}
  `).all() as any[];
  if (!videos.length) return { subjects: 0, rule_tags: 0, semantic_tags: 0 };

  let ruleCount = 0;
  const forSemantic: { key: string; title: string }[] = [];
  const ctypeByKey = new Map<string, ContentType>();
  for (const v of videos) {
    const ctype = classifyContent(v.title, v.category);
    ctypeByKey.set(v.video_id, ctype);
    const tags = ruleTags(v.title);
    writeTags({ video_id: v.video_id }, ctype, tags, 'rule', ids);
    ruleCount += tags.length;
    forSemantic.push({ key: v.video_id, title: v.title });
  }

  let semCount = 0;
  if (opts.semantic !== false) {
    const sem = await semanticBatch(forSemantic);
    for (const [vid, tags] of sem) {
      writeTags({ video_id: vid }, ctypeByKey.get(vid)!, tags, 'ai', ids);
      semCount += tags.length;
    }
  }
  return { subjects: videos.length, rule_tags: ruleCount, semantic_tags: semCount };
}

/** Tag every A/B title-test variant. */
export async function tagAllVariants(opts: { semantic?: boolean; onlyUntagged?: boolean } = {}): Promise<TitleTagStats> {
  ensureTitleSchema();
  const db = getDb();
  const ids = tagIdMap();
  const variants = db.prepare(`
    SELECT tv.id AS variant_id, tv.title, t.video_title, t.video_id
    FROM test_variants tv JOIN tests t ON t.id = tv.test_id
    WHERE tv.active = 1 AND tv.title IS NOT NULL AND tv.title != ''
      ${opts.onlyUntagged ? 'AND tv.id NOT IN (SELECT DISTINCT variant_id FROM title_tag_map WHERE variant_id IS NOT NULL)' : ''}
  `).all() as any[];
  if (!variants.length) return { subjects: 0, rule_tags: 0, semantic_tags: 0 };

  // Content type comes from the video (join youtube.db category when present).
  const catByVideo = new Map((db.prepare(`SELECT video_id, category FROM yt.videos`).all() as any[]).map(r => [r.video_id, r.category]));

  let ruleCount = 0;
  const forSemantic: { key: string; title: string }[] = [];
  const ctypeByKey = new Map<string, ContentType>();
  for (const v of variants) {
    const ctype = classifyContent(v.video_title, catByVideo.get(v.video_id));
    const key = String(v.variant_id);
    ctypeByKey.set(key, ctype);
    const tags = ruleTags(v.title);
    writeTags({ variant_id: v.variant_id }, ctype, tags, 'rule', ids);
    ruleCount += tags.length;
    forSemantic.push({ key, title: v.title });
  }

  let semCount = 0;
  if (opts.semantic !== false) {
    const sem = await semanticBatch(forSemantic);
    for (const [key, tags] of sem) {
      writeTags({ variant_id: Number(key) }, ctypeByKey.get(key)!, tags, 'ai', ids);
      semCount += tags.length;
    }
  }
  return { subjects: variants.length, rule_tags: ruleCount, semantic_tags: semCount };
}
