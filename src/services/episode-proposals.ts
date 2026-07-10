import Anthropic from '@anthropic-ai/sdk';
import { getDb } from '../db/client.js';
import { config } from '../config.js';
import { getChannelIntel } from './channel-intel.js';
import { buildIdentityPrompt } from './producer.js';
import { computeTitleAbUplift } from './title-insights.js';
import { preflightTitle } from './title-preflight.js';
import type { ContentType } from './content-type.js';

export interface ProposalTitle {
  title: string;
  pattern: string;
  rationale: string;
  preflight: {
    score: number;
    ctr_band: string;
    confidence: string;
    verdict: string;
    signals: Array<{ tag: string; verdict: string; uplift_pct: number }>;
    reasons: string[];
  };
}

export interface ProposalThumbnail {
  concept: string;
  rationale: string;
  winning_tags: string[];
}

export interface ProposalTestPlan {
  first: 'title' | 'thumbnail';
  rationale: string;
  chain: boolean;
}

export interface ProposalPack {
  id: number;
  transcript_id: number | null;
  video_id: string | null;
  source: 'transcript' | 'video';
  episode_title: string;
  content_type: string;
  titles: ProposalTitle[];
  thumbnails: ProposalThumbnail[];
  test_plan: ProposalTestPlan;
  status: 'pending' | 'converted' | 'dismissed';
  created_at: string;
}

export function ensureProposalSchema(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS episode_proposals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transcript_id INTEGER,
      episode_title TEXT NOT NULL DEFAULT '',
      content_type TEXT NOT NULL DEFAULT 'podcast',
      titles_json TEXT NOT NULL DEFAULT '[]',
      thumbnails_json TEXT NOT NULL DEFAULT '[]',
      test_plan_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

function getWinningThumbnailTags(): string {
  const db = getDb();
  try {
    const rows = db.prepare(`
      SELECT th.name, th.category, COUNT(*) as uses,
        SUM(CASE WHEN tv.id = t.winner_variant_id THEN 1 ELSE 0 END) as wins
      FROM variant_tags vt
      JOIN thumbnail_tags th ON th.id = vt.tag_id
      JOIN test_variants tv ON tv.id = vt.variant_id
      JOIN tests t ON t.id = tv.test_id AND t.status = 'completed' AND t.test_type != 'title'
      GROUP BY th.name HAVING uses >= 3
      ORDER BY wins DESC LIMIT 12
    `).all() as any[];
    if (!rows.length) return 'No thumbnail A/B data yet.';
    return rows.map(r => `${r.name} (${r.category}): ${r.wins}/${r.uses} wins`).join('\n');
  } catch { return ''; }
}

function getTopThumbnailAttributes(): string {
  const db = getDb();
  try {
    const expressionRows = db.prepare(`
      SELECT expression, ROUND(AVG(ctr), 2) as avg_ctr, COUNT(*) as count
      FROM thumbnail_analysis WHERE expression IS NOT NULL AND expression != 'none' AND ctr > 0
      GROUP BY expression HAVING count >= 2 ORDER BY avg_ctr DESC LIMIT 4
    `).all() as any[];
    const layoutRows = db.prepare(`
      SELECT layout, ROUND(AVG(ctr), 2) as avg_ctr, COUNT(*) as count
      FROM thumbnail_analysis WHERE layout IS NOT NULL AND ctr > 0
      GROUP BY layout HAVING count >= 2 ORDER BY avg_ctr DESC LIMIT 3
    `).all() as any[];
    const globalRow = db.prepare(`
      SELECT
        ROUND(AVG(CASE WHEN has_text=1 THEN ctr END), 2) as text_ctr,
        ROUND(AVG(CASE WHEN has_text=0 THEN ctr END), 2) as no_text_ctr,
        ROUND(AVG(CASE WHEN face_count>0 THEN ctr END), 2) as face_ctr,
        ROUND(AVG(CASE WHEN face_count=0 THEN ctr END), 2) as no_face_ctr
      FROM thumbnail_analysis WHERE ctr > 0
    `).get() as any;
    let out = '';
    if (expressionRows.length) out += `Best expressions by CTR: ${expressionRows.map(r => `${r.expression} (${r.avg_ctr}%)`).join(', ')}\n`;
    if (layoutRows.length) out += `Best layouts: ${layoutRows.map(r => `${r.layout} (${r.avg_ctr}%)`).join(', ')}\n`;
    if (globalRow?.text_ctr && globalRow?.no_text_ctr) out += `Text overlay: ${globalRow.text_ctr}% vs no text: ${globalRow.no_text_ctr}%\n`;
    if (globalRow?.face_ctr && globalRow?.no_face_ctr) out += `With faces: ${globalRow.face_ctr}% vs without: ${globalRow.no_face_ctr}%\n`;
    return out || 'No thumbnail attribute data yet.';
  } catch { return ''; }
}

function getProvenTitlePatterns(contentType: ContentType | null): string {
  try {
    const uplifts = computeTitleAbUplift(2);
    const tags = uplifts[contentType || 'podcast'] || [];
    const useful = tags.filter(t => t.verdict === 'proven' || t.verdict === 'promising').slice(0, 10);
    if (!useful.length) return 'No A/B title pattern data yet.';
    return useful.map(t => `"${t.name}" (${t.verdict}, ${t.avg_uplift_pct > 0 ? '+' : ''}${t.avg_uplift_pct.toFixed(0)}% uplift, ${t.tests} tests)`).join('\n');
  } catch { return ''; }
}

export async function generateProposalPack(
  transcriptId: number,
  transcript: string,
  episodeTitle: string | null,
  contentType: ContentType | null,
): Promise<ProposalPack> {
  ensureProposalSchema();
  const db = getDb();
  const type: ContentType = contentType || 'podcast';

  const titlePatterns = getProvenTitlePatterns(contentType);
  const winningTags = getWinningThumbnailTags();
  const thumbAttributes = getTopThumbnailAttributes();

  const systemPrompt = `${buildIdentityPrompt()}\n\n${getChannelIntel()}`;

  const userPrompt = `Generate a complete recording-day proposal pack for this episode.

TRANSCRIPT (excerpt):
${transcript.slice(0, 8000)}

PROVEN TITLE PATTERNS from our A/B tests (use these to ground your 3 title candidates):
${titlePatterns}

WINNING THUMBNAIL TAGS (appear most on winning variants in our A/B tests):
${winningTags}

THUMBNAIL ATTRIBUTE DATA (from our published video library, by CTR):
${thumbAttributes}

Content type: ${type}${episodeTitle ? `\nEpisode working title: "${episodeTitle}"` : ''}

Return ONLY valid JSON matching exactly this structure (no markdown, no code block):
{
  "episode_title": "short descriptive label for this episode",
  "titles": [
    {"title": "...", "pattern": "exact proven pattern name from list above", "rationale": "one sentence why this title works for this episode"},
    {"title": "...", "pattern": "...", "rationale": "..."},
    {"title": "...", "pattern": "...", "rationale": "..."}
  ],
  "thumbnails": [
    {"concept": "precise visual description: who is in frame, expression, layout, text overlay wording and style", "rationale": "why this concept wins, referencing the winning tags data", "winning_tags": ["tag1", "tag2"]},
    {"concept": "...", "rationale": "...", "winning_tags": [...]}
  ],
  "test_plan": {
    "first": "title",
    "rationale": "one sentence — title or thumbnail first and why",
    "chain": true
  }
}

Rules:
- All 3 titles must take genuinely different angles (different hook, not just synonym swaps)
- Each pattern must match one of the proven patterns listed (use the exact name)
- Thumbnail concepts must be specific enough for a designer to execute without asking questions
- winning_tags must only reference tags from the winning thumbnail tags list above
- test_plan.first = "title" when no title test exists yet (cheapest signal to get first)
- test_plan.chain = true means auto-chain the second test type after the first winner`;

  const client = new Anthropic({ apiKey: config.anthropicApiKey });
  const response = await client.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 2000,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const text = response.content.filter(b => b.type === 'text').map(b => (b as any).text).join('');
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON found in proposal response');
  const raw = JSON.parse(jsonMatch[0]) as {
    episode_title: string;
    titles: Array<{ title: string; pattern: string; rationale: string }>;
    thumbnails: Array<{ concept: string; rationale: string; winning_tags: string[] }>;
    test_plan: { first: string; rationale: string; chain: boolean };
  };

  const titlesWithPreflight: ProposalTitle[] = (raw.titles || []).map(t => {
    try {
      const pf = preflightTitle(t.title, type);
      return {
        ...t,
        preflight: {
          score: pf.score,
          ctr_band: pf.ctr_band,
          confidence: pf.confidence,
          verdict: pf.verdict,
          signals: pf.signals.slice(0, 5).map(s => ({ tag: s.tag, verdict: s.verdict, uplift_pct: s.uplift_pct })),
          reasons: pf.reasons.slice(0, 3),
        },
      };
    } catch {
      return { ...t, preflight: { score: 50, ctr_band: 'around median', confidence: 'low', verdict: 'neutral', signals: [], reasons: [] } };
    }
  });

  const testPlan: ProposalTestPlan = {
    first: raw.test_plan?.first === 'thumbnail' ? 'thumbnail' : 'title',
    rationale: raw.test_plan?.rationale || '',
    chain: raw.test_plan?.chain !== false,
  };

  const episodeTitleFinal = raw.episode_title || episodeTitle || 'Untitled';

  const ins = db.prepare(`
    INSERT INTO episode_proposals (transcript_id, episode_title, content_type, titles_json, thumbnails_json, test_plan_json, source)
    VALUES (?, ?, ?, ?, ?, ?, 'transcript')
  `).run(transcriptId, episodeTitleFinal, type, JSON.stringify(titlesWithPreflight), JSON.stringify(raw.thumbnails || []), JSON.stringify(testPlan));

  return {
    id: Number(ins.lastInsertRowid),
    transcript_id: transcriptId,
    video_id: null,
    source: 'transcript',
    episode_title: episodeTitleFinal,
    content_type: type,
    titles: titlesWithPreflight,
    thumbnails: raw.thumbnails || [],
    test_plan: testPlan,
    status: 'pending',
    created_at: new Date().toISOString(),
  };
}

export async function generateVideoProposalPack(
  videoId: string,
  videoTitle: string,
  contentType: ContentType | null,
): Promise<ProposalPack> {
  ensureProposalSchema();
  const db = getDb();
  const type: ContentType = contentType || 'podcast';

  const titlePatterns = getProvenTitlePatterns(contentType);
  const winningTags = getWinningThumbnailTags();
  const thumbAttributes = getTopThumbnailAttributes();

  const systemPrompt = `${buildIdentityPrompt()}\n\n${getChannelIntel()}`;

  const userPrompt = `Generate a packaging proposal for an upcoming YouTube video (podcast episode). You do NOT have the transcript — work from the video title and our channel data only.

VIDEO TITLE: "${videoTitle}"
Content type: ${type}

PROVEN TITLE PATTERNS from our A/B tests (use these to ground your 3 title candidates):
${titlePatterns}

WINNING THUMBNAIL TAGS:
${winningTags}

THUMBNAIL ATTRIBUTE DATA (by CTR):
${thumbAttributes}

Return ONLY valid JSON matching exactly this structure (no markdown, no code block):
{
  "episode_title": "short descriptive label for this episode",
  "titles": [
    {"title": "...", "pattern": "exact proven pattern name from list above", "rationale": "one sentence why"},
    {"title": "...", "pattern": "...", "rationale": "..."},
    {"title": "...", "pattern": "...", "rationale": "..."}
  ],
  "thumbnails": [
    {"concept": "precise visual description: who is in frame, expression, layout, text overlay wording", "rationale": "why this concept wins", "winning_tags": ["tag1", "tag2"]},
    {"concept": "...", "rationale": "...", "winning_tags": [...]}
  ],
  "test_plan": {
    "first": "title",
    "rationale": "one sentence",
    "chain": true
  }
}

Rules:
- All 3 titles must take genuinely different angles — different hook, not synonym swaps
- Each pattern must match one of the proven patterns listed (use exact name)
- The podcast is the product — frame titles around the audience finding the show, not the specific topic
- winning_tags must only reference tags from the winning thumbnail tags list
- test_plan.first = "title" when no title test has run (cheapest signal first)`;

  const client = new Anthropic({ apiKey: config.anthropicApiKey });
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const text = response.content.filter(b => b.type === 'text').map(b => (b as any).text).join('');
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON found in video proposal response');
  const raw = JSON.parse(jsonMatch[0]) as {
    episode_title: string;
    titles: Array<{ title: string; pattern: string; rationale: string }>;
    thumbnails: Array<{ concept: string; rationale: string; winning_tags: string[] }>;
    test_plan: { first: string; rationale: string; chain: boolean };
  };

  const titlesWithPreflight: ProposalTitle[] = (raw.titles || []).map(t => {
    try {
      const pf = preflightTitle(t.title, type);
      return {
        ...t,
        preflight: {
          score: pf.score,
          ctr_band: pf.ctr_band,
          confidence: pf.confidence,
          verdict: pf.verdict,
          signals: pf.signals.slice(0, 5).map(s => ({ tag: s.tag, verdict: s.verdict, uplift_pct: s.uplift_pct })),
          reasons: pf.reasons.slice(0, 3),
        },
      };
    } catch {
      return { ...t, preflight: { score: 50, ctr_band: 'around median', confidence: 'low', verdict: 'neutral', signals: [], reasons: [] } };
    }
  });

  const testPlan: ProposalTestPlan = {
    first: raw.test_plan?.first === 'thumbnail' ? 'thumbnail' : 'title',
    rationale: raw.test_plan?.rationale || '',
    chain: raw.test_plan?.chain !== false,
  };

  const episodeTitleFinal = raw.episode_title || videoTitle;

  const ins = db.prepare(`
    INSERT INTO episode_proposals (video_id, episode_title, content_type, titles_json, thumbnails_json, test_plan_json, source)
    VALUES (?, ?, ?, ?, ?, ?, 'video')
  `).run(videoId, episodeTitleFinal, type, JSON.stringify(titlesWithPreflight), JSON.stringify(raw.thumbnails || []), JSON.stringify(testPlan));

  return {
    id: Number(ins.lastInsertRowid),
    transcript_id: null,
    video_id: videoId,
    source: 'video',
    episode_title: episodeTitleFinal,
    content_type: type,
    titles: titlesWithPreflight,
    thumbnails: raw.thumbnails || [],
    test_plan: testPlan,
    status: 'pending',
    created_at: new Date().toISOString(),
  };
}

export function getProposals(status?: string): ProposalPack[] {
  ensureProposalSchema();
  const db = getDb();
  const rows = (status
    ? db.prepare(`SELECT * FROM episode_proposals WHERE status = ? ORDER BY created_at DESC LIMIT 50`).all(status)
    : db.prepare(`SELECT * FROM episode_proposals ORDER BY created_at DESC LIMIT 50`).all()) as any[];
  return rows.map(r => ({
    id: r.id,
    transcript_id: r.transcript_id ?? null,
    video_id: r.video_id ?? null,
    source: (r.source as 'transcript' | 'video') || 'transcript',
    episode_title: r.episode_title,
    content_type: r.content_type,
    titles: JSON.parse(r.titles_json || '[]'),
    thumbnails: JSON.parse(r.thumbnails_json || '[]'),
    test_plan: JSON.parse(r.test_plan_json || '{}'),
    status: r.status,
    created_at: r.created_at,
  }));
}

export function videoProposalExists(videoId: string): boolean {
  const db = getDb();
  try {
    const row = db.prepare(`SELECT 1 FROM episode_proposals WHERE video_id = ? AND status != 'dismissed' LIMIT 1`).get(videoId);
    return !!row;
  } catch { return false; }
}
