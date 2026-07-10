/**
 * YouTube OAuth token management.
 * Reads the refresh token from TARPGPT's token file and exchanges for access tokens.
 */

import { google } from 'googleapis';
import { readFileSync } from 'fs';
import { config } from '../config.js';

let _cachedToken: { accessToken: string; expiresAt: number } | null = null;

// Per-token-file access-token cache for the write-quota rotation. Each project's
// token file carries its OWN client_id/client_secret (falling back to the main
// Google creds), so any project's OAuth can be refreshed independently.
const _writeTokCache: Record<string, { accessToken: string; expiresAt: number }> = {};
export async function getAccessTokenFrom(tokenPath: string): Promise<string> {
  const c = _writeTokCache[tokenPath];
  if (c && Date.now() < c.expiresAt - 300_000) return c.accessToken;
  const t = JSON.parse(readFileSync(tokenPath, 'utf-8'));
  if (!t.refresh_token) throw new Error(`No refresh_token in ${tokenPath}`);
  const oauth2 = new google.auth.OAuth2(t.client_id || config.google.clientId, t.client_secret || config.google.clientSecret);
  oauth2.setCredentials({ refresh_token: t.refresh_token });
  const { credentials } = await oauth2.refreshAccessToken();
  if (!credentials.access_token) throw new Error(`Failed to refresh token from ${tokenPath}`);
  _writeTokCache[tokenPath] = { accessToken: credentials.access_token, expiresAt: credentials.expiry_date || Date.now() + 3600_000 };
  return credentials.access_token;
}

export async function getAccessToken(): Promise<string> {
  // Return cached if still valid (with 5 min buffer)
  if (_cachedToken && Date.now() < _cachedToken.expiresAt - 300_000) {
    return _cachedToken.accessToken;
  }

  if (!config.ytAnalyticsTokenPath) {
    throw new Error('YT_ANALYTICS_TOKEN_PATH not configured');
  }

  const tokenData = JSON.parse(readFileSync(config.ytAnalyticsTokenPath, 'utf-8'));
  const refreshToken = tokenData.refresh_token;
  if (!refreshToken) throw new Error('No refresh_token in token file');

  const oauth2 = new google.auth.OAuth2(
    config.google.clientId,
    config.google.clientSecret,
  );
  oauth2.setCredentials({ refresh_token: refreshToken });

  const { credentials } = await oauth2.refreshAccessToken();
  if (!credentials.access_token) throw new Error('Failed to refresh access token');

  _cachedToken = {
    accessToken: credentials.access_token,
    expiresAt: credentials.expiry_date || Date.now() + 3600_000,
  };

  return _cachedToken.accessToken;
}

let _cachedClipsToken: { accessToken: string; expiresAt: number } | null = null;

export async function getClipsAccessToken(): Promise<string> {
  if (_cachedClipsToken && Date.now() < _cachedClipsToken.expiresAt - 300_000) {
    return _cachedClipsToken.accessToken;
  }

  const clipsTokenPath = config.ytAnalyticsTokenPath?.replace('.json', '_clips.json');
  if (!clipsTokenPath) throw new Error('Clips token path not configured');

  const { existsSync } = await import('fs');
  if (!existsSync(clipsTokenPath)) throw new Error('Clips channel not connected — go to /api/youtube-auth/connect-clips');

  const tokenData = JSON.parse(readFileSync(clipsTokenPath, 'utf-8'));
  if (!tokenData.refresh_token) throw new Error('No refresh_token in clips token file');

  const oauth2 = new google.auth.OAuth2(config.google.clientId, config.google.clientSecret);
  oauth2.setCredentials({ refresh_token: tokenData.refresh_token });

  const { credentials } = await oauth2.refreshAccessToken();
  if (!credentials.access_token) throw new Error('Failed to refresh clips access token');

  _cachedClipsToken = {
    accessToken: credentials.access_token,
    expiresAt: credentials.expiry_date || Date.now() + 3600_000,
  };

  return _cachedClipsToken.accessToken;
}
