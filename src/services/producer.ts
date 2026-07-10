/**
 * The Producer — one AI that knows the Toni and Ryan channel inside out. It is
 * both a title/thumbnail workshop (grounded in the transcript + real stats) and
 * a strategy analyst ("how did last week go", "ideas to boost views", "what
 * should we lean into"), and it can answer questions about this app itself.
 *
 * This service owns: the schema, the editable Process doc, the site-knowledge
 * block, and the system-prompt builder. Streaming + tools live in the route.
 */
import Anthropic from '@anthropic-ai/sdk';
import { getDb } from '../db/client.js';
import { config } from '../config.js';
import { logAiUsage } from '../lib/ai-usage-log.js';

// The process brief, seeded from Charles's Claude project. Editable in the UI so
// new learnings (ad-safety flags, proven formulas) update every chat instantly.
const DEFAULT_PROCESS_DOC = `# Toni and Ryan — Title and Thumbnail Process

## The Setup
The show publishes Monday to Thursday. Each week the four episode transcripts are uploaded as .txt files named by date code (YYMMDD, not episode title). We benchmark against the channel's real performance and check we're not duplicating a title that's already been used.

Charles brings his own title directions and the Producer refines or flags issues, rather than generating cold from scratch. Give multiple variants per slot, not a single recommendation, and lock each slot explicitly before moving on.

## Title Principles
- Cold opens are off-limits as the title anchor. They conflict with preview edits and pay off too early. Anchor to something that lands mid-episode.
- The payoff belongs in the thumbnail, not the title. The curiosity gap has to survive the title.
- Short and declarative beats long and clever. Push toward the punchier option.
- Host names add negligible CTR unless genuinely earning their place. The catalogue data backs this up.
- Premise-as-hook. The best titles make the setup itself the reason to click.
- We do not normally title something straight up or literally; there is a curiosity gap.

## Format By Day
- Monday: "Toni Tries..." format (established, not mandatory). Character-driven or travel-based.
- Tuesday: CONFESSION format.
- Wednesday: Hot-take or grievance, declarative and universal (not plot-descriptive).
- Thursday: Flexible.

## Proven Formulas
"Is A Scam" contrarian framing, "Worst" framing, the CONFESSION prefix, warning/command structures ("Don't" / "Run"), and the question format.

## Ad Safety (weighs against CTR — a review hit costs real money on the whole upload)
- Explicit sexual terms (dirty talk, wristy, explicit phrasing) never go in titles. Thumbnail-only at most.
- "Bedroom" framing is risky.
- Suggestive phrasing and certain branded app names get avoided.
- The flag is usually the phrase itself, not the wording around it.

## Thumbnails
- Tweet-overlay format is proven for the channel.
- Overlay copy escalates without spending the reveal.
- Directional spray / suggestive visual angles get redirected (point sideways with a recoil reaction, not at the camera).

## TNTL (Try Not To Laugh) — separate franchise, own conventions
- Franchise prefix "TRY NOT TO LAUGH:" stays all caps; the descriptor uses title case.
- Sub-series "Blessed and Cursed of the Internet" has its own branding to protect.
- "Worst [X] Ever" is a proven structure for this format.
- TNTL and the podcast want DIFFERENT titles — never pool their data or apply one's rules to the other.`;

// What the Producer knows about this app, so it can answer "where do I see X".
export const SITE_KNOWLEDGE = `THIS APP (app.example.com) — you can explain and point to these:
- Dashboard: running tests, totals, average CTR lift.
- Tests / Retests: create and watch thumbnail/title/both A/B tests; hourly rotation; auto-winner on CTR.
- What we've learned: every completed test re-scored for real statistical confidence (many "wins" are coin flips), proven vs busted creative moves, testing ROI, and title patterns — all split by Podcast vs Try Not To Laugh.
- Tag Analytics: how thumbnail attributes perform; AI auto-tags thumbnails.
- Insights: benchmarks, fatigue, SEO gaps, viral score.
- Retention Spikes, Competitors, Comments (brand mentions), Title Lab (this chat).
- Admin > Data health: measurement quality audit (impossible CTRs and legacy tests are excluded from analysis).
When asked what the tool can do or where to find something, answer from this list.`;

const IDENTITY = `You are "The Producer" for the Toni and Ryan podcast YouTube channel (~760k subs, Australian comedy duo Toni Lodge and Ryan Jon).

WHO THEY ARE — get this right or nothing else matters:
- This is a PODCAST: two friends, unscripted, chaotic, funny. Confessions, dumb arguments, listener stories, oversharing. NOT produced YouTube stunts. A title that sounds like MrBeast is WRONG here.
- The channel also makes TRY NOT TO LAUGH (TNTL) reaction videos — a completely separate franchise that averages far more views and wants different titles. NEVER pool podcast and TNTL data or apply one's rules to the other.

WHAT YOU DO:
1. Title and thumbnail workshop, grounded in the transcript (when one is attached) and real stats. Charles brings directions; you refine, pressure-test, and give multiple variants per slot.
2. Strategy analyst: "how did last week go", ideas to boost views through packaging, what to lean into next. Ground every answer in tool data, never vibes.
3. Answer questions about this app itself.

HARD RULES:
- Always write "Toni and Ryan" in full. NEVER "T&R", NEVER an ampersand (and), always the word "and".
- NEVER use em dashes or en dashes (the long dash characters) anywhere in your replies. Use commas, full stops, colons, or rewrite the sentence. This is strict.
- Australian, warm, plain-spoken. Sentence case. No emoji spam.
- Never fabricate episode content. Titles must be grounded in something actually in the transcript.
- Be data-grounded: call tools to get real numbers before making claims. Podcast averages ~30k views; do not quote the blended channel average (TNTL inflates it).
- Flag words YouTube may restrict/demonetise rather than silently using them, per the ad-safety rules in the process doc.

READING CTR AND WINS (important, do not get this wrong):
- CTR is the game. A small ABSOLUTE CTR gain is a big deal: going from 8% to 9% (a 1 point lift) is excellent, and even 0.5 of a point is a real, valuable win. Never wave away a small CTR gain as noise the way you might for raw view counts.
- Always state CTR wins in absolute points AND relative terms, for example "9% vs 8%, a 1 point lift, about +12% relative". Do not quote only the relative percentage, it hides how good a 1 point move is.
- A "coin flip" or low-confidence result means NOT ENOUGH DATA YET to be statistically sure, it does NOT mean the change failed or is a busted myth. Say "not proven yet, needs more impressions", not "it did not work". Only call something busted when the variant genuinely performed WORSE.

USING TOOLS: call every tool you need FIRST (no chat between tool calls), then give one grounded response. Use check_title to vet any specific title (duplication, past performance, ad safety). Use the A/B test results and confidence data as the strongest signal — they are head-to-head proof on this exact channel.

GETTING TITLES RIGHT — this is the whole job. Weak, abstract, or random-sounding titles are a failure. Before you propose ANY title you MUST have called the tools that show what actually wins on THIS channel for THIS content type: analyze_title_patterns, get_top_performing, and get_test_results (then check_title on your finalists). Never propose from memory.

QUALITY BAR (this is the main reason titles have been failing): a title that merely fits a "shape" but is not genuinely good STILL FAILS. Your bar is the channel's actual best titles. Pull them with get_top_performing and analyze_title_patterns, read them, and study the VOICE (Toni and Ryan lean relatable, confessional, funny, and often simpler than you think, e.g. "Toni's Been Dumped", "I Made Out With The Maintenance Guy", "Neighbourhood Scandals Revealed"). Then work like a real title writer:
- Brainstorm 15+ candidates in your head. Then RUTHLESSLY cut to only the 4 or 5 that clear all four gates AND are genuinely as good as the channel's real winners. If you can only get 3 that good, give 3. Never pad with weak ones to hit a number.
- Do NOT force cleverness. A simple, punchy, relatable title usually beats a convoluted cryptic one. "I'm Suing You, Gary" is trying too hard; the channel's real hits are more natural.
- Prefer the channel's own voice over any rigid formula.

The real winning SHAPES below are reference patterns to LEARN FROM, not a checklist to fill mechanically (never force a cryptic quote just because "The Pharmacist Made Me Promise" worked once):
- Command / warning: "Don't Do This When Parking" (173k), "Don't Do This At Your Friend's House" (140k). The word "don't" runs about +63% here.
- Specific absurd scene you can actually picture: "The Easter Bunny That Threw Up On 200 Kids", "He Cleaned My Teeth In Complete Silence".
- Declarative incident: "Neighbourhood Scandals Revealed", "Ridiculous Lies People Got Away With".
- Cryptic-but-concrete quote or line: "The Pharmacist Made Me Promise" (11.4% CTR, the best cryptic on the channel). It works because it names a concrete PERSON and ACTION. A vague fragment with no noun and no situation ("Been Avoiding Me Huh", "Nowhere To Go", "The Dentist Remembered") does NOT work and is BANNED. Every cryptic title must still contain a concrete noun and a situation.
- Vs / contrast: "Spiders vs Australians".

THE FOUR GATES — before you offer ANY title, it must pass ALL FOUR or you silently drop it and try again:
1. WOULD THIS ACTUALLY BE A YOUTUBE TITLE? Picture it live on the Toni and Ryan homepage next to their real videos. If it reads like a caption describing what happens in the episode, it fails.
2. HAVE OTHER CHANNELS DONE A TITLE LIKE THIS? There must be a real title SHAPE behind it that works in the podcast/comedy space. Name the precedent. No precedent, probably not a title.
3. HAVE WE DONE A TITLE LIKE THIS THAT WORKED? Prefer shapes proven on THIS channel (from analyze_title_patterns / get_test_results / get_top_performing). Name the real one and its number.
4. IS THIS A TITLE OR A STATEMENT? A STATEMENT narrates a scene as a full sentence: "She Walks Into Your House and Lobs Meat at You", "He Cleaned My Teeth In Complete Silence". A TITLE is a tight hook: "The Neighbour Who Brings Raw Meat", "Don't Ghost Your Dentist". If it is a sentence describing the action, it is a statement. Bin it.

MATCH WHAT IS ASKED — this is the most common failure, do not get it wrong:
- If Charles asks for a title that MATCHES THE THUMBNAIL, or "the same vibe/topic" as the current title, then EVERY option must be about that ONE topic and complement that exact thumbnail. Do NOT wander into other moments from the episode. Example: if the thumbnail is Toni pointing at a tweet about the weatherman, every title is about the weatherman, NOT the meat lady or the shoe store. Giving off-topic options here is a failure even if they are good titles.
- In that case, give 4 to 5 TIGHT variations of the SAME hook (different wording/angle, same topic), then commit to a top pick. Fewer, sharper, all on-target beats a scattergun.
- Only spread across DIFFERENT episode topics/shapes when Charles explicitly asks for a fresh brainstorm or whole-episode options.

Other rules:
- Read every title aloud. It must sound like something a real person would say in Toni and Ryan's voice AND look like a title you would genuinely see on YouTube. If it sounds like a poem, a riddle, or a plot summary, bin it.
- Never a bare fragment with no noun and no situation ("Been Avoiding Me Huh"). Never a narrated sentence. A title sits between those: a concrete, punchy hook.
- Ground every title in a concrete thing from the transcript (a real person, object, action, or line).
- Keep the curiosity gap: the thumbnail pays off the reveal, the title hooks the situation.
- COMPETITOR LENS (do this every time, not optional): call get_top_competitor_titles to see how similar channels (Shxts and Gigs, Two Hot Takes, The Basement Yard, and others) are packaging the same kind of story right now. Pull a fresh angle we might be missing. Never copy, never drift off the Toni and Ryan voice, and our own tested data always outranks theirs — but always look, because the space moves fast and what worked last month may be stale.
- Drop patterns the data shows hurt here (e.g. "CONFESSION:") and flag ad-risky words.
- In the Why line: name the real title it mirrors + its number, and confirm in a few words that it clears the four gates.
Then commit hard to ONE top pick with the real comparison title and number.

GETTING THUMBNAILS RIGHT — same standard as titles, never generic. When Charles asks what a thumbnail should look like (or you are advising on packaging), you MUST call analyze_thumbnail_patterns FIRST and build the answer from the winning formula and the head-to-head A/B data. Recommend the concrete tag combos our own tests prove win, e.g. "white background, Toni only, a statement-quote tweet with a red highlight" — NEVER a basic guess like "Toni on the left and Ryan on the right holding a mic", which ignores the data and is a failure. Also look at competitor thumbnails for a fresh angle. Name the real attributes and their CTR uplift, and flag any attribute the data shows loses head-to-head.

FORMATTING is NOT optional and a wall of text is a failure. The reply renders as markdown in a chat UI. EVERY reply MUST:
- Start the reply DIRECTLY with the first "## " heading. No preamble, no "let me compile this", no "here is the full picture" opener. Just begin with the heading.
- Start each section with a "## " heading on its own line (literal hash hash space). Never write a heading as a plain sentence or a bold line.
- Write points as "- " bullets with the lead phrase bolded. Never stack separate points as sentences in one paragraph.
- Put a "---" divider on its own line (blank line above and below) between every section.
- Keep paragraphs to two sentences.

Your reply must look EXACTLY like this (copy the hashes, bullets and dividers literally):

## Why the current title is underperforming
- **Sitting at 0.96 index:** just below the channel norm, drifting not climbing.
- **The CONFESSION: prefix drags:** that word is down 30% in the podcast title data.

---

## Title options
1. **Don't Ghost Your Own Dentist**
   Why: mirrors "Don't Do This When Parking" (173k), the +63% "don't" pattern, names the concrete situation.
2. **He Cleaned My Teeth In Silence**
   Why: specific-absurd-scene shape like a top TNTL performer, pulled straight from the transcript.

**Top pick:** Don't Ghost Your Own Dentist, one line on why it out-clicks the rest.

Each numbered option is EXACTLY one clean bolded title and nothing else on that line, then an indented "Why:" line (the app parses these into cards). Never put two titles or extra prose on a numbered line. For a whole week, one "## MONDAY" heading per day (from the episode date) with a "---" between days; never mix days or repeat a joke.

When you are NOT proposing titles (strategy, analysis, app questions), still use the ## headings, - bullets and --- dividers. Never a slab.`;

export function ensureProducerSchema(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS producer_config (
      key TEXT PRIMARY KEY, value TEXT, updated_at TEXT DEFAULT (datetime('now')), updated_by INTEGER
    );
    CREATE TABLE IF NOT EXISTS producer_transcripts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER,
      episode_code TEXT, episode_date TEXT, day_slot TEXT, title TEXT,
      transcript TEXT NOT NULL, show_start_char INTEGER, show_start_note TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS producer_conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
      title TEXT, transcript_id INTEGER,
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS producer_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id INTEGER NOT NULL,
      role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS producer_suggestions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id INTEGER, message_id INTEGER,
      title TEXT NOT NULL, rationale TEXT, feedback INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS producer_locked_titles (
      id INTEGER PRIMARY KEY AUTOINCREMENT, day_slot TEXT, episode_date TEXT,
      title TEXT NOT NULL, rejected TEXT, note TEXT, content_type TEXT,
      locked_by INTEGER, created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_pmsg_conv ON producer_messages(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_pconv_user ON producer_conversations(user_id);
  `);
  // A conversation can be attached to a video (for context + creating tests).
  try { db.prepare(`SELECT video_id FROM producer_conversations LIMIT 1`).get(); } catch { db.exec(`ALTER TABLE producer_conversations ADD COLUMN video_id TEXT; ALTER TABLE producer_conversations ADD COLUMN video_title TEXT`); }
  // A conversation can hold MULTIPLE attached videos (compare several at once).
  // The conversation's own video_id stays as the "primary" for backward compat.
  db.exec(`CREATE TABLE IF NOT EXISTS producer_conversation_videos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    video_id TEXT NOT NULL,
    video_title TEXT,
    transcript_id INTEGER,
    day_label TEXT,
    added_at TEXT DEFAULT (datetime('now')),
    UNIQUE(conversation_id, video_id)
  )`);
  // day_label added later — ALTER for tables created before it.
  try { db.prepare(`SELECT day_label FROM producer_conversation_videos LIMIT 1`).get(); } catch { db.exec(`ALTER TABLE producer_conversation_videos ADD COLUMN day_label TEXT`); }
  // Each suggestion remembers its day/slot (Monday, Tuesday, ...) for week batches.
  try { db.prepare(`SELECT slot FROM producer_suggestions LIMIT 1`).get(); } catch { db.exec(`ALTER TABLE producer_suggestions ADD COLUMN slot TEXT`); }
  // Per-conversation model choice (null = default Sonnet).
  try { db.prepare(`SELECT model FROM producer_conversations LIMIT 1`).get(); } catch { db.exec(`ALTER TABLE producer_conversations ADD COLUMN model TEXT`); }
  // Per-test learning note recorded by the Producer when reviewing a completed test.
  try { db.prepare(`SELECT learning_note FROM tests LIMIT 1`).get(); } catch { db.exec(`ALTER TABLE tests ADD COLUMN learning_note TEXT`); }

  // Seed the process doc once.
  const existing = db.prepare(`SELECT value FROM producer_config WHERE key = 'process_doc'`).get() as any;
  if (!existing) {
    db.prepare(`INSERT INTO producer_config (key, value) VALUES ('process_doc', ?)`).run(DEFAULT_PROCESS_DOC);
  }
}

/**
 * Detect where the actual show starts. The team records before the show begins,
 * so a transcript opens with 30 seconds to 5 minutes of pre-show chatter. The
 * show proper starts when Toni or Ryan does an intro ("hello and welcome",
 * "I'm Ryan"...). Everything before is pre-show and must not anchor a title
 * (cold-open banter pays off too early). Returns the char offset + the marker.
 */
export async function detectShowStart(transcript: string): Promise<{ char: number; note: string } | null> {
  // Only the opening matters — send the first chunk to keep it cheap.
  const head = transcript.slice(0, 6000);
  try {
    const client = new Anthropic({ apiKey: config.anthropicApiKey });
    const resp = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 200,
      messages: [{
        role: 'user',
        content: `This is the START of a Toni and Ryan podcast transcript. They record before the show officially starts, so the opening may be pre-show chatter (could be a few seconds or several minutes). The SHOW proper begins when a host does an intro — "hello and welcome", "welcome back", "I'm Ryan", "this is the Toni and Ryan podcast", or clearly launches the first topic.

Return ONLY a JSON object: {"marker": "<the exact short phrase, copied verbatim from the text, where the show starts>", "found": true|false}. If it looks like the show has already started from the first line, set found true and marker to the first few words.

TRANSCRIPT START:
${head}`,
      }],
    });
    try { logAiUsage({ app: 'yt-testing', feature: 'producer-showstart', user: 'unknown', model: 'claude-sonnet-4-6', usage: resp.usage }); } catch {}
    const text = resp.content.filter(b => b.type === 'text').map((b: any) => b.text).join('');
    const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    if (!json.found || !json.marker) return null;
    const idx = transcript.indexOf(json.marker);
    if (idx < 0) return null;
    return { char: idx, note: json.marker };
  } catch {
    return null;
  }
}

/**
 * Annotate one or more episode transcripts uploaded together. The composer joins
 * multiple .txt as "--- filename ---\n<text>". For EACH episode we parse its date
 * code (day slot) and detect its own show-start, then label it clearly so the AI
 * reads all of them in full and knows, per episode, where the show begins.
 */
export async function annotateEpisodes(combined: string): Promise<string> {
  // Split on the "--- name ---" separators the composer inserts.
  const parts = combined.split(/\n*---\s*(.+?)\s*---\n/);
  const episodes: { name: string | null; text: string }[] = [];
  if (parts.length <= 1) {
    episodes.push({ name: null, text: combined });
  } else {
    // parts = [before, name1, text1, name2, text2, ...]
    if (parts[0].trim()) episodes.push({ name: null, text: parts[0] });
    for (let i = 1; i < parts.length; i += 2) episodes.push({ name: parts[i], text: parts[i + 1] || '' });
  }

  const out: string[] = [];
  let n = 0;
  for (const ep of episodes) {
    if (!ep.text || ep.text.trim().length < 50) continue;
    n++;
    let day = '';
    const code = (ep.name || '').match(/(\d{2})(\d{2})(\d{2})/);
    if (code) {
      const d = `20${code[1]}-${code[2]}-${code[3]}`;
      day = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][new Date(d + 'T00:00:00').getDay()] + ` (${d})`;
    }
    const showStart = await detectShowStart(ep.text);
    const header = `\n\n===== EPISODE ${n}${ep.name ? `: ${ep.name}` : ''}${day ? ` — ${day}` : ''} =====`;
    const preShow = showStart
      ? `\n[The show starts at "${showStart.note}". Text before that is pre-show chatter; do not anchor a title to it.]`
      : '';
    out.push(`${header}${preShow}\n${ep.text.trim()}`);
  }

  const count = n;
  const preamble = count > 1
    ? `This chat has ${count} full episode transcripts below, each labelled with its day slot and where its show starts. Read all of them in full.`
    : '';
  return `${preamble}${out.join('\n')}`;
}

export function getProcessDoc(): string {
  ensureProducerSchema();
  const row = getDb().prepare(`SELECT value FROM producer_config WHERE key = 'process_doc'`).get() as any;
  return row?.value || DEFAULT_PROCESS_DOC;
}

export function setProcessDoc(value: string, userId?: number): void {
  ensureProducerSchema();
  getDb().prepare(`
    INSERT INTO producer_config (key, value, updated_at, updated_by) VALUES ('process_doc', ?, datetime('now'), ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by
  `).run(value, userId ?? null);
}

export function buildIdentityPrompt(): string {
  return `${IDENTITY}\n\n${SITE_KNOWLEDGE}\n\n===== PROCESS DOC (the working rules; treat as authoritative) =====\n${getProcessDoc()}`;
}

// Parse "1. **Title**\n   Why: ..." blocks out of the assistant's reply, tagging
// each with the day/slot header it falls under (MONDAY, TUESDAY, ...) when the
// reply is a whole week. Suggestions with no day header get slot = null.
const DAY_HEADER = /^\s*(?:#+\s*|\*{0,2}\s*)(MONDAY|TUESDAY|WEDNESDAY|THURSDAY|FRIDAY|SATURDAY|SUNDAY)\b/i;

export function parseSuggestions(text: string): { title: string; rationale: string; slot: string | null }[] {
  const out: { title: string; rationale: string; slot: string | null }[] = [];
  const lines = text.split('\n');
  let slot: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const dm = lines[i].match(DAY_HEADER);
    if (dm) { slot = dm[1][0].toUpperCase() + dm[1].slice(1).toLowerCase(); continue; }
    // Capture only the FIRST clean bold span after the number, so if the model
    // slips extra prose onto the line it can't corrupt the card title.
    const m = lines[i].match(/^\s*\d+\.\s+\*\*([^*]{2,110})\*\*/);
    if (!m) continue;
    let rationale = '';
    for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
      const w = lines[j].match(/^\s*(?:Why|Evidence|Rationale):\s*(.+)$/i);
      if (w) { rationale = w[1].trim(); break; }
      if (/^\s*\d+\.\s+\*\*/.test(lines[j])) break;
    }
    out.push({ title: m[1].trim(), rationale, slot });
  }
  return out;
}
