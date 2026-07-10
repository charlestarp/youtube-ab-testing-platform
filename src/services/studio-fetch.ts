/**
 * Server-side YouTube Studio analytics fetch — NO browser, NO extension.
 *
 * Pulls the Reach tab (get_screen, ANALYTICS_TAB_ID_REACH) for a video using the
 * Firefox studio session cookies. This is the SAME internal youtubei API the
 * extension hits, but driven entirely server-side so CTR updates hourly on its own.
 *
 * Key mechanics (hard-won):
 *  - Auth: SAPISIDHASH multi-hash (SAPISID + 1PAPISID + 3PAPISID), origin studio.youtube.com.
 *  - Channel scope: load /video/<id>/edit first; Studio auto-scopes the session to the
 *    video's OWNING channel and renders its CHANNEL_ID + a fresh INNERTUBE_CONTEXT.
 *    Pass that channel as the X-Goog-PageId header. (get_cards returns a realtime
 *    "estimated" stub; only get_screen Reach returns real since-publish data.)
 *  - The Reach response gives: cumulative impressions/views at HOURLY granularity
 *    (TIME_PERIOD_UNIT_NTH_HOURS) spanning the whole since-publish window, plus a
 *    VIDEO_THUMBNAIL_IMPRESSIONS_VTR series that is only ever DAILY (NTH_DAYS) — see below.
 *
 * HISTORICAL-HOURLY (fixed 2026-07-05): the previous version keyed the output hours off the
 * VTR series, which YouTube only serves at DAY granularity for anything older than the last
 * hour or two (impression-attributed metrics — VTR, VIDEO_THUMBNAIL_IMPRESSED_VIEWS — are
 * batch-processed daily; impressions / external-views / watch-time are realtime hourly). So
 * the series collapsed to ~1 point/day and any hour not captured live (e.g. a Studio-session
 * outage) read 0 impressions/CTR forever. We now key the hours off the REAL hourly
 * impressions series (full ~48-120h window) so every hour backfills.
 *
 * CTR formula (confirmed): Studio VTR = VIDEO_THUMBNAIL_IMPRESSED_VIEWS / VIDEO_THUMBNAIL_
 * IMPRESSIONS (funnel card lifetime: 59581/657714 = 9.0588% == reported 9.06). IMPRESSED_VIEWS
 * is DAYS-only (even on the realtime get_cards path — verified), so per-hour clicks cannot be
 * read directly. Per-hour CTR is therefore reconstructed DAILY-EXACT: take each day's real VTR
 * (the daily VTR series), turn it into that day's clicks (VTR_day/100 * impressions_day), and
 * distribute those clicks across the day's hours weighted by each hour's external-views. Then
 * Σ(imp_h*ctr_h)/Σimp_h over a day == VTR_day EXACTLY (validated to ±0.003 pt through rounding
 * on multiple days/videos), so any full-day slot aggregate matches Studio's daily VTR while
 * the external-views weighting preserves the per-hour variation the A/B test needs. (The prior
 * single global factor was only lifetime-exact and drifted up to ~1.9 CTR pts per day.) The
 * per-hour impressions and external-views themselves are exact — they match the extension's
 * independent hourly capture (imp MAE ~0.1-1.4, views MAE ~0-0.2, ~99% hours exact).
 *
 *  - Watch time: the Engagement screen (ANALYTICS_TAB_ID_ENGAGEMENT) returns
 *    EXTERNAL_WATCH_TIME at hourly granularity with real values, so watch_time_hours and
 *    avg_view_duration are now pulled server-side too (avg_view_pct still needs the video
 *    length YouTube only exposes daily, so that one stays with the extension).
 */
import { createHash } from 'crypto';
import { copyFileSync } from 'fs';
import Database from 'better-sqlite3';
import path from 'path';

const ORIGIN = 'https://studio.youtube.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:140.0) Gecko/20100101 Firefox/140.0';
const COOKIE_DB = path.join(process.cwd(), 'data/firefox-studio-work/cookies.sqlite');

export interface ReachHourlyPayload {
  video_id: string;
  channel_id: string;
  total_impressions: number;
  total_ctr: number; // blended lifetime CTR (what Studio Reach tab shows)
  timestamps: string[]; // ISO, one per hour bucket
  metrics: {
    VIDEO_THUMBNAIL_IMPRESSIONS: number[];
    EXTERNAL_VIEWS: number[];
    VIDEO_THUMBNAIL_IMPRESSIONS_VTR: number[]; // per-hour CTR (%), calibrated to lifetime VTR
    EXTERNAL_WATCH_TIME_HOURS: number[]; // per-hour watch time (hours), from Overview screen
    AVERAGE_WATCH_TIME_SEC: number[]; // per-hour avg view duration (seconds) = watch_ms / views
    SUBSCRIBERS_NET_CHANGE?: number[]; // per-hour net subs (can be negative); absent if Overview fetch failed
  };
}

function loadCookies(): Record<string, string> {
  const tmp = path.join('/tmp', `_ffsf_${process.pid}.sqlite`);
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

/** Difference a cumulative {x,y} minute-series into per-hour deltas keyed by hour-start ms. */
function perHourDeltas(datums: { x: number; y: number }[], allowNegative = false): Map<number, number> {
  const lastInHour = new Map<number, number>(); // hourStartMs -> last cumulative value
  for (const d of datums) {
    const hourStart = Math.floor(d.x / 3600000) * 3600000;
    lastInHour.set(hourStart, d.y); // datums are ordered, so this keeps the last per hour
  }
  const hours = [...lastInHour.keys()].sort((a, b) => a - b);
  const deltas = new Map<number, number>();
  let prev = 0;
  for (const h of hours) {
    const cum = lastInHour.get(h)!;
    deltas.set(h, allowNegative ? cum - prev : Math.max(0, cum - prev));
    prev = cum;
  }
  return deltas;
}

// channelId / sessionIndex / INNERTUBE_CONTEXT are the same for every video on the
// channel, so cache them. Re-fetching the video edit page per video is what trips
// Studio's rate-limiting when scoring many videos in one sweep.
let _scope: { channelId: string; sessionIndex: string; ctx: any; at: number } | null = null;
const SCOPE_TTL = 30 * 60_000;

// Session scope + authenticated get_screen caller, shared by every internal-API
// reader (reach series, engagement extras, screen probes, nightly deep audit).
async function studioScreen(videoId: string): Promise<{ getScreen: (tabId: string) => Promise<any>; post: (endpoint: string, body: any) => Promise<any>; channelId: string }> {
  const cm = loadCookies();
  const cookieHeader = Object.entries(cm).map(([k, v]) => `${k}=${v}`).join('; ');

  // Scope the session to the owning channel. Reuse a cached scope when fresh;
  // otherwise load one video edit page to extract it.
  let channelId: string | undefined, sessionIndex: string, ctx: any;
  if (_scope && Date.now() - _scope.at < SCOPE_TTL) {
    ({ channelId, sessionIndex, ctx } = _scope);
  } else {
    const pageRes = await fetch(`${ORIGIN}/video/${videoId}/edit`, { headers: { Cookie: cookieHeader, 'User-Agent': UA, Accept: 'text/html' }, redirect: 'follow' });
    const html = await pageRes.text();
    channelId = (html.match(/"CHANNEL_ID":"([^"]*)"/) || [])[1];
    sessionIndex = (html.match(/"SESSION_INDEX":"?([0-9]+)"?/) || [])[1] || '0';
    ctx = extractObj(html, '"INNERTUBE_CONTEXT":');
    if (!channelId || !ctx) throw new Error(`studio-fetch: could not scope channel for ${videoId} (logged out / cookies stale?)`);
    _scope = { channelId, sessionIndex, ctx, at: Date.now() };
  }

  const headers: any = {
    'Content-Type': 'application/json', Authorization: sapisidHashHeader(cm), Cookie: cookieHeader,
    'X-Origin': ORIGIN, Origin: ORIGIN, 'User-Agent': UA, 'X-Goog-AuthUser': sessionIndex, 'X-Goog-PageId': channelId,
  };
  const post = async (endpoint: string, body: any) => {
    const res = await fetch(`${ORIGIN}/youtubei/v1/${endpoint}?alt=json`, { method: 'POST', headers, body: JSON.stringify({ ...body, context: ctx }) });
    let t = await res.text();
    if (t.startsWith(")]}'")) t = t.slice(t.indexOf('\n') + 1);
    if (res.status !== 200) throw new Error(`studio-fetch: ${endpoint} ${res.status}: ${t.slice(0, 160)}`);
    return JSON.parse(t);
  };
  const getScreen = (tabId: string) => post('yta_web/get_screen', { screenConfig: { entity: { videoId }, currency: 'AUD', timeZoneOffsetSecs: 36000 }, desktopState: { tabId } });
  return { getScreen, post, channelId: channelId! };
}

/** Authenticated POST to any Studio internal endpoint (scope warmed via videoId). */
export async function studioApiPost(videoId: string, endpoint: string, body: any): Promise<any> {
  const { post } = await studioScreen(videoId);
  return post(endpoint, body);
}

export interface ScreenSeries { isCumulative: boolean; total: number; datums: { x: number; y: number }[] }

/** Every key-metric series a Studio tab returns, keyed by internal metric name. */
export async function fetchScreenSeries(videoId: string, tabId: string): Promise<Record<string, ScreenSeries>> {
  const { getScreen } = await studioScreen(videoId);
  const json = await getScreen(tabId);
  const out: Record<string, ScreenSeries> = {};
  for (const card of json.cards || []) {
    for (const tab of card.keyMetricCardData?.keyMetricTabs || []) {
      const pc = tab.primaryContent; const s = pc?.mainSeries;
      if (!pc?.metric || !s?.datums) continue;
      out[pc.metric] = { isCumulative: !!s.isCumulative, total: pc.total || 0, datums: s.datums.map((d: any) => ({ x: d.x, y: d.y || 0 })) };
    }
  }
  return out;
}

export async function fetchReachHourly(videoId: string): Promise<ReachHourlyPayload> {
  // get_screen Reach tab — the only call that returns real since-publish data.
  const { getScreen, channelId } = await studioScreen(videoId);
  const json = await getScreen('ANALYTICS_TAB_ID_REACH');

  // 3. Parse the reach series. Impressions & external-views come at HOURLY granularity
  // (real values); VTR comes only DAILY (impression-attributed metrics are batch-processed
  // daily — confirmed VIDEO_THUMBNAIL_IMPRESSED_VIEWS is DAYS-only even on the realtime
  // path). We keep the whole daily VTR series (not just its total) so we can pin each day's
  // reconstructed CTR to that day's real VTR — daily-exact, not just lifetime-exact.
  let impCum: { x: number; y: number }[] = [];
  let viewCum: { x: number; y: number }[] = [];
  let vtrDaily: { x: number; y: number }[] = []; // one datum per day-bucket, y = that day's VTR%
  let totalImp = 0, totalViews = 0, totalCtr = 0;
  for (const card of json.cards || []) {
    for (const tab of card.keyMetricCardData?.keyMetricTabs || []) {
      const pc = tab.primaryContent; const s = pc?.mainSeries;
      if (!pc?.metric || !s?.datums) continue;
      const datums = s.datums.map((d: any) => ({ x: d.x, y: d.y || 0 }));
      if (pc.metric === 'VIDEO_THUMBNAIL_IMPRESSIONS' && s.isCumulative) { impCum = datums; totalImp = pc.total || 0; }
      else if (pc.metric === 'EXTERNAL_VIEWS' && s.isCumulative) { viewCum = datums; totalViews = pc.total || 0; }
      else if (pc.metric === 'VIDEO_THUMBNAIL_IMPRESSIONS_VTR') { vtrDaily = datums; totalCtr = pc.total || 0; }
    }
  }
  if (!impCum.length) throw new Error(`studio-fetch: no hourly impressions series for ${videoId}`);

  // Overview screen: real hourly EXTERNAL_WATCH_TIME (cumulative ms) AND
  // SUBSCRIBERS_NET_CHANGE (cumulative) in one call — this replaced the
  // Engagement-tab fetch, which carried only watch time (verified 2026-07-10).
  // Non-fatal: if it fails we still return reach data; watch-time and subs then
  // fall back to the extension feed.
  let watchCum: { x: number; y: number }[] = [];
  let subsCum: { x: number; y: number }[] = [];
  let hasSubsSeries = false;
  try {
    const eng = await getScreen('ANALYTICS_TAB_ID_OVERVIEW');
    for (const card of eng.cards || []) {
      for (const tab of card.keyMetricCardData?.keyMetricTabs || []) {
        const pc = tab.primaryContent; const s = pc?.mainSeries;
        if (pc?.metric === 'EXTERNAL_WATCH_TIME' && s?.isCumulative && s?.datums) {
          watchCum = s.datums.map((d: any) => ({ x: d.x, y: d.y || 0 }));
        } else if (pc?.metric === 'SUBSCRIBERS_NET_CHANGE' && s?.isCumulative && s?.datums) {
          subsCum = s.datums.map((d: any) => ({ x: d.x, y: d.y || 0 }));
          hasSubsSeries = true;
        }
      }
    }
  } catch (e: any) {
    console.error(`[studio-fetch] overview watch-time/subs fetch failed for ${videoId}: ${e.message}`);
  }

  const impDeltas = perHourDeltas(impCum);
  const viewDeltas = perHourDeltas(viewCum);
  const watchDeltas = perHourDeltas(watchCum); // ms per hour
  const subsDeltas = perHourDeltas(subsCum, true); // net subs per hour (can be negative)

  // Per-hour CTR reconstruction (DAILY-EXACT). YouTube only resolves the true CTR numerator
  // (VIDEO_THUMBNAIL_IMPRESSED_VIEWS) per DAY, so we cannot read hourly clicks. Instead we
  // take each day's REAL VTR (vtrDaily) and distribute that day's clicks
  // (impressed_views_day = VTR_day/100 * impressions_day) across the day's hours weighted by
  // each hour's external-views. Then ctr_h = impressed_views_h / impressions_h, and by
  // construction Σ(imp_h*ctr_h)/Σimp_h over a day == VTR_day EXACTLY — so any full-day slot
  // aggregate matches Studio's daily VTR, while the views/impressions weighting preserves the
  // hour-to-hour variation the A/B test needs. (Impression-weighting would give a flat daily
  // VTR with no per-hour signal, so external-views is the click proxy.) Validated: this is
  // daily-exact vs. the previous single global factor, which drifted up to ~1.9 CTR points
  // per day. Per-hour impressions/views themselves are exact (match the extension capture).
  //
  // Day buckets: each vtrDaily datum represents the 24h ENDING at its x (day boundary sits at
  // the publish time-of-day). An hour h belongs to the first bucket whose x is > h.
  const dayEdges = vtrDaily.map(d => ({ x: d.x, vtr: d.y })).sort((a, b) => a.x - b.x);
  const bucketOf = (h: number): { x: number; vtr: number } | null => {
    for (const e of dayEdges) if (h < e.x) return e;
    return dayEdges.length ? dayEdges[dayEdges.length - 1] : null; // trailing partial day
  };
  // Aggregate each day-bucket's impressions and external-views from the real hourly series.
  const dayImp = new Map<number, number>();
  const dayView = new Map<number, number>();
  for (const [h, imp] of impDeltas) {
    if (imp <= 0) continue;
    const b = bucketOf(h); if (!b) continue;
    dayImp.set(b.x, (dayImp.get(b.x) || 0) + imp);
    dayView.set(b.x, (dayView.get(b.x) || 0) + (viewDeltas.get(h) || 0));
  }

  // 4. Build per-hour rows keyed off the real hourly impressions series (full window),
  // so every hour — including ones never captured live — carries real impressions/views.
  const timestamps: string[] = [];
  const impArr: number[] = [], viewArr: number[] = [], ctrArr: number[] = [];
  const watchHrsArr: number[] = [], avgDurArr: number[] = [], subsArr: number[] = [];
  for (const hourStart of [...impDeltas.keys()].sort((a, b) => a - b)) {
    const imp = Math.round(impDeltas.get(hourStart) || 0);
    if (imp <= 0) continue; // skip leading/empty buckets (no data yet)
    const views = Math.round(viewDeltas.get(hourStart) || 0);
    const watchMs = watchDeltas.get(hourStart) || 0;
    subsArr.push(Math.round(subsDeltas.get(hourStart) || 0));
    // Daily-exact per-hour CTR.
    const b = bucketOf(hourStart);
    let ctr = 0;
    if (b && b.vtr > 0) {
      const dImp = dayImp.get(b.x) || 0;
      const dView = dayView.get(b.x) || 0;
      const impressedViewsDay = (b.vtr / 100) * dImp; // this day's real clicks
      // Distribute by external-views; if the day has no views, fall back to impression share
      // (which yields the flat daily VTR for that hour).
      const share = dView > 0 ? (viewDeltas.get(hourStart) || 0) / dView : (dImp > 0 ? imp / dImp : 0);
      const impressedViewsHour = impressedViewsDay * share;
      ctr = Math.min(100, Math.round((impressedViewsHour / imp) * 100 * 100) / 100);
    }
    timestamps.push(new Date(hourStart).toISOString());
    impArr.push(imp);
    viewArr.push(views);
    ctrArr.push(ctr);
    watchHrsArr.push(Math.round((watchMs / 3600000) * 1000) / 1000);
    avgDurArr.push(views > 0 ? Math.round((watchMs / views / 1000) * 100) / 100 : 0);
  }

  return {
    video_id: videoId, channel_id: channelId, total_impressions: totalImp, total_ctr: totalCtr,
    timestamps,
    metrics: {
      VIDEO_THUMBNAIL_IMPRESSIONS: impArr,
      EXTERNAL_VIEWS: viewArr,
      VIDEO_THUMBNAIL_IMPRESSIONS_VTR: ctrArr,
      EXTERNAL_WATCH_TIME_HOURS: watchHrsArr,
      AVERAGE_WATCH_TIME_SEC: avgDurArr,
      ...(hasSubsSeries ? { SUBSCRIBERS_NET_CHANGE: subsArr } : {}),
    },
  };
}

/**
 * Cumulative public counters from the internal get_creator_videos endpoint:
 * same numbers as the Data API videos.list but quota-free and session-authed,
 * so likes/comments delta-sampling can never silently freeze on key exhaustion.
 */
export async function fetchVideoPublicStats(videoId: string): Promise<{ views: number; likes: number; comments: number }> {
  const j = await studioApiPost(videoId, 'creator/get_creator_videos', { videoIds: [videoId], mask: { videoId: true, metrics: { all: true } } });
  const mtr = j?.videos?.[0]?.metrics;
  if (!mtr) throw new Error(`get_creator_videos returned no metrics for ${videoId}`);
  return { views: parseInt(mtr.viewCount) || 0, likes: parseInt(mtr.likeCount) || 0, comments: parseInt(mtr.commentCount) || 0 };
}

/**
 * Returns a subscriber count sourced from the Studio internal API (get_creator_channels),
 * confirming the Firefox session is alive. Note: YouTube rounds metric.subscriberCount in
 * this API to the nearest 1000 for large channels, same as the public Data API — the exact
 * live count is only accessible in a real browser session via a real-time data stream,
 * not server-side. This function returns the Studio-sourced value so the caller can tag it
 * source:"studio" (session healthy) vs source:"data_api" (session dead).
 *
 * Scope is warmed via a video edit page (same path as reach-refresh). Studio home is NOT
 * safe — it may scope to a different channel depending on the Firefox session's last tab.
 * Returns null on any failure so the caller falls back to the public Data API.
 */
export async function fetchExactSubscriberCount(): Promise<number | null> {
  const cm = loadCookies();
  const cookieHeader = Object.entries(cm).map(([k, v]) => `${k}=${v}`).join('; ');

  // Warm scope via a video edit page (same as reach-refresh, every 20 min in production).
  if (!_scope || Date.now() - _scope.at >= SCOPE_TTL) {
    console.log('[live-subs] scope stale, warming via video edit page');
    try {
      const { getDb } = await import('../db/client.js');
      const db = getDb();
      const row = db.prepare(
        `SELECT video_id FROM channel_videos WHERE is_short = 0 ORDER BY published_at DESC LIMIT 1`
      ).get() as { video_id: string } | undefined;
      if (!row?.video_id) {
        console.error('[live-subs] scope warm failed: no channel_videos rows');
        return null;
      }
      const pageRes = await fetch(`${ORIGIN}/video/${row.video_id}/edit`, {
        headers: { Cookie: cookieHeader, 'User-Agent': UA, Accept: 'text/html' }, redirect: 'follow',
      });
      if (!pageRes.ok) {
        console.error(`[live-subs] video edit page HTTP ${pageRes.status} — session expired?`);
        return null;
      }
      const html = await pageRes.text();
      const chId = (html.match(/"CHANNEL_ID":"([^"]*)"/) || [])[1];
      const si = (html.match(/"SESSION_INDEX":"?([0-9]+)"?/) || [])[1] || '0';
      const ctx = extractObj(html, '"INNERTUBE_CONTEXT":');
      if (!chId || !ctx) {
        console.error('[live-subs] scope warm failed: no CHANNEL_ID or INNERTUBE_CONTEXT (cookies stale?)');
        return null;
      }
      _scope = { channelId: chId, sessionIndex: si, ctx, at: Date.now() };
      console.log(`[live-subs] scope warmed via ${row.video_id}, channelId=${chId}`);
    } catch (e: any) {
      console.error('[live-subs] scope warm error:', e?.message);
      return null;
    }
  } else {
    console.log(`[live-subs] using warm scope, channelId=${_scope.channelId}`);
  }

  const { ctx, channelId, sessionIndex } = _scope;
  // Main channel ID — get_creator_channels needs it explicitly alongside the persona ID.
  const mainChannelId = process.env.YOUTUBE_CHANNEL_ID || 'UCkhy7g4GvHuzhbzTVjc8izQ';

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: sapisidHashHeader(cm),
    Cookie: cookieHeader,
    'X-Origin': ORIGIN, Origin: ORIGIN,
    'User-Agent': UA,
    'X-Goog-AuthUser': sessionIndex,
    'X-Goog-PageId': channelId,
  };

  // get_creator_channels requires channelIds + mask to return metric data.
  // Without channelIds the API returns 400; without mask the channels array has no metric field.
  try {
    const body = {
      context: ctx,
      channelIds: [mainChannelId, channelId],
      mask: { channelId: true, metric: { subscriberCount: true } },
    };
    const res = await fetch(`${ORIGIN}/youtubei/v1/creator/get_creator_channels`, {
      method: 'POST', headers, body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.error(`[live-subs] get_creator_channels HTTP ${res.status}`);
      return null;
    }
    let text = await res.text();
    if (text.startsWith(")]}'")) text = text.slice(text.indexOf('\n') + 1);
    const data = JSON.parse(text);
    const n = deepFindSubscriberCount(data);
    if (n) {
      console.log(`[live-subs] got count ${n} from get_creator_channels (Studio session alive)`);
      return n;
    }
    console.error(`[live-subs] get_creator_channels: no subscriberCount in response: ${JSON.stringify(data).slice(0, 300)}`);
  } catch (e: any) {
    console.error('[live-subs] get_creator_channels threw:', e?.message);
  }

  return null;
}

/**
 * Update a video's TITLE via Studio's internal metadata_update — quota-free
 * (the official Data API costs ~51 units per rotation and can exhaust the daily
 * quota, stalling every title test). Same SAPISID cookie auth as the reach pull;
 * titles are not BotGuard-gated (thumbnail SET is — that stays on Firefox).
 * Verified 2026-07-08: returns 200 and applies the title.
 */
export async function updateTitleInternal(videoId: string, newTitle: string): Promise<void> {
  const cm = loadCookies();
  const cookieHeader = Object.entries(cm).map(([k, v]) => `${k}=${v}`).join('; ');

  // Scope the session (cached; same mechanics as fetchReachHourly).
  let channelId: string | undefined, sessionIndex: string, ctx: any;
  if (_scope && Date.now() - _scope.at < SCOPE_TTL) {
    ({ channelId, sessionIndex, ctx } = _scope);
  } else {
    const pageRes = await fetch(`${ORIGIN}/video/${videoId}/edit`, { headers: { Cookie: cookieHeader, 'User-Agent': UA, Accept: 'text/html' }, redirect: 'follow' });
    const html = await pageRes.text();
    channelId = (html.match(/"CHANNEL_ID":"([^"]*)"/) || [])[1];
    sessionIndex = (html.match(/"SESSION_INDEX":"?([0-9]+)"?/) || [])[1] || '0';
    ctx = extractObj(html, '"INNERTUBE_CONTEXT":');
    if (!channelId || !ctx) throw new Error(`title-internal: could not scope channel for ${videoId}`);
    _scope = { channelId, sessionIndex, ctx, at: Date.now() };
  }

  const res = await fetch(`${ORIGIN}/youtubei/v1/video_manager/metadata_update?alt=json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', Authorization: sapisidHashHeader(cm), Cookie: cookieHeader,
      'X-Origin': ORIGIN, Origin: ORIGIN, 'User-Agent': UA, 'X-Goog-AuthUser': sessionIndex!, 'X-Goog-PageId': channelId!,
    },
    body: JSON.stringify({ encryptedVideoId: videoId, title: { newTitle }, context: ctx }),
  });
  let t = await res.text();
  if (t.startsWith(")]}'")) t = t.slice(t.indexOf('\n') + 1);
  if (res.status !== 200) throw new Error(`title-internal: metadata_update ${res.status}: ${t.slice(0, 140)}`);
  // A 200 with an error payload (e.g. validation) must not pass silently.
  if (/"errors"\s*:/.test(t) && !/"resultCode"\s*:\s*"UPDATE_SUCCESS"/.test(t)) {
    throw new Error(`title-internal: unexpected response: ${t.slice(0, 140)}`);
  }
}

/** Depth-limited search for a `subscriberCount` key with a plausible channel value. */

function deepFindSubscriberCount(obj: unknown, depth = 0): number | null {
  if (depth > 6 || obj === null || typeof obj !== 'object') return null;
  if ('subscriberCount' in (obj as Record<string, unknown>)) {
    const v = (obj as Record<string, unknown>).subscriberCount;
    const n = typeof v === 'number' ? v : parseInt(String(v).replace(/,/g, ''));
    if (n >= 10_000) return n; // sanity-check: a real channel, not a stub
  }
  for (const val of Object.values(obj as Record<string, unknown>)) {
    const r = Array.isArray(val)
      ? val.reduce<number | null>((acc, item) => acc ?? deepFindSubscriberCount(item, depth + 1), null)
      : deepFindSubscriberCount(val, depth + 1);
    if (r !== null) return r;
  }
  return null;
}
