-- Users (Google OAuth)
CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  google_id  TEXT UNIQUE NOT NULL,
  email      TEXT UNIQUE NOT NULL,
  name       TEXT NOT NULL,
  avatar     TEXT,
  role       TEXT NOT NULL DEFAULT 'admin',
  status     TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Sessions
CREATE TABLE IF NOT EXISTS sessions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  token      TEXT UNIQUE NOT NULL,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  auth_source TEXT NOT NULL DEFAULT 'native'
);

-- A/B Tests
CREATE TABLE IF NOT EXISTS tests (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id                  TEXT NOT NULL,
  video_title               TEXT,
  test_type                 TEXT NOT NULL DEFAULT 'thumbnail' CHECK(test_type IN ('thumbnail','title','both')),
  status                    TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','paused','completed','failed')),
  original_thumbnail_blob   BLOB,
  original_title            TEXT,
  winner_variant_id         INTEGER,
  schedule_id               INTEGER,
  duration_hours_per_variant INTEGER NOT NULL DEFAULT 4,
  min_impressions           INTEGER NOT NULL DEFAULT 500,
  started_at                TEXT,
  completed_at              TEXT,
  created_at                TEXT NOT NULL DEFAULT (datetime('now')),
  error_msg                 TEXT
);

-- Test variants (thumbnails and/or titles to compare)
CREATE TABLE IF NOT EXISTS test_variants (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  test_id         INTEGER NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
  label           TEXT NOT NULL DEFAULT 'A',
  thumbnail_path  TEXT,
  title           TEXT,
  is_control      INTEGER NOT NULL DEFAULT 0,
  active_since    TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Test measurements (one row per variant per measurement cycle)
CREATE TABLE IF NOT EXISTS test_measurements (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  test_id               INTEGER NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
  variant_id            INTEGER NOT NULL REFERENCES test_variants(id) ON DELETE CASCADE,
  measured_at           TEXT NOT NULL DEFAULT (datetime('now')),
  impressions           INTEGER NOT NULL DEFAULT 0,
  views                 INTEGER NOT NULL DEFAULT 0,
  ctr                   REAL NOT NULL DEFAULT 0.0,
  unique_viewers        INTEGER NOT NULL DEFAULT 0,
  watch_time_hours      REAL NOT NULL DEFAULT 0.0,
  avg_view_duration     REAL NOT NULL DEFAULT 0.0,
  avg_view_pct          REAL NOT NULL DEFAULT 0.0,
  likes                 INTEGER NOT NULL DEFAULT 0,
  comments              INTEGER NOT NULL DEFAULT 0,
  subs_gained           INTEGER NOT NULL DEFAULT 0,
  subs_lost             INTEGER NOT NULL DEFAULT 0,
  retention_json        TEXT,
  traffic_sources_json  TEXT,
  device_breakdown_json TEXT,
  realtime_views_json   TEXT
);

-- Bulk test schedules
CREATE TABLE IF NOT EXISTS test_schedules (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  name                 TEXT NOT NULL,
  video_ids_json       TEXT NOT NULL,
  variant_configs_json TEXT NOT NULL,
  cron                 TEXT NOT NULL DEFAULT '0 * * * *',
  duration_hours       INTEGER NOT NULL DEFAULT 4,
  min_impressions      INTEGER NOT NULL DEFAULT 500,
  is_active            INTEGER NOT NULL DEFAULT 1,
  last_run_at          TEXT,
  created_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Competitor channels
CREATE TABLE IF NOT EXISTS competitors (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id        TEXT UNIQUE NOT NULL,
  name              TEXT NOT NULL,
  handle            TEXT,
  subscriber_count  INTEGER DEFAULT 0,
  video_count       INTEGER DEFAULT 0,
  is_auto_discovered INTEGER NOT NULL DEFAULT 0,
  tracked_since     TEXT NOT NULL DEFAULT (datetime('now')),
  last_synced_at    TEXT
);

-- Competitor videos
CREATE TABLE IF NOT EXISTS competitor_videos (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  competitor_id   INTEGER NOT NULL REFERENCES competitors(id) ON DELETE CASCADE,
  video_id        TEXT UNIQUE NOT NULL,
  title           TEXT,
  published_at    TEXT,
  thumbnail_url   TEXT,
  views           INTEGER DEFAULT 0,
  likes           INTEGER DEFAULT 0,
  comments        INTEGER DEFAULT 0,
  duration_seconds INTEGER,
  fetched_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Comments (social listening)
CREATE TABLE IF NOT EXISTS comments (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  comment_id           TEXT UNIQUE NOT NULL,
  video_id             TEXT NOT NULL,
  channel_id           TEXT NOT NULL,
  author               TEXT,
  author_channel_url   TEXT,
  author_profile_image TEXT,
  content              TEXT NOT NULL,
  like_count           INTEGER DEFAULT 0,
  published_at         TEXT,
  sentiment            TEXT,
  topics_json          TEXT,
  mentions_us          INTEGER NOT NULL DEFAULT 0,
  fetched_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Comment topic aggregation
CREATE TABLE IF NOT EXISTS comment_topics (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  topic         TEXT UNIQUE NOT NULL,
  count         INTEGER NOT NULL DEFAULT 0,
  avg_sentiment REAL,
  last_seen     TEXT
);

-- Chat conversations
CREATE TABLE IF NOT EXISTS chat_conversations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  title      TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Chat messages
CREATE TABLE IF NOT EXISTS chat_messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL,
  content         TEXT NOT NULL,
  attachments_json TEXT NOT NULL DEFAULT '[]',
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- YouTube Studio snapshots (real-time data from Playwright scraper)
CREATE TABLE IF NOT EXISTS studio_snapshots (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id              TEXT NOT NULL,
  scraped_at            TEXT NOT NULL DEFAULT (datetime('now')),
  impressions           INTEGER NOT NULL DEFAULT 0,
  ctr                   REAL NOT NULL DEFAULT 0.0,
  views                 INTEGER NOT NULL DEFAULT 0,
  unique_viewers        INTEGER NOT NULL DEFAULT 0,
  watch_time_hours      REAL NOT NULL DEFAULT 0.0,
  avg_view_duration_sec REAL NOT NULL DEFAULT 0.0,
  avg_view_pct          REAL NOT NULL DEFAULT 0.0,
  subscribers_net       INTEGER NOT NULL DEFAULT 0,
  likes                 INTEGER NOT NULL DEFAULT 0,
  engaged_views         INTEGER NOT NULL DEFAULT 0,
  estimated_earnings    REAL NOT NULL DEFAULT 0.0,
  like_rate             REAL NOT NULL DEFAULT 0.0,
  retention_json        TEXT,
  traffic_sources_json  TEXT,
  device_breakdown_json TEXT,
  realtime_views_json   TEXT,
  typical_views         INTEGER NOT NULL DEFAULT 0,
  typical_range_json    TEXT,
  comments              INTEGER NOT NULL DEFAULT 0
);

-- Invite tokens
CREATE TABLE IF NOT EXISTS invites (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  token      TEXT UNIQUE NOT NULL,
  email      TEXT NOT NULL,
  invited_by INTEGER NOT NULL REFERENCES users(id),
  role       TEXT NOT NULL DEFAULT 'viewer',
  used_at    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Pre-release transcripts (upcoming episodes for AI review)
CREATE TABLE IF NOT EXISTS prerelease_transcripts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  transcript  TEXT NOT NULL,
  uploaded_by INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- API quota tracking
CREATE TABLE IF NOT EXISTS quota_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  action     TEXT NOT NULL,
  units      INTEGER NOT NULL,
  test_id    INTEGER,
  video_id   TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Thumbnail analysis (Claude Vision tags)
CREATE TABLE IF NOT EXISTS thumbnail_analysis (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id        TEXT UNIQUE NOT NULL,
  title           TEXT,
  thumbnail_url   TEXT,
  views           INTEGER DEFAULT 0,
  ctr             REAL DEFAULT 0,
  -- Facial expression tags
  expression      TEXT,          -- shocked, laughing, neutral, scared, angry, confused, excited
  mouth_open      INTEGER DEFAULT 0,
  eyebrows_raised INTEGER DEFAULT 0,
  -- People
  face_count      INTEGER DEFAULT 0,
  face_size       TEXT,          -- large, medium, small
  -- Colors
  primary_color   TEXT,          -- red, blue, green, yellow, purple, orange, pink, white, black
  secondary_color TEXT,
  brightness      TEXT,          -- bright, dark, medium
  contrast        TEXT,          -- high, medium, low
  -- Text
  has_text        INTEGER DEFAULT 0,
  text_content    TEXT,
  text_color      TEXT,
  text_size       TEXT,          -- large, medium, small
  all_caps_text   INTEGER DEFAULT 0,
  -- Composition
  layout          TEXT,          -- face-left, face-right, centered, split
  background_type TEXT,          -- solid, photo, gradient, collage
  has_border      INTEGER DEFAULT 0,
  has_emoji       INTEGER DEFAULT 0,
  -- Raw analysis
  analysis_json   TEXT,
  analyzed_at     TEXT NOT NULL DEFAULT (datetime('now')),
  faces_json      TEXT DEFAULT '[]'
);

-- Competitor thumbnail analysis (same schema as ours)
CREATE TABLE IF NOT EXISTS competitor_thumbnail_analysis (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id        TEXT UNIQUE NOT NULL,
  channel_name    TEXT,
  title           TEXT,
  thumbnail_url   TEXT,
  views           INTEGER DEFAULT 0,
  expression      TEXT,
  mouth_open      INTEGER DEFAULT 0,
  eyebrows_raised INTEGER DEFAULT 0,
  face_count      INTEGER DEFAULT 0,
  face_size       TEXT,
  primary_color   TEXT,
  secondary_color TEXT,
  brightness      TEXT,
  contrast        TEXT,
  has_text        INTEGER DEFAULT 0,
  text_content    TEXT,
  text_color      TEXT,
  text_size       TEXT,
  all_caps_text   INTEGER DEFAULT 0,
  layout          TEXT,
  background_type TEXT,
  has_border      INTEGER DEFAULT 0,
  has_emoji       INTEGER DEFAULT 0,
  analysis_json   TEXT,
  analyzed_at     TEXT NOT NULL DEFAULT (datetime('now')),
  faces_json      TEXT DEFAULT '[]'
);

-- Hourly metrics (per-video, per-hour data from extension)
CREATE TABLE IF NOT EXISTS hourly_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id TEXT NOT NULL,
  hour_ts TEXT NOT NULL,
  impressions INTEGER NOT NULL DEFAULT 0,
  views INTEGER NOT NULL DEFAULT 0,
  ctr REAL NOT NULL DEFAULT 0,
  watch_time_ms INTEGER NOT NULL DEFAULT 0,
  avg_watch_time_ms INTEGER NOT NULL DEFAULT 0,
  subscribers_net INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(video_id, hour_ts)
);

-- Channel videos cache
CREATE TABLE IF NOT EXISTS channel_videos (
  video_id TEXT PRIMARY KEY,
  title TEXT,
  published_at TEXT,
  duration_seconds INTEGER,
  is_short INTEGER DEFAULT 0,
  view_count INTEGER,
  like_count INTEGER,
  comment_count INTEGER,
  thumbnail_url TEXT,
  synced_at TEXT DEFAULT (datetime('now'))
);

-- Tag categories (user-editable columns for organizing tags)
CREATE TABLE IF NOT EXISTS tag_categories (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT UNIQUE NOT NULL,
  color      TEXT NOT NULL DEFAULT '#6b7280',
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- Seed default categories if empty
INSERT OR IGNORE INTO tag_categories (name, color, sort_order) VALUES
  ('background', '#3b82f6', 0),
  ('people', '#22c55e', 1),
  ('elements', '#f59e0b', 2),
  ('extras', '#a855f7', 3),
  ('other', '#6b7280', 4);

-- Thumbnail tags (reusable across all tests)
CREATE TABLE IF NOT EXISTS thumbnail_tags (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT UNIQUE NOT NULL,
  color      TEXT NOT NULL DEFAULT '#7c63ff',
  category   TEXT NOT NULL DEFAULT 'other',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Variant-tag junction (many-to-many)
CREATE TABLE IF NOT EXISTS variant_tags (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  variant_id INTEGER NOT NULL REFERENCES test_variants(id) ON DELETE CASCADE,
  tag_id     INTEGER NOT NULL REFERENCES thumbnail_tags(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(variant_id, tag_id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_variant_tags_variant ON variant_tags(variant_id);
CREATE INDEX IF NOT EXISTS idx_variant_tags_tag ON variant_tags(tag_id);
CREATE INDEX IF NOT EXISTS idx_tests_status ON tests(status);
CREATE INDEX IF NOT EXISTS idx_tests_video ON tests(video_id);
CREATE INDEX IF NOT EXISTS idx_measurements_test ON test_measurements(test_id);
CREATE INDEX IF NOT EXISTS idx_measurements_variant ON test_measurements(variant_id);
CREATE INDEX IF NOT EXISTS idx_comments_video ON comments(video_id);
CREATE INDEX IF NOT EXISTS idx_comments_channel ON comments(channel_id);
CREATE INDEX IF NOT EXISTS idx_comments_mentions ON comments(mentions_us);
CREATE INDEX IF NOT EXISTS idx_competitor_videos_competitor ON competitor_videos(competitor_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_conv ON chat_messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_studio_snapshots_video ON studio_snapshots(video_id);
CREATE INDEX IF NOT EXISTS idx_studio_snapshots_time ON studio_snapshots(scraped_at);
CREATE INDEX IF NOT EXISTS idx_channel_videos_published ON channel_videos(published_at);

-- Title Lab (episode title chat, rebuilt 2026-06)
CREATE TABLE IF NOT EXISTS title_sessions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER,
  episode_title TEXT,
  transcript    TEXT NOT NULL,
  created_at    TEXT DEFAULT (datetime('now')),
  updated_at    TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS title_messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  INTEGER NOT NULL REFERENCES title_sessions(id) ON DELETE CASCADE,
  role        TEXT NOT NULL,
  content     TEXT NOT NULL,
  created_at  TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS title_suggestions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  INTEGER NOT NULL REFERENCES title_sessions(id) ON DELETE CASCADE,
  message_id  INTEGER,
  title       TEXT NOT NULL,
  rationale   TEXT,
  feedback    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS channel_intel_cache (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  content      TEXT NOT NULL,
  generated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_title_messages_session ON title_messages(session_id);
CREATE INDEX IF NOT EXISTS idx_title_suggestions_session ON title_suggestions(session_id);
CREATE INDEX IF NOT EXISTS idx_title_suggestions_feedback ON title_suggestions(feedback);

-- Pre-flight prediction calibration log
-- Stores each preflight score at the moment a title is evaluated, then records the
-- actual winner CTR once the test completes so we can measure how well the model predicts.
CREATE TABLE IF NOT EXISTS title_predictions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id         TEXT,
  test_id          INTEGER,
  title            TEXT NOT NULL,
  predicted_band   TEXT NOT NULL,
  predicted_score  INTEGER NOT NULL,
  confidence       TEXT NOT NULL,
  patterns_json    TEXT NOT NULL DEFAULT '[]',
  actual_winner_ctr REAL,
  actual_band      TEXT,
  resolved_at      TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_title_predictions_test ON title_predictions(test_id);
CREATE INDEX IF NOT EXISTS idx_title_predictions_video ON title_predictions(video_id);

-- Retention-transcript overlay: drop and hold moments per video, with transcript context
CREATE TABLE IF NOT EXISTS retention_moments (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id       TEXT NOT NULL,
  moment_type    TEXT NOT NULL CHECK(moment_type IN ('drop','hold')),
  time_sec       REAL NOT NULL,
  timecode       TEXT NOT NULL,
  retention_pct  REAL NOT NULL,
  delta_pct      REAL NOT NULL,
  transcript_quote TEXT,
  segment_type   TEXT NOT NULL DEFAULT 'discussion',
  computed_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_retention_moments_video ON retention_moments(video_id);
CREATE INDEX IF NOT EXISTS idx_retention_moments_type ON retention_moments(video_id, moment_type);
