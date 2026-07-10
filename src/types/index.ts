export interface User {
  id: number;
  google_id: string;
  email: string;
  name: string;
  avatar: string | null;
  role: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface Test {
  id: number;
  video_id: string;
  video_title: string | null;
  test_type: 'thumbnail' | 'title' | 'both';
  status: 'pending' | 'running' | 'paused' | 'completed' | 'failed';
  original_thumbnail_blob: Buffer | null;
  original_title: string | null;
  winner_variant_id: number | null;
  schedule_id: number | null;
  duration_hours_per_variant: number;
  min_impressions: number;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  error_msg: string | null;
  channel: 'main' | 'clips';
}

export interface TestVariant {
  id: number;
  test_id: number;
  label: string;
  thumbnail_path: string | null;
  title: string | null;
  is_control: number;
  active_since: string | null;
  created_at: string;
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
  retention_json: string | null;
  traffic_sources_json: string | null;
  device_breakdown_json: string | null;
  realtime_views_json: string | null;
}

export interface Competitor {
  id: number;
  channel_id: string;
  name: string;
  handle: string | null;
  subscriber_count: number;
  video_count: number;
  is_auto_discovered: number;
  tracked_since: string;
  last_synced_at: string | null;
}

export interface Comment {
  id: number;
  comment_id: string;
  video_id: string;
  channel_id: string;
  author: string | null;
  content: string;
  like_count: number;
  published_at: string | null;
  sentiment: string | null;
  topics_json: string | null;
  mentions_us: number;
  fetched_at: string;
}
