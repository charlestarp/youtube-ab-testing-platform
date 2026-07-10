import { FastifyInstance } from 'fastify';
import Anthropic from '@anthropic-ai/sdk';
import { getDb } from '../db/client.js';
import { authMiddleware } from '../middleware/auth.js';
import { config } from '../config.js';
import { logAiUsage } from '../lib/ai-usage-log.js';

export const TOOLS: Anthropic.Tool[] = [
  {
    name: 'search_videos',
    description: 'Search our YouTube videos by title or description. Returns video details and performance.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search term' },
        category: { type: 'string', enum: ['podcast', 'reaction', 'all'], description: 'Filter by category' },
        limit: { type: 'number', description: 'Max results (default 10)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_video_analytics',
    description: 'Get daily analytics for a specific video (views, watch time, retention, likes, subs gained).',
    input_schema: {
      type: 'object' as const,
      properties: {
        video_title: { type: 'string', description: 'Video title to search for' },
        days: { type: 'number', description: 'Number of days of data (default 30)' },
      },
      required: ['video_title'],
    },
  },
  {
    name: 'get_top_performing',
    description: 'Get top performing videos ranked by views, likes, or comments.',
    input_schema: {
      type: 'object' as const,
      properties: {
        metric: { type: 'string', enum: ['views', 'likes', 'comments'], description: 'Metric to rank by' },
        category: { type: 'string', enum: ['podcast', 'reaction', 'all'] },
        limit: { type: 'number', description: 'Max results (default 20)' },
      },
      required: ['metric'],
    },
  },
  {
    name: 'get_channel_trends',
    description: 'Get channel-level analytics trends over time.',
    input_schema: {
      type: 'object' as const,
      properties: { days: { type: 'number', description: 'Number of days (default 30)' } },
      required: [],
    },
  },
  {
    name: 'get_test_results',
    description: 'Get A/B test results, including which variant won and by how much.',
    input_schema: {
      type: 'object' as const,
      properties: {
        video_title: { type: 'string', description: 'Filter by video title' },
        status: { type: 'string', enum: ['running', 'completed', 'all'] },
      },
      required: [],
    },
  },
  {
    name: 'get_competitor_stats',
    description: 'Compare our channel stats with tracked competitors.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'search_comments',
    description: 'Search YouTube comments across our channel and competitors.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search term in comments' },
        sentiment: { type: 'string', enum: ['positive', 'negative', 'neutral'] },
        mentions_only: { type: 'boolean', description: 'Only show comments mentioning Toni and Ryan' },
      },
      required: ['query'],
    },
  },
  {
    name: 'analyze_title_patterns',
    description: "What actually wins on this channel, learned from the real tagged title corpus. Returns, per content type, which title attributes over- and under-perform vs that format's median (with lift %), plus the actual top titles to mirror the shape of. Podcast and TNTL are kept separate. Call this before proposing titles.",
    input_schema: {
      type: 'object' as const,
      properties: {
        content_type: { type: 'string', enum: ['podcast', 'TNTL'], description: 'Limit to one format. Omit to get both.' },
      },
      required: [],
    },
  },
  {
    name: 'score_title',
    description: 'Score a proposed video title for performance potential (0-100) based on historical patterns. Identifies what works and what does not.',
    input_schema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: 'The proposed video title to score' },
      },
      required: ['title'],
    },
  },
  {
    name: 'get_growth_projections',
    description: 'Get channel growth projections including subscriber milestone dates, weekly trends, and growth insights.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'search_competitor_videos',
    description: 'Search competitor video titles for similar content. Use this to find examples of titles that worked well on other channels.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search term to match in competitor video titles' },
        min_views: { type: 'number', description: 'Minimum view count filter (default 50000)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_top_competitor_titles',
    description: "Top long-form titles from tracked competitor podcasts (Shxts and Gigs, Two Hot Takes, The Basement Yard, Bad Friends, and more), highest views first. Use as a SECONDARY lens when brainstorming titles, to see fresh angles that land in the wider podcast space. Our own data stays primary and you must never copy a competitor's title verbatim.",
    input_schema: {
      type: 'object' as const,
      properties: {
        competitor: { type: 'string', description: 'Optional channel name filter, e.g. "Shxts and Gigs"' },
        limit: { type: 'number', description: 'How many titles (default 15, max 30)' },
      },
      required: [],
    },
  },
  {
    name: 'find_seo_gaps',
    description: 'Find topics and keywords that competitors cover but we do not. Returns content opportunities ranked by potential.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'detect_fatigue',
    description: 'Detect title/thumbnail patterns that are declining in effectiveness. Shows which styles are fatigued and should be refreshed.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_benchmarks',
    description: 'Get channel performance benchmarks. Shows average views, top performers, underperformers, and performance thresholds.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'search_transcripts',
    description: 'Search across all 1,285 podcast episode transcripts using full-text search. Returns matching segments with episode title, speaker, and timestamp.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search term (supports FTS5 syntax: AND, OR, NEAR, quotes for phrases)' },
        limit: { type: 'number', description: 'Max results (default 20)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_episode_transcript',
    description: 'Get the full transcript for a specific podcast episode by title search. Returns all segments with speaker labels and timestamps.',
    input_schema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: 'Episode title (partial match)' },
      },
      required: ['title'],
    },
  },
  {
    name: 'get_prerelease_transcript',
    description: 'Get a pre-release (upcoming) episode transcript by ID. Use this to read episode content before it is published, for evaluating titles and thumbnails.',
    input_schema: {
      type: 'object' as const,
      properties: {
        id: { type: 'number', description: 'Pre-release transcript ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'list_prerelease_transcripts',
    description: 'List all uploaded pre-release episode transcripts. Shows ID, title, and upload date.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_thumbnail_insights',
    description: 'Get data-driven insights about which thumbnail attributes (expressions, colors, text, layout) correlate with higher views and CTR for our channel. Based on Claude Vision analysis of all thumbnails.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
];

export async function executeTool(name: string, input: any): Promise<string> {
  const db = getDb();

  switch (name) {
    case 'search_videos': {
      const rows = db.prepare(`
        SELECT video_id, title, publish_date, view_count, like_count, comment_count, category
        FROM yt.videos WHERE title LIKE ? ${input.category && input.category !== 'all' ? 'AND category = ?' : ''}
        ORDER BY view_count DESC LIMIT ?
      `).all(
        `%${input.query}%`,
        ...(input.category && input.category !== 'all' ? [input.category] : []),
        input.limit || 10
      ) as any[];
      return rows.map(r => `${r.title} (${r.publish_date}) — ${r.view_count.toLocaleString()} views, ${r.like_count} likes`).join('\n') || 'No videos found';
    }

    case 'get_video_analytics': {
      const video = db.prepare('SELECT video_id, title FROM yt.videos WHERE title LIKE ? LIMIT 1').get(`%${input.video_title}%`) as any;
      if (!video) return 'Video not found';
      const analytics = db.prepare(`
        SELECT date, views, avg_view_duration, avg_view_pct, watch_time_hours, likes, subscribers_gained
        FROM yt.video_analytics WHERE video_id = ? ORDER BY date DESC LIMIT ?
      `).all(video.video_id, input.days || 30) as any[];
      if (!analytics.length) return `No analytics data for "${video.title}"`;
      const totalViews = analytics.reduce((s: number, r: any) => s + r.views, 0);
      const avgRetention = analytics.reduce((s: number, r: any) => s + (r.avg_view_pct || 0), 0) / analytics.length;
      return `${video.title}\nTotal views (${analytics.length} days): ${totalViews.toLocaleString()}\nAvg retention: ${avgRetention.toFixed(1)}%\n\nDaily:\n` +
        analytics.slice(0, 10).map((r: any) => `${r.date}: ${r.views} views, ${r.avg_view_pct?.toFixed(1) || '?'}% retention, ${r.watch_time_hours?.toFixed(1) || 0}h watch time`).join('\n');
    }

    case 'get_top_performing': {
      const metric = input.metric || 'views';
      const col = metric === 'views' ? 'view_count' : metric === 'likes' ? 'like_count' : 'comment_count';
      const rows = db.prepare(`
        SELECT title, publish_date, view_count, like_count, comment_count, category
        FROM yt.videos ${input.category && input.category !== 'all' ? 'WHERE category = ?' : ''}
        ORDER BY ${col} DESC LIMIT ?
      `).all(
        ...(input.category && input.category !== 'all' ? [input.category] : []),
        input.limit || 20
      ) as any[];
      return rows.map((r: any, i: number) => `${i + 1}. ${r.title} (${r.publish_date}) — ${r.view_count.toLocaleString()} views, ${r.like_count} likes`).join('\n');
    }

    case 'get_channel_trends': {
      const days = input.days || 30;
      const rows = db.prepare(`
        SELECT date, SUM(views) as total_views, SUM(watch_time_hours) as total_wt,
               AVG(avg_view_pct) as avg_retention, SUM(subscribers_gained) as total_subs
        FROM yt.video_analytics
        WHERE date >= date('now', '-' || ? || ' days')
        GROUP BY date ORDER BY date
      `).all(days) as any[];
      if (!rows.length) return 'No channel analytics data';
      return rows.map((r: any) => `${r.date}: ${r.total_views} views, ${r.total_wt?.toFixed(1) || 0}h watch time, ${r.avg_retention?.toFixed(1) || '?'}% retention, +${r.total_subs || 0} subs`).join('\n');
    }

    case 'get_test_results': {
      let sql = 'SELECT t.*, tv.label as winner_label FROM tests t LEFT JOIN test_variants tv ON t.winner_variant_id = tv.id WHERE 1=1';
      const params: any[] = [];
      if (input.video_title) { sql += ' AND t.video_title LIKE ?'; params.push(`%${input.video_title}%`); }
      if (input.status && input.status !== 'all') { sql += ' AND t.status = ?'; params.push(input.status); }
      sql += ' ORDER BY t.created_at DESC LIMIT 20';
      const rows = db.prepare(sql).all(...params) as any[];
      if (!rows.length) return 'No tests found';
      return rows.map((r: any) => {
        let line = `Test #${r.id}: ${r.video_title || r.video_id} [${r.test_type}] — ${r.status}${r.winner_label ? `, winner: ${r.winner_label}` : ''}`;
        if (r.learning_note) line += `\n  Learning: ${r.learning_note}`;
        return line;
      }).join('\n');
    }

    case 'get_competitor_stats': {
      const comps = db.prepare('SELECT * FROM competitors ORDER BY subscriber_count DESC').all() as any[];
      if (!comps.length) return 'No competitors being tracked yet';
      return comps.map((c: any) => `${c.name} (@${c.handle}) — ${c.subscriber_count.toLocaleString()} subs, ${c.video_count} videos`).join('\n');
    }

    case 'search_comments': {
      let sql = 'SELECT author, content, sentiment, like_count, published_at FROM comments WHERE content LIKE ?';
      const params: any[] = [`%${input.query}%`];
      if (input.sentiment) { sql += ' AND sentiment = ?'; params.push(input.sentiment); }
      if (input.mentions_only) { sql += ' AND mentions_us = 1'; }
      sql += ' ORDER BY published_at DESC LIMIT 20';
      const rows = db.prepare(sql).all(...params) as any[];
      if (!rows.length) return 'No matching comments found';
      return rows.map((r: any) => `[${r.sentiment}] ${r.author}: "${r.content.slice(0, 150)}" (${r.like_count} likes)`).join('\n');
    }

    case 'analyze_title_patterns': {
      // Real "what beats what" learning, split by content type. Uses the tagged
      // title corpus (attribute lift vs that type's median) plus the actual top
      // titles so the model can mirror shapes that genuinely win here.
      const { computeTitleCorpus, computeTitleAbUplift } = await import('../services/title-insights.js');
      const corpus = computeTitleCorpus();
      const abUplift = computeTitleAbUplift(2);
      const wanted = input.content_type === 'TNTL' ? ['TNTL'] : input.content_type === 'podcast' ? ['podcast'] : ['podcast', 'TNTL'];
      const pct = (lift: number) => `${lift >= 1 ? '+' : ''}${Math.round((lift - 1) * 100)}%`;
      const out: string[] = [];
      for (const t of wanted) {
        const c = (corpus as any)[t];
        if (!c || !c.total_videos) continue;
        const named = t === 'TNTL' ? 'TRY NOT TO LAUGH' : 'PODCAST';
        out.push(`=== ${named}: ${c.total_videos} videos, median ${c.median_views.toLocaleString()} views ===`);

        // STRONGEST SIGNAL FIRST: which attributes actually WON head-to-head A/B
        // tests on this content type (same video + thumbnail, only the title
        // changed). This is a controlled experiment, so it beats the view-based
        // correlation below. Lead the model with it.
        const ab = ((abUplift as any)[t] || []).filter((a: any) => a.tests >= 2);
        if (ab.length) {
          const ranked = [...ab].sort((a: any, b: any) => b.avg_uplift_pct - a.avg_uplift_pct);
          const winners = ranked.filter((a: any) => a.avg_uplift_pct > 0 || a.win_rate >= 0.5);
          const losers = ranked.filter((a: any) => a.avg_uplift_pct < 0 && a.win_rate < 0.5);
          out.push(`WON HEAD-TO-HEAD A/B TESTS for ${named} (strongest signal — same video and thumbnail, only the title changed; lean into these):`);
          for (const a of winners.slice(0, 6)) out.push(`  ${a.name} [${a.category}]: ${a.avg_uplift_pct >= 0 ? '+' : ''}${a.avg_uplift_pct}% CTR, won ${Math.round(a.win_rate * 100)}% of ${a.tests} tests`);
          if (losers.length) {
            out.push(`LOST head-to-head (avoid unless the story truly demands it):`);
            for (const a of losers.slice(0, 4)) out.push(`  ${a.name}: ${a.avg_uplift_pct}% CTR, won ${Math.round(a.win_rate * 100)}% of ${a.tests} tests`);
          }
        } else {
          out.push(`(No A/B title tests with enough data for ${named} yet — use the correlational view below, but treat it as weaker.)`);
        }

        const usable = c.tags.filter((tg: any) => tg.videos >= 4);
        out.push(`Broader correlation across ALL ${named} titles (view-based, weaker than the A/B data above — how each attribute tracks vs the median video):`);
        for (const tg of usable.slice(0, 8)) out.push(`  ${tg.name}${tg.category ? ` [${tg.category}]` : ''}: ${pct(tg.lift_vs_median)} (${tg.median_views.toLocaleString()} median, ${tg.videos} videos)`);
        out.push(`Attributes that UNDER-perform (use with care):`);
        for (const tg of usable.slice(-4).reverse()) out.push(`  ${tg.name}: ${pct(tg.lift_vs_median)}`);
        const cat = t === 'TNTL' ? 'reaction' : 'podcast';
        const tops = db.prepare(`SELECT title, view_count FROM yt.videos WHERE category = ? AND view_count > 0 ORDER BY view_count DESC LIMIT 10`).all(cat) as any[];
        out.push(`Actual top ${named} titles, mirror the SHAPE of these (they are proper, readable titles, not cryptic fragments):`);
        for (const v of tops) out.push(`  "${v.title}" (${v.view_count.toLocaleString()})`);
        out.push('');
      }
      return out.length ? out.join('\n') : 'No tagged title data yet.';
    }

    case 'score_title': {
      const { scoreTitle } = await import('../services/viral-score.js');
      const result = scoreTitle(input.title);
      let out = `Title Score: ${result.score}/100\nVideo Type: ${result.videoType === 'tntl' ? 'TRY NOT TO LAUGH compilation' : 'PODCAST EPISODE (do NOT reference TNTL data)'}\nWord count: ${input.title.split(/\\s+/).length} words\nBaseline avg views (PODCAST ONLY, last 3 months): ${result.avgViews.toLocaleString()}\n${result.prediction}\nIMPORTANT: Use ${result.avgViews.toLocaleString()} as the baseline, not the overall channel average.\n`;

      if (result.flags.length > 0) {
        out += `\n⚠️ YouTube Policy Flags:\n`;
        for (const f of result.flags) {
          out += `- WARNING: ${f}\n`;
        }
        out += `Consider rewording to avoid these flags.\n`;
      }

      out += `\nFactors:\n`;
      for (const f of result.factors) {
        out += `- ${f.name} (${f.score}/100): ${f.insight}\n`;
      }
      if (result.similarTopVideos.length > 0) {
        out += `\nSimilar top videos:\n`;
        for (const v of result.similarTopVideos) {
          out += `- "${v.title}" (${v.views.toLocaleString()} views)\n`;
        }
      }
      return out;
    }

    case 'get_growth_projections': {
      const { getGrowthProjections } = await import('../services/growth-projections.js');
      const g = getGrowthProjections();
      let out = `Channel Growth:\n`;
      out += `Avg ${Math.round(g.avgSubsPerDay)} subs/day, ${Math.round(g.avgSubsPerWeek)} subs/week\n`;
      out += `Avg ${Math.round(g.avgViewsPerDay).toLocaleString()} views/day\n`;
      out += `Avg ${Math.round(g.avgViewsPerVideo).toLocaleString()} views/video\n`;
      out += `Publishing ${g.postsPerWeek.toFixed(1)} videos/week\n\n`;
      if (g.milestones.length > 0) {
        out += `Milestones:\n`;
        for (const m of g.milestones) {
          out += `- ${m.target.toLocaleString()} subs: ~${m.estimatedDate} (${m.daysAway} days)\n`;
        }
      }
      out += `\nInsights:\n` + g.insights.map(i => `- ${i}`).join('\n');
      return out;
    }

    case 'get_top_competitor_titles': {
      const lim = Math.min(30, Math.max(5, input.limit || 15));
      const args: any[] = [];
      let where = `cv.duration_seconds > 180 AND cv.views > 0 AND cv.title NOT LIKE '%#shorts%'`;
      if (input.competitor) { where += ` AND c.name LIKE ?`; args.push(`%${input.competitor}%`); }
      args.push(lim);
      const rows = db.prepare(`
        SELECT c.name AS channel, cv.title, cv.views
        FROM competitor_videos cv JOIN competitors c ON c.id = cv.competitor_id
        WHERE ${where} ORDER BY cv.views DESC LIMIT ?
      `).all(...args) as any[];
      if (!rows.length) return 'No competitor titles found.';
      return ['Top competitor podcast titles (secondary inspiration, do not copy):', ...rows.map((r: any) => `  ${r.channel}: "${r.title}" (${r.views.toLocaleString()})`)].join('\n');
    }

    case 'search_competitor_videos': {
      const minViews = input.min_views || 50000;
      const rows = db.prepare(`
        SELECT cv.title, cv.views, cv.published_at, c.name as channel
        FROM competitor_videos cv
        JOIN competitors c ON cv.competitor_id = c.id
        WHERE cv.title LIKE ? AND cv.views >= ? AND cv.duration_seconds > 180
        ORDER BY cv.views DESC LIMIT 20
      `).all(`%${input.query}%`, minViews) as any[];
      if (!rows.length) return `No competitor videos found matching "${input.query}" with ${minViews}+ views`;
      return rows.map((r: any) => `${r.channel}: "${r.title}" — ${r.views.toLocaleString()} views (${r.published_at})`).join('\n');
    }

    case 'find_seo_gaps': {
      const { findSEOGaps } = await import('../services/seo-finder.js');
      const gaps = findSEOGaps();
      if (gaps.length === 0) return 'No SEO gaps found. Add competitor channels first.';
      let out = `SEO Gaps (topics competitors cover that we don't):\n\n`;
      for (const g of gaps.slice(0, 15)) {
        out += `[${g.opportunity.toUpperCase()}] "${g.keyword}" — est. ${g.estimatedViews.toLocaleString()} views\n`;
        for (const v of g.competitorVideos) {
          out += `  - ${v.channel}: "${v.title}" (${v.views.toLocaleString()} views)\n`;
        }
      }
      return out;
    }

    case 'detect_fatigue': {
      const { detectFatigue } = await import('../services/fatigue-tracker.js');
      const patterns = detectFatigue();
      if (patterns.length === 0) return 'Not enough data to detect fatigue patterns yet.';
      let out = `Pattern Fatigue Analysis (Podcast and Try Not To Laugh are kept separate, and title vs thumbnail are separate):\n\n`;
      const lenses = [
        { ct: 'podcast', kind: 'title', label: 'PODCAST · TITLE' },
        { ct: 'podcast', kind: 'thumbnail', label: 'PODCAST · THUMBNAIL' },
        { ct: 'TNTL', kind: 'title', label: 'TNTL · TITLE' },
        { ct: 'TNTL', kind: 'thumbnail', label: 'TNTL · THUMBNAIL' },
      ] as const;
      for (const lens of lenses) {
        const group = patterns.filter((p: any) => p.contentType === lens.ct && p.kind === lens.kind);
        if (group.length === 0) continue;
        out += `${lens.label}:\n`;
        for (const p of group.slice(0, 6)) {
          const icon = p.status === 'fatigued' ? '🔴' : p.status === 'declining' ? '🟡' : p.status === 'growing' ? '🟢' : '⚪';
          const name = p.attribute ? `${p.attribute}: "${p.pattern}"` : `"${p.pattern}"`;
          out += `${icon} ${name} [${p.status}] ${p.changePercent > 0 ? '+' : ''}${p.changePercent}%\n`;
          out += `   ${p.reason}\n`;
          out += `   ${p.recommendation}\n`;
        }
        out += `\n`;
      }
      return out;
    }

    case 'get_benchmarks': {
      const { getChannelBenchmarks } = await import('../services/benchmarks.js');
      const bench = getChannelBenchmarks();
      let out = `Channel Benchmarks (Podcast and Try Not To Laugh are separate benchmarks, never pooled):\n\n`;
      for (const b of [bench.podcast, bench.TNTL]) {
        out += `=== ${b.label} (${b.videoCount} videos) ===\n`;
        if (!b.enoughData) {
          out += `Not enough ${b.label} videos yet for a benchmark.\n\n`;
          continue;
        }
        out += `Average views: ${b.avgViews.toLocaleString()}\n`;
        out += `Median views: ${b.medianViews.toLocaleString()}\n`;
        out += `Average likes: ${b.avgLikes.toLocaleString()}\n`;
        out += `Recent trend: ${b.recentTrend}\n`;
        out += `Thresholds: Top performer=${b.benchmarks.viral.toLocaleString()}, Above avg=${b.benchmarks.above.toLocaleString()}, Below avg=${b.benchmarks.below.toLocaleString()}\n`;
        if (b.topPerformers.length > 0) {
          out += `Top performers:\n`;
          for (const v of b.topPerformers.slice(0, 5)) {
            out += `- "${v.title}" — ${v.views.toLocaleString()} views (+${v.viewsVsAvg}% vs avg)\n`;
          }
        }
        if (b.underperformers.length > 0) {
          out += `Underperformers:\n`;
          for (const v of b.underperformers.slice(0, 5)) {
            out += `- "${v.title}" — ${v.views.toLocaleString()} views (${v.viewsVsAvg}% vs avg)\n`;
          }
        }
        out += `\n`;
      }
      return out;
    }

    case 'search_transcripts': {
      try {
        const rows = db.prepare(`
          SELECT s.text, s.speaker, s.start, s.end, e.title as episode_title
          FROM podcast.segments_fts fts
          JOIN podcast.segments s ON s.id = fts.rowid
          JOIN podcast.episodes e ON e.id = s.episode_id
          WHERE fts.text MATCH ?
          ORDER BY rank
          LIMIT ?
        `).all(input.query, input.limit || 20) as any[];
        if (!rows.length) return 'No transcript matches found';
        return rows.map((r: any) => {
          const mins = Math.floor(r.start / 60);
          const secs = Math.floor(r.start % 60);
          return `[${r.episode_title}] ${r.speaker} at ${mins}:${secs.toString().padStart(2, '0')}: "${r.text}"`;
        }).join('\n');
      } catch (err: any) {
        return `Transcript search error: ${err.message}`;
      }
    }

    case 'get_episode_transcript': {
      try {
        const episode = db.prepare(`
          SELECT id, title, date, duration FROM podcast.episodes WHERE title LIKE ? LIMIT 1
        `).get(`%${input.title}%`) as any;
        if (!episode) return `No episode found matching "${input.title}"`;
        const segments = db.prepare(`
          SELECT speaker, start, text FROM podcast.segments WHERE episode_id = ? ORDER BY start
        `).all(episode.id) as any[];
        if (!segments.length) return `Episode "${episode.title}" has no segments`;
        let out = `Episode: ${episode.title} (${episode.date}, ${Math.round(episode.duration / 60)} min)\n\n`;
        out += segments.map((s: any) => {
          const mins = Math.floor(s.start / 60);
          const secs = Math.floor(s.start % 60);
          return `[${mins}:${secs.toString().padStart(2, '0')}] ${s.speaker}: ${s.text}`;
        }).join('\n');
        return out;
      } catch (err: any) {
        return `Episode transcript error: ${err.message}`;
      }
    }

    case 'get_prerelease_transcript': {
      // First check local uploads
      const localRow = db.prepare('SELECT * FROM prerelease_transcripts WHERE id = ?').get(input.id) as any;
      if (localRow) return `Pre-release Episode: ${localRow.title}\nUploaded: ${localRow.created_at}\n\n${localRow.transcript}`;

      // Check TARPGPT pre-release API FIRST (before podcast.db to avoid ID collisions)
      try {
        const token = (db.prepare("SELECT token FROM podcast.sessions ORDER BY created_at DESC LIMIT 1").get() as any)?.token;
        if (token) {
          const segRes = await fetch(`http://localhost:8000/api/prerelease/episodes/${input.id}/segments`, {
            headers: { 'Cookie': 'session=' + token },
          });
          if (segRes.ok) {
            const segments = await segRes.json() as any[];
            if (segments.length > 0) {
              const epRes = await fetch(`http://localhost:8000/api/prerelease/episodes/${input.id}`, {
                headers: { 'Cookie': 'session=' + token },
              });
              const epData = epRes.ok ? await epRes.json() as any : null;
              const title = epData?.title || `Pre-release #${input.id}`;

              const transcript = segments.map((s: any) => {
                const mins = Math.floor(s.start / 60);
                const secs = Math.floor(s.start % 60);
                return `[${mins}:${secs.toString().padStart(2, '0')}] ${s.speaker}: ${s.text}`;
              }).join('\n');

              // Build topic index
              const fullText = segments.map((s: any) => s.text).join(' ').toLowerCase();
              const topics: string[] = [];
              if (fullText.includes('pickup line') || fullText.includes('pick up line') || fullText.includes('pick-up')) topics.push('PICKUP LINES segment');
              if (fullText.includes('normal or na') || fullText.includes('normal or nah')) topics.push('NORMAL OR NAH segment');
              if (fullText.includes('christmas tree')) topics.push('Christmas tree history');
              if (fullText.includes('crocodile') || fullText.includes('dundee')) topics.push('Crocodile Dundee');
              if (fullText.includes('egg') && fullText.includes('12')) topics.push('10 eggs vs 12 eggs');
              if (fullText.includes('funeral') || fullText.includes('dead relative')) topics.push('Funeral culture');
              if (fullText.includes('live show') || fullText.includes('riga') || fullText.includes('latvia')) topics.push('LIVE SHOW in Riga, Latvia');
              if (fullText.includes('alcohol') || fullText.includes('shots') || fullText.includes('jäger')) topics.push('Cheap alcohol');
              if (fullText.includes('single men') || fullText.includes('single ladies')) topics.push('Shortage of single men');

              const topicStr = topics.length > 0 ? `\n\nKEY TOPICS (from transcript):\n${topics.map(t => '- ' + t).join('\n')}\n` : '';

              return `=== PRE-RELEASE TRANSCRIPT: "${title}" ===\nTotal segments: ${segments.length}${topicStr}\nIMPORTANT: The content below is the ONLY source of truth about this episode. Do NOT describe any content that isn't in these lines. Every claim about the episode must be backed by a direct quote from below.\n\n${transcript.slice(0, 60000)}`;
            }
          }
        }
      } catch {}

      // Fallback: Check podcast.db regular episodes (only if pre-release not found)
      try {
        const ep = db.prepare('SELECT id, title, date FROM podcast.episodes WHERE id = ?').get(input.id) as any;
        if (ep) {
          const segments = db.prepare(
            "SELECT speaker, text, start, end FROM podcast.segments WHERE episode_id = ? ORDER BY start"
          ).all(input.id) as any[];
          if (segments.length > 0) {
            const transcript = segments.map((s: any) => {
              const mins = Math.floor(s.start / 60);
              const secs = Math.floor(s.start % 60);
              return `[${mins}:${secs.toString().padStart(2, '0')}] ${s.speaker}: ${s.text}`;
            }).join('\n');
            return `Episode: ${ep.title} (${ep.date})\n${segments.length} segments\n\n${transcript.slice(0, 60000)}`;
          }
        }
      } catch {}

      return `No transcript found with ID ${input.id}`;
    }

    case 'list_prerelease_transcripts': {
      const localRows = db.prepare("SELECT id, title, created_at, 'uploaded' as source FROM prerelease_transcripts ORDER BY created_at DESC").all() as any[];

      // Also list pre-release episodes from podcast.db via TARPGPT API
      let apiEps: any[] = [];
      try {
        const token = (db.prepare("SELECT token FROM podcast.sessions ORDER BY created_at DESC LIMIT 1").get() as any)?.token;
        if (token) {
          const res = await fetch('http://localhost:8000/api/prerelease/episodes', { headers: { 'Cookie': 'session=' + token } });
          if (res.ok) {
            apiEps = (await res.json() as any[]).filter((e: any) => e.upload_status === 'ready')
              .map((e: any) => `#${e.id}: ${e.title} (pre-release, ${e.date})`);
          }
        }
      } catch {}

      const localList = localRows.map((r: any) => `#${r.id}: ${r.title} (uploaded ${r.created_at})`);
      const all = [...apiEps, ...localList];
      return all.length > 0 ? all.join('\n') : 'No pre-release transcripts available';
    }

    case 'get_thumbnail_insights': {
      const { getThumbnailInsights } = await import('../services/thumbnail-analyzer.js');
      const data = getThumbnailInsights();
      if (data.message) return data.message;
      let out = `Thumbnail Analysis (${data.total} thumbnails analyzed, avg ${data.avgViews.toLocaleString()} views):\n\n`;
      for (const insight of data.insights.slice(0, 15)) {
        out += `${insight.attribute}: Best="${insight.bestValue}" (${insight.bestAvgViews.toLocaleString()} avg views) vs Worst="${insight.worstValue}" (${insight.worstAvgViews.toLocaleString()} avg views) — ${insight.liftPercent}% lift\n`;
        for (const v of insight.values) {
          out += `  ${v.value}: ${v.count} videos, ${v.avg_views.toLocaleString()} avg views, ${v.avg_ctr || 0}% CTR\n`;
        }
        out += '\n';
      }
      return out;
    }

    default:
      return `Unknown tool: ${name}`;
  }
}

const SYSTEM_PROMPT = `You are a YouTube title and thumbnail strategist for the Toni and Ryan podcast channel (~760k subs, Australian comedy podcast).

CRITICAL FACTS:
- Podcast episodes average ~30k views (last 3 months). Do NOT use overall channel average which includes TRY NOT TO LAUGH compilations at ~100k+.
- These are COMPLETELY different content types. When analyzing podcast titles, ONLY reference podcast data.
- Never use ampersand (&), always write "and".

TOOLS: Call all tools you need FIRST (no text between tool calls), then give ONE response.
- If user mentions a pre-release transcript ID, call get_prerelease_transcript to read the episode content.
- Call score_title to get data-driven scoring.
- Call search_videos to find similar past Toni and Ryan titles and their view counts.
- Call search_competitor_videos to find competitor titles with similar themes that performed well.

TITLE ANALYSIS FORMAT:
Use this exact structure with --- between sections:

## Your Title
> [quote the proposed title]
**Score: [X/100]** — Predicted ~Xk views (podcast baseline: ~30k)

---

## What Works
- bullet points

---

## What Could Be Better
- bullet points

---

## Your Past Videos With Similar Themes
Quote 3-5 real titles from search_videos results with actual view counts.

---

## How Competitors Title Similar Content
Quote 3-5 real titles from search_competitor_videos with channel name and views.

---

## My Suggestions (Ranked)

1. **"Title Here"** (X words) — [Score/100]
   Why: one line explanation referencing data

2. **"Title Here"** (X words) — [Score/100]
   Why: one line explanation

[continue for 5-8 titles]

---

## My Top Pick
State which title and WHY in 2-3 sentences.

CRITICAL RULES:
- ABSOLUTELY NEVER fabricate, invent, or make up episode content. This is the #1 rule.
- ONLY describe stories, topics, and moments that appear WORD FOR WORD in the transcript text.
- If you claim the episode is about something, you MUST quote the exact transcript line that proves it.
- If the transcript doesn't clearly show what the episode is about, say "I couldn't determine the main topics from the transcript" — do NOT guess.
- When summarizing episode content, list only topics you can directly quote from the transcript.
- NEVER say the transcript is "mislabeled" or contains different content than what the title suggests. Read the ENTIRE transcript carefully before making any claims about its content. If the title says "live show" and the transcript has audience interaction, crowd reactions, and live venue references — it IS a live show.
- ALWAYS follow the user's instructions. If they say to keep a specific part of the title (like "RIGA LIVE SHOW"), ALL your suggestions MUST include that exact text. Do NOT change or remove parts the user explicitly wants to keep.
- If the user gives constraints (like "keeping X"), every single suggestion must honour those constraints.
- Before summarising episode content, list the TOP 5 actual topics from the transcript with direct quotes. This prevents hallucination.

TITLE RULES:
- Count words properly. "My Husband Thinks I Squirted But It Was Actually This" = 10 words, not 8.
- If you say shorter titles perform better, suggest shorter titles. Be consistent.
- Titles should match the TONE of the content — funny episodes get funny titles, not dramatic ones.
- Flag any words YouTube might restrict (squirt, orgasm, etc.) with a warning.
- All suggestions must be grounded in the episode transcript content — don't make up stories.`;

export async function chatRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware);

  // GET /chat/conversations
  app.get('/chat/conversations', async (request) => {
    const db = getDb();
    return db.prepare(
      'SELECT * FROM chat_conversations WHERE user_id = ? ORDER BY updated_at DESC LIMIT 50'
    ).all(request.user!.id);
  });

  // POST /chat/conversations
  app.post('/chat/conversations', async (request) => {
    const { title } = request.body as { title: string };
    const db = getDb();
    const result = db.prepare(
      'INSERT INTO chat_conversations (user_id, title) VALUES (?, ?)'
    ).run(request.user!.id, title || 'New Chat');
    return { id: Number(result.lastInsertRowid) };
  });

  // GET /chat/conversations/:id/messages
  app.get('/chat/conversations/:id/messages', async (request) => {
    const { id } = request.params as { id: string };
    const db = getDb();
    return db.prepare(
      'SELECT * FROM chat_messages WHERE conversation_id = ? ORDER BY id'
    ).all(parseInt(id));
  });

  // DELETE /chat/conversations/:id
  app.delete('/chat/conversations/:id', async (request) => {
    const { id } = request.params as { id: string };
    const db = getDb();
    db.prepare('DELETE FROM chat_conversations WHERE id = ? AND user_id = ?').run(parseInt(id), request.user!.id);
    return { ok: true };
  });

  // POST /chat/upload-image -- upload a thumbnail for analysis
  app.post('/chat/upload-image', async (request) => {
    const data = await request.file();
    if (!data) return { detail: 'No file uploaded' };

    const { mkdirSync } = await import('fs');
    const { resolve } = await import('path');
    const { pipeline } = await import('stream/promises');
    const { createWriteStream } = await import('fs');
    const { nanoid } = await import('nanoid');
    const { config } = await import('../config.js');

    mkdirSync(config.uploadsDir, { recursive: true });
    const filename = `chat_${nanoid(8)}.jpg`;
    const filepath = resolve(config.uploadsDir, filename);
    await pipeline(data.file, createWriteStream(filepath));

    return { ok: true, url: `/api/uploads/${filename}`, path: filepath };
  });

  // GET /chat/prerelease-transcripts -- list pre-release + recent episodes from TARPGPT
  app.get('/chat/prerelease-transcripts', async () => {
    const db = getDb();

    // Our own uploaded transcripts
    const uploaded = db.prepare("SELECT id, title, created_at, 'uploaded' as source FROM prerelease_transcripts ORDER BY created_at DESC").all() as any[];

    // Pre-release episodes from TARPGPT API
    let prereleaseEps: any[] = [];
    try {
      // Get a session cookie from TARPGPT (use admin session)
      const res = await fetch('http://localhost:8000/api/prerelease/episodes', {
        headers: { 'Cookie': 'session=' + (db.prepare("SELECT token FROM podcast.sessions ORDER BY created_at DESC LIMIT 1").get() as any)?.token },
      });
      if (res.ok) {
        const eps = await res.json() as any[];
        prereleaseEps = eps
          .filter((e: any) => e.upload_status === 'ready')
          .map((e: any) => ({
            id: e.id,
            title: e.title,
            created_at: e.uploaded_at || e.date,
            source: 'prerelease',
          }));
      }
    } catch {}

    // Recent regular episodes (last 10) for reference
    let recentEps: any[] = [];
    try {
      recentEps = db.prepare(`
        SELECT id, title, date as created_at, 'episode' as source
        FROM podcast.episodes ORDER BY date DESC LIMIT 10
      `).all() as any[];
    } catch {}

    return [...prereleaseEps, ...uploaded, ...recentEps];
  });

  // POST /chat/upload-transcript -- upload a pre-release episode transcript
  app.post('/chat/upload-transcript', async (request) => {
    const db = getDb();
    const contentType = request.headers['content-type'] || '';

    let title = '';
    let transcript = '';

    if (contentType.includes('multipart')) {
      // File upload (text file)
      const data = await request.file();
      if (!data) return { detail: 'No file uploaded' };
      const chunks: Buffer[] = [];
      for await (const chunk of data.file) {
        chunks.push(chunk);
      }
      transcript = Buffer.concat(chunks).toString('utf-8');
      title = (data.fields as any)?.title?.value || data.filename?.replace(/\.[^.]+$/, '') || 'Untitled';
    } else {
      // JSON body with raw text
      const body = request.body as { title?: string; transcript?: string };
      if (!body.transcript) return { detail: 'Missing transcript field' };
      title = body.title || 'Untitled';
      transcript = body.transcript;
    }

    const result = db.prepare(
      'INSERT INTO prerelease_transcripts (title, transcript, uploaded_by) VALUES (?, ?, ?)'
    ).run(title, transcript, request.user!.id);

    return { id: Number(result.lastInsertRowid), title };
  });

  // POST /chat/conversations/:id/stream -- SSE streaming chat
  app.post('/chat/conversations/:id/stream', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { message, image_url } = request.body as { message: string; image_url?: string };
    const convId = parseInt(id);
    const db = getDb();

    // Save user message
    db.prepare("INSERT INTO chat_messages (conversation_id, role, content) VALUES (?, 'user', ?)").run(convId, message);
    db.prepare("UPDATE chat_conversations SET updated_at = datetime('now') WHERE id = ?").run(convId);

    // Load history
    const history = db.prepare(
      'SELECT role, content FROM chat_messages WHERE conversation_id = ? ORDER BY id'
    ).all(convId) as { role: string; content: string }[];

    reply.hijack(); // Fastify must not run onSend against our raw SSE reply (drops the live stream)
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // Keep-alive ping every 5s to prevent proxy timeouts
    const keepAlive = setInterval(() => {
      try { reply.raw.write(': keepalive\n\n'); } catch {}
    }, 5000);

    try {
      const client = new Anthropic({ apiKey: config.anthropicApiKey });
      const messages: Anthropic.MessageParam[] = history.slice(0, -1).map(m => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      }));

      // Last user message may include an image
      if (image_url) {
        const { readFileSync } = await import('fs');
        const { resolve } = await import('path');
        const { config: appConfig } = await import('../config.js');
        const filename = image_url.split('/').pop() || '';
        const filepath = resolve(appConfig.uploadsDir, filename);
        try {
          const imageData = readFileSync(filepath).toString('base64');
          messages.push({
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageData } },
              { type: 'text', text: message },
            ],
          });
        } catch {
          messages.push({ role: 'user', content: message });
        }
      } else {
        messages.push({ role: 'user', content: message });
      }

      let fullText = '';
      let iterations = 0;
      const maxIterations = 8;

      while (iterations < maxIterations) {
        iterations++;

        const response = await client.messages.create({
          model: 'claude-opus-4-6',
          max_tokens: 4096,
          system: SYSTEM_PROMPT,
          tools: TOOLS,
          messages,
        });
        try { logAiUsage({ app: 'yt-testing', feature: 'chat', user: request.user?.email, model: 'claude-opus-4-6', usage: response.usage }); } catch {}

        let hasToolUse = false;
        const toolResults: { type: 'tool_result'; tool_use_id: string; content: string }[] = [];

        for (const block of response.content) {
          if (block.type === 'text') {
            fullText += block.text;
            reply.raw.write(`data: ${JSON.stringify({ type: 'text', delta: block.text })}\n\n`);
          } else if (block.type === 'tool_use') {
            hasToolUse = true;
            reply.raw.write(`data: ${JSON.stringify({ type: 'tool', name: block.name })}\n\n`);

            const result = await executeTool(block.name, block.input);
            reply.raw.write(`data: ${JSON.stringify({ type: 'tool_result', name: block.name })}\n\n`);

            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
          }
        }

        if (hasToolUse) {
          // Push assistant response once, then all tool results together
          messages.push({ role: 'assistant', content: response.content });
          messages.push({ role: 'user', content: toolResults });
        }

        if (!hasToolUse || response.stop_reason === 'end_turn') break;
      }

      // Save assistant message
      db.prepare("INSERT INTO chat_messages (conversation_id, role, content) VALUES (?, 'assistant', ?)").run(convId, fullText);

      reply.raw.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    } catch (err: any) {
      reply.raw.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
    }

    clearInterval(keepAlive);
    reply.raw.end();
  });

  // POST /chat/stream -- new conversation stream
  app.post('/chat/stream', async (request, reply) => {
    const { message, image_url } = request.body as { message: string; image_url?: string };
    const db = getDb();

    const title = message.slice(0, 60) + (message.length > 60 ? '...' : '');
    const result = db.prepare('INSERT INTO chat_conversations (user_id, title) VALUES (?, ?)').run(request.user!.id, title);
    const convId = Number(result.lastInsertRowid);

    reply.hijack(); // Fastify must not run onSend against our raw SSE reply (drops the live stream)
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const keepAlive2 = setInterval(() => {
      try { reply.raw.write(': keepalive\n\n'); } catch {}
    }, 5000);

    reply.raw.write(`data: ${JSON.stringify({ type: 'conv_created', conv_id: convId })}\n\n`);

    // Save user message
    db.prepare("INSERT INTO chat_messages (conversation_id, role, content) VALUES (?, 'user', ?)").run(convId, message);

    try {
      const client = new Anthropic({ apiKey: config.anthropicApiKey });

      let userContent: Anthropic.ContentBlockParam[] | string = message;
      if (image_url) {
        const { readFileSync } = await import('fs');
        const { resolve } = await import('path');
        const filename = image_url.split('/').pop() || '';
        const filepath = resolve(config.uploadsDir, filename);
        try {
          const imageData = readFileSync(filepath).toString('base64');
          userContent = [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageData } },
            { type: 'text', text: message },
          ];
        } catch {}
      }

      const messages: Anthropic.MessageParam[] = [{ role: 'user', content: userContent }];

      let fullText = '';
      let iterations = 0;

      while (iterations < 8) {
        iterations++;
        const response = await client.messages.create({
          model: 'claude-opus-4-6',
          max_tokens: 4096,
          system: SYSTEM_PROMPT,
          tools: TOOLS,
          messages,
        });
        try { logAiUsage({ app: 'yt-testing', feature: 'chat', user: request.user?.email, model: 'claude-opus-4-6', usage: response.usage }); } catch {}

        let hasToolUse = false;
        const toolResults2: { type: 'tool_result'; tool_use_id: string; content: string }[] = [];

        for (const block of response.content) {
          if (block.type === 'text') {
            fullText += block.text;
            reply.raw.write(`data: ${JSON.stringify({ type: 'text', delta: block.text })}\n\n`);
          } else if (block.type === 'tool_use') {
            hasToolUse = true;
            reply.raw.write(`data: ${JSON.stringify({ type: 'tool', name: block.name })}\n\n`);
            const result = await executeTool(block.name, block.input);
            reply.raw.write(`data: ${JSON.stringify({ type: 'tool_result', name: block.name })}\n\n`);
            toolResults2.push({ type: 'tool_result', tool_use_id: block.id, content: result });
          }
        }

        if (hasToolUse) {
          messages.push({ role: 'assistant', content: response.content });
          messages.push({ role: 'user', content: toolResults2 });
        }

        if (!hasToolUse || response.stop_reason === 'end_turn') break;
      }

      db.prepare("INSERT INTO chat_messages (conversation_id, role, content) VALUES (?, 'assistant', ?)").run(convId, fullText);
      reply.raw.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    } catch (err: any) {
      reply.raw.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
    }

    clearInterval(keepAlive2);
    reply.raw.end();
  });
}
