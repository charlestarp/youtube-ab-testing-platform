/**
 * Set a video's custom thumbnail via the YouTube Studio INTERNAL API — no browser.
 *
 * Why this exists: the official Data API v3 `thumbnails.set` is hard-capped at 2MB, so it
 * CANNOT push the 50MB / 4K thumbnails YouTube Studio now allows (March 2026). The internal
 * Studio API is the only programmatic path to large thumbnails, and it lets us drop the
 * Playwright/Firefox uploader entirely.
 *
 * Auth + channel scoping are identical to the Reach CTR read ([[yt-internal-api-ctr]]):
 * load /video/<id>/edit to auto-scope the session to the owning channel, then call youtubei
 * with multi-hash SAPISIDHASH + the owning channel as X-Goog-PageId.
 *
 * Two upload modes:
 *  - inline (default): base64 data-URI inside metadata_update. Fine for typical thumbnails
 *    (a few MB). A 50MB image becomes a ~67MB JSON body, which the endpoint may reject.
 *  - resumable (large files): PUT bytes to upload.youtube.com/upload/studio (Google "scotty"),
 *    take the returned scottyResourceId, reference it in metadata_update. Used when the image
 *    exceeds `INLINE_MAX_BYTES`.
 */
import { createHash } from 'crypto';
import { copyFileSync } from 'fs';
import Database from 'better-sqlite3';
import path from 'path';

const ORIGIN = 'https://studio.youtube.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:140.0) Gecko/20100101 Firefox/140.0';
const COOKIE_DB = path.join(process.cwd(), 'data/firefox-studio-work/cookies.sqlite');
// Inline base64 (data-URI in metadata_update) is proven to work well past 8MB — verified
// 200 at 8.5MB. Keep it as the primary path up to a generous ceiling; the resumable scotty
// path is a fallback only for the very largest 4K files.
const INLINE_MAX_BYTES = 40 * 1024 * 1024;

function loadCookies(): Record<string, string> {
  const tmp = path.join('/tmp', `_fftn_${process.pid}.sqlite`);
  copyFileSync(COOKIE_DB, tmp);
  const cdb = new Database(tmp, { readonly: true });
  const cm: Record<string, string> = {};
  for (const r of cdb.prepare("SELECT name,value FROM moz_cookies WHERE host LIKE '%youtube.com%'").all() as any[]) cm[r.name] = r.value;
  cdb.close();
  return cm;
}

function sapisidHashHeader(cm: Record<string, string>): string {
  const ts = Math.floor(Date.now() / 1000);
  const mk = (x: string) => createHash('sha1').update(`${ts} ${x} ${ORIGIN}`).digest('hex');
  const parts: string[] = [];
  if (cm['SAPISID']) parts.push(`SAPISIDHASH ${ts}_${mk(cm['SAPISID'])}`);
  if (cm['__Secure-1PAPISID']) parts.push(`SAPISID1PHASH ${ts}_${mk(cm['__Secure-1PAPISID'])}`);
  if (cm['__Secure-3PAPISID']) parts.push(`SAPISID3PHASH ${ts}_${mk(cm['__Secure-3PAPISID'])}`);
  return parts.join(' ');
}

function extractObj(html: string, marker: string): any | null {
  const i = html.indexOf(marker);
  if (i < 0) return null;
  let j = html.indexOf('{', i), depth = 0, inStr = false, esc = false;
  for (let k = j; k < html.length; k++) {
    const c = html[k];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; }
    else { if (c === '"') inStr = true; else if (c === '{') depth++; else if (c === '}') { if (--depth === 0) { try { return JSON.parse(html.slice(j, k + 1)); } catch { return null; } } } }
  }
  return null;
}

interface ScopedSession { cm: Record<string, string>; cookieHeader: string; context: any; channelId: string; sessionIndex: string; }

/** Load /video/<id>/edit so the session is scoped to the owning channel; return auth bits. */
async function scopeToVideo(videoId: string): Promise<ScopedSession> {
  const cm = loadCookies();
  const cookieHeader = Object.entries(cm).map(([k, v]) => `${k}=${v}`).join('; ');
  const html = await (await fetch(`${ORIGIN}/video/${videoId}/edit`, { headers: { Cookie: cookieHeader, 'User-Agent': UA, Accept: 'text/html' }, redirect: 'follow' })).text();
  const channelId = (html.match(/"CHANNEL_ID":"([^"]*)"/) || [])[1];
  const sessionIndex = (html.match(/"SESSION_INDEX":"?([0-9]+)"?/) || [])[1] || '0';
  const context = extractObj(html, '"INNERTUBE_CONTEXT":');
  if (!channelId || !context) throw new Error(`studio-thumbnail: could not scope channel for ${videoId} (cookies stale / logged out?)`);
  return { cm, cookieHeader, context, channelId, sessionIndex };
}

function jsonHeaders(s: ScopedSession): Record<string, string> {
  return { 'Content-Type': 'application/json', Authorization: sapisidHashHeader(s.cm), Cookie: s.cookieHeader, 'X-Origin': ORIGIN, Origin: ORIGIN, 'User-Agent': UA, 'X-Goog-AuthUser': s.sessionIndex, 'X-Goog-PageId': s.channelId };
}

/** Upload bytes via Google "scotty" resumable; returns the scottyResourceId. */
async function scottyUpload(s: ScopedSession, image: Buffer, mime: string): Promise<string> {
  const startHeaders: Record<string, string> = {
    Authorization: sapisidHashHeader(s.cm), Cookie: s.cookieHeader, 'User-Agent': UA, Referer: ORIGIN, Origin: ORIGIN,
    'X-Goog-AuthUser': s.sessionIndex, 'X-Goog-PageId': s.channelId,
    'x-goog-upload-command': 'start', 'x-goog-upload-protocol': 'resumable',
    'x-goog-upload-header-content-length': String(image.length), 'x-goog-upload-header-content-type': mime,
    'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
  };
  const startRes = await fetch('https://upload.youtube.com/upload/studio', { method: 'POST', headers: startHeaders, body: '' });
  const uploadUrl = startRes.headers.get('x-goog-upload-url');
  if (!uploadUrl) throw new Error(`scotty: no upload URL (status ${startRes.status})`);
  const upRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: { Authorization: sapisidHashHeader(s.cm), Cookie: s.cookieHeader, 'User-Agent': UA, 'x-goog-upload-command': 'upload, finalize', 'x-goog-upload-offset': '0', 'Content-Type': mime },
    body: image as unknown as BodyInit,
  });
  let t = await upRes.text(); if (t.startsWith(")]}'")) t = t.slice(t.indexOf('\n') + 1);
  let rid: string | undefined;
  try { rid = JSON.parse(t)?.scottyResourceId; } catch {}
  if (!rid) rid = (t.match(/"scottyResourceId"\s*:\s*"([^"]+)"/) || [])[1];
  if (!rid) throw new Error(`scotty: no scottyResourceId (status ${upRes.status}): ${t.slice(0, 120)}`);
  return rid;
}

export interface SetThumbnailResult { videoId: string; channelId: string; mode: 'inline' | 'resumable'; status: number; ok: boolean; response: string; }

/**
 * Set the custom thumbnail for a video. `image` is the raw image bytes; `mime` e.g. image/jpeg.
 * Picks inline vs resumable automatically based on size.
 */
export async function setThumbnail(videoId: string, image: Buffer, mime = 'image/jpeg'): Promise<SetThumbnailResult> {
  const s = await scopeToVideo(videoId);
  const useResumable = image.length > INLINE_MAX_BYTES;

  let videoStill: any;
  if (useResumable) {
    const scottyResourceId = await scottyUpload(s, image, mime);
    videoStill = { operation: 'UPLOAD_CUSTOM_THUMBNAIL', image: { scottyResourceId } };
  } else {
    videoStill = { operation: 'UPLOAD_CUSTOM_THUMBNAIL', image: { dataUri: `data:${mime};base64,${image.toString('base64')}` } };
  }

  const body = { context: s.context, encryptedVideoId: videoId, videoStill };
  const res = await fetch(`${ORIGIN}/youtubei/v1/video_manager/metadata_update?alt=json`, { method: 'POST', headers: jsonHeaders(s), body: JSON.stringify(body) });
  let response = await res.text(); if (response.startsWith(")]}'")) response = response.slice(response.indexOf('\n') + 1);
  return { videoId, channelId: s.channelId, mode: useResumable ? 'resumable' : 'inline', status: res.status, ok: res.status === 200, response: response.slice(0, 400) };
}

/** Read the video's current thumbnail URL (for safe round-trip testing). */
export async function getCurrentThumbnailUrl(videoId: string): Promise<string | null> {
  const s = await scopeToVideo(videoId);
  const body = { context: s.context, externalVideoId: videoId };
  const res = await fetch(`${ORIGIN}/youtubei/v1/creator/get_creator_videos?alt=json`, { method: 'POST', headers: jsonHeaders(s), body: JSON.stringify(body) });
  let t = await res.text(); if (t.startsWith(")]}'")) t = t.slice(t.indexOf('\n') + 1);
  const m = t.match(/https:\/\/i\.ytimg\.com\/[^"\\]+/);
  return m ? m[0] : null;
}
