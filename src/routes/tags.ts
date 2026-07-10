import { FastifyInstance } from 'fastify';
import { getDb } from '../db/client.js';
import { authMiddleware } from '../middleware/auth.js';
import { autoTagBatch } from '../services/auto-tagger.js';

// --- Content type split (Podcast vs TNTL) -----------------------------------
// PODCAST and TNTL (Try Not To Laugh / reaction) are two different formats with
// different packaging and must NEVER be pooled. The real signal lives in
// youtube.db (attached as `yt`): category 'reaction' = TNTL, 'podcast' = Podcast.
// tests.category is 'test'/'retest' and is NOT the content type — don't use it.
type ContentType = 'podcast' | 'TNTL';

// CASE that resolves the content type for a row where `tests` (aliased) is joined
// to `yt.videos yv`. Mirrors src/services/content-type.ts classifyContent().
function contentCase(testsAlias: string): string {
  return `CASE
    WHEN LOWER(COALESCE(yv.category,'')) = 'reaction' THEN 'TNTL'
    WHEN LOWER(COALESCE(yv.category,'')) = 'podcast' THEN 'podcast'
    WHEN LOWER(COALESCE(${testsAlias}.video_title,'')) LIKE '%try not to laugh%' THEN 'TNTL'
    ELSE 'podcast' END`;
}
const contentJoin = (testsAlias: string) => `LEFT JOIN yt.videos yv ON yv.video_id = ${testsAlias}.video_id`;

let _ytOk: boolean | null = null;
function ytAttached(db: any): boolean {
  if (_ytOk !== null) return _ytOk;
  try { db.prepare('SELECT 1 FROM yt.videos LIMIT 1').get(); _ytOk = true; }
  catch { _ytOk = false; }
  return _ytOk;
}

function parseContentType(v: unknown): ContentType | null {
  const s = String(v || '').toLowerCase();
  if (s === 'tntl' || s === 'reaction') return 'TNTL';
  if (s === 'podcast') return 'podcast';
  return null;
}

export async function tagRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware);

  // POST /tags/auto-tag — auto-tag thumbnail variants from the existing vocabulary
  // via Claude Vision. Defaults to untagged only. { limit?, all?, dryRun? }
  // { limit?, all?, dryRun?, retag? } — retag:true re-scans variants that already
  // have tags too, so a new vocabulary (e.g. the tweet/content tags) gets applied
  // to the whole back catalogue, not just untagged thumbnails.
  app.post('/tags/auto-tag', async (request) => {
    const body = (request.body || {}) as { limit?: number; all?: boolean; dryRun?: boolean; retag?: boolean; provider?: string };
    const results = await autoTagBatch({
      limit: body.all || body.retag ? undefined : (body.limit ?? 50),
      onlyUntagged: !body.retag,
      dryRun: !!body.dryRun,
      concurrency: body.provider === 'ollama' ? 2 : 5, // local model runs fewer in parallel
      provider: body.provider,
    });
    const tagged = results.filter(r => r.applied.length).length;
    const errors = results.filter(r => r.error).length;
    const tags = results.reduce((s, r) => s + r.applied.length, 0);
    return { processed: results.length, tagged, tags, errors, results };
  });

  // GET /tag-categories — list all categories
  app.get('/tag-categories', async () => {
    const db = getDb();
    return db.prepare('SELECT * FROM tag_categories ORDER BY sort_order').all();
  });

  // POST /tag-categories — create a new category
  app.post('/tag-categories', async (request) => {
    const { name, color } = request.body as { name: string; color?: string };
    if (!name?.trim()) return { detail: 'name required' };
    const db = getDb();
    const maxOrder = (db.prepare('SELECT MAX(sort_order) as m FROM tag_categories').get() as any)?.m || 0;
    db.prepare('INSERT OR IGNORE INTO tag_categories (name, color, sort_order) VALUES (?, ?, ?)').run(name.trim().toLowerCase(), color || '#6b7280', maxOrder + 1);
    return db.prepare('SELECT * FROM tag_categories WHERE name = ?').get(name.trim().toLowerCase());
  });

  // PATCH /tag-categories/:id — rename or recolor
  app.patch('/tag-categories/:id', async (request) => {
    const { id } = request.params as { id: string };
    const { name, color } = request.body as { name?: string; color?: string };
    const db = getDb();
    const old = db.prepare('SELECT name FROM tag_categories WHERE id = ?').get(parseInt(id)) as any;
    if (name && old) {
      db.prepare('UPDATE tag_categories SET name = ? WHERE id = ?').run(name.trim().toLowerCase(), parseInt(id));
      // Update all tags that referenced the old category name
      db.prepare('UPDATE thumbnail_tags SET category = ? WHERE category = ?').run(name.trim().toLowerCase(), old.name);
    }
    if (color) db.prepare('UPDATE tag_categories SET color = ? WHERE id = ?').run(color, parseInt(id));
    return { ok: true };
  });

  // DELETE /tag-categories/:id — delete category, move tags to 'other'
  app.delete('/tag-categories/:id', async (request) => {
    const { id } = request.params as { id: string };
    const db = getDb();
    const cat = db.prepare('SELECT name FROM tag_categories WHERE id = ?').get(parseInt(id)) as any;
    if (cat?.name === 'other') return { detail: 'Cannot delete the "other" category' };
    if (cat) db.prepare("UPDATE thumbnail_tags SET category = 'other' WHERE category = ?").run(cat.name);
    db.prepare('DELETE FROM tag_categories WHERE id = ?').run(parseInt(id));
    return { ok: true };
  });

  // GET /tags — list all tags with usage counts
  app.get('/tags', async (request) => {
    const db = getDb();
    const { search } = request.query as { search?: string };
    if (search) {
      return db.prepare(`
        SELECT t.*, COUNT(vt.id) as usage_count
        FROM thumbnail_tags t LEFT JOIN variant_tags vt ON vt.tag_id = t.id
        WHERE t.name LIKE ?
        GROUP BY t.id ORDER BY t.name
      `).all(`%${search}%`);
    }
    return db.prepare(`
      SELECT t.*, COUNT(vt.id) as usage_count
      FROM thumbnail_tags t LEFT JOIN variant_tags vt ON vt.tag_id = t.id
      GROUP BY t.id ORDER BY t.name
    `).all();
  });

  // POST /tags — create a new tag
  app.post('/tags', async (request) => {
    const { name, color, category } = request.body as { name: string; color?: string; category?: string };
    if (!name?.trim()) return { detail: 'name required' };
    const db = getDb();
    const trimmed = name.trim().toLowerCase();
    db.prepare('INSERT OR IGNORE INTO thumbnail_tags (name, color, category) VALUES (?, ?, ?)').run(trimmed, color || '#7c63ff', category || 'other');
    const tag = db.prepare('SELECT * FROM thumbnail_tags WHERE name = ?').get(trimmed);
    return tag;
  });

  // PATCH /tags/:id — update tag
  app.patch('/tags/:id', async (request) => {
    const { id } = request.params as { id: string };
    const { name, color } = request.body as { name?: string; color?: string };
    const db = getDb();
    const { category } = request.body as { name?: string; color?: string; category?: string };
    if (name) db.prepare('UPDATE thumbnail_tags SET name = ? WHERE id = ?').run(name.trim().toLowerCase(), parseInt(id));
    if (color) db.prepare('UPDATE thumbnail_tags SET color = ? WHERE id = ?').run(color, parseInt(id));
    if (category) db.prepare('UPDATE thumbnail_tags SET category = ? WHERE id = ?').run(category, parseInt(id));
    return { ok: true };
  });

  // DELETE /tags/:id — delete tag (cascades to variant_tags)
  app.delete('/tags/:id', async (request) => {
    const { id } = request.params as { id: string };
    const db = getDb();
    db.prepare('DELETE FROM thumbnail_tags WHERE id = ?').run(parseInt(id));
    return { ok: true };
  });

  // GET /tests/:testId/variants/:vid/tags — tags for a variant
  app.get('/tests/:testId/variants/:vid/tags', async (request) => {
    const { vid } = request.params as { testId: string; vid: string };
    const db = getDb();
    return db.prepare(`
      SELECT t.* FROM thumbnail_tags t
      JOIN variant_tags vt ON vt.tag_id = t.id
      WHERE vt.variant_id = ?
      ORDER BY t.name
    `).all(parseInt(vid));
  });

  // PUT /tests/:testId/variants/:vid/tags — replace all tags for a variant
  app.put('/tests/:testId/variants/:vid/tags', async (request) => {
    const { vid } = request.params as { testId: string; vid: string };
    const { tag_ids } = request.body as { tag_ids: number[] };
    const db = getDb();
    const variantId = parseInt(vid);
    const setTags = db.transaction(() => {
      db.prepare('DELETE FROM variant_tags WHERE variant_id = ?').run(variantId);
      const ins = db.prepare('INSERT OR IGNORE INTO variant_tags (variant_id, tag_id) VALUES (?, ?)');
      for (const tagId of (tag_ids || [])) ins.run(variantId, tagId);
    });
    setTags();
    return { ok: true };
  });

  // POST /tests/:testId/variants/:vid/tags — add a tag (by id or name)
  app.post('/tests/:testId/variants/:vid/tags', async (request) => {
    const { vid } = request.params as { testId: string; vid: string };
    const { tag_id, tag_name } = request.body as { tag_id?: number; tag_name?: string };
    const db = getDb();
    const variantId = parseInt(vid);
    let resolvedTagId = tag_id;
    if (!resolvedTagId && tag_name) {
      const trimmed = tag_name.trim().toLowerCase();
      db.prepare('INSERT OR IGNORE INTO thumbnail_tags (name) VALUES (?)').run(trimmed);
      const tag = db.prepare('SELECT id FROM thumbnail_tags WHERE name = ?').get(trimmed) as any;
      resolvedTagId = tag.id;
    }
    if (!resolvedTagId) return { detail: 'tag_id or tag_name required' };
    db.prepare('INSERT OR IGNORE INTO variant_tags (variant_id, tag_id) VALUES (?, ?)').run(variantId, resolvedTagId);
    const tag = db.prepare('SELECT * FROM thumbnail_tags WHERE id = ?').get(resolvedTagId);
    return { ok: true, tag };
  });

  // DELETE /tests/:testId/variants/:vid/tags/:tagId — remove a tag from a variant
  app.delete('/tests/:testId/variants/:vid/tags/:tagId', async (request) => {
    const { vid, tagId } = request.params as { testId: string; vid: string; tagId: string };
    const db = getDb();
    db.prepare('DELETE FROM variant_tags WHERE variant_id = ? AND tag_id = ?').run(parseInt(vid), parseInt(tagId));
    return { ok: true };
  });

  // GET /tags/analytics — aggregate performance by tag
  app.get('/tags/analytics', async (request) => {
    const { status, since, min_impressions, content_type } = request.query as {
      status?: string; since?: string; min_impressions?: string; content_type?: string;
    };
    const db = getDb();
    const minImp = parseInt(min_impressions || '100');
    const ct = ytAttached(db) ? parseContentType(content_type) : null;

    let where = "WHERE 1=1";
    const params: any[] = [];
    if (status) { where += " AND tests.status = ?"; params.push(status); }
    if (since) { where += " AND tm.measured_at >= ?"; params.push(since); }
    if (ct) { where += ` AND (${contentCase('tests')}) = ?`; params.push(ct); }

    const tags = db.prepare(`
      SELECT
        t.id, t.name, t.color, t.category,
        COUNT(DISTINCT tv.id) as variant_count,
        COUNT(DISTINCT tv.test_id) as test_count,
        COALESCE(SUM(tm.impressions), 0) as total_impressions,
        COALESCE(SUM(tm.views), 0) as total_views,
        CASE WHEN SUM(tm.impressions) > 0
          THEN ROUND(SUM(tm.impressions * tm.ctr) / SUM(tm.impressions), 2)
          ELSE 0 END as weighted_ctr,
        ROUND(COALESCE(SUM(tm.watch_time_hours), 0), 2) as total_watch_time_hours,
        -- AVD: use stored avg_view_duration from studio snapshots (more reliable than watch_time/views which can be cumulative)
        ROUND(COALESCE(AVG(CASE WHEN tm.avg_view_duration > 0 THEN tm.avg_view_duration END), 0), 1) as avg_view_duration,
        COALESCE(SUM(tm.likes), 0) as total_likes,
        COALESCE(SUM(tm.subs_gained), 0) as total_subs_gained,
        -- Count wins at test level, not measurement level
        COUNT(DISTINCT CASE WHEN tests.winner_variant_id = tv.id THEN tests.id END) as win_count
      FROM thumbnail_tags t
      JOIN variant_tags vt ON vt.tag_id = t.id
      JOIN test_variants tv ON tv.id = vt.variant_id
      JOIN tests ON tests.id = tv.test_id
      ${ytAttached(db) ? contentJoin('tests') : ''}
      LEFT JOIN test_measurements tm ON tm.variant_id = tv.id
        AND ((tm.realtime_views_json LIKE '%"type":"rotation_slot"%' OR tm.realtime_views_json LIKE '%"type":"reconstructed_vtr"%') AND NOT (tm.ctr > 25) AND tm.realtime_views_json NOT LIKE '%"suspect":true%')
      ${where}
      GROUP BY t.id
      HAVING total_impressions >= ?
      ORDER BY weighted_ctr DESC
    `).all(...params, minImp) as any[];

    // Compute win_rate and generate comparisons
    for (const tag of tags) {
      tag.win_rate = tag.test_count > 0 ? Math.round((tag.win_count / tag.test_count) * 100) : 0;
    }

    const comparisons: any[] = [];
    for (let i = 0; i < tags.length; i++) {
      for (let j = i + 1; j < tags.length; j++) {
        const a = tags[i], b = tags[j];
        // Only compare tags in the same category
        if (a.category !== b.category) continue;
        if (a.weighted_ctr > 0 && b.weighted_ctr > 0) {
          const diff = Math.round(((a.weighted_ctr - b.weighted_ctr) / b.weighted_ctr) * 100);
          if (Math.abs(diff) >= 10) {
            const better = diff > 0 ? a : b;
            const worse = diff > 0 ? b : a;
            comparisons.push({
              text: `"${better.name}" thumbnails average ${better.weighted_ctr}% CTR vs ${worse.weighted_ctr}% for "${worse.name}" (+${Math.abs(diff)}%)`,
              tag_a: better.name, tag_b: worse.name,
              metric: 'ctr', diff_pct: Math.abs(diff),
            });
          }
        }
      }
    }
    comparisons.sort((a, b) => b.diff_pct - a.diff_pct);

    // HEAD-TO-HEAD: when two tags IN THE SAME CATEGORY appear in the same test, which won?
    const h2hRows = db.prepare(`
      SELECT vt1.tag_id as tag_a, vt2.tag_id as tag_b, t.id as test_id, t.winner_variant_id,
        tv1.id as var_a, tv2.id as var_b, tt1.category
      FROM variant_tags vt1
      JOIN variant_tags vt2 ON vt1.variant_id != vt2.variant_id AND vt1.tag_id < vt2.tag_id
      JOIN thumbnail_tags tt1 ON tt1.id = vt1.tag_id
      JOIN thumbnail_tags tt2 ON tt2.id = vt2.tag_id AND tt1.category = tt2.category
      JOIN test_variants tv1 ON tv1.id = vt1.variant_id
      JOIN test_variants tv2 ON tv2.id = vt2.variant_id AND tv1.test_id = tv2.test_id
      JOIN tests t ON t.id = tv1.test_id AND t.winner_variant_id IS NOT NULL
      ${ct ? contentJoin('t') : ''}
      ${ct ? `WHERE (${contentCase('t')}) = ?` : ''}
      GROUP BY vt1.tag_id, vt2.tag_id, t.id
    `).all(...(ct ? [ct] : [])) as any[];

    const tagNameById: Record<number, { name: string; color: string }> = {};
    for (const t of tags) tagNameById[t.id] = { name: t.name, color: t.color };

    const h2hMap: Record<string, { a_wins: number; b_wins: number; draws: number; total: number }> = {};
    for (const r of h2hRows) {
      const key = `${r.tag_a}-${r.tag_b}`;
      if (!h2hMap[key]) h2hMap[key] = { a_wins: 0, b_wins: 0, draws: 0, total: 0 };
      h2hMap[key].total++;
      if (r.winner_variant_id === r.var_a) h2hMap[key].a_wins++;
      else if (r.winner_variant_id === r.var_b) h2hMap[key].b_wins++;
      else h2hMap[key].draws++;
    }

    const headToHead = Object.entries(h2hMap).filter(([, v]) => v.total >= 1).map(([key, v]) => {
      const [aId, bId] = key.split('-').map(Number);
      const a = tagNameById[aId], b = tagNameById[bId];
      if (!a || !b) return null;
      const winner = v.a_wins > v.b_wins ? a : v.b_wins > v.a_wins ? b : null;
      const loser = v.a_wins > v.b_wins ? b : v.b_wins > v.a_wins ? a : null;
      return {
        tag_a: a, tag_b: b,
        a_wins: v.a_wins, b_wins: v.b_wins, draws: v.draws, total: v.total,
        winner: winner?.name, loser: loser?.name,
        winner_color: winner?.color,
        text: winner && loser ? `"${winner.name}" beat "${loser.name}" ${Math.max(v.a_wins, v.b_wins)}/${v.total} times` : `"${a.name}" vs "${b.name}": tied ${v.draws}/${v.total}`,
      };
    }).filter(Boolean).sort((a: any, b: any) => b.total - a.total);

    // CONTENT BREAKDOWN: performance per tag split by content type (Podcast vs TNTL).
    // Uses the REAL content type from youtube.db, never tests.category (which is test/retest).
    const catRows = ytAttached(db) ? db.prepare(`
      SELECT t.id as tag_id, (${contentCase('tests')}) as content_type,
        COUNT(DISTINCT tv.id) as variant_count,
        COALESCE(SUM(tm.impressions), 0) as imp,
        CASE WHEN SUM(tm.impressions) > 0 THEN ROUND(SUM(tm.impressions * tm.ctr) / SUM(tm.impressions), 2) ELSE 0 END as ctr,
        ROUND(COALESCE(AVG(CASE WHEN tm.avg_view_duration > 0 THEN tm.avg_view_duration END), 0), 1) as avd,
        COUNT(DISTINCT CASE WHEN tests.winner_variant_id = tv.id THEN tests.id END) as wins,
        COUNT(DISTINCT tv.test_id) as tests_count
      FROM thumbnail_tags t
      JOIN variant_tags vt ON vt.tag_id = t.id
      JOIN test_variants tv ON tv.id = vt.variant_id
      JOIN tests ON tests.id = tv.test_id
      ${contentJoin('tests')}
      LEFT JOIN test_measurements tm ON tm.variant_id = tv.id
        AND ((tm.realtime_views_json LIKE '%"type":"rotation_slot"%' OR tm.realtime_views_json LIKE '%"type":"reconstructed_vtr"%') AND NOT (tm.ctr > 25) AND tm.realtime_views_json NOT LIKE '%"suspect":true%')
      GROUP BY t.id, content_type
      HAVING imp > 0
    `).all() as any[] : [];

    const byCategory: Record<string, any[]> = {};
    for (const r of catRows) {
      const cat = r.content_type || 'podcast';
      if (!byCategory[cat]) byCategory[cat] = [];
      const tagInfo = tagNameById[r.tag_id];
      if (tagInfo) {
        byCategory[cat].push({
          ...tagInfo, tag_id: r.tag_id,
          variant_count: r.variant_count, impressions: r.imp, ctr: r.ctr, avd: r.avd,
          wins: r.wins, tests: r.tests_count,
          win_rate: r.tests_count > 0 ? Math.round(r.wins / r.tests_count * 100) : 0,
        });
      }
    }
    for (const cat of Object.keys(byCategory)) {
      byCategory[cat].sort((a: any, b: any) => b.ctr - a.ctr);
    }

    // CONFIDENCE: add confidence level to each tag
    for (const tag of tags) {
      const imp = tag.total_impressions;
      const variants = tag.variant_count;
      if (imp >= 50000 && variants >= 6) tag.confidence = 'high';
      else if (imp >= 10000 && variants >= 3) tag.confidence = 'medium';
      else tag.confidence = 'low';
      tag.confidence_reason = imp < 10000 ? `Need ${Math.ceil((10000 - imp) / 1000)}K more impressions` : variants < 3 ? `Need ${3 - variants} more variants` : 'Enough data';
    }

    return { tags, comparisons: comparisons.slice(0, 10), headToHead, byCategory };
  });

  // GET /tags/analytics/playbook — winning formula + category leaderboards
  // Split by content type: pass ?content_type=podcast|TNTL so the formula is never
  // pooled across the two formats. Defaults to podcast when omitted.
  app.get('/tags/analytics/playbook', async (request) => {
    const db = getDb();
    const ctParam = (request.query as { content_type?: string }).content_type;
    const ct: ContentType = (ytAttached(db) ? parseContentType(ctParam) : null) || 'podcast';
    const ctFilter = ytAttached(db) ? `AND (${contentCase('tests')}) = '${ct}'` : '';
    const ctJoinTests = ytAttached(db) ? contentJoin('tests') : '';

    // Get all categories
    const categories = db.prepare('SELECT * FROM tag_categories ORDER BY sort_order').all() as any[];

    // Core tag aggregation (reuses same SQL pattern as /tags/analytics)
    const tagRows = db.prepare(`
      SELECT
        t.id, t.name, t.color, t.category,
        COUNT(DISTINCT tv.id) as variant_count,
        COUNT(DISTINCT tv.test_id) as test_count,
        COALESCE(SUM(tm.impressions), 0) as total_impressions,
        COALESCE(SUM(tm.views), 0) as total_views,
        CASE WHEN SUM(tm.impressions) > 0
          THEN ROUND(SUM(tm.impressions * tm.ctr) / SUM(tm.impressions), 2)
          ELSE 0 END as weighted_ctr,
        ROUND(COALESCE(AVG(CASE WHEN tm.avg_view_duration > 0 THEN tm.avg_view_duration END), 0), 1) as avg_view_duration,
        COUNT(DISTINCT CASE WHEN tests.winner_variant_id = tv.id THEN tests.id END) as win_count
      FROM thumbnail_tags t
      JOIN variant_tags vt ON vt.tag_id = t.id
      JOIN test_variants tv ON tv.id = vt.variant_id
      JOIN tests ON tests.id = tv.test_id
      ${ctJoinTests}
      LEFT JOIN test_measurements tm ON tm.variant_id = tv.id
        AND ((tm.realtime_views_json LIKE '%"type":"rotation_slot"%' OR tm.realtime_views_json LIKE '%"type":"reconstructed_vtr"%') AND NOT (tm.ctr > 25) AND tm.realtime_views_json NOT LIKE '%"suspect":true%')
      WHERE 1=1 ${ctFilter}
      GROUP BY t.id
      HAVING total_impressions >= 1000
      ORDER BY weighted_ctr DESC
    `).all() as any[];

    for (const t of tagRows) {
      t.win_rate = t.test_count > 0 ? Math.round((t.win_count / t.test_count) * 100) : 0;
      if (t.total_impressions >= 50000 && t.variant_count >= 6) t.confidence = 'high';
      else if (t.total_impressions >= 10000 && t.variant_count >= 3) t.confidence = 'medium';
      else t.confidence = 'low';
    }

    // Build per-category leaderboards and pick winner per category
    const leaderboards: Record<string, any[]> = {};
    const recipeTags: any[] = [];

    for (const cat of categories) {
      const catTags = tagRows.filter(t => t.category === cat.name);
      if (catTags.length === 0) continue;
      leaderboards[cat.name] = catTags.map((t, i) => ({
        ...t, rank: i + 1,
        bar_pct: catTags[0].weighted_ctr > 0 ? Math.round((t.weighted_ctr / catTags[0].weighted_ctr) * 100) : 0,
      }));
      // Winner = highest CTR with at least medium confidence (or fallback to best available)
      const winner = catTags.find(t => t.confidence !== 'low') || catTags[0];
      if (winner) recipeTags.push({ ...winner, category_name: cat.name, category_color: cat.color });
    }

    // Channel avg CTR from rotation_slot measurements, for THIS content type only.
    const avgRow = db.prepare(`
      SELECT CASE WHEN SUM(tm.impressions) > 0
        THEN ROUND(SUM(tm.impressions * tm.ctr) / SUM(tm.impressions), 2) ELSE 0 END as avg_ctr
      FROM test_measurements tm
      JOIN test_variants tv ON tv.id = tm.variant_id
      JOIN tests ON tests.id = tv.test_id
      ${ctJoinTests}
      WHERE (tm.realtime_views_json LIKE '%"type":"rotation_slot"%' OR tm.realtime_views_json LIKE '%"type":"reconstructed_vtr"%') AND NOT (tm.ctr > 25) AND tm.realtime_views_json NOT LIKE '%"suspect":true%'
        ${ctFilter}
    `).get() as any;
    const channelAvgCtr = avgRow?.avg_ctr || 0;

    // Composite CTR: find variants that have ALL recipe tag IDs, compute their weighted CTR
    let compositeCtr = 0;
    if (recipeTags.length >= 2) {
      const recipeIds = recipeTags.map(t => t.id);
      const matchingVariants = db.prepare(`
        SELECT vt.variant_id FROM variant_tags vt
        JOIN test_variants tv ON tv.id = vt.variant_id
        JOIN tests ON tests.id = tv.test_id
        ${ctJoinTests}
        WHERE vt.tag_id IN (${recipeIds.map(() => '?').join(',')}) ${ctFilter}
        GROUP BY vt.variant_id
        HAVING COUNT(DISTINCT vt.tag_id) = ?
      `).all(...recipeIds, recipeIds.length) as any[];

      if (matchingVariants.length > 0) {
        const varIds = matchingVariants.map(v => v.variant_id);
        const compRow = db.prepare(`
          SELECT CASE WHEN SUM(impressions) > 0
            THEN ROUND(SUM(impressions * ctr) / SUM(impressions), 2) ELSE 0 END as ctr
          FROM test_measurements
          WHERE variant_id IN (${varIds.map(() => '?').join(',')})
            AND (realtime_views_json IS NULL OR realtime_views_json NOT LIKE '%"type":"activation_baseline"%')
        `).get(...varIds) as any;
        compositeCtr = compRow?.ctr || 0;
      }
    }

    // Top 3 insights (same logic as /tags/analytics comparisons)
    const insights: any[] = [];
    for (let i = 0; i < tagRows.length && insights.length < 3; i++) {
      for (let j = i + 1; j < tagRows.length && insights.length < 3; j++) {
        const a = tagRows[i], b = tagRows[j];
        if (a.category !== b.category || a.weighted_ctr <= 0 || b.weighted_ctr <= 0) continue;
        const diff = Math.round(((a.weighted_ctr - b.weighted_ctr) / b.weighted_ctr) * 100);
        if (Math.abs(diff) >= 10) {
          const better = diff > 0 ? a : b;
          const worse = diff > 0 ? b : a;
          insights.push({
            text: `"${better.name}" averages ${better.weighted_ctr}% CTR vs ${worse.weighted_ctr}% for "${worse.name}"`,
            diff_pct: Math.abs(diff), better: better.name, worse: worse.name,
          });
        }
      }
    }

    return {
      content_type: ct,
      recipe: {
        tags: recipeTags,
        composite_ctr: compositeCtr,
        channel_avg_ctr: channelAvgCtr,
        uplift_pct: channelAvgCtr > 0 ? Math.round(((compositeCtr - channelAvgCtr) / channelAvgCtr) * 100) : 0,
        variant_count: tagRows.reduce((s, t) => s + t.variant_count, 0),
      },
      leaderboards,
      categories: categories.map(c => ({ id: c.id, name: c.name, color: c.color })),
      top_insights: insights,
    };
  });

  // GET /tags/analytics/retests — before/after for videos tested multiple times
  app.get('/tags/analytics/retests', async () => {
    const db = getDb();

    // Find videos with multiple tests
    const multiTestVideos = db.prepare(`
      SELECT video_id, video_title, COUNT(*) as test_count
      FROM tests
      WHERE status IN ('completed', 'running')
      GROUP BY video_id
      HAVING COUNT(*) > 1
      ORDER BY MAX(started_at) DESC
    `).all() as any[];

    const retests: any[] = [];

    for (const video of multiTestVideos) {
      // Get all tests for this video with their variants and performance
      const tests = db.prepare(`
        SELECT t.id as test_id, t.started_at, t.completed_at, t.status, t.winner_variant_id,
          tv.id as variant_id, tv.label, tv.thumbnail_path, tv.is_control,
          COALESCE(SUM(tm.impressions), 0) as total_impressions,
          COALESCE(SUM(tm.views), 0) as total_views,
          CASE WHEN SUM(tm.impressions) > 0
            THEN ROUND(SUM(tm.impressions * tm.ctr) / SUM(tm.impressions), 2)
            ELSE 0 END as weighted_ctr,
          ROUND(COALESCE(AVG(CASE WHEN tm.avg_view_duration > 0 THEN tm.avg_view_duration END), 0), 1) as avg_view_duration
        FROM tests t
        JOIN test_variants tv ON tv.test_id = t.id
        LEFT JOIN test_measurements tm ON tm.variant_id = tv.id
          AND ((tm.realtime_views_json LIKE '%"type":"rotation_slot"%' OR tm.realtime_views_json LIKE '%"type":"reconstructed_vtr"%') AND NOT (tm.ctr > 25) AND tm.realtime_views_json NOT LIKE '%"suspect":true%')
        WHERE t.video_id = ? AND t.status IN ('completed', 'running')
        GROUP BY tv.id
        ORDER BY t.started_at ASC, tv.label ASC
      `).all(video.video_id) as any[];

      // Get tags for each variant
      for (const t of tests) {
        const tags = db.prepare(`
          SELECT tt.id, tt.name, tt.color, tt.category
          FROM variant_tags vt JOIN thumbnail_tags tt ON tt.id = vt.tag_id
          WHERE vt.variant_id = ?
        `).all(t.variant_id) as any[];
        t.tags = tags;
        t.is_winner = t.winner_variant_id === t.variant_id;
      }

      // Group by test_id, pair oldest vs newest
      const testGroups: Record<number, any[]> = {};
      for (const t of tests) {
        if (!testGroups[t.test_id]) testGroups[t.test_id] = [];
        testGroups[t.test_id].push(t);
      }

      const testIds = Object.keys(testGroups).map(Number).sort((a, b) => a - b);
      if (testIds.length < 2) continue;

      // Compare first test's winner (or control) with latest test's winner (or best)
      for (let i = 0; i < testIds.length - 1; i++) {
        const beforeVariants = testGroups[testIds[i]];
        const afterVariants = testGroups[testIds[i + 1]];
        const before = beforeVariants.find((v: any) => v.is_winner) || beforeVariants.find((v: any) => v.is_control) || beforeVariants[0];
        const after = afterVariants.find((v: any) => v.is_winner) || afterVariants.reduce((best: any, v: any) => v.weighted_ctr > (best?.weighted_ctr || 0) ? v : best, null) || afterVariants[0];

        if (!before || !after) continue;

        const beforeTagNames = new Set(before.tags.map((t: any) => t.name));
        const afterTagNames = new Set(after.tags.map((t: any) => t.name));
        const tagsAdded = after.tags.filter((t: any) => !beforeTagNames.has(t.name));
        const tagsRemoved = before.tags.filter((t: any) => !afterTagNames.has(t.name));

        retests.push({
          video_id: video.video_id,
          video_title: video.video_title,
          before: {
            test_id: before.test_id, ctr: before.weighted_ctr,
            tags: before.tags, thumbnail_path: before.thumbnail_path,
            is_winner: before.is_winner, impressions: before.total_impressions,
          },
          after: {
            test_id: after.test_id, ctr: after.weighted_ctr,
            tags: after.tags, thumbnail_path: after.thumbnail_path,
            is_winner: after.is_winner, impressions: after.total_impressions,
          },
          ctr_delta: after.weighted_ctr - before.weighted_ctr,
          ctr_delta_pct: before.weighted_ctr > 0 ? Math.round(((after.weighted_ctr - before.weighted_ctr) / before.weighted_ctr) * 100) : 0,
          tags_added: tagsAdded,
          tags_removed: tagsRemoved,
        });
      }
    }

    retests.sort((a, b) => Math.abs(b.ctr_delta) - Math.abs(a.ctr_delta));
    return { retests };
  });

  // GET /tags/analytics/retest-candidates — videos worth retesting
  app.get('/tags/analytics/retest-candidates', async () => {
    const db = getDb();

    // Channel avg CTR
    const avgRow = db.prepare(`
      SELECT CASE WHEN SUM(impressions) > 0
        THEN ROUND(SUM(impressions * ctr) / SUM(impressions), 2) ELSE 0 END as avg_ctr
      FROM test_measurements
      WHERE (realtime_views_json LIKE '%"type":"rotation_slot"%' OR realtime_views_json LIKE '%"type":"reconstructed_vtr"%') AND NOT (ctr > 25) AND realtime_views_json NOT LIKE '%"suspect":true%'
    `).get() as any;
    const channelAvgCtr = avgRow?.avg_ctr || 0;

    // Get latest studio snapshot per video with CTR and impressions
    const candidates = db.prepare(`
      SELECT
        ss.video_id,
        cv.title,
        cv.published_at,
        cv.thumbnail_url,
        ss.ctr as current_ctr,
        ss.impressions,
        ss.views,
        ss.avg_view_duration_sec,
        ss.scraped_at
      FROM studio_snapshots ss
      JOIN channel_videos cv ON cv.video_id = ss.video_id
      WHERE ss.id = (SELECT id FROM studio_snapshots WHERE video_id = ss.video_id AND impressions > 0 ORDER BY scraped_at DESC LIMIT 1)
        AND cv.published_at < datetime('now', '-7 days')
        AND ss.ctr > 0 AND ss.ctr < ?
        AND ss.impressions > 50000
      ORDER BY ss.impressions DESC
      LIMIT 20
    `).all(channelAvgCtr) as any[];

    // Get the winning recipe tags for suggestion
    const recipeTags = db.prepare(`
      WITH tag_perf AS (
        SELECT t.id, t.name, t.color, t.category,
          CASE WHEN SUM(tm.impressions) > 0
            THEN ROUND(SUM(tm.impressions * tm.ctr) / SUM(tm.impressions), 2)
            ELSE 0 END as weighted_ctr,
          ROW_NUMBER() OVER (PARTITION BY t.category ORDER BY
            CASE WHEN SUM(tm.impressions) > 0 THEN SUM(tm.impressions * tm.ctr) / SUM(tm.impressions) ELSE 0 END DESC
          ) as rn
        FROM thumbnail_tags t
        JOIN variant_tags vt ON vt.tag_id = t.id
        JOIN test_variants tv ON tv.id = vt.variant_id
        LEFT JOIN test_measurements tm ON tm.variant_id = tv.id
          AND ((tm.realtime_views_json LIKE '%"type":"rotation_slot"%' OR tm.realtime_views_json LIKE '%"type":"reconstructed_vtr"%') AND NOT (tm.ctr > 25) AND tm.realtime_views_json NOT LIKE '%"suspect":true%')
        GROUP BY t.id
        HAVING SUM(tm.impressions) >= 5000
      )
      SELECT id, name, color, category FROM tag_perf WHERE rn = 1
    `).all() as any[];

    // Check which candidates already have tests
    for (const c of candidates) {
      const existingTest = db.prepare(`
        SELECT id, status FROM tests WHERE video_id = ? ORDER BY id DESC LIMIT 1
      `).get(c.video_id) as any;
      c.has_test = !!existingTest;
      c.test_status = existingTest?.status || null;
      c.test_id = existingTest?.id || null;
      c.ctr_gap = Math.round(((channelAvgCtr - c.current_ctr) / channelAvgCtr) * 100);
    }

    return {
      candidates: candidates.filter((c: any) => !c.has_test || c.test_status === 'completed'),
      suggested_tags: recipeTags,
      channel_avg_ctr: channelAvgCtr,
    };
  });

  // GET /tags/analytics/:tagId — detailed breakdown for a single tag
  app.get('/tags/analytics/:tagId', async (request) => {
    const { tagId } = request.params as { tagId: string };
    const ctParam = (request.query as { content_type?: string }).content_type;
    const db = getDb();
    const ct = ytAttached(db) ? parseContentType(ctParam) : null;
    const ctFilter = ct ? `AND (${contentCase('t')}) = '${ct}'` : '';
    const tag = db.prepare('SELECT * FROM thumbnail_tags WHERE id = ?').get(parseInt(tagId));
    if (!tag) return { detail: 'Tag not found' };

    const variants = db.prepare(`
      SELECT tv.id, tv.label, tv.thumbnail_path, tv.test_id,
        t.video_id, t.video_title, t.status as test_status,
        t.winner_variant_id,
        COALESCE(SUM(tm.impressions), 0) as total_impressions,
        COALESCE(SUM(tm.views), 0) as total_views,
        CASE WHEN SUM(tm.impressions) > 0
          THEN ROUND(SUM(tm.impressions * tm.ctr) / SUM(tm.impressions), 2)
          ELSE 0 END as weighted_ctr,
        ROUND(COALESCE(SUM(tm.watch_time_hours), 0), 2) as total_watch_time,
        ROUND(COALESCE(AVG(CASE WHEN tm.avg_view_duration > 0 THEN tm.avg_view_duration END), 0), 1) as avg_view_duration
      FROM test_variants tv
      JOIN variant_tags vt ON vt.variant_id = tv.id AND vt.tag_id = ?
      JOIN tests t ON t.id = tv.test_id
      ${ct ? contentJoin('t') : ''}
      LEFT JOIN test_measurements tm ON tm.variant_id = tv.id
        AND ((tm.realtime_views_json LIKE '%"type":"rotation_slot"%' OR tm.realtime_views_json LIKE '%"type":"reconstructed_vtr"%') AND NOT (tm.ctr > 25) AND tm.realtime_views_json NOT LIKE '%"suspect":true%')
      WHERE 1=1 ${ctFilter}
      GROUP BY tv.id
      ORDER BY t.completed_at DESC, t.started_at DESC
    `).all(parseInt(tagId));

    return { tag, variants };
  });

  // GET /tags/analytics/combos — auto-discover best/worst tag combinations
  app.get('/tags/analytics/combos', async (request) => {
    const { max_tags, content_type } = request.query as { max_tags?: string; content_type?: string };
    const maxComboSize = Math.min(parseInt(max_tags || '3'), 4);
    const db = getDb();
    const ct = ytAttached(db) ? parseContentType(content_type) : null;
    const ctFilterT = ct ? `AND (${contentCase('t')}) = '${ct}'` : '';

    // Get all variants with their tags and performance
    const rows = db.prepare(`
      SELECT tv.id as variant_id, tv.test_id, t.video_id, t.winner_variant_id,
        COALESCE(SUM(tm.impressions), 0) as imp,
        COALESCE(SUM(tm.views), 0) as views,
        CASE WHEN SUM(tm.impressions) > 0 THEN SUM(tm.impressions * tm.ctr) / SUM(tm.impressions) ELSE 0 END as ctr,
        COALESCE(SUM(tm.watch_time_hours), 0) as wt,
        CASE WHEN SUM(tm.views) > 0 THEN SUM(tm.watch_time_hours) * 3600.0 / SUM(tm.views) ELSE 0 END as avd
      FROM test_variants tv
      JOIN tests t ON t.id = tv.test_id
      ${ct ? contentJoin('t') : ''}
      JOIN variant_tags vt ON vt.variant_id = tv.id
      LEFT JOIN test_measurements tm ON tm.variant_id = tv.id
        AND ((tm.realtime_views_json LIKE '%"type":"rotation_slot"%' OR tm.realtime_views_json LIKE '%"type":"reconstructed_vtr"%') AND NOT (tm.ctr > 25) AND tm.realtime_views_json NOT LIKE '%"suspect":true%')
      WHERE 1=1 ${ctFilterT}
      GROUP BY tv.id
      HAVING imp > 0
    `).all() as any[];

    // Get tags per variant
    const tagRows = db.prepare(`
      SELECT vt.variant_id, tt.id as tag_id, tt.name, tt.color
      FROM variant_tags vt JOIN thumbnail_tags tt ON tt.id = vt.tag_id
    `).all() as any[];

    const variantTags: Record<number, { id: number; name: string; color: string }[]> = {};
    for (const r of tagRows) {
      if (!variantTags[r.variant_id]) variantTags[r.variant_id] = [];
      variantTags[r.variant_id].push({ id: r.tag_id, name: r.name, color: r.color });
    }

    // Global averages for scoring (within this content type when filtered)
    const global = db.prepare(`
      SELECT
        CASE WHEN SUM(tm.impressions) > 0 THEN SUM(tm.impressions * tm.ctr) / SUM(tm.impressions) ELSE 0 END as avg_ctr,
        CASE WHEN SUM(tm.views) > 0 THEN SUM(tm.watch_time_hours) * 3600.0 / SUM(tm.views) ELSE 0 END as avg_avd
      FROM test_measurements tm
      JOIN test_variants tv ON tv.id = tm.variant_id
      JOIN tests t ON t.id = tv.test_id
      ${ct ? contentJoin('t') : ''}
      WHERE tm.realtime_views_json LIKE '%rotation_slot%' AND tm.impressions > 0 ${ctFilterT}
    `).get() as any;
    const avgCtr = global.avg_ctr || 1;
    const avgAvd = global.avg_avd || 1;

    // Build variant data with tags
    const variants = rows.filter((r: any) => variantTags[r.variant_id]?.length > 0).map((r: any) => ({
      ...r,
      tags: variantTags[r.variant_id] || [],
      tagIds: (variantTags[r.variant_id] || []).map((t: any) => t.id).sort(),
      isWinner: r.winner_variant_id === r.variant_id,
    }));

    // Generate all tag combinations of size 1..maxComboSize
    const allTagIds = [...new Set(tagRows.map((r: any) => r.tag_id))];
    const tagNameMap: Record<number, { name: string; color: string }> = {};
    for (const r of tagRows) tagNameMap[r.tag_id] = { name: r.name, color: r.color };

    function generateCombos(ids: number[], size: number): number[][] {
      if (size === 0) return [[]];
      if (ids.length < size) return [];
      const result: number[][] = [];
      for (let i = 0; i <= ids.length - size; i++) {
        const rest = generateCombos(ids.slice(i + 1), size - 1);
        for (const r of rest) result.push([ids[i], ...r]);
      }
      return result;
    }

    const combos: any[] = [];
    for (let size = 2; size <= maxComboSize; size++) {
      for (const combo of generateCombos(allTagIds, size)) {
        const comboSet = new Set(combo);
        // Find variants that have ALL tags in this combo
        const matching = variants.filter((v: any) => combo.every((tagId: number) => v.tagIds.includes(tagId)));
        if (matching.length < 2) continue; // Need at least 2 data points

        const totalImp = matching.reduce((s: number, v: any) => s + v.imp, 0);
        const totalViews = matching.reduce((s: number, v: any) => s + v.views, 0);
        const totalWt = matching.reduce((s: number, v: any) => s + v.wt, 0);
        const weightedCtr = totalImp > 0 ? Math.round(matching.reduce((s: number, v: any) => s + v.imp * v.ctr, 0) / totalImp * 100) / 100 : 0;
        const avd = totalViews > 0 ? Math.round(totalWt * 3600 / totalViews * 10) / 10 : 0;
        const wins = matching.filter((v: any) => v.isWinner).length;
        const tests = new Set(matching.map((v: any) => v.test_id)).size;

        const ctrFactor = avgCtr > 0 ? weightedCtr / avgCtr : 1;
        const avdFactor = avd > 0 && avgAvd > 0 ? avd / avgAvd : 1;
        const score = Math.round(ctrFactor * avdFactor * 100);

        combos.push({
          tags: combo.map(id => tagNameMap[id]),
          tag_ids: combo,
          variant_count: matching.length,
          test_count: tests,
          total_impressions: totalImp,
          total_views: totalViews,
          weighted_ctr: weightedCtr,
          avg_view_duration: avd,
          total_watch_time: totalWt,
          win_count: wins,
          win_rate: tests > 0 ? Math.round(wins / tests * 100) : 0,
          composite_score: score,
          ctr_vs_avg: Math.round((ctrFactor - 1) * 100),
          avd_vs_avg: Math.round((avdFactor - 1) * 100),
        });
      }
    }

    // Sort by composite score
    combos.sort((a, b) => b.composite_score - a.composite_score);

    // Also include single-tag stats for context (already in main analytics)
    return {
      best: combos.slice(0, 15),
      worst: combos.filter(c => c.composite_score < 100).sort((a, b) => a.composite_score - b.composite_score).slice(0, 10),
      all: combos,
      global_avg: { ctr: Math.round(avgCtr * 100) / 100, avd: Math.round(avgAvd * 10) / 10 },
    };
  });

  // GET /tags/analytics/filter — filter variants by tag combination (include + exclude)
  // Returns per-variant stats, aggregate for matching set, and comparison vs non-matching
  app.get('/tags/analytics/filter', async (request) => {
    const { include, exclude, content_type } = request.query as { include?: string; exclude?: string; content_type?: string };
    const db = getDb();
    const ct = ytAttached(db) ? parseContentType(content_type) : null;

    const includeTags = (include || '').split(',').filter(Boolean).map(Number);
    const excludeTags = (exclude || '').split(',').filter(Boolean).map(Number);

    if (includeTags.length === 0 && excludeTags.length === 0) {
      return { detail: 'Provide include or exclude tag IDs' };
    }

    // Restrict to variants whose video is this content type, so podcast and TNTL never pool.
    const ctVariantSet = ct ? new Set(
      (db.prepare(`
        SELECT tv.id FROM test_variants tv JOIN tests t ON t.id = tv.test_id
        ${contentJoin('t')} WHERE (${contentCase('t')}) = ?
      `).all(ct) as any[]).map((r: any) => r.id)
    ) : null;

    // Find variants that have ALL include tags and NONE of the exclude tags
    // Step 1: variants with all include tags
    let matchingVariantIds: number[];
    if (includeTags.length > 0) {
      const rows = db.prepare(`
        SELECT variant_id FROM variant_tags WHERE tag_id IN (${includeTags.map(() => '?').join(',')})
        GROUP BY variant_id HAVING COUNT(DISTINCT tag_id) = ?
      `).all(...includeTags, includeTags.length) as any[];
      matchingVariantIds = rows.map((r: any) => r.variant_id);
    } else {
      // All variants with any tag
      matchingVariantIds = (db.prepare('SELECT DISTINCT variant_id FROM variant_tags').all() as any[]).map((r: any) => r.variant_id);
    }

    // Step 2: remove variants that have any exclude tag
    if (excludeTags.length > 0 && matchingVariantIds.length > 0) {
      const excluded = new Set(
        (db.prepare(`SELECT DISTINCT variant_id FROM variant_tags WHERE tag_id IN (${excludeTags.map(() => '?').join(',')})`)
          .all(...excludeTags) as any[]).map((r: any) => r.variant_id)
      );
      matchingVariantIds = matchingVariantIds.filter(id => !excluded.has(id));
    }

    // Keep only variants in the selected content type.
    if (ctVariantSet) matchingVariantIds = matchingVariantIds.filter(id => ctVariantSet.has(id));

    if (matchingVariantIds.length === 0) {
      return { matching: [], aggregate: null, comparison: null };
    }

    // Get all channel-wide averages for composite score baseline
    const globalAvg = db.prepare(`
      SELECT
        CASE WHEN SUM(impressions) > 0 THEN SUM(impressions * ctr) / SUM(impressions) ELSE 0 END as avg_ctr,
        CASE WHEN SUM(views) > 0 THEN SUM(watch_time_hours) * 3600.0 / SUM(views) ELSE 0 END as avg_avd
      FROM test_measurements
      WHERE realtime_views_json LIKE '%rotation_slot%' AND impressions > 0
    `).get() as any;

    // Get per-variant data for matching variants
    const placeholders = matchingVariantIds.map(() => '?').join(',');
    const variants = db.prepare(`
      SELECT tv.id, tv.label, tv.thumbnail_path, tv.test_id,
        t.video_id, t.video_title, t.status as test_status, t.winner_variant_id,
        COALESCE(SUM(tm.impressions), 0) as total_impressions,
        COALESCE(SUM(tm.views), 0) as total_views,
        CASE WHEN SUM(tm.impressions) > 0
          THEN ROUND(SUM(tm.impressions * tm.ctr) / SUM(tm.impressions), 2)
          ELSE 0 END as weighted_ctr,
        ROUND(COALESCE(SUM(tm.watch_time_hours), 0), 2) as total_watch_time,
        CASE WHEN SUM(tm.views) > 0
          THEN ROUND(SUM(tm.watch_time_hours) * 3600.0 / SUM(tm.views), 1)
          ELSE 0 END as avg_view_duration,
        COALESCE(SUM(tm.likes), 0) as total_likes,
        COALESCE(SUM(tm.subs_gained), 0) as total_subs
      FROM test_variants tv
      JOIN tests t ON t.id = tv.test_id
      LEFT JOIN test_measurements tm ON tm.variant_id = tv.id
        AND ((tm.realtime_views_json LIKE '%"type":"rotation_slot"%' OR tm.realtime_views_json LIKE '%"type":"reconstructed_vtr"%') AND NOT (tm.ctr > 25) AND tm.realtime_views_json NOT LIKE '%"suspect":true%')
      WHERE tv.id IN (${placeholders})
      GROUP BY tv.id
      ORDER BY weighted_ctr DESC
    `).all(...matchingVariantIds) as any[];

    // Attach tags to each variant
    const allVarTags = db.prepare(`
      SELECT vt.variant_id, t.id, t.name, t.color FROM variant_tags vt
      JOIN thumbnail_tags t ON t.id = vt.tag_id
      WHERE vt.variant_id IN (${placeholders})
    `).all(...matchingVariantIds) as any[];
    const tagMap: Record<number, any[]> = {};
    for (const r of allVarTags) {
      if (!tagMap[r.variant_id]) tagMap[r.variant_id] = [];
      tagMap[r.variant_id].push({ id: r.id, name: r.name, color: r.color });
    }

    // Compute composite score per variant: (CTR / avgCTR) * (AVD / avgAVD) * 100
    // If no AVD data, use CTR alone
    const avgCtr = globalAvg.avg_ctr || 1;
    const avgAvd = globalAvg.avg_avd || 1;

    for (const v of variants) {
      v.tags = tagMap[v.id] || [];
      v.is_winner = v.winner_variant_id === v.id;
      const ctrFactor = avgCtr > 0 ? v.weighted_ctr / avgCtr : 1;
      const avdFactor = v.avg_view_duration > 0 && avgAvd > 0 ? v.avg_view_duration / avgAvd : 1;
      v.composite_score = Math.round(ctrFactor * avdFactor * 100);
    }

    // Aggregate for all matching variants
    const totalImp = variants.reduce((s: number, v: any) => s + v.total_impressions, 0);
    const totalViews = variants.reduce((s: number, v: any) => s + v.total_views, 0);
    const totalWt = variants.reduce((s: number, v: any) => s + v.total_watch_time, 0);
    const aggCtr = totalImp > 0 ? Math.round(variants.reduce((s: number, v: any) => s + v.total_impressions * v.weighted_ctr, 0) / totalImp * 100) / 100 : 0;
    const aggAvd = totalViews > 0 ? Math.round(totalWt * 3600 / totalViews * 10) / 10 : 0;
    const winCount = variants.filter((v: any) => v.is_winner).length;
    const testCount = new Set(variants.map((v: any) => v.test_id)).size;

    // Comparison: all OTHER tagged variants (not matching this filter)
    let otherIds = (db.prepare(`SELECT DISTINCT variant_id FROM variant_tags WHERE variant_id NOT IN (${placeholders})`).all(...matchingVariantIds) as any[]).map((r: any) => r.variant_id);
    if (ctVariantSet) otherIds = otherIds.filter((id: number) => ctVariantSet.has(id));
    let otherAgg = null;
    if (otherIds.length > 0) {
      const op = otherIds.map(() => '?').join(',');
      const other = db.prepare(`
        SELECT COALESCE(SUM(tm.impressions), 0) as imp, COALESCE(SUM(tm.views), 0) as views,
          CASE WHEN SUM(tm.impressions) > 0 THEN ROUND(SUM(tm.impressions * tm.ctr) / SUM(tm.impressions), 2) ELSE 0 END as ctr,
          COALESCE(SUM(tm.watch_time_hours), 0) as wt
        FROM test_measurements tm WHERE tm.variant_id IN (${op})
          AND ((tm.realtime_views_json LIKE '%"type":"rotation_slot"%' OR tm.realtime_views_json LIKE '%"type":"reconstructed_vtr"%') AND NOT (tm.ctr > 25) AND tm.realtime_views_json NOT LIKE '%"suspect":true%')
      `).get(...otherIds) as any;
      const otherAvd = other.views > 0 ? Math.round(other.wt * 3600 / other.views * 10) / 10 : 0;
      otherAgg = { ctr: other.ctr, avd: otherAvd, impressions: other.imp, views: other.views, variant_count: otherIds.length };
    }

    return {
      matching: variants,
      aggregate: { ctr: aggCtr, avd: aggAvd, impressions: totalImp, views: totalViews, watch_time: totalWt, win_count: winCount, test_count: testCount, variant_count: variants.length },
      other: otherAgg,
      global_avg: { ctr: Math.round(avgCtr * 100) / 100, avd: Math.round(avgAvd * 10) / 10 },
    };
  });
}
