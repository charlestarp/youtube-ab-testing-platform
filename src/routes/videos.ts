import { FastifyInstance } from 'fastify';
import { google } from 'googleapis';
import { getDb } from '../db/client.js';
import { authMiddleware } from '../middleware/auth.js';
import { getAccessToken } from '../services/youtube-auth.js';
import { config } from '../config.js';

function parseDuration(iso: string): number {
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  return (parseInt(match[1] || '0') * 3600) + (parseInt(match[2] || '0') * 60) + parseInt(match[3] || '0');
}

export async function videoRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware);

  // GET /videos -- browse videos from youtube.db + scheduled videos from YouTube API
  // ?channel=clips to show clips channel videos instead
  app.get('/videos', async (request) => {
    const { search, category, limit, offset, include_scheduled, channel } = request.query as {
      search?: string; category?: string; limit?: string; offset?: string; include_scheduled?: string; channel?: string;
    };
    const db = getDb();
    const isClips = channel === 'clips';
    const clipsChannelId = process.env.YOUTUBE_CLIPS_CHANNEL_ID || 'UC36A0yALoD0LeRr7NoCCZtg';

    let videos: any[] = [];

    if (!isClips) {
      // Main channel — from youtube.db
      let sql = 'SELECT video_id, title, publish_date, thumbnail_url, duration_seconds, view_count, like_count, comment_count, category FROM yt.videos WHERE duration_seconds > 60';
      const params: any[] = [];

      // A pasted YouTube URL or bare 11-char video id should find the video —
      // Ali tried "link, video id, spelling title" and title-only matching
      // found nothing (2026-07-09).
      const idFromUrl = (search || '').match(/(?:youtu\.be\/|[?&]v=|\/shorts\/|\/live\/)([A-Za-z0-9_-]{11})/)?.[1];
      const bareId = /^[A-Za-z0-9_-]{11}$/.test((search || '').trim()) ? (search || '').trim() : null;
      const searchId = idFromUrl || bareId;

      if (searchId) {
        sql += ' AND video_id = ?';
        params.push(searchId);
      } else if (search) {
        sql += ' AND (title LIKE ? OR video_id = ?)';
        params.push(`%${search}%`, search.trim());
      }
      if (category) {
        sql += ' AND category = ?';
        params.push(category);
      }

      sql += ' ORDER BY publish_date DESC LIMIT ? OFFSET ?';
      params.push(parseInt(limit || '200'), parseInt(offset || '0'));

      try {
        videos = db.prepare(sql).all(...params) as any[];
      } catch (err: any) {
        if (!err.message.includes('no such table')) throw err;
      }

      // Pasted an id/URL that isn't in the local DB (it only holds ~350 of the
      // channel's ~1,700 videos — older ones mostly absent)? Fetch it straight
      // from YouTube so ANY video is selectable for a test.
      if (searchId && videos.length === 0) {
        try {
          const { getVideoDetails } = await import('../services/youtube-api.js');
          const d = await getVideoDetails(searchId);
          if (d?.snippet) {
            const durS = (() => { const m = String(d.contentDetails?.duration || '').match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/); return m ? (parseInt(m[1] || '0') * 3600 + parseInt(m[2] || '0') * 60 + parseInt(m[3] || '0')) : 0; })();
            videos = [{
              video_id: searchId,
              title: d.snippet.title,
              publish_date: (d.snippet.publishedAt || '').slice(0, 10),
              thumbnail_url: d.snippet.thumbnails?.high?.url || d.snippet.thumbnails?.default?.url || `https://i.ytimg.com/vi/${searchId}/hqdefault.jpg`,
              duration_seconds: durS,
              view_count: parseInt(d.statistics?.viewCount || '0'),
              like_count: parseInt(d.statistics?.likeCount || '0'),
              comment_count: parseInt(d.statistics?.commentCount || '0'),
              category: null,
            }];
          }
        } catch (e: any) { console.log('[videos] live lookup failed:', e?.message); }
      }
    }

    // Fetch from YouTube API — scheduled videos for main channel, or all videos for clips channel
    try {
      let accessToken: string;
      if (isClips) {
        // Use clips channel token
        const { getClipsAccessToken } = await import('../services/youtube-auth.js');
        accessToken = await getClipsAccessToken();
      } else {
        accessToken = await getAccessToken();
      }
      const auth = new google.auth.OAuth2(config.google.clientId, config.google.clientSecret);
      auth.setCredentials({ access_token: accessToken });
      const yt = google.youtube({ version: 'v3', auth });

      // Get uploads playlist — use mine:true for both since the token is channel-specific
      const channelRes = await yt.channels.list({ part: ['contentDetails'], mine: true });
      const uploadsPlaylist = channelRes.data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;

      if (uploadsPlaylist) {
        // Get recent items (includes scheduled/private)
        const playlistRes = await yt.playlistItems.list({
          part: ['contentDetails'],
          playlistId: uploadsPlaylist,
          maxResults: isClips ? 50 : 30,
        });

        const videoIds = playlistRes.data.items
          ?.map(i => i.contentDetails?.videoId)
          .filter(Boolean) as string[];

        if (videoIds?.length) {
          const existingIds = new Set(videos.map((v: any) => v.video_id));
          // For clips channel, fetch all; for main channel, only new ones
          const newIds = isClips ? videoIds : videoIds.filter(id => !existingIds.has(id));

          if (newIds.length > 0) {
            const detailRes = await yt.videos.list({
              part: ['snippet', 'status', 'contentDetails', 'statistics'],
              id: newIds,
            });

            for (const v of detailRes.data.items || []) {
              if (!v.id) continue;

              const dur = parseDuration(v.contentDetails?.duration || '');
              if (!isClips && dur <= 60) continue; // Filter very short videos for main channel
              // Filter out Shorts from main channel (under 3 min or has #Shorts in title)
              const title = v.snippet?.title || '';
              if (!isClips && (title.includes('#Shorts') || title.includes('#shorts') || (dur > 0 && dur <= 180))) continue;

              const privacy = v.status?.privacyStatus;
              const publishAt = v.status?.publishAt;
              const isScheduled = (privacy === 'private' && !!publishAt) || privacy === 'unlisted';

              // Apply search filter for clips channel
              if (search && !title.toLowerCase().includes(search.toLowerCase())) continue;

              videos.push({
                video_id: v.id,
                title,
                publish_date: publishAt?.split('T')[0] || v.snippet?.publishedAt?.split('T')[0] || '',
                thumbnail_url: v.snippet?.thumbnails?.high?.url || v.snippet?.thumbnails?.default?.url || '',
                duration_seconds: dur,
                view_count: parseInt(v.statistics?.viewCount || '0'),
                like_count: parseInt(v.statistics?.likeCount || '0'),
                comment_count: parseInt(v.statistics?.commentCount || '0'),
                category: isClips ? 'clips' : 'podcast',
                is_scheduled: isScheduled,
                scheduled_at: publishAt || null,
                privacy_status: privacy,
                channel: isClips ? 'clips' : 'main',
              });
            }
          }
        }
      }
    } catch (err: any) {
      console.log(`[videos] Could not fetch scheduled videos: ${err.message}`);
    }

    // Sort: scheduled first (by scheduled date), then published newest first
    videos.sort((a: any, b: any) => {
      // Scheduled videos always come first
      if (a.is_scheduled && !b.is_scheduled) return -1;
      if (!a.is_scheduled && b.is_scheduled) return 1;
      // Within each group, sort by date descending
      const dateA = a.scheduled_at || a.publish_date || '';
      const dateB = b.scheduled_at || b.publish_date || '';
      return dateB.localeCompare(dateA);
    });

    // Attach test history
    const testStmt = db.prepare(`
      SELECT id, test_type, status, created_at, completed_at
      FROM tests WHERE video_id = ? ORDER BY created_at DESC LIMIT 5
    `);

    return videos.map((v: any) => ({
      ...v,
      recent_tests: testStmt.all(v.video_id),
    }));
  });

  // GET /videos/:videoId -- single video with analytics
  app.get('/videos/:videoId', async (request) => {
    const { videoId } = request.params as { videoId: string };
    const db = getDb();

    try {
      const video = db.prepare('SELECT * FROM yt.videos WHERE video_id = ?').get(videoId);
      if (!video) return { detail: 'Video not found' };

      const analytics = db.prepare(`
        SELECT date, views, impressions, ctr, avg_view_duration, avg_view_pct, watch_time_hours, likes, subscribers_gained
        FROM yt.video_analytics WHERE video_id = ? ORDER BY date DESC LIMIT 90
      `).all(videoId);

      const tests = db.prepare('SELECT * FROM tests WHERE video_id = ? ORDER BY created_at DESC').all(videoId);

      return { video, analytics, tests };
    } catch (err: any) {
      if (err.message.includes('no such table')) {
        return { detail: 'YouTube database not available' };
      }
      throw err;
    }
  });
}
