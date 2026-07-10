/**
 * Producer-specific tools, layered on top of the 19 stats tools in chat.ts.
 * These are the ones that make it "really good at knowing stats": vetting a
 * title against everything we have ever published or tested, recent performance,
 * and the confidence-scored learnings. Content type (podcast vs TNTL) is
 * respected throughout.
 */
import Anthropic from '@anthropic-ai/sdk';
import { getDb } from '../db/client.js';
import { TOOLS as STATS_TOOLS, executeTool as executeStatsTool } from '../routes/chat.js';
import { ruleTags } from './title-tagger.js';
import { computeTitleCorpus, computeTitleAbUplift } from './title-insights.js';
import { classifyContent } from './content-type.js';
import { computePortfolio, computeTestConfidence } from './learnings.js';
import { getProcessDoc, setProcessDoc, ensureProducerSchema } from './producer.js';
import { getPodcastStats } from './podcast-stats.js';

// Ad-safety phrases that flag a title (kept in sync with the process doc).
const AD_SAFETY_FLAGS = [
  'dirty talk', 'wristy', 'bedroom', 'sex', 'sexual', 'porn', 'nude', 'naked',
  'onlyfans', 'nsfw', 'orgasm', 'masturbat', 'horny', 'kink',
];

const STOPWORDS = new Set(['the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'is', 'i', 'my', 'me', 'we', 'you', 'with', 'that', 'this', 'it', 'at', 'as', 'by', 'be']);

function normalize(t: string): string {
  return (t || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}
function tokenSet(t: string): Set<string> {
  return new Set(normalize(t).split(' ').filter(w => w.length > 2 && !STOPWORDS.has(w)));
}
function similarity(aTokens: Set<string>, aNorm: string, b: string): number {
  const bNorm = normalize(b);
  const bTokens = tokenSet(b);
  if (aTokens.size === 0 || bTokens.size === 0) return 0;
  let inter = 0;
  for (const w of aTokens) if (bTokens.has(w)) inter++;
  const jaccard = inter / (aTokens.size + bTokens.size - inter);
  // Boost when one title's words are largely contained in the other.
  const contain = inter / Math.min(aTokens.size, bTokens.size);
  let score = 0.6 * jaccard + 0.4 * contain;
  if (aNorm && bNorm && (aNorm.includes(bNorm) || bNorm.includes(aNorm))) score = Math.max(score, 0.9);
  return score;
}

// Extra tool schemas exposed to the model.
export const PRODUCER_TOOLS: Anthropic.Tool[] = [
  {
    name: 'check_title',
    description: 'Vet a specific proposed title BEFORE recommending it. Returns: near-duplicate past titles (published or A/B tested) with how they performed, the title-pattern priors for that content type, and any ad-safety flags. Always call this on a title you are about to suggest or that the user pasted.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'The exact title to check' },
        content_type: { type: 'string', enum: ['podcast', 'TNTL'], description: 'podcast (default) or TNTL' },
      },
      required: ['title'],
    },
  },
  {
    name: 'get_episode_stats',
    description: "An episode's CURRENT reach from the podcast analytics platform: audio listens, unique listeners, Acast video views, YouTube views, and a performance index vs the channel norm (1.0 = average). Use this to see where an older episode is at right now, or to compare episodes.",
    input_schema: {
      type: 'object',
      properties: { title: { type: 'string', description: 'Episode / video title (partial match ok)' } },
      required: ['title'],
    },
  },
  {
    name: 'get_recent_performance',
    description: 'How the channel has done recently (default last 7 days): views, watch time, retention, subs, and the standout videos. Use for "how did last week go" and trend questions.',
    input_schema: {
      type: 'object',
      properties: { days: { type: 'number', description: 'Look-back window, default 7' } },
    },
  },
  {
    name: 'get_learnings',
    description: 'The confidence-scored test learnings: how many tests were real wins vs coin flips, average CTR lift, testing ROI, and which title patterns help or hurt — split by podcast vs TNTL. Use for "what works", "what should we lean into".',
    input_schema: {
      type: 'object',
      properties: { content_type: { type: 'string', enum: ['podcast', 'TNTL'] } },
    },
  },
  {
    name: 'lock_title',
    description: 'Record a title Charles has committed to. Call this whenever he LOCKS a slot ("lock it", "go with X") OR tells you the titles he ACTUALLY WENT WITH / published (e.g. "the titles I went with were ..."). Call it once per title. These become the strongest taste signal fed into every future chat, so always record his real picks. Include the day_slot and a one-line note on the shape (e.g. "plain declarative, no prefix").',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        day_slot: { type: 'string', description: 'Monday/Tuesday/etc if known' },
        rejected: { type: 'string', description: 'comma-separated titles that were considered and rejected' },
        note: { type: 'string', description: 'one line on why this was the pick' },
      },
      required: ['title'],
    },
  },
  {
    name: 'get_recent_decisions',
    description: 'The last locked-in title decisions, so you know what we have already committed to and do not repeat an angle we just used.',
    input_schema: { type: 'object', properties: { limit: { type: 'number' } } },
  },
  {
    name: 'remember_rule',
    description: 'Save a durable rule to the process doc when Charles states a lasting preference or correction (e.g. "we never do X", "always Y"). ONLY when he clearly means it as a standing rule, not one-off feedback.',
    input_schema: { type: 'object', properties: { rule: { type: 'string' } }, required: ['rule'] },
  },
  {
    name: 'flag_for_retest',
    description: 'Move a test into the Retests section (the redo queue on the site) so it is queued to be run again. Call this when a test result was inconclusive / a coin flip / had no clear winner, or when Charles asks to redo or retest one. Get the test id first from get_test_results. Pass to_retest=false to move it back into the normal Tests section.',
    input_schema: {
      type: 'object',
      properties: {
        test_id: { type: 'number', description: 'the id of the test to move (from get_test_results)' },
        to_retest: { type: 'boolean', description: 'true (default) = move to Retests; false = move back to Tests' },
        reason: { type: 'string', description: 'one short line on why it needs a redo' },
      },
      required: ['test_id'],
    },
  },
  {
    name: 'analyze_thumbnail_patterns',
    description: "What actually WINS on THUMBNAILS for this channel, from real A/B tests: the winning formula (best attribute per category) plus which thumbnail attributes win/lose head-to-head, split by content type. You MUST call this before giving any thumbnail advice. Ground every thumbnail recommendation in this data (e.g. 'white background + Toni only + a statement-quote tweet with a red highlight'), NEVER generic advice like 'Toni on the left holding a mic'.",
    input_schema: { type: 'object', properties: { content_type: { type: 'string', enum: ['podcast', 'TNTL'], description: 'which content type; omit for both' } } },
  },
  {
    name: 'analyze_title_test_patterns',
    description: 'What actually WINS on TITLES from real A/B head-to-head tests: which title attributes (curiosity gap, confession, question, negative framing, short vs long, etc.) beat the average CTR of their own test, controlling for the video. Ranked proven → promising → coinflip → weak. Call this before proposing titles — it is the strongest title signal we have.',
    input_schema: { type: 'object', properties: { content_type: { type: 'string', enum: ['podcast', 'TNTL'], description: 'which content type; omit for both' } } },
  },
  {
    name: 'save_test_learning',
    description: 'Record a learning conclusion for a completed test — thumbnail or title. Call this after reviewing a result: what did the test prove, lean toward, or leave inconclusive? One sentence is enough. The note is stored on the test permanently and shows up in future get_test_results calls so we build a searchable record of what we have learned from every test.',
    input_schema: {
      type: 'object',
      properties: {
        test_id: { type: 'number', description: 'The id of the completed test (from get_test_results)' },
        note: { type: 'string', description: 'One concise sentence: what the test proved, leaned toward, or left inconclusive.' },
      },
      required: ['test_id', 'note'],
    },
  },
  {
    name: 'get_recent_test_learnings',
    description: 'The per-test lessons from recent completed A/B tests (auto-written and any you saved): which variant won, by how much, the confidence, and the attributes the winner used. Call this to cite specific past results when workshopping ("last time we tested question vs declarative on a listener story, declarative won").',
    input_schema: { type: 'object', properties: { limit: { type: 'number' } } },
  },
];

export const ALL_TOOLS: Anthropic.Tool[] = [...PRODUCER_TOOLS, ...STATS_TOOLS];

async function checkTitle(title: string, contentType: 'podcast' | 'TNTL'): Promise<string> {
  const db = getDb();
  const aTokens = tokenSet(title);
  const aNorm = normalize(title);

  // Candidate pool: published videos + every A/B variant title ever tried.
  const published = db.prepare(`SELECT title, view_count, category FROM yt.videos WHERE title IS NOT NULL`).all() as any[];
  const variants = db.prepare(`
    SELECT tv.title, t.video_title, t.winner_variant_id, tv.id AS vid
    FROM test_variants tv JOIN tests t ON t.id = tv.test_id
    WHERE tv.title IS NOT NULL AND tv.title != ''
  `).all() as any[];

  const pubMatches = published
    .map(v => ({ title: v.title, score: similarity(aTokens, aNorm, v.title), views: v.view_count, ctype: classifyContent(v.title, v.category) }))
    .filter(m => m.score >= 0.45)
    .sort((a, b) => b.score - a.score).slice(0, 6);

  const varMatches = variants
    .map(v => ({ title: v.title, score: similarity(aTokens, aNorm, v.title), won: v.winner_variant_id === v.vid }))
    .filter(m => m.score >= 0.5)
    .sort((a, b) => b.score - a.score).slice(0, 5);

  // Also check against locked-in decisions.
  let lockedMatches: any[] = [];
  try {
    const locked = db.prepare(`SELECT title, day_slot FROM producer_locked_titles`).all() as any[];
    lockedMatches = locked
      .map(l => ({ title: l.title, day_slot: l.day_slot, score: similarity(aTokens, aNorm, l.title) }))
      .filter(m => m.score >= 0.5).sort((a, b) => b.score - a.score).slice(0, 3);
  } catch {}

  // Priors: which of this title's attributes help/hurt for the content type.
  const corpus = computeTitleCorpus()[contentType];
  const attrs = ruleTags(title);
  const priorLines = attrs
    .map(a => corpus?.tags.find(t => t.name === a))
    .filter(Boolean)
    .map((t: any) => `  ${t.name}: ${t.lift_vs_median >= 1 ? '+' : ''}${Math.round((t.lift_vs_median - 1) * 100)}% vs ${contentType} median (${t.videos} videos)`);

  // Ad safety.
  const low = title.toLowerCase();
  const flags = AD_SAFETY_FLAGS.filter(f => low.includes(f));
  const hasAmp = /&/.test(title);

  const out: string[] = [`CHECK: "${title}" (as ${contentType})`];
  out.push('');
  out.push('DUPLICATION vs published titles:');
  out.push(pubMatches.length
    ? pubMatches.map(m => `  ${(m.score * 100).toFixed(0)}% similar: "${m.title}" [${m.ctype}, ${m.views?.toLocaleString() || '?'} views]`).join('\n')
    : '  No close matches — this angle looks fresh.');
  out.push('');
  out.push('DUPLICATION vs past A/B variants (things we already tried):');
  out.push(varMatches.length
    ? varMatches.map(m => `  ${(m.score * 100).toFixed(0)}% similar: "${m.title}"${m.won ? ' (this one WON its test)' : ' (tested, did not win)'}`).join('\n')
    : '  None — not tested before.');
  if (lockedMatches.length) {
    out.push('');
    out.push('ALREADY LOCKED (we committed to these):');
    out.push(lockedMatches.map(m => `  ${(m.score * 100).toFixed(0)}% similar: "${m.title}"${m.day_slot ? ` (${m.day_slot})` : ''}`).join('\n'));
  }
  out.push('');
  out.push(`TITLE-PATTERN PRIORS (${contentType}):`);
  out.push(priorLines.length ? priorLines.join('\n') : '  No strong pattern signal for this title.');
  out.push('');
  out.push('AD SAFETY:');
  if (flags.length) out.push(`  ⚠ Flagged phrases: ${flags.join(', ')} — keep out of the title (thumbnail only at most).`);
  if (hasAmp) out.push('  ⚠ Contains "&" — must be the word "and".');
  if (!flags.length && !hasAmp) out.push('  Clear.');

  // Pre-flight score — A/B uplift + corpus + winner similarity combined.
  try {
    const { preflightTitle } = await import('./title-preflight.js');
    const pf = preflightTitle(title, contentType);
    out.push('');
    out.push(`PRE-FLIGHT SCORE: ${pf.score}/100 — ${pf.ctr_band.toUpperCase()} (confidence: ${pf.confidence})`);
    if (pf.signals.length) {
      out.push('  Signals:');
      for (const s of pf.signals.slice(0, 5)) {
        const dir = s.uplift_pct >= 0 ? '+' : '';
        out.push(`    ${s.tag}: ${s.verdict}${s.uplift_pct !== 0 ? ` (${dir}${s.uplift_pct}%)` : ''} [${s.source}]`);
      }
    } else {
      out.push('  No tag-level signal yet (run more title tests to build the data).');
    }
    if (pf.similar_winners.length) {
      out.push(`  Closest A/B winner: "${pf.similar_winners[0].title}" (${pf.similar_winners[0].ctr}% CTR, ${pf.similar_winners[0].similarity}% match)`);
    }
  } catch {}

  return out.join('\n');
}

function recentPerformance(days: number): string {
  const db = getDb();
  let rows: any[] = [];
  try {
    rows = db.prepare(`
      SELECT date, SUM(views) v, SUM(watch_time_hours) wt, AVG(avg_view_pct) ret, SUM(subscribers_gained) subs
      FROM yt.video_analytics WHERE date >= date('now', '-' || ? || ' days')
      GROUP BY date ORDER BY date DESC
    `).all(days) as any[];
  } catch {}
  if (!rows.length) return `No analytics for the last ${days} days.`;
  const totV = rows.reduce((s, r) => s + (r.v || 0), 0);
  const totWt = rows.reduce((s, r) => s + (r.wt || 0), 0);
  const totSubs = rows.reduce((s, r) => s + (r.subs || 0), 0);
  const avgRet = rows.reduce((s, r) => s + (r.ret || 0), 0) / rows.length;

  // Standout videos published in the window.
  let standouts: any[] = [];
  try {
    standouts = db.prepare(`
      SELECT title, view_count, category FROM yt.videos
      WHERE publish_date >= date('now', '-' || ? || ' days') ORDER BY view_count DESC LIMIT 6
    `).all(days) as any[];
  } catch {}

  return [
    `LAST ${days} DAYS:`,
    `  ${totV.toLocaleString()} views, ${Math.round(totWt).toLocaleString()}h watch time, ${avgRet.toFixed(1)}% avg retention, ${totSubs >= 0 ? '+' : ''}${totSubs.toLocaleString()} subs`,
    '',
    standouts.length ? 'Published in this window:' : '',
    ...standouts.map(s => `  ${classifyContent(s.title, s.category)}: "${s.title}" — ${s.view_count?.toLocaleString() || '?'} views`),
  ].filter(Boolean).join('\n');
}

function learningsSummary(contentType?: 'podcast' | 'TNTL'): string {
  const conf = computeTestConfidence(contentType);
  const p = computePortfolio(conf);
  const corpus = computeTitleCorpus();
  const abUplift = computeTitleAbUplift(2);
  const scope = contentType ? contentType : 'all content';
  const out = [
    `LEARNINGS (${scope}):`,
    `  ${p.total_tests} completed tests: ${p.confident} confident wins, ${p.lean} leaning, ${p.coinflip} coin flips.`,
    `  Average CTR lift when a win was real: ${p.avg_confident_lift}%. Testing has earned ~${p.extra_views_total.toLocaleString()} extra views.`,
  ];
  for (const ct of (contentType ? [contentType] : ['podcast', 'TNTL'] as const)) {
    const c = corpus[ct];
    if (!c) continue;
    const helps = c.tags.filter(t => t.videos >= 4 && t.lift_vs_median > 1).slice(0, 4);
    const hurts = c.tags.filter(t => t.videos >= 4 && t.lift_vs_median < 1).slice(-3);
    out.push('', `${ct} title patterns — published catalogue (vs ${c.median_views.toLocaleString()} median views):`);
    out.push('  Helps: ' + (helps.map(t => `${t.name} +${Math.round((t.lift_vs_median - 1) * 100)}%`).join(', ') || 'none clear'));
    out.push('  Hurts: ' + (hurts.map(t => `${t.name} ${Math.round((t.lift_vs_median - 1) * 100)}%`).join(', ') || 'none clear'));
    // A/B head-to-head signal: stronger than catalogue correlation.
    const ab = (abUplift[ct] || []).filter(t => t.tests >= 2);
    if (ab.length) {
      const wins = ab.filter(t => t.avg_uplift_pct > 0).slice(0, 4);
      const loses = ab.filter(t => t.avg_uplift_pct < 0).slice(0, 3);
      out.push(`${ct} title attributes — HEAD-TO-HEAD A/B tests (strongest signal):`);
      out.push('  Won: ' + (wins.map(t => `${t.name} ${t.avg_uplift_pct >= 0 ? '+' : ''}${t.avg_uplift_pct}% (${t.tests} tests, ${Math.round(t.win_rate * 100)}% win rate) [${t.verdict}]`).join(', ') || 'none yet'));
      out.push('  Lost: ' + (loses.map(t => `${t.name} ${t.avg_uplift_pct}% (${t.tests} tests) [${t.verdict}]`).join(', ') || 'none'));
    }
  }
  return out.join('\n');
}

/** Execute a tool: Producer tools handled here, everything else delegated to the stats tools. */
export async function executeProducerTool(name: string, input: any): Promise<string> {
  switch (name) {
    case 'check_title':
      return checkTitle(String(input.title || ''), input.content_type === 'TNTL' ? 'TNTL' : 'podcast');
    case 'get_episode_stats': {
      const db = getDb();
      const v = db.prepare(`SELECT video_id, title FROM yt.videos WHERE title LIKE ? ORDER BY view_count DESC LIMIT 1`).get(`%${input.title}%`) as any;
      if (!v) return `No episode found matching "${input.title}".`;
      const ps = getPodcastStats(v.video_id);
      if (!ps) return `"${v.title}" found, but no podcast analytics match yet (may not be synced).`;
      return `"${v.title}" — CURRENT reach:\n  ${ps.listens.toLocaleString()} audio listens, ${ps.unique_listeners.toLocaleString()} unique listeners\n  ${ps.video_views.toLocaleString()} Acast video views${ps.yt_views != null ? `, ${ps.yt_views.toLocaleString()} YouTube views` : ''}\n  Performance index: ${ps.perf_index != null ? ps.perf_index.toFixed(2) + ' vs channel norm (1.0 = average)' : 'n/a'}`;
    }
    case 'get_recent_performance':
      return recentPerformance(Math.max(1, Math.min(90, input.days || 7)));
    case 'get_learnings':
      return learningsSummary(input.content_type === 'podcast' || input.content_type === 'TNTL' ? input.content_type : undefined);
    case 'lock_title': {
      ensureProducerSchema();
      getDb().prepare(`INSERT INTO producer_locked_titles (title, day_slot, rejected, note) VALUES (?, ?, ?, ?)`)
        .run(String(input.title || '').trim(), input.day_slot || null, input.rejected || null, input.note || null);
      return `Locked: "${input.title}"${input.day_slot ? ` for ${input.day_slot}` : ''}. Recorded so we won't repeat it.`;
    }
    case 'get_recent_decisions': {
      ensureProducerSchema();
      const rows = getDb().prepare(`SELECT title, day_slot, note, created_at FROM producer_locked_titles ORDER BY id DESC LIMIT ?`).all(Math.min(30, input.limit || 15)) as any[];
      if (!rows.length) return 'No locked decisions recorded yet.';
      return 'RECENT LOCKED TITLES:\n' + rows.map(r => `  ${r.created_at?.slice(0, 10)} ${r.day_slot ? `[${r.day_slot}] ` : ''}"${r.title}"${r.note ? ` — ${r.note}` : ''}`).join('\n');
    }
    case 'remember_rule': {
      const rule = String(input.rule || '').trim();
      if (!rule) return 'No rule provided.';
      const doc = getProcessDoc();
      const marker = '## Learned Rules';
      const updated = doc.includes(marker)
        ? doc.replace(marker, `${marker}\n- ${rule}`)
        : `${doc}\n\n${marker}\n- ${rule}`;
      setProcessDoc(updated);
      return `Saved to the process doc under Learned Rules: "${rule}"`;
    }
    case 'flag_for_retest': {
      const testId = Number(input.test_id);
      if (!testId) return 'No test_id provided.';
      const db = getDb();
      const t = db.prepare('SELECT id, video_title FROM tests WHERE id = ?').get(testId) as any;
      if (!t) return `No test found with id ${testId}.`;
      const cat = input.to_retest === false ? 'test' : 'retest';
      db.prepare('UPDATE tests SET category = ? WHERE id = ?').run(cat, testId);
      return cat === 'retest'
        ? `Moved test ${testId} ("${t.video_title || 'untitled'}") into the Retests section${input.reason ? ` — ${input.reason}` : ''}. It's queued for a redo.`
        : `Moved test ${testId} back into the normal Tests section.`;
    }
    case 'analyze_title_test_patterns': {
      const types = input.content_type === 'TNTL' ? ['TNTL'] : input.content_type === 'podcast' ? ['podcast'] : ['podcast', 'TNTL'];
      const abUplift = computeTitleAbUplift(2);
      const out: string[] = [];
      for (const ct of types) {
        const tags = abUplift[ct as 'podcast' | 'TNTL'] || [];
        const named = ct === 'TNTL' ? 'TRY NOT TO LAUGH' : 'PODCAST';
        if (!tags.length) { out.push(`=== ${named} TITLE PATTERNS: no A/B data yet ===\n`); continue; }
        const wins = tags.filter(t => t.avg_uplift_pct > 0 || t.win_rate >= 0.5);
        const loses = tags.filter(t => t.avg_uplift_pct < 0 && t.win_rate < 0.5);
        out.push(`=== ${named} TITLE PATTERNS (head-to-head A/B tests) ===`);
        out.push('WON head-to-head:');
        for (const t of wins.slice(0, 8)) out.push(`  ${t.name} [${t.category}]: ${t.avg_uplift_pct >= 0 ? '+' : ''}${t.avg_uplift_pct}% CTR, won ${Math.round(t.win_rate * 100)}% of ${t.tests} tests [${t.verdict}]`);
        if (loses.length) {
          out.push('LOST head-to-head:');
          for (const t of loses.slice(0, 5)) out.push(`  ${t.name}: ${t.avg_uplift_pct}% CTR, won ${Math.round(t.win_rate * 100)}% of ${t.tests} tests [${t.verdict}]`);
        }
        out.push('');
      }
      return out.join('\n') || 'No title A/B data with enough tests yet (need at least 2 per attribute).';
    }
    case 'save_test_learning': {
      const testId = Number(input.test_id);
      const note = String(input.note || '').trim();
      if (!testId || !note) return 'test_id and note are both required.';
      const db = getDb();
      const t = db.prepare('SELECT id, video_title, status, test_type FROM tests WHERE id = ?').get(testId) as any;
      if (!t) return `No test found with id ${testId}.`;
      if (t.status !== 'completed') return `Test ${testId} is ${t.status}, not completed — save the learning after the test finishes.`;
      const { ensureLearningSchema } = await import('./test-learning.js');
      ensureLearningSchema();
      db.prepare('UPDATE tests SET learning_note = ? WHERE id = ?').run(note, testId);
      return `Learning saved for test ${testId} ("${t.video_title || 'untitled'}", ${t.test_type}): "${note}"`;
    }
    case 'get_recent_test_learnings': {
      const { recentTestLearnings } = await import('./test-learning.js');
      const notes = recentTestLearnings(input.limit || 25);
      return notes.length ? 'RECENT PER-TEST RESULTS (auto-written + saved):\n' + notes.join('\n') : 'No per-test learnings recorded yet.';
    }
    case 'analyze_thumbnail_patterns': {
      const { computeTagUplift } = await import('./learnings.js');
      const types = input.content_type === 'TNTL' ? ['TNTL'] : input.content_type === 'podcast' ? ['podcast'] : ['podcast', 'TNTL'];
      const out: string[] = [];
      for (const ct of types) {
        const tags = computeTagUplift(2, ct as any).filter(t => t.tests >= 2);
        const named = ct === 'TNTL' ? 'TRY NOT TO LAUGH' : 'PODCAST';
        if (!tags.length) { out.push(`=== ${named} THUMBNAILS: no A/B data yet ===\n`); continue; }
        // Winning formula: the best-lift attribute in each category.
        const byCat = new Map<string, any>();
        for (const t of tags) { const c = t.category || 'other'; const cur = byCat.get(c); if (!cur || t.avg_uplift_pct > cur.avg_uplift_pct) byCat.set(c, t); }
        const ranked = [...tags].sort((a, b) => b.avg_uplift_pct - a.avg_uplift_pct);
        out.push(`=== ${named} THUMBNAILS (from real A/B tests) ===`);
        out.push(`WINNING FORMULA — best attribute per category, build the thumbnail around these:`);
        for (const [cat, t] of byCat) out.push(`  ${cat}: ${t.name} (${t.avg_uplift_pct >= 0 ? '+' : ''}${t.avg_uplift_pct}% CTR, won ${Math.round(t.win_rate * 100)}% of ${t.tests})`);
        out.push(`WON head-to-head (lean into these):`);
        for (const t of ranked.filter(t => t.avg_uplift_pct > 0 || t.win_rate >= 0.5).slice(0, 8)) out.push(`  ${t.name} [${t.category}]: ${t.avg_uplift_pct >= 0 ? '+' : ''}${t.avg_uplift_pct}% CTR, won ${Math.round(t.win_rate * 100)}% of ${t.tests}`);
        const losers = ranked.filter(t => t.avg_uplift_pct < 0 && t.win_rate < 0.5);
        if (losers.length) { out.push(`LOST head-to-head (avoid unless the story demands it):`); for (const t of losers.slice(0, 5)) out.push(`  ${t.name}: ${t.avg_uplift_pct}% CTR, won ${Math.round(t.win_rate * 100)}% of ${t.tests}`); }
        out.push('');
      }
      return out.join('\n');
    }
    default:
      return executeStatsTool(name, input);
  }
}
