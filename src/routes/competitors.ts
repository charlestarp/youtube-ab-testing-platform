import { FastifyInstance } from 'fastify';
import { getDb } from '../db/client.js';
import { authMiddleware } from '../middleware/auth.js';
import { getChannelDetails, getChannelVideos } from '../services/youtube-api.js';

export async function competitorRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware);

  // GET /competitors
  app.get('/competitors', async () => {
    const db = getDb();
    const competitors = db.prepare('SELECT * FROM competitors ORDER BY subscriber_count DESC').all();
    return competitors;
  });

  // POST /competitors -- add by channel URL or ID
  app.post('/competitors', async (request) => {
    const { channel_url, channel_id: rawId } = request.body as any;

    // Extract channel ID from URL if provided
    let channelId = rawId;
    if (channel_url) {
      const match = channel_url.match(/channel\/(UC[\w-]+)/);
      if (match) {
        channelId = match[1];
      } else {
        // Try handle-based lookup
        const handle = channel_url.match(/@([\w-]+)/)?.[1];
        if (handle) {
          // Search for channel by handle
          const { searchChannels } = await import('../services/youtube-api.js');
          const results = await searchChannels(`@${handle}`, 1);
          channelId = results[0]?.channelId;
        }
      }
    }

    if (!channelId) return { detail: 'Could not resolve channel ID' };

    const details = await getChannelDetails(channelId);
    if (!details) return { detail: 'Channel not found' };

    const db = getDb();
    try {
      db.prepare(`
        INSERT INTO competitors (channel_id, name, handle, subscriber_count, video_count, thumbnail)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(channelId, details.name, details.handle, details.subscriberCount, details.videoCount, details.thumbnail || null);
    } catch (err: any) {
      if (err.message.includes('UNIQUE')) return { detail: 'Channel already tracked' };
      throw err;
    }

    // Fetch initial videos
    const videos = await getChannelVideos(channelId, 1000);
    const comp = db.prepare('SELECT id FROM competitors WHERE channel_id = ?').get(channelId) as any;
    const upsert = db.prepare(`
      INSERT OR IGNORE INTO competitor_videos (competitor_id, video_id, title, published_at, thumbnail_url, views, likes, comments, duration_seconds)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const v of videos) {
      if (v.durationSeconds <= 60) continue;
      upsert.run(comp.id, v.videoId, v.title, v.publishedAt, v.thumbnailUrl, v.views, v.likes, v.comments, v.durationSeconds);
    }

    return { ok: true, name: details.name, videos_synced: videos.length };
  });

  // DELETE /competitors/:id
  app.delete('/competitors/:id', async (request) => {
    const { id } = request.params as { id: string };
    const db = getDb();
    db.prepare('DELETE FROM competitors WHERE id = ?').run(parseInt(id));
    return { ok: true };
  });

  // GET /competitors/:id/videos
  app.get('/competitors/:id/videos', async (request) => {
    const { id } = request.params as { id: string };
    const db = getDb();
    const videos = db.prepare(
      'SELECT * FROM competitor_videos WHERE competitor_id = ? AND duration_seconds > 180 ORDER BY published_at DESC LIMIT 200'
    ).all(parseInt(id));
    return videos;
  });

  // GET /competitors/:id/analysis — full channel breakdown
  app.get('/competitors/:id/analysis', async (request) => {
    const { id } = request.params as { id: string };
    const { since, content_type } = request.query as { since?: string; content_type?: string };
    const db = getDb();

    const comp = db.prepare('SELECT * FROM competitors WHERE id = ?').get(parseInt(id)) as any;
    if (!comp) return { detail: 'Not found' };

    let sql = 'SELECT * FROM competitor_videos WHERE competitor_id = ? AND duration_seconds > 180';
    const params: any[] = [parseInt(id)];
    if (since) { sql += ' AND published_at >= ?'; params.push(since); }
    if (content_type === 'tntl') {
      sql += " AND title LIKE '%TRY NOT TO LAUGH%'";
    } else if (content_type === 'podcast') {
      sql += " AND title NOT LIKE '%TRY NOT TO LAUGH%'";
    }
    sql += ' ORDER BY published_at DESC';
    const videos = db.prepare(sql).all(...params) as any[];

    if (videos.length === 0) return { channel: comp, analysis: null };

    const viewsSorted = [...videos].sort((a, b) => b.views - a.views);
    const avgViews = videos.reduce((s: number, v: any) => s + v.views, 0) / videos.length;
    const avgLikes = videos.reduce((s: number, v: any) => s + v.likes, 0) / videos.length;
    const avgComments = videos.reduce((s: number, v: any) => s + v.comments, 0) / videos.length;
    const medianViews = viewsSorted[Math.floor(viewsSorted.length / 2)]?.views || 0;

    // Outliers (viral hits — top 10% by views)
    const aboveAvg = viewsSorted.filter((v: any) => v.views > avgViews);
    const outliers = aboveAvg.slice(0, 20).map((v: any) => ({
      ...v,
      multiplier: +(v.views / avgViews).toFixed(1),
    }));

    // Underperformers (bottom 10%)
    // Only show videos below average as underperformers
    const belowAvg = viewsSorted.filter((v: any) => v.views < avgViews);
    // belowAvg is sorted desc (from viewsSorted), reverse to get lowest first
    const underperformers = belowAvg.reverse().slice(0, 20).map((v: any) => ({
      ...v,
      percentOfAvg: Math.round((v.views / avgViews) * 100),
    }));

    // Title patterns analysis
    const titlePatterns: Record<string, { count: number; avgViews: number; examples: string[] }> = {};
    const patternChecks = [
      { name: 'Question titles', test: (t: string) => t.includes('?') },
      { name: 'ALL CAPS words', test: (t: string) => /[A-Z]{4,}/.test(t) },
      { name: 'Numbers in title', test: (t: string) => /\d/.test(t) },
      { name: 'Exclamation mark', test: (t: string) => t.includes('!') },
      { name: 'Short titles (1-5 words)', test: (t: string) => t.split(/\s+/).length <= 5 },
      { name: 'Long titles (10+ words)', test: (t: string) => t.split(/\s+/).length >= 10 },
      { name: 'Colon or dash separator', test: (t: string) => /[:\-—|]/.test(t) },
      { name: 'Emotional words', test: (t: string) => /worst|best|crazy|insane|shocking|embarrassing|hilarious|awkward/i.test(t) },
    ];

    for (const p of patternChecks) {
      const matches = videos.filter((v: any) => p.test(v.title));
      if (matches.length >= 2) {
        titlePatterns[p.name] = {
          count: matches.length,
          avgViews: Math.round(matches.reduce((s: number, v: any) => s + v.views, 0) / matches.length),
          examples: matches.slice(0, 3).map((v: any) => v.title),
        };
      }
    }

    // Thumbnail packaging analysis (what we can infer from titles)
    // Group by common title word pairs to find content themes
    const stopWords = new Set(['the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'was', 'one', 'our', 'out', 'has', 'how', 'its', 'new', 'now', 'see', 'who', 'did', 'get', 'got', 'had', 'him', 'let', 'say', 'she', 'too', 'use', 'with', 'from', 'this', 'that', 'they', 'have', 'been', 'their', 'what', 'when', 'about', 'would', 'there', 'could', 'than', 'then', 'some', 'just', 'most', 'also', 'into', 'over', 'only', 'your', 'will', 'been', 'does', 'dont', 'each', 'even', 'every', 'first', 'here', 'know', 'like', 'make', 'made', 'many', 'much', 'need', 'never', 'next', 'really', 'should', 'still', 'take', 'tell', 'thing', 'think', 'time', 'very', 'want', 'well', 'were', 'what', 'will', 'episode', 'part', 'podcast', 'react', 'reacting', 'watch', 'video', 'best', 'worst', 'ever', 'back', 'going', 'come', 'laugh', 'full', 'funny', 'more', 'last', 'week']);
    const themes = new Map<string, { count: number; totalViews: number; videos: any[] }>();

    for (const v of videos) {
      const words = v.title.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/)
        .filter((w: string) => w.length > 3 && !stopWords.has(w));
      for (const word of words) {
        if (!themes.has(word)) themes.set(word, { count: 0, totalViews: 0, videos: [] });
        const t = themes.get(word)!;
        t.count++;
        t.totalViews += v.views;
        if (t.videos.length < 3) t.videos.push({ title: v.title, views: v.views });
      }
    }

    const contentThemes = [...themes.entries()]
      .filter(([, d]) => d.count >= Math.min(3, Math.max(2, Math.floor(videos.length * 0.1))))
      .map(([word, d]) => ({
        theme: word,
        videoCount: d.count,
        avgViews: Math.round(d.totalViews / d.count),
        topVideos: d.videos.sort((a: any, b: any) => b.views - a.views),
      }))
      .sort((a, b) => b.avgViews - a.avgViews)
      .slice(0, 15);

    // Publishing frequency
    const dates = videos.map((v: any) => v.published_at).filter(Boolean).sort();
    const recentVideos = videos.filter((v: any) => {
      const d = new Date(v.published_at);
      return d > new Date(Date.now() - 90 * 86400000);
    });
    const postsPerWeek = recentVideos.length / 13; // 90 days = ~13 weeks

    // Engagement rate
    const avgEngagementRate = videos.reduce((s: number, v: any) => {
      const rate = v.views > 0 ? ((v.likes + v.comments) / v.views) * 100 : 0;
      return s + rate;
    }, 0) / videos.length;

    // Compare to our channel
    let comparison = null;
    try {
      const ourVideos = db.prepare('SELECT view_count, like_count, comment_count FROM yt.videos LIMIT 250').all() as any[];
      if (ourVideos.length > 0) {
        const ourAvgViews = ourVideos.reduce((s: number, v: any) => s + v.view_count, 0) / ourVideos.length;
        const ourAvgLikes = ourVideos.reduce((s: number, v: any) => s + v.like_count, 0) / ourVideos.length;
        comparison = {
          ourAvgViews: Math.round(ourAvgViews),
          theirAvgViews: Math.round(avgViews),
          viewsDiff: Math.round(((avgViews - ourAvgViews) / ourAvgViews) * 100),
          ourAvgLikes: Math.round(ourAvgLikes),
          theirAvgLikes: Math.round(avgLikes),
        };
      }
    } catch {}

    // --- Per-TYPE breakdown (duration-based, all in code = free), each type read
    // against OUR channel's equivalent. Competitors mix full episodes, clips and
    // shorts that perform very differently — and their podcast vs our podcast is
    // the sharpest growth signal.
    const allForType = db.prepare(
      `SELECT duration_seconds, views FROM competitor_videos WHERE competitor_id = ?${since ? ' AND published_at >= ?' : ''}`
    ).all(...(since ? [parseInt(id), since] : [parseInt(id)])) as any[];
    const typeOf = (d: number) => (d < 90 ? 'short' : d >= 1500 ? 'podcast' : 'clip');
    const buckets: Record<string, number[]> = { podcast: [], clip: [], short: [] };
    for (const v of allForType) buckets[typeOf(v.duration_seconds || 0)].push(v.views || 0);
    const ourAvg = (cat: string) => { const r = db.prepare(`SELECT AVG(view_count) a FROM yt.videos WHERE category = ? AND view_count > 0`).get(cat) as any; return Math.round(r?.a || 0); };
    const ourPodcast = ourAvg('podcast'), ourReaction = ourAvg('reaction');
    const mean = (a: number[]) => (a.length ? Math.round(a.reduce((s, x) => s + x, 0) / a.length) : 0);
    const median = (a: number[]) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
    const byType = (['podcast', 'clip', 'short'] as const).filter(t => buckets[t].length).map(t => {
      const theirAvg = mean(buckets[t]);
      const ours = t === 'podcast' ? ourPodcast : ourReaction; // clips/shorts compare to our reaction content
      const oursLabel = t === 'podcast' ? 'our podcast' : 'our reaction';
      return { type: t, count: buckets[t].length, avgViews: theirAvg, medianViews: median(buckets[t]), bestViews: Math.max(...buckets[t]), vsOurs: ours, vsOursLabel: oursLabel, ratio: ours > 0 ? +(theirAvg / ours).toFixed(1) : null };
    });

    return {
      channel: comp,
      summary: {
        totalVideos: videos.length,
        avgViews: Math.round(avgViews),
        medianViews,
        avgLikes: Math.round(avgLikes),
        avgComments: Math.round(avgComments),
        postsPerWeek: +postsPerWeek.toFixed(1),
        avgEngagementRate: +avgEngagementRate.toFixed(2),
        firstVideo: dates[0],
        latestVideo: dates[dates.length - 1],
      },
      byType,
      ourBenchmark: { podcast: ourPodcast, reaction: ourReaction },
      outliers,
      underperformers,
      titlePatterns,
      contentThemes,
      comparison,
      recentVideos: videos.slice(0, 20),
    };
  });

  // GET /competitors/summary — compare all competitors side by side
  app.get('/competitors/summary', async (request) => {
    const db = getDb();
    const comps = db.prepare('SELECT * FROM competitors ORDER BY subscriber_count DESC').all() as any[];

    const summaries = comps.map((comp: any) => {
      const videos = db.prepare(
        'SELECT * FROM competitor_videos WHERE competitor_id = ? AND duration_seconds > 180 ORDER BY views DESC'
      ).all(comp.id) as any[];

      if (videos.length === 0) return { ...comp, stats: null };

      const avgViews = Math.round(videos.reduce((s: number, v: any) => s + v.views, 0) / videos.length);
      const avgLikes = Math.round(videos.reduce((s: number, v: any) => s + v.likes, 0) / videos.length);
      const avgComments = Math.round(videos.reduce((s: number, v: any) => s + v.comments, 0) / videos.length);
      const medianViews = videos[Math.floor(videos.length / 2)]?.views || 0;
      const topVideo = videos[0];
      const avgDuration = Math.round(videos.reduce((s: number, v: any) => s + v.duration_seconds, 0) / videos.length);

      // Posting frequency (last 90 days)
      const recent = videos.filter((v: any) => v.published_at >= new Date(Date.now() - 90 * 86400000).toISOString().split('T')[0]);
      const postsPerWeek = +(recent.length / 13).toFixed(1);

      // Engagement rate
      const avgEngagement = +(videos.reduce((s: number, v: any) => {
        return s + (v.views > 0 ? ((v.likes + v.comments) / v.views) * 100 : 0);
      }, 0) / videos.length).toFixed(2);

      // Common title words
      const wordCounts = new Map<string, number>();
      const stopWords = new Set(['the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'was', 'one', 'our', 'out', 'has', 'how', 'its', 'new', 'now', 'see', 'who', 'did', 'get', 'got', 'had', 'him', 'let', 'say', 'she', 'too', 'use', 'with', 'from', 'this', 'that', 'they', 'have', 'been', 'their', 'what', 'when', 'about', 'would', 'there', 'could', 'than', 'then', 'some', 'just', 'most', 'also', 'into', 'over', 'only', 'your', 'will', 'does', 'dont', 'each', 'even', 'every', 'first', 'here', 'know', 'like', 'make', 'made', 'many', 'much', 'need', 'never', 'next', 'really', 'should', 'still', 'take', 'tell', 'thing', 'think', 'time', 'very', 'want', 'well', 'were', 'will', 'episode', 'part', 'podcast', 'react', 'reacting', 'watch', 'video', 'best', 'worst', 'ever', 'back', 'going', 'come', 'laugh', 'full', 'funny', 'more', 'last', 'week']);
      for (const v of videos) {
        const words = v.title.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter((w: string) => w.length > 3 && !stopWords.has(w));
        for (const w of words) wordCounts.set(w, (wordCounts.get(w) || 0) + 1);
      }
      const topWords = [...wordCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([w, c]) => ({ word: w, count: c }));

      return {
        ...comp,
        stats: {
          videoCount: videos.length,
          avgViews, medianViews, avgLikes, avgComments,
          avgDuration, postsPerWeek, avgEngagement,
          topVideo: { title: topVideo.title, views: topVideo.views, thumbnail_url: topVideo.thumbnail_url },
          topWords,
        },
      };
    });

    // Find common patterns across all competitors
    const allTopWords = new Map<string, number>();
    for (const s of summaries) {
      if (!s.stats) continue;
      for (const tw of s.stats.topWords) {
        allTopWords.set(tw.word, (allTopWords.get(tw.word) || 0) + 1);
      }
    }
    const commonWords = [...allTopWords.entries()]
      .filter(([, count]) => count >= 2)
      .sort((a, b) => b[1] - a[1])
      .map(([word, channels]) => ({ word, usedByChannels: channels }));

    // Our channel stats for comparison
    let ourStats: any = null;
    try {
      // Get our subscriber count from YouTube API
      let ourSubs = 0;
      try {
        const { getChannelDetails } = await import('../services/youtube-api.js');
        const { config: appConfig } = await import('../config.js');
        const ch = await getChannelDetails(appConfig.youtubeChannelId);
        if (ch) ourSubs = ch.subscriberCount;
      } catch {}

      const ourVideos = db.prepare('SELECT view_count, like_count, comment_count, duration_seconds, publish_date FROM yt.videos WHERE duration_seconds > 180 ORDER BY publish_date DESC LIMIT 500').all() as any[];
      if (ourVideos.length > 0) {
        const sorted = [...ourVideos].sort((a: any, b: any) => a.view_count - b.view_count);
        const recent = ourVideos.filter((v: any) => v.publish_date >= new Date(Date.now() - 90 * 86400000).toISOString().split('T')[0]);
        ourStats = {
          subscriberCount: ourSubs,
          avgViews: Math.round(ourVideos.reduce((s: number, v: any) => s + v.view_count, 0) / ourVideos.length),
          medianViews: sorted[Math.floor(sorted.length / 2)]?.view_count || 0,
          avgLikes: Math.round(ourVideos.reduce((s: number, v: any) => s + v.like_count, 0) / ourVideos.length),
          avgComments: Math.round(ourVideos.reduce((s: number, v: any) => s + v.comment_count, 0) / ourVideos.length),
          avgDuration: Math.round(ourVideos.reduce((s: number, v: any) => s + v.duration_seconds, 0) / ourVideos.length),
          postsPerWeek: +(recent.length / 13).toFixed(1),
          avgEngagement: +(ourVideos.reduce((s: number, v: any) => s + (v.view_count > 0 ? ((v.like_count + v.comment_count) / v.view_count) * 100 : 0), 0) / ourVideos.length).toFixed(2),
          videoCount: ourVideos.length,
        };
      }
    } catch {}

    // All title patterns across all competitors combined
    const allTitlePatterns: Record<string, { count: number; avgViews: number; channels: number }> = {};
    const patternChecks = [
      { name: 'Question titles', test: (t: string) => t.includes('?') },
      { name: 'ALL CAPS words', test: (t: string) => /[A-Z]{4,}/.test(t) },
      { name: 'Numbers in title', test: (t: string) => /\d/.test(t) },
      { name: 'Exclamation mark', test: (t: string) => t.includes('!') },
      { name: 'Short titles (1-5 words)', test: (t: string) => t.split(/\s+/).length <= 5 },
      { name: 'Colon or dash', test: (t: string) => /[:\-—|]/.test(t) },
    ];
    for (const s of summaries) {
      if (!s.stats) continue;
      const vids = db.prepare('SELECT title, views FROM competitor_videos WHERE competitor_id = ? AND duration_seconds > 180').all(s.id) as any[];
      for (const p of patternChecks) {
        const matches = vids.filter((v: any) => p.test(v.title));
        if (matches.length >= 3) {
          if (!allTitlePatterns[p.name]) allTitlePatterns[p.name] = { count: 0, avgViews: 0, channels: 0 };
          const avg = Math.round(matches.reduce((sum: number, v: any) => sum + v.views, 0) / matches.length);
          allTitlePatterns[p.name].count += matches.length;
          allTitlePatterns[p.name].avgViews = Math.round((allTitlePatterns[p.name].avgViews * allTitlePatterns[p.name].channels + avg) / (allTitlePatterns[p.name].channels + 1));
          allTitlePatterns[p.name].channels++;
        }
      }
    }

    return { competitors: summaries, commonWords, ourStats, allTitlePatterns };
  });

  // POST /competitors/:id/sync — sync a single competitor
  app.post('/competitors/:id/sync', async (request) => {
    const { id } = request.params as { id: string };
    const db = getDb();
    const comp = db.prepare('SELECT * FROM competitors WHERE id = ?').get(parseInt(id)) as any;
    if (!comp) return { detail: 'Not found' };

    const details = await getChannelDetails(comp.channel_id);
    if (details) {
      db.prepare(`UPDATE competitors SET name = ?, handle = ?, subscriber_count = ?, video_count = ?, thumbnail = ?, last_synced_at = datetime('now') WHERE id = ?`)
        .run(details.name, details.handle, details.subscriberCount, details.videoCount, details.thumbnail || null, comp.id);
    }

    const videos = await getChannelVideos(comp.channel_id, 1000);
    const upsert = db.prepare(`INSERT OR REPLACE INTO competitor_videos (competitor_id, video_id, title, published_at, thumbnail_url, views, likes, comments, duration_seconds, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`);
    let synced = 0;
    for (const v of videos) {
      if (v.durationSeconds <= 60) continue;
      upsert.run(comp.id, v.videoId, v.title, v.publishedAt, v.thumbnailUrl, v.views, v.likes, v.comments, v.durationSeconds);
      synced++;
    }

    return { ok: true, synced };
  });

  // POST /competitors/discover — writes suggestions, never auto-adds
  app.post('/competitors/discover', async () => {
    const { runDiscoverySuggestions } = await import('../services/competitor-discovery.js');
    const count = await runDiscoverySuggestions();
    return { ok: true, suggested: count };
  });

  // GET /competitors/suggestions — pending channel suggestions for review
  app.get('/competitors/suggestions', async () => {
    const db = getDb();
    return db.prepare(`SELECT * FROM competitor_suggestions ORDER BY suggested_at DESC`).all();
  });

  // POST /competitors/suggestions/:id/approve — add to competitors + fetch videos
  app.post('/competitors/suggestions/:id/approve', async (request) => {
    const { id } = request.params as { id: string };
    const db = getDb();
    const sug = db.prepare(`SELECT * FROM competitor_suggestions WHERE id = ?`).get(parseInt(id)) as any;
    if (!sug) return { detail: 'Not found' };

    try {
      db.prepare(`
        INSERT INTO competitors (channel_id, name, handle, subscriber_count, video_count, thumbnail)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(sug.channel_id, sug.name, sug.handle, sug.subscriber_count, sug.video_count, sug.thumbnail);
    } catch (err: any) {
      if (err.message.includes('UNIQUE')) {
        db.prepare(`UPDATE competitor_suggestions SET status = 'approved' WHERE id = ?`).run(sug.id);
        return { detail: 'Channel already tracked' };
      }
      throw err;
    }

    db.prepare(`UPDATE competitor_suggestions SET status = 'approved' WHERE id = ?`).run(sug.id);

    const comp = db.prepare('SELECT id FROM competitors WHERE channel_id = ?').get(sug.channel_id) as any;
    const videos = await getChannelVideos(sug.channel_id, 1000);
    const upsert = db.prepare(`
      INSERT OR IGNORE INTO competitor_videos (competitor_id, video_id, title, published_at, thumbnail_url, views, likes, comments, duration_seconds)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    let synced = 0;
    for (const v of videos) {
      if (v.durationSeconds <= 60) continue;
      upsert.run(comp.id, v.videoId, v.title, v.publishedAt, v.thumbnailUrl, v.views, v.likes, v.comments, v.durationSeconds);
      synced++;
    }

    return { ok: true, name: sug.name, videos_synced: synced };
  });

  // POST /competitors/suggestions/:id/dismiss
  app.post('/competitors/suggestions/:id/dismiss', async (request) => {
    const { id } = request.params as { id: string };
    const db = getDb();
    db.prepare(`UPDATE competitor_suggestions SET status = 'dismissed' WHERE id = ?`).run(parseInt(id));
    return { ok: true };
  });

  // GET /competitors/growth-findings — pre-computed findings for the dashboard
  app.get('/competitors/growth-findings', async (request) => {
    const { limit: rawLimit } = request.query as { limit?: string };
    const limit = Math.min(50, parseInt(rawLimit || '10'));
    const db = getDb();
    return db.prepare(`
      SELECT id, competitor_id, competitor_name, finding_type, headline, detail, uplift, computed_at, evidence_json
      FROM competitor_growth_findings
      ORDER BY uplift DESC
      LIMIT ?
    `).all(limit);
  });

  // POST /competitors/growth-findings/refresh — recompute now (adds examples).
  app.post('/competitors/growth-findings/refresh', async () => {
    const { computeCompetitorGrowth } = await import('../services/competitor-growth.js');
    await computeCompetitorGrowth();
    return { ok: true };
  });
}
