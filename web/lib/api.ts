const API_BASE = "";

async function apiFetch<T = unknown>(path: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { ...options.headers as any };
  if (options.body) {
    headers["Content-Type"] = headers["Content-Type"] || "application/json";
  }

  const res = await fetch(`${API_BASE}${path}`, {
    credentials: "include",
    ...options,
    headers,
  });
  if (!res.ok) {
    let detail = `Request failed (${res.status})`;
    try { const body = await res.json(); detail = body.detail || detail; } catch {}
    throw new Error(detail);
  }
  return res.json();
}

export interface User {
  id: number;
  name: string;
  email: string;
  avatar: string | null;
  role: string;
}

export interface TestSummary {
  id: number;
  video_id: string;
  video_title: string | null;
  test_type: "thumbnail" | "title" | "both";
  status: "pending" | "running" | "paused" | "completed" | "failed";
  duration_hours_per_variant: number;
  min_impressions: number;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  error_msg: string | null;
  variants: TestVariant[];
  measurement_summary: { variant_id: number; total_impressions: number; total_views: number }[];
}

export interface TestVariant {
  id: number;
  test_id: number;
  label: string;
  thumbnail_path: string | null;
  title: string | null;
  is_control: number;
  active_since: string | null;
}

export interface TestMeasurement {
  id: number;
  test_id: number;
  variant_id: number;
  measured_at: string;
  impressions: number;
  views: number;
  ctr: number;
  unique_viewers: number;
  watch_time_hours: number;
  avg_view_duration: number;
  avg_view_pct: number;
  likes: number;
  comments: number;
  subs_gained: number;
  subs_lost: number;
}

export interface TestDetail extends TestSummary {
  measurements: TestMeasurement[];
}

export interface Video {
  video_id: string;
  title: string;
  publish_date: string;
  thumbnail_url: string;
  duration_seconds: number;
  view_count: number;
  like_count: number;
  comment_count: number;
  category: string;
  recent_tests: { id: number; test_type: string; status: string; created_at: string }[];
}

export interface Schedule {
  id: number;
  name: string;
  video_ids_json: string;
  variant_configs_json: string;
  cron: string;
  duration_hours: number;
  min_impressions: number;
  is_active: number;
  last_run_at: string | null;
  created_at: string;
}

export const auth = {
  me: () => apiFetch<User>("/api/auth/me"),
  loginUrl: () => "/api/auth/login",
  logout: () => apiFetch<{ ok: boolean }>("/api/auth/logout", { method: "POST" }),
};

export const tests = {
  list: (status?: string, category?: string) => {
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (category) params.set("category", category);
    const qs = params.toString();
    return apiFetch<TestSummary[]>(`/api/tests${qs ? `?${qs}` : ""}`);
  },
  get: (id: number) => apiFetch<TestDetail>(`/api/tests/${id}`),
  create: (data: { video_id: string; video_title?: string; test_type?: string; duration_hours_per_variant?: number; min_impressions?: number }) =>
    apiFetch<{ id: number }>("/api/tests", { method: "POST", body: JSON.stringify(data) }),
  start: (id: number) => apiFetch<{ ok: boolean }>(`/api/tests/${id}/start`, { method: "POST" }),
  startNow: (id: number) => apiFetch<{ ok: boolean }>(`/api/tests/${id}/start-now`, { method: "POST" }),
  pause: (id: number) => apiFetch<{ ok: boolean }>(`/api/tests/${id}/pause`, { method: "POST" }),
  complete: (id: number) => apiFetch<{ ok: boolean }>(`/api/tests/${id}/complete`, { method: "POST" }),
  delete: (id: number) => apiFetch<{ ok: boolean }>(`/api/tests/${id}`, { method: "DELETE" }),
  setCategory: (id: number, category: "test" | "retest") => apiFetch<{ ok: boolean; category: string }>(`/api/tests/${id}/category`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ category }) }),
  titleSuggestions: () => apiFetch<{ video_id: string; current_title: string; suggested_title: string; reasoning: string; thumbnail_concept: string | null; view_count: number | null; thumbnail_url: string | null }[]>("/api/title-suggestions"),
  testSuggestedTitle: (videoId: string, titles?: string[]) => apiFetch<{ ok: boolean; test_id: number; started: boolean }>(`/api/videos/${videoId}/test-suggested-title`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ titles }) }),
  reviveCandidates: () => apiFetch<{ video_id: string; title: string; impressions: number; ctr: number; avg_pct_watched: number; revive_score: number; reason: string; thumbnail_url: string | null; has_prior_thumb: number }[]>("/api/revive/candidates"),
  retestThumbnail: (videoId: string, chainTitle: boolean, thumbnails?: string[], chainChallenger?: string) => apiFetch<{ ok: boolean; test_id?: number; detail?: string; reused?: number; chained?: boolean }>(`/api/videos/${videoId}/retest-thumbnail`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chainTitle, thumbnails, chainChallenger }) }),
  suggestTitle: (videoId: string) => apiFetch<{ current_title: string | null; suggested_title: string | null; reasoning?: string; thumbnail_concept?: string | null; detail?: string }>(`/api/videos/${videoId}/suggest-title`, { method: "POST" }),
  prereleaseQueue: (episode_ids: number[]) => apiFetch<{ ok: boolean; pitched: number; conversation_id: number | null }>("/api/prerelease/queue", { method: "POST", body: JSON.stringify({ episode_ids }) }),
  prereleaseBrief: () => apiFetch<{ ok: boolean; pitched: number }>("/api/prerelease/brief", { method: "POST" }),
  priorThumbnails: (videoId: string) => apiFetch<{ thumbnails: { label: string; path: string; file: string; is_control: number }[] }>(`/api/videos/${videoId}/prior-thumbnails`),
  addVariant: async (testId: number, file: File, title?: string) => {
    const formData = new FormData();
    formData.append("file", file);
    if (title) formData.append("title", title);
    const res = await fetch(`/api/upload?testId=${testId}`, {
      method: "POST",
      credentials: "include",
      body: formData,
    });
    if (!res.ok) throw new Error(`Upload failed (${res.status})`);
    return res.json();
  },
  addTitleVariant: (testId: number, title: string) =>
    apiFetch(`/api/tests/${testId}/variants`, { method: "POST", body: JSON.stringify({ title }) }),
};

export const videos = {
  list: (search?: string, category?: string, limit = 50, channel?: string) =>
    apiFetch<Video[]>(`/api/videos?${new URLSearchParams({ ...(search ? { search } : {}), ...(category ? { category } : {}), ...(channel ? { channel } : {}), limit: String(limit) })}`),
  get: (videoId: string) => apiFetch<{ video: any; analytics: any[]; tests: any[] }>(`/api/videos/${videoId}`),
};

export const schedules = {
  list: () => apiFetch<Schedule[]>("/api/schedules"),
  create: (data: any) => apiFetch<{ id: number }>("/api/schedules", { method: "POST", body: JSON.stringify(data) }),
  update: (id: number, data: any) => apiFetch<{ ok: boolean }>(`/api/schedules/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  delete: (id: number) => apiFetch<{ ok: boolean }>(`/api/schedules/${id}`, { method: "DELETE" }),
  run: (id: number) => apiFetch<{ ok: boolean; tests_created: number }>(`/api/schedules/${id}/run`, { method: "POST" }),
};

export interface Competitor {
  id: number;
  channel_id: string;
  name: string;
  handle: string | null;
  subscriber_count: number;
  video_count: number;
  is_auto_discovered: number;
  last_synced_at: string | null;
}

export interface CommentEntry {
  id: number;
  comment_id: string;
  video_id: string;
  author: string;
  content: string;
  like_count: number;
  published_at: string;
  sentiment: string;
  mentions_us: number;
}

export interface ChatConversation {
  id: number;
  title: string;
  created_at: string;
  updated_at: string;
}

export interface ChatMessage {
  id: number;
  conversation_id: number;
  role: string;
  content: string;
  created_at: string;
}

export const competitors = {
  list: () => apiFetch<Competitor[]>("/api/competitors"),
  add: (data: { channel_url?: string; channel_id?: string }) =>
    apiFetch<{ ok: boolean; name: string }>("/api/competitors", { method: "POST", body: JSON.stringify(data) }),
  delete: (id: number) => apiFetch<{ ok: boolean }>(`/api/competitors/${id}`, { method: "DELETE" }),
  videos: (id: number) => apiFetch<any[]>(`/api/competitors/${id}/videos`),
  analysis: (id: number, since?: string, contentType?: string) => {
    const params = new URLSearchParams();
    if (since) params.set('since', since);
    if (contentType) params.set('content_type', contentType);
    const qs = params.toString();
    return apiFetch<any>(`/api/competitors/${id}/analysis${qs ? `?${qs}` : ''}`);
  },
  discover: () => apiFetch<{ ok: boolean; discovered: number }>("/api/competitors/discover", { method: "POST" }),
  sync: (id: number) => apiFetch<{ ok: boolean; synced: number }>(`/api/competitors/${id}/sync`, { method: "POST" }),
  summary: () => apiFetch<any>("/api/competitors/summary"),
};

// The 1,020-channel research dataset (Social Blade history + metadata)
export const research = {
  stats: () => apiFetch<any>("/api/research/stats"),
  core: () => apiFetch<any[]>("/api/research/core"),
  channels: (opts: { sort?: string; q?: string; core?: boolean; limit?: number; offset?: number } = {}) => {
    const p = new URLSearchParams();
    if (opts.sort) p.set("sort", opts.sort);
    if (opts.q) p.set("q", opts.q);
    if (opts.core) p.set("core", "1");
    if (opts.limit) p.set("limit", String(opts.limit));
    if (opts.offset) p.set("offset", String(opts.offset));
    return apiFetch<{ total: number; count: number; channels: any[] }>(`/api/research/channels?${p.toString()}`);
  },
  channel: (id: string) => apiFetch<any>(`/api/research/channels/${id}`),
  setCore: (id: string, core: boolean) =>
    apiFetch<{ ok: boolean }>(`/api/research/core/${id}`, { method: "POST", body: JSON.stringify({ core }) }),
};

export const comments = {
  list: (params?: Record<string, string>) =>
    apiFetch<CommentEntry[]>(`/api/comments?${new URLSearchParams(params || {})}`),
  mentions: () => apiFetch<CommentEntry[]>("/api/comments/mentions"),
  stats: () => apiFetch<{ total: number; by_sentiment: any[]; recent_mentions: number }>("/api/comments/stats"),
  scrape: () => apiFetch<{ scraped: number; mentions: number }>("/api/comments/scrape", { method: "POST" }),
};

export const chat = {
  conversations: () => apiFetch<ChatConversation[]>("/api/chat/conversations"),
  create: (title: string) => apiFetch<{ id: number }>("/api/chat/conversations", { method: "POST", body: JSON.stringify({ title }) }),
  messages: (convId: number) => apiFetch<ChatMessage[]>(`/api/chat/conversations/${convId}/messages`),
  delete: (convId: number) => apiFetch<{ ok: boolean }>(`/api/chat/conversations/${convId}`, { method: "DELETE" }),
};

export interface SSEEvent {
  type: string;
  delta?: string;
  name?: string;
  conv_id?: number;
  message?: string;
}

export const admin = {
  users: () => apiFetch<any[]>("/api/admin/users"),
  updateUser: (id: number, data: { role?: string; status?: string }) =>
    apiFetch<{ ok: boolean }>(`/api/admin/users/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  deleteUser: (id: number) => apiFetch<{ ok: boolean }>(`/api/admin/users/${id}`, { method: "DELETE" }),
  invite: (email: string, role?: string) =>
    apiFetch<{ ok: boolean; token: string; invite_url: string }>("/api/admin/invite", { method: "POST", body: JSON.stringify({ email, role }) }),
  invites: () => apiFetch<any[]>("/api/admin/invites"),
  revokeInvite: (id: number) => apiFetch<{ ok: boolean }>(`/api/admin/invites/${id}`, { method: "DELETE" }),
  quota: () => apiFetch<any>("/api/admin/quota"),
  activity: () => apiFetch<{ activity: any[]; online: any[] }>("/api/admin/activity"),
  impersonate: (id: number) => apiFetch<{ ok: boolean }>(`/api/admin/impersonate/${id}`, { method: "POST" }),
  stopImpersonation: () => apiFetch<{ ok: boolean }>("/api/admin/stop-impersonation", { method: "POST" }),
};

export const prerelease = {
  list: () => apiFetch<{ id: number; title: string; created_at: string }[]>("/api/chat/prerelease-transcripts"),
  upload: async (title: string, file: File) => {
    const formData = new FormData();
    formData.append("title", title);
    formData.append("file", file);
    const res = await fetch("/api/chat/upload-transcript", { method: "POST", credentials: "include", body: formData });
    return res.json();
  },
  uploadText: (title: string, transcript: string) =>
    apiFetch<{ id: number }>("/api/chat/upload-transcript", { method: "POST", body: JSON.stringify({ title, transcript }) }),
};

export const thumbnails = {
  insights: (contentType?: string) =>
    apiFetch<any>(`/api/thumbnails/insights${contentType ? `?content_type=${contentType}` : ""}`),
  competitorInsights: () => apiFetch<any>("/api/thumbnails/competitor-insights"),
  comparison: () => apiFetch<any>("/api/thumbnails/comparison"),
  analyzed: (params?: Record<string, string>) =>
    apiFetch<any[]>(`/api/thumbnails/analyzed?${new URLSearchParams(params || {})}`),
  stats: () => apiFetch<any>("/api/thumbnails/stats"),
  analyze: (limit?: number) =>
    apiFetch<{ analyzed: number; errors: number }>("/api/thumbnails/analyze", { method: "POST", body: JSON.stringify({ limit }) }),
  analyzeCompetitors: (limit?: number) =>
    apiFetch<{ analyzed: number; errors: number }>("/api/thumbnails/analyze-competitors", { method: "POST", body: JSON.stringify({ limit }) }),
  analyzeOne: (video_id: string) =>
    apiFetch<any>("/api/thumbnails/analyze-one", { method: "POST", body: JSON.stringify({ video_id }) }),
};

export interface ThumbnailScoreFactor {
  name: string;
  value: string;
  score: number;
  insight: string;
}

export interface ThumbnailScoreResult {
  score: number;
  analysis: Record<string, any>;
  factors: ThumbnailScoreFactor[];
  advice: string[];
  matchesWinners: boolean;
}

export interface CompareResult {
  thumbnails: Array<{ index: number; filename: string; score: number; strengths: string[]; weaknesses: string[]; verdict: string; analysis: any; factors: ThumbnailScoreFactor[] }>;
  predicted_winner: { filename: string; score: number; reason: string };
  key_differences: string[];
  error?: string;
}

/**
 * Resize an image file client-side to JPEG under maxBytes.
 * Uses canvas to convert PNG/large images to compressed JPEG.
 */
async function resizeImageForScoring(file: File, maxWidth = 1920, maxBytes = 2 * 1024 * 1024): Promise<File> {
  // Small JPEGs can pass through as-is
  if (file.size <= maxBytes && file.type === "image/jpeg") return file;

  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const canvas = document.createElement("canvas");
      let w = img.width;
      let h = img.height;
      if (w > maxWidth) {
        h = Math.round(h * (maxWidth / w));
        w = maxWidth;
      }
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) { reject(new Error("Canvas not supported")); return; }
      ctx.drawImage(img, 0, 0, w, h);

      let quality = 0.9;
      const tryCompress = () => {
        canvas.toBlob(
          (blob) => {
            if (!blob) { reject(new Error("Failed to compress")); return; }
            if (blob.size > maxBytes && quality > 0.3) {
              quality -= 0.1;
              tryCompress();
            } else {
              resolve(new File([blob], file.name.replace(/\.png$/i, ".jpg"), { type: "image/jpeg" }));
            }
          },
          "image/jpeg",
          quality,
        );
      };
      tryCompress();
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Failed to load image")); };
    img.src = url;
  });
}

export interface TitleSignal {
  tag: string;
  verdict: 'proven' | 'promising' | 'coinflip' | 'weak' | 'corpus_positive' | 'corpus_neutral' | 'corpus_negative';
  uplift_pct: number;
  source: 'ab' | 'corpus';
}

export interface TitlePreflightResult {
  score: number;
  ctr_band: 'top quartile' | 'above median' | 'around median' | 'below median';
  confidence: 'high' | 'medium' | 'low';
  verdict: 'strong' | 'good' | 'neutral' | 'weak';
  signals: TitleSignal[];
  similar_winners: { title: string; ctr: number; similarity: number }[];
  reasons: string[];
  content_type: string;
}

export const score = {
  thumbnail: async (file: File): Promise<ThumbnailScoreResult> => {
    const resized = await resizeImageForScoring(file);
    const formData = new FormData();
    formData.append("file", resized);
    const res = await fetch("/api/score/thumbnail", {
      method: "POST",
      credentials: "include",
      body: formData,
    });
    if (!res.ok) {
      let detail = `Score failed (${res.status})`;
      try { const b = await res.json(); detail = b.detail || detail; } catch {}
      throw new Error(detail);
    }
    return res.json();
  },
  title: (title: string) =>
    apiFetch<any>("/api/score/title", { method: "POST", body: JSON.stringify({ title }) }),
  titlePreflight: (title: string, content_type?: string) =>
    apiFetch<TitlePreflightResult>("/api/score/title-preflight", { method: "POST", body: JSON.stringify({ title, content_type }) }),
  compare: async (files: File[]): Promise<CompareResult> => {
    // Resize all images client-side before uploading (PNGs can be 10MB+)
    const resized = await Promise.all(files.map(f => resizeImageForScoring(f)));
    const formData = new FormData();
    for (const f of resized) formData.append("images", f);
    const res = await fetch("/api/score/compare", {
      method: "POST",
      credentials: "include",
      body: formData,
    });
    if (!res.ok) {
      let detail = `Compare failed (${res.status})`;
      try { const b = await res.json(); detail = b.detail || detail; } catch {}
      throw new Error(detail);
    }
    return res.json();
  },
};

export const analytics = {
  viralScore: (title: string) =>
    apiFetch<any>("/api/analytics/viral-score", { method: "POST", body: JSON.stringify({ title }) }),
  growth: () => apiFetch<any>("/api/analytics/growth"),
  seoGaps: () => apiFetch<any[]>("/api/analytics/seo-gaps"),
  fatigue: () => apiFetch<any[]>("/api/analytics/fatigue"),
  benchmarks: () => apiFetch<any>("/api/analytics/benchmarks"),
};

export interface RetentionSpike {
  position: number;
  timecode: string;
  retention_value: number;
  above_typical_pct: number;
  context_before: number | null;
  context_after: number | null;
}

export interface RetentionSpikeVideo {
  video_id: string;
  title: string;
  published_at: string;
  duration_seconds: number;
  thumbnail_url: string;
  view_count: number;
  like_count: number;
  comment_count: number;
  has_retention_data: boolean;
  latest_snapshot_id: number | null;
  latest_snapshot_at: string | null;
  views: number;
  impressions: number;
  ctr: number;
  avg_view_pct: number;
}

export interface RetentionAnalysis {
  video_id: string;
  title: string;
  thumbnail_url: string;
  published_at: string;
  duration_seconds: number;
  scraped_at: string;
  views: number;
  impressions: number;
  ctr: number;
  avg_view_pct: number;
  retention_points: number;
  retention_curve: number[];
  avg_retention: number;
  spikes: RetentionSpike[];
  absolute_max: RetentionSpike | null;
}

export const retentionSpikes = {
  videos: (days: number) =>
    apiFetch<RetentionSpikeVideo[]>(`/api/retention-spikes/videos?days=${days}`),
  sync: () =>
    apiFetch<{ ok: boolean; synced?: number; detail?: string }>("/api/retention-spikes/sync", { method: "POST" }),
  scrape: (videoId: string) =>
    apiFetch<{ ok: boolean; scraped?: number; errors?: number }>(`/api/retention-spikes/scrape/${videoId}`, { method: "POST" }),
  analysis: (videoId: string) =>
    apiFetch<RetentionAnalysis>(`/api/retention-spikes/analysis/${videoId}`),
};

export interface RetentionMoment {
  moment_type: 'drop' | 'hold';
  time_sec: number;
  timecode: string;
  retention_pct: number;
  delta_pct: number;
  transcript_quote: string | null;
  segment_type: string;
}
export interface VideoMoments {
  video_id: string;
  title: string;
  thumbnail_url: string | null;
  published_at: string | null;
  duration_seconds: number;
  drop_moments: RetentionMoment[];
  hold_moments: RetentionMoment[];
  has_transcript: boolean;
  computed_at: string;
}
export interface SegmentScorecard {
  segment_type: string;
  video_count: number;
  avg_drop_delta: number | null;
  avg_hold_delta: number | null;
  verdict: 'holds' | 'sheds' | 'neutral';
}
export interface RetentionMomentsResponse {
  videos: VideoMoments[];
  segment_scorecard: SegmentScorecard[];
}
export const retentionMoments = {
  get: (days?: number) => apiFetch<RetentionMomentsResponse>(`/api/retention/moments${days ? `?days=${days}` : ''}`),
  compute: (videoId: string) => apiFetch<{ ok: boolean; video_id: string }>(`/api/retention/moments/${videoId}/compute`, { method: 'POST' }),
};

export interface ThumbnailTag {
  id: number;
  name: string;
  color: string;
  category?: string;
  usage_count?: number;
  source?: "ai" | "manual" | string;
}

export interface TagAnalyticsItem {
  id: number;
  name: string;
  color: string;
  variant_count: number;
  test_count: number;
  total_impressions: number;
  total_views: number;
  weighted_ctr: number;
  total_watch_time_hours: number;
  avg_view_duration: number;
  total_likes: number;
  total_subs_gained: number;
  win_count: number;
  win_rate: number;
}

export interface TagCategory {
  id: number;
  name: string;
  color: string;
  sort_order: number;
}

export const tagCategories = {
  list: () => apiFetch<TagCategory[]>("/api/tag-categories"),
  create: (name: string, color?: string) =>
    apiFetch<TagCategory>("/api/tag-categories", { method: "POST", body: JSON.stringify({ name, color }) }),
  update: (id: number, data: { name?: string; color?: string }) =>
    apiFetch<{ ok: boolean }>(`/api/tag-categories/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  delete: (id: number) =>
    apiFetch<{ ok: boolean }>(`/api/tag-categories/${id}`, { method: "DELETE" }),
};

export interface PlaybookTag {
  id: number; name: string; color: string; category: string;
  category_name: string; category_color: string;
  weighted_ctr: number; win_rate: number; variant_count: number;
  total_impressions: number; confidence: string;
}

export interface LeaderboardTag {
  id: number; name: string; color: string; category: string;
  weighted_ctr: number; win_rate: number; variant_count: number;
  total_impressions: number; avg_view_duration: number;
  win_count: number; test_count: number;
  confidence: string; rank: number; bar_pct: number;
}

export type TagContentType = "podcast" | "TNTL";

export interface PlaybookResponse {
  content_type?: TagContentType;
  recipe: {
    tags: PlaybookTag[];
    composite_ctr: number;
    channel_avg_ctr: number;
    uplift_pct: number;
    variant_count: number;
  };
  leaderboards: Record<string, LeaderboardTag[]>;
  categories: { id: number; name: string; color: string }[];
  top_insights: { text: string; diff_pct: number; better: string; worse: string }[];
}

export interface RetestEntry {
  video_id: string; video_title: string;
  before: { test_id: number; ctr: number; tags: ThumbnailTag[]; thumbnail_path: string; is_winner: boolean; impressions: number };
  after: { test_id: number; ctr: number; tags: ThumbnailTag[]; thumbnail_path: string; is_winner: boolean; impressions: number };
  ctr_delta: number; ctr_delta_pct: number;
  tags_added: ThumbnailTag[]; tags_removed: ThumbnailTag[];
}

export interface RetestHistoryResponse {
  retests: RetestEntry[];
}

export interface RetestCandidate {
  video_id: string; title: string; published_at: string; thumbnail_url: string;
  current_ctr: number; impressions: number; views: number;
  avg_view_duration_sec: number; ctr_gap: number;
  has_test: boolean; test_status: string | null; test_id: number | null;
}

export interface RetestCandidatesResponse {
  candidates: RetestCandidate[];
  suggested_tags: ThumbnailTag[];
  channel_avg_ctr: number;
}

export const tags = {
  list: (search?: string) =>
    apiFetch<ThumbnailTag[]>(`/api/tags${search ? `?search=${encodeURIComponent(search)}` : ""}`),
  autoTag: (opts?: { all?: boolean; limit?: number }) =>
    apiFetch<{ processed: number; tagged: number; tags: number; errors: number }>("/api/tags/auto-tag", {
      method: "POST",
      body: JSON.stringify(opts ?? { all: true }),
    }),
  create: (name: string, color?: string) =>
    apiFetch<ThumbnailTag>("/api/tags", { method: "POST", body: JSON.stringify({ name, color }) }),
  update: (id: number, data: { name?: string; color?: string; category?: string }) =>
    apiFetch<{ ok: boolean }>(`/api/tags/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  delete: (id: number) =>
    apiFetch<{ ok: boolean }>(`/api/tags/${id}`, { method: "DELETE" }),
  setForVariant: (testId: number, variantId: number, tagIds: number[]) =>
    apiFetch<{ ok: boolean }>(`/api/tests/${testId}/variants/${variantId}/tags`, { method: "PUT", body: JSON.stringify({ tag_ids: tagIds }) }),
  addToVariant: (testId: number, variantId: number, tagName: string) =>
    apiFetch<{ ok: boolean; tag: ThumbnailTag }>(`/api/tests/${testId}/variants/${variantId}/tags`, { method: "POST", body: JSON.stringify({ tag_name: tagName }) }),
  removeFromVariant: (testId: number, variantId: number, tagId: number) =>
    apiFetch<{ ok: boolean }>(`/api/tests/${testId}/variants/${variantId}/tags/${tagId}`, { method: "DELETE" }),
  analytics: (params?: Record<string, string>) =>
    apiFetch<{ tags: TagAnalyticsItem[]; comparisons: any[]; byCategory?: Record<string, any[]> }>(`/api/tags/analytics?${new URLSearchParams(params || {})}`),
  tagDetail: (tagId: number, contentType?: TagContentType) =>
    apiFetch<{ tag: ThumbnailTag; variants: any[] }>(`/api/tags/analytics/${tagId}${contentType ? `?content_type=${contentType}` : ""}`),
  combos: (contentType?: TagContentType) =>
    apiFetch<{ best: any[]; worst: any[]; all: any[]; global_avg: any }>(`/api/tags/analytics/combos${contentType ? `?content_type=${contentType}` : ""}`),
  filter: (include: number[], exclude: number[], contentType?: TagContentType) =>
    apiFetch<{ matching: any[]; aggregate: any; other: any; global_avg: any }>(
      `/api/tags/analytics/filter?include=${include.join(',')}&exclude=${exclude.join(',')}${contentType ? `&content_type=${contentType}` : ""}`
    ),
  playbook: (contentType?: TagContentType) =>
    apiFetch<PlaybookResponse>(`/api/tags/analytics/playbook${contentType ? `?content_type=${contentType}` : ""}`),
  retestHistory: () =>
    apiFetch<RetestHistoryResponse>("/api/tags/analytics/retests"),
  retestCandidates: () =>
    apiFetch<RetestCandidatesResponse>("/api/tags/analytics/retest-candidates"),
};

// ---- Title Lab (episode title chat) ----

export interface TitleSession {
  id: number;
  episode_title: string | null;
  created_at: string;
  updated_at: string;
  transcript_chars: number;
}

export interface TitleSuggestion {
  id: number;
  message_id: number | null;
  title: string;
  rationale: string | null;
  feedback: number;
}

export interface TitleMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
  created_at: string;
}

export const titleChat = {
  sessions: () => apiFetch<TitleSession[]>("/api/title-chat/sessions"),
  create: (transcript: string, episode_title?: string) =>
    apiFetch<{ id: number }>("/api/title-chat/sessions", {
      method: "POST",
      body: JSON.stringify({ transcript, episode_title }),
    }),
  get: (id: number) =>
    apiFetch<{ session: TitleSession; messages: TitleMessage[]; suggestions: TitleSuggestion[] }>(
      `/api/title-chat/sessions/${id}`
    ),
  delete: (id: number) =>
    apiFetch<{ ok: boolean }>(`/api/title-chat/sessions/${id}`, { method: "DELETE" }),
  feedback: (suggestionId: number, feedback: 1 | -1 | 0) =>
    apiFetch<{ ok: boolean }>(`/api/title-chat/suggestions/${suggestionId}/feedback`, {
      method: "POST",
      body: JSON.stringify({ feedback }),
    }),
};

export function streamTitleChat(
  sessionId: number,
  body: { message?: string; action?: "suggest" | "more_liked" },
  onEvent: (event: Record<string, any>) => void,
  onDone: () => void,
) {
  fetch(`/api/title-chat/sessions/${sessionId}/stream`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then(async (res) => {
    if (!res.ok) {
      let msg = `Request failed (HTTP ${res.status})`;
      try { const j = await res.json(); if (j?.detail) msg = j.detail; } catch {}
      onEvent({ type: "error", message: msg });
      onDone();
      return;
    }
    const reader = res.body?.getReader();
    if (!reader) { onDone(); return; }
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          try {
            const event = JSON.parse(line.slice(6));
            onEvent(event);
            if (event.type === "done" || event.type === "error") { onDone(); return; }
          } catch {}
        }
      }
    }
    onDone();
  }).catch((err) => {
    console.error("[streamTitleChat] Error:", err);
    onEvent({ type: "error", message: err?.message || "Connection failed" });
    onDone();
  });
}

export function streamChat(
  url: string,
  body: { message: string; image_url?: string },
  onEvent: (event: SSEEvent) => void,
  onDone: () => void,
  signal?: AbortSignal,
) {
  fetch(url, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  }).then(async (res) => {
    const reader = res.body?.getReader();
    if (!reader) { onDone(); return; }
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          try {
            const event = JSON.parse(line.slice(6));
            onEvent(event);
            if (event.type === "done" || event.type === "error") { onDone(); return; }
          } catch {}
        }
      }
    }
    onDone();
  }).catch((err) => {
    console.error('[streamChat] Error:', err);
    onEvent({ type: 'error', message: err?.message || 'Connection failed' });
    onDone();
  });
}

// ===== Learnings ("What we've learned") =====
export interface LearnPortfolio {
  total_tests: number;
  confident: number;
  lean: number;
  coinflip: number;
  avg_confident_lift: number;
  extra_views_total: number;
  decisive_rate: number;
}
export interface LearnTagUplift {
  tag_id: number;
  name: string;
  category: string | null;
  color: string | null;
  tests: number;
  avg_uplift_pct: number;
  win_rate: number;
  verdict: "proven" | "promising" | "coinflip" | "weak";
}
export interface LearnTest {
  test_id: number;
  video_title: string | null;
  video_id: string;
  test_type: string;
  completed_at: string | null;
  winner_label: string | null;
  winner_ctr: number;
  runnerup_label: string | null;
  runnerup_ctr: number;
  lift_pct: number;
  winner_impressions: number;
  confidence: number;
  tier: "confident" | "lean" | "coinflip";
  extra_views: number;
}
export interface LearnMention {
  text: string;
  author: string | null;
  video_id: string | null;
  comment_id: string | null;
  video_title: string | null;
  is_competitor: number;
  published_at: string | null;
}
export interface LearningsResponse {
  portfolio: LearnPortfolio;
  proven: LearnTagUplift[];
  promising: LearnTagUplift[];
  busted: LearnTagUplift[];
  inconclusive?: LearnTagUplift[];
  topWins: LearnTest[];
  tests: LearnTest[];
  mentions: { total: number; recent: LearnMention[] };
}
export type ContentType = "podcast" | "TNTL";

export const learnings = {
  get: (type?: ContentType) =>
    apiFetch<LearningsResponse>(`/api/learnings${type ? `?type=${type}` : ""}`),
  portfolio: () => apiFetch<LearnPortfolio>("/api/learnings/portfolio"),
};

export interface CorpusTag {
  name: string; category: string | null; videos: number; lift_vs_median: number; median_views: number;
}
export interface AbTitleTag {
  name: string; category: string | null; tests: number; avg_uplift_pct: number; win_rate: number;
}
export interface TitleInsights {
  corpus: Record<ContentType, { median_views: number; total_videos: number; tags: CorpusTag[] }>;
  ab: Record<ContentType, AbTitleTag[]>;
}
export const titleInsights = {
  get: () => apiFetch<TitleInsights>("/api/title-insights"),
};

export interface WwTag { name: string; category: string | null; tests: number; avg_uplift_pct: number; win_rate: number; }
export interface WwSection { total: number; winners: WwTag[]; losers: WwTag[]; }
export interface WhatWorks {
  since: number | null;
  titles: { podcast: WwSection; TNTL: WwSection };
  thumbnails: { podcast: WwSection; TNTL: WwSection };
}
export const whatWorks = {
  get: (since?: "7" | "30" | "all") => apiFetch<WhatWorks>(`/api/what-works${since && since !== "all" ? `?since=${since}` : ""}`),
};
export const preflight = {
  calibration: () => apiFetch<CalibrationReport>("/api/preflight/calibration"),
};

export interface GrowthData {
  formats: { format: string; ours: number; benchmark: number; ratio: number | null }[];
  levers: { titlePodcast: { name: string; uplift: number }[]; titleTNTL: { name: string; uplift: number }[]; thumbPodcast: { name: string; uplift: number }[]; thumbTNTL: { name: string; uplift: number }[] };
}
export const growth = {
  get: () => apiFetch<GrowthData>("/api/growth"),
};

export interface ChannelStatRow {
  id: number; date: string; captured_at: string;
  subscriber_count: number; view_count: number; video_count: number;
}
export interface ChannelStatsGoals {
  subs_goal: number; views_goal: number; deadline: string;
  days_left: number; months_left: number;
  current_subs: number; podcast_avg_views_30ep: number;
  subs_monthly_growth_needed: number | null;
  views_monthly_growth_needed: number | null;
}
export interface ChannelStatsResponse {
  latest: ChannelStatRow | null;
  history: ChannelStatRow[];
  goals: ChannelStatsGoals;
}
export const channelStats = {
  get: () => apiFetch<ChannelStatsResponse>("/api/analytics/channel-stats"),
  liveSubs: () => apiFetch<{ subscribers_exact: number; subs_per_second: number; source: string; fetched_at: string }>("/api/channel/live-subs"),
  forecast: () => apiFetch<ChannelForecast>("/api/channel/forecast"),
};

export interface ForecastLever {
  id: string; label: string; description: string;
  subs_boost_days: number; views_boost_days: number;
}
export interface ChannelForecast {
  computed_at: string; data_days: number; confidence: 'low' | 'medium' | 'high'; note: string;
  current_subs: number; subs_goal: number; subs_needed: number;
  daily_rates: { p25: number; median: number; p75: number };
  subs_forecast: { pessimistic_date: string | null; baseline_date: string | null; optimistic_date: string | null };
  longform_uploads_per_week: number; compilation_pct: number;
  recent_compilation_avg_views: number; recent_standard_avg_views: number; current_30ep_avg: number; views_goal: number;
  views_forecast: { baseline_date: string | null; note: string };
  levers: ForecastLever[];
  best_lever: ForecastLever | null;
}

export interface CompetitorGrowthFinding {
  id: number;
  competitor_id: number;
  competitor_name: string;
  finding_type: string;
  headline: string;
  detail: string | null;
  uplift: number;
  computed_at: string;
  evidence_json?: string | null;
}

export interface CompetitorSuggestion {
  id: number;
  channel_id: string;
  name: string;
  handle: string | null;
  subscriber_count: number;
  video_count: number;
  thumbnail: string | null;
  reason: string | null;
  suggested_at: string;
  status: string;
}

export const competitorIntel = {
  findings: (limit = 8) => apiFetch<CompetitorGrowthFinding[]>(`/api/competitors/growth-findings?limit=${limit}`),
  suggestions: () => apiFetch<CompetitorSuggestion[]>('/api/competitors/suggestions'),
  approve: (id: number) => apiFetch<{ ok: boolean; detail?: string }>(`/api/competitors/suggestions/${id}/approve`, { method: 'POST' }),
  dismiss: (id: number) => apiFetch<{ ok: boolean }>(`/api/competitors/suggestions/${id}/dismiss`, { method: 'POST' }),
};

export interface DataIntegrity {
  summary: { completed_tests: number; tests_no_real_data: number; suspect_rows: number; legacy_baseline_rows: number };
  no_real_data: { test_id: number; video_title: string | null; completed_at: string | null }[];
  suspect_rows: { test_id: number; variant_label: string | null; measured_at: string | null; impressions: number; views: number; ctr: number; reason: string }[];
}
export const dataIntegrity = {
  get: () => apiFetch<DataIntegrity>("/api/data-integrity"),
};

// ===== The Producer (unified strategy + title chat) =====
export interface ProducerConversation {
  id: number; title: string; transcript_id: number | null;
  transcript_title?: string | null; day_slot?: string | null;
  created_at: string; updated_at: string;
}
export interface ProducerMessage { id: number; role: "user" | "assistant"; content: string; created_at: string; }
export interface ProducerSuggestion { id: number; message_id: number; title: string; rationale: string; slot?: string | null; feedback: number; }

export interface ProposalPreflight { score: number; ctr_band: string; confidence: string; verdict: string; signals: Array<{ tag: string; verdict: string; uplift_pct: number }>; reasons: string[]; }
export interface ProposalTitle { title: string; pattern: string; rationale: string; preflight: ProposalPreflight; }
export interface ProposalThumbnail { concept: string; rationale: string; winning_tags: string[]; }
export interface ProposalTestPlan { first: 'title' | 'thumbnail'; rationale: string; chain: boolean; }
export interface ProposalPack {
  id: number; transcript_id: number | null; video_id: string | null; source: 'transcript' | 'video';
  episode_title: string; content_type: string;
  titles: ProposalTitle[]; thumbnails: ProposalThumbnail[]; test_plan: ProposalTestPlan;
  status: 'pending' | 'converted' | 'dismissed'; created_at: string;
}
export interface CalibrationBand { predicted_band: string; predictions: number; resolved: number; correct: number; accuracy: number | null; avg_actual_ctr: number | null; }
export interface CalibrationReport { total_predictions: number; resolved: number; overall_accuracy: number | null; by_band: CalibrationBand[]; health_note: string; }
export const proposals = {
  list: (status = 'pending') => apiFetch<ProposalPack[]>(`/api/producer/proposals?status=${status}`),
  propose: (transcriptId: number, content_type?: string) => apiFetch<ProposalPack>(`/api/producer/transcripts/${transcriptId}/propose`, { method: 'POST', body: JSON.stringify({ content_type }) }),
  createTest: (id: number, opts: { title_index: number; video_id: string; video_title?: string; start?: boolean }) => apiFetch<{ ok: boolean; test_id: number; started: boolean }>(`/api/producer/proposals/${id}/create-test`, { method: 'POST', body: JSON.stringify(opts) }),
  dismiss: (id: number) => apiFetch<{ ok: boolean }>(`/api/producer/proposals/${id}/dismiss`, { method: 'POST' }),
};

export const producer = {
  processDoc: () => apiFetch<{ content: string }>("/api/producer/process-doc"),
  saveProcessDoc: (content: string) => apiFetch<{ ok: boolean }>("/api/producer/process-doc", { method: "PUT", body: JSON.stringify({ content }) }),
  conversations: () => apiFetch<ProducerConversation[]>("/api/producer/conversations"),
  create: (opts?: { title?: string; transcript_id?: number }) => apiFetch<{ id: number }>("/api/producer/conversations", { method: "POST", body: JSON.stringify(opts || {}) }),
  get: (id: number) => apiFetch<{ conversation: ProducerConversation; messages: ProducerMessage[]; suggestions: ProducerSuggestion[]; transcript: any; video: any }>(`/api/producer/conversations/${id}`),
  remove: (id: number) => apiFetch<{ ok: boolean }>(`/api/producer/conversations/${id}`, { method: "DELETE" }),
  addTranscript: (data: { title?: string; transcript: string; episode_code?: string }) => apiFetch<{ id: number; day_slot: string | null }>("/api/producer/transcripts", { method: "POST", body: JSON.stringify(data) }),
  feedback: (id: number, feedback: 1 | -1 | 0) => apiFetch<{ ok: boolean }>(`/api/producer/suggestions/${id}/feedback`, { method: "POST", body: JSON.stringify({ feedback }) }),
  attachVideo: (convId: number, video_id: string, video_title?: string) => apiFetch<{ ok: boolean }>(`/api/producer/conversations/${convId}/attach-video`, { method: "POST", body: JSON.stringify({ video_id, video_title }) }),
  attachEpisode: (convId: number, video_id: string) => apiFetch<{ ok: boolean; video: any; transcript_loaded: boolean; episode_title: string | null; tests: any[]; podcast_stats: { listens: number; unique_listeners: number; video_views: number; perf_index: number | null; yt_views: number | null } | null; videos: { video_id: string; video_title: string | null; day_label: string | null }[] }>(`/api/producer/conversations/${convId}/attach-episode`, { method: "POST", body: JSON.stringify({ video_id }) }),
  conversationVideos: (convId: number) => apiFetch<{ videos: { video_id: string; video_title: string | null; day_label: string | null; has_transcript: number }[] }>(`/api/producer/conversations/${convId}/videos`),
  removeConversationVideo: (convId: number, videoId: string) => apiFetch<{ ok: boolean; videos: { video_id: string; video_title: string | null; day_label: string | null }[] }>(`/api/producer/conversations/${convId}/videos/${videoId}`, { method: "DELETE" }),
  prerelease: () => apiFetch<{ id: number; title: string; date: string }[]>("/api/producer/prerelease"),
  attachPrerelease: (convId: number, prerelease_id: number) => apiFetch<{ ok: boolean; transcript_loaded: boolean; episode_title: string; prerelease: boolean; videos: { video_id: string; video_title: string | null; day_label: string | null }[] }>(`/api/producer/conversations/${convId}/attach-prerelease`, { method: "POST", body: JSON.stringify({ prerelease_id }) }),
  setModel: (convId: number, model: string) => apiFetch<{ ok: boolean }>(`/api/producer/conversations/${convId}/model`, { method: "POST", body: JSON.stringify({ model }) }),
  rename: (convId: number, title: string) => apiFetch<{ ok: boolean }>(`/api/producer/conversations/${convId}`, { method: "PATCH", body: JSON.stringify({ title }) }),
  createTest: (convId: number, opts: { titles: string[]; test_type?: "title" | "both"; video_id?: string; video_title?: string; start?: boolean }) => apiFetch<{ ok: boolean; test_id: number; variants: number; started: boolean }>(`/api/producer/conversations/${convId}/create-test`, { method: "POST", body: JSON.stringify(opts) }),
};

export function streamProducer(
  conversationId: number,
  message: string,
  onEvent: (event: Record<string, any>) => void,
  onDone: () => void,
  extra?: { images?: { media_type: string; data: string }[]; documents?: { media_type: string; data: string; name?: string }[]; attach_transcript?: string },
) {
  fetch(`/api/producer/conversations/${conversationId}/stream`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, ...extra }),
  }).then(async (res) => {
    if (!res.ok) {
      let msg = `Request failed (HTTP ${res.status})`;
      try { const j = await res.json(); if (j?.detail) msg = j.detail; } catch {}
      onEvent({ type: "error", message: msg }); onDone(); return;
    }
    const reader = res.body?.getReader();
    if (!reader) { onDone(); return; }
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          try {
            const event = JSON.parse(line.slice(6));
            onEvent(event);
            if (event.type === "done" || event.type === "error") { onDone(); return; }
          } catch {}
        }
      }
    }
    onDone();
  }).catch((err) => { onEvent({ type: "error", message: err?.message || "Connection failed" }); onDone(); });
}
