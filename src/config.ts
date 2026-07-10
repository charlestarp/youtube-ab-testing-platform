import 'dotenv/config';
import { resolve } from 'path';

const root = resolve(import.meta.dirname, '..');

export const config = {
  port: parseInt(process.env.PORT || '4700'),
  host: process.env.HOST || '0.0.0.0',
  nodeEnv: process.env.NODE_ENV || 'development',
  isDev: (process.env.NODE_ENV || 'development') === 'development',

  // Database
  dbPath: resolve(root, process.env.DB_PATH || './data/testing.db'),
  youtubeDbPath: process.env.YOUTUBE_DB_PATH || '',
  podcastDbPath: process.env.PODCAST_DB_PATH || '/Users/charlespatterson/Projects/TARPGPT/podcast_search/podcast.db',

  // YouTube (multiple API keys for quota rotation)
  youtubeApiKey: process.env.YOUTUBE_API_KEY || '',
  youtubeApiKeys: (process.env.YOUTUBE_API_KEYS || process.env.YOUTUBE_API_KEY || '').split(',').filter(Boolean),
  youtubeChannelId: process.env.YOUTUBE_CHANNEL_ID || '',
  ytAnalyticsTokenPath: process.env.YT_ANALYTICS_TOKEN_PATH || '',
  // Extra main-channel OAuth token files (one per Cloud project) for WRITE-quota
  // rotation. Each file is self-contained: { refresh_token, client_id, client_secret }.
  // On a Data-API quota error the write hops to the next project's token.
  ytWriteTokenPaths: (process.env.YT_WRITE_TOKEN_PATHS || '').split(',').map(s => s.trim()).filter(Boolean),

  // Google OAuth
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    redirectUri: process.env.GOOGLE_REDIRECT_URI || 'http://localhost:4701/api/auth/callback',
  },

  // Claude
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',

  // Internal token for watchdog/cron alerts (no user session needed)
  internalToken: process.env.INTERNAL_TOKEN || '',

  // Fleet feedback widget — forward to home's ingest endpoint
  homeFeedbackUrl: process.env.HOME_FEEDBACK_URL || 'http://localhost:4860/api/feedback/ingest',
  homeFeedbackToken: process.env.HOME_FEEDBACK_TOKEN || '',

  // Session
  sessionSecret: process.env.SESSION_SECRET || 'change-me',
  sessionMaxAge: 90 * 24 * 60 * 60 * 1000, // 90 days

  // Fleet SSO consumer key (this app's independent HMAC secret; empty = disabled)
  tarpSsoSecret: process.env.TARP_SSO_SECRET || '',

  // Auth
  allowedDomains: (process.env.ALLOWED_DOMAINS || '').split(',').filter(Boolean),

  // Browser (for Studio scraper)
  browserDataDir: process.env.BROWSER_DATA_DIR || '',

  // Paths
  dataDir: resolve(root, 'data'),
  uploadsDir: resolve(root, 'uploads'),
  logsDir: resolve(root, 'logs'),
};
