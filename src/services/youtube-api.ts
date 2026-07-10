/**
 * YouTube Data API service for A/B testing operations.
 * Handles thumbnail upload/download, title updates, and video stats.
 */

import { google } from 'googleapis';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { config } from '../config.js';
import { getAccessToken } from './youtube-auth.js';

/**
 * Rotate through API keys to spread quota usage.
 */
let _keyIndex = 0;
export function getApiKey(): string {
  const keys = config.youtubeApiKeys;
  if (keys.length === 0) return config.youtubeApiKey;
  const key = keys[_keyIndex % keys.length];
  _keyIndex++;
  return key;
}

function getAuthClient() {
  const oauth2 = new google.auth.OAuth2(
    config.google.clientId,
    config.google.clientSecret,
  );
  return oauth2;
}

async function getAuthedYoutube() {
  const accessToken = await getAccessToken();
  const auth = getAuthClient();
  auth.setCredentials({ access_token: accessToken });
  return google.youtube({ version: 'v3', auth });
}

async function getAuthedYoutubeForChannel(channel: 'main' | 'clips' = 'main') {
  let accessToken: string;
  if (channel === 'clips') {
    const { getClipsAccessToken } = await import('./youtube-auth.js');
    accessToken = await getClipsAccessToken();
  } else {
    accessToken = await getAccessToken();
  }
  const auth = getAuthClient();
  auth.setCredentials({ access_token: accessToken });
  return google.youtube({ version: 'v3', auth });
}

// ---- WRITE-quota rotation across main-channel OAuth projects ----------------
// The Data API fallback for writes (title/thumbnail) shares one project's 10k/day
// quota. With extra project token files configured (YT_WRITE_TOKEN_PATHS), a
// quota error hops to the next project and retries, so the fallback survives an
// exhausted project. Primary writes (internal Studio + Firefox) stay quota-free.
let _writeIdx = 0;
function writeTokenPaths(): string[] {
  return [config.ytAnalyticsTokenPath, ...config.ytWriteTokenPaths].filter(Boolean);
}
function isQuotaError(e: any): boolean {
  const s = JSON.stringify(e?.errors || e?.response?.data?.error || e?.message || '') + String(e?.message || '');
  return /quota|dailyLimitExceeded|rateLimitExceeded|exceeded your/i.test(s);
}
async function authedWriteClient(idx: number) {
  const paths = writeTokenPaths();
  const { getAccessTokenFrom } = await import('./youtube-auth.js');
  const token = await getAccessTokenFrom(paths[idx % paths.length]);
  const auth = getAuthClient();
  auth.setCredentials({ access_token: token });
  return google.youtube({ version: 'v3', auth });
}
async function writeWithRotation<T>(op: (yt: any) => Promise<T>): Promise<T> {
  const paths = writeTokenPaths();
  let lastErr: any;
  for (let n = 0; n < Math.max(1, paths.length); n++) {
    const idx = _writeIdx;
    try { return await op(await authedWriteClient(idx)); }
    catch (e: any) {
      lastErr = e;
      if (isQuotaError(e) && paths.length > 1) {
        _writeIdx = (_writeIdx + 1) % paths.length;
        console.warn(`[yt-api] write quota on OAuth project #${idx}, rotating to #${_writeIdx}`);
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

/**
 * Upload a thumbnail image to a YouTube video.
 * @param channel — 'main' (default) uses Studio for >2MB, 'clips' always uses API
 */
export async function uploadThumbnail(videoId: string, imagePath: string, channel: 'main' | 'clips' = 'main'): Promise<void> {
  const imageData = readFileSync(imagePath);
  const imageSize = imageData.length;

  // Clips channel: always use API (Studio is signed into main channel only)
  // Always convert to JPEG — PNG→JPEG alone often saves 80%+ of file size
  if (channel === 'clips') {
    const sharp = (await import('sharp')).default;
    let quality = 92;
    let body = await sharp(imageData).jpeg({ quality }).toBuffer();
    console.log(`[yt-api] Clips: converted to JPEG ${(imageSize / 1024 / 1024).toFixed(1)}MB → ${(body.length / 1024 / 1024).toFixed(1)}MB (q${quality})`);
    while (body.length > 2 * 1024 * 1024 && quality > 30) {
      quality -= 10;
      body = await sharp(imageData).jpeg({ quality }).toBuffer();
    }
    if (body.length > 2 * 1024 * 1024) {
      throw new Error(`Thumbnail still ${(body.length / 1024 / 1024).toFixed(1)}MB after compression — cannot upload via API`);
    }
    if (quality < 92) {
      console.log(`[yt-api] Clips: further compressed to ${(body.length / 1024 / 1024).toFixed(1)}MB (q${quality})`);
    }
    const yt = await getAuthedYoutubeForChannel('clips');
    await yt.thumbnails.set({ videoId, media: { mimeType: 'image/jpeg', body: body as any } });
    console.log(`[yt-api] Clips thumbnail uploaded for ${videoId}`);
    return;
  }

  // Main channel: ALWAYS try the Studio (Firefox) upload first — full quality
  // AND zero Data API quota. The old "<2MB goes straight to the API" shortcut
  // burned ~50 quota units per rotation and stalled test 191 the moment the
  // daily quota ran out (2026-07-08). The API is a fallback only.
  console.log(`[yt-api] Uploading ${(imageSize / 1024 / 1024).toFixed(1)}MB via Studio (quota-free)`);
  try {
    const { uploadThumbnailViaStudio } = await import('./youtube-studio-upload.js');
    const success = await uploadThumbnailViaStudio(videoId, imagePath);
    if (success) return;
    console.log(`[yt-api] Studio upload failed for ${videoId}`);
  } catch (err: any) {
    // Firefox failed (often an expired Studio session). Per the owner's call,
    // keep the test moving with an API upload rather than stalling.
    if ((err as any).sessionExpired) console.warn(`[yt-api] Studio session expired for ${videoId} — falling back to the API so the test continues. Re-login to Firefox for full quality.`);
    else console.log(`[yt-api] Studio upload error: ${err.message}`);
  }

  // Fallback: Data API (costs quota; compresses anything over the 2MB API cap).
  console.log('[yt-api] Falling back to Data API');
  let body: Buffer = imageData;
  if (imageSize > 2 * 1024 * 1024) {
    const sharp = (await import('sharp')).default;
    let quality = 92;
    body = await sharp(imageData).resize(1920, 1080, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality }).toBuffer();
    while (body.length > 2 * 1024 * 1024 && quality > 40) {
      quality -= 5;
      body = await sharp(imageData).resize(1920, 1080, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality }).toBuffer();
    }
    console.log(`[yt-api] Compressed: ${(imageSize / 1024 / 1024).toFixed(1)}MB → ${(body.length / 1024).toFixed(0)}KB (q${quality})`);
  }
  await writeWithRotation(yt => yt.thumbnails.set({ videoId, media: { mimeType: 'image/jpeg', body: body as any } }));
  console.log(`[yt-api] Thumbnail uploaded for ${videoId} (API fallback)`);
}

/**
 * Download the current thumbnail of a video and save locally.
 * Returns the saved file path.
 */
export async function downloadThumbnail(videoId: string, thumbnailUrl: string): Promise<Buffer> {
  const res = await fetch(thumbnailUrl);
  if (!res.ok) throw new Error(`Failed to download thumbnail: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  return buffer;
}

/**
 * Update a video's title via YouTube Data API.
 */
export async function updateVideoTitle(videoId: string, newTitle: string): Promise<void> {
  // Primary: Studio's internal metadata_update — quota-FREE (the Data API path
  // costs ~51 units per rotation and exhausted the daily quota on 2026-07-08,
  // stalling every title rotation for hours). Verified working with the same
  // SAPISID cookie auth reach-refresh uses; titles are not BotGuard-gated
  // (thumbnails are, which is why thumbnails still go through Firefox).
  try {
    const { updateTitleInternal } = await import('./studio-fetch.js');
    await updateTitleInternal(videoId, newTitle);
    console.log(`[yt-api] Title updated for ${videoId} via internal API: "${newTitle}"`);
    return;
  } catch (e: any) {
    console.error(`[yt-api] internal title update failed (${e?.message}) — falling back to Data API`);
  }

  await writeWithRotation(async yt => {
    // Preserve the other snippet fields.
    const current = await yt.videos.list({ part: ['snippet'], id: [videoId] });
    const snippet = current.data.items?.[0]?.snippet;
    if (!snippet) throw new Error(`Video ${videoId} not found`);
    return yt.videos.update({
      part: ['snippet'],
      requestBody: {
        id: videoId,
        snippet: { ...snippet, title: newTitle, categoryId: snippet.categoryId || '22' },
      },
    });
  });

  console.log(`[yt-api] Title updated for ${videoId}: "${newTitle}"`);
}

/**
 * Get current video details (title, description, tags, thumbnail).
 */
export async function getVideoDetails(videoId: string) {
  const yt = google.youtube({ version: 'v3', auth: getApiKey() });
  const res = await yt.videos.list({
    part: ['snippet', 'contentDetails', 'statistics'],
    id: [videoId],
  });
  return res.data.items?.[0] || null;
}

/**
 * Get real-time view count for a video.
 */
export async function getVideoStats(videoId: string) {
  const yt = google.youtube({ version: 'v3', auth: getApiKey() });
  const res = await yt.videos.list({
    part: ['statistics'],
    id: [videoId],
  });
  const stats = res.data.items?.[0]?.statistics;
  return {
    views: parseInt(stats?.viewCount || '0'),
    likes: parseInt(stats?.likeCount || '0'),
    comments: parseInt(stats?.commentCount || '0'),
  };
}

/**
 * Search for YouTube channels by keyword (for competitor discovery).
 */
export async function searchChannels(query: string, maxResults = 20) {
  const yt = google.youtube({ version: 'v3', auth: getApiKey() });
  const res = await yt.search.list({
    part: ['snippet'],
    q: query,
    type: ['channel'],
    maxResults,
  });
  return res.data.items?.map(item => ({
    channelId: item.snippet?.channelId || item.id?.channelId || '',
    name: item.snippet?.title || '',
    description: item.snippet?.description || '',
    thumbnail: item.snippet?.thumbnails?.default?.url || '',
  })) || [];
}

/**
 * Get channel details (subscriber count, video count).
 */
export async function getChannelDetails(channelId: string) {
  const yt = google.youtube({ version: 'v3', auth: getApiKey() });
  const res = await yt.channels.list({
    part: ['snippet', 'statistics'],
    id: [channelId],
  });
  const ch = res.data.items?.[0];
  if (!ch) return null;
  return {
    channelId,
    name: ch.snippet?.title || '',
    handle: ch.snippet?.customUrl || '',
    subscriberCount: parseInt(ch.statistics?.subscriberCount || '0'),
    videoCount: parseInt(ch.statistics?.videoCount || '0'),
    thumbnail: ch.snippet?.thumbnails?.default?.url || '',
  };
}

/**
 * Get recent videos from a channel.
 */
export async function getChannelVideos(channelId: string, maxResults = 500) {
  const yt = google.youtube({ version: 'v3', auth: getApiKey() });

  // Get uploads playlist
  const channelRes = await yt.channels.list({
    part: ['contentDetails'],
    id: [channelId],
  });
  const uploadsPlaylist = channelRes.data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploadsPlaylist) return [];

  // Paginate through all playlist items
  const allItems: any[] = [];
  let pageToken: string | undefined;
  const maxPages = Math.ceil(maxResults / 50);

  for (let page = 0; page < maxPages; page++) {
    const playlistRes = await yt.playlistItems.list({
      part: ['contentDetails', 'snippet'],
      playlistId: uploadsPlaylist,
      maxResults: 50,
      pageToken,
    });
    allItems.push(...(playlistRes.data.items || []));
    pageToken = playlistRes.data.nextPageToken || undefined;
    if (!pageToken) break;
  }

  if (!allItems.length) return [];

  // Get stats in batches of 50
  const allVideoIds = allItems.map(i => i.contentDetails?.videoId).filter(Boolean) as string[];
  const statsMap = new Map<string, any>();

  for (let i = 0; i < allVideoIds.length; i += 50) {
    const batch = allVideoIds.slice(i, i + 50);
    const statsRes = await yt.videos.list({
      part: ['statistics', 'contentDetails'],
      id: batch,
    });
    for (const v of statsRes.data.items || []) {
      statsMap.set(v.id!, v);
    }
  }

  return allItems.map(item => {
    const vid = item.contentDetails?.videoId || '';
    const stats = statsMap.get(vid);
    return {
      videoId: vid,
      title: item.snippet?.title || '',
      publishedAt: item.snippet?.publishedAt?.split('T')[0] || '',
      thumbnailUrl: item.snippet?.thumbnails?.high?.url || '',
      views: parseInt(stats?.statistics?.viewCount || '0'),
      likes: parseInt(stats?.statistics?.likeCount || '0'),
      comments: parseInt(stats?.statistics?.commentCount || '0'),
      durationSeconds: parseDuration(stats?.contentDetails?.duration || ''),
    };
  });
}

/**
 * Get comment threads for a video.
 */
export async function getVideoComments(videoId: string, maxResults = 100) {
  const yt = google.youtube({ version: 'v3', auth: getApiKey() });
  const res = await yt.commentThreads.list({
    part: ['snippet'],
    videoId,
    maxResults,
    order: 'time',
  });
  return res.data.items?.map(item => {
    const c = item.snippet?.topLevelComment?.snippet;
    return {
      commentId: item.id || '',
      author: c?.authorDisplayName || '',
      authorChannelUrl: c?.authorChannelUrl || '',
      authorProfileImage: c?.authorProfileImageUrl || '',
      content: c?.textDisplay || '',
      likeCount: c?.likeCount || 0,
      publishedAt: c?.publishedAt || '',
    };
  }) || [];
}

function parseDuration(iso: string): number {
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  return (parseInt(match[1] || '0') * 3600) +
         (parseInt(match[2] || '0') * 60) +
         parseInt(match[3] || '0');
}
