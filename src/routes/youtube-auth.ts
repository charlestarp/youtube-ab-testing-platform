/**
 * YouTube Analytics OAuth flow.
 * Authorizes access to YouTube Analytics + Data API for the channel.
 * Saves refresh token to the shared TARPGPT token file so both apps benefit.
 */

import { FastifyInstance } from 'fastify';
import { writeFileSync, existsSync } from 'fs';
import { google } from 'googleapis';
import { config } from '../config.js';
import { authMiddleware } from '../middleware/auth.js';

const SCOPES = [
  'https://www.googleapis.com/auth/yt-analytics.readonly',
  'https://www.googleapis.com/auth/youtube.force-ssl',
  'https://www.googleapis.com/auth/youtube.readonly',
];

const REDIRECT_URI = 'https://app.example.com/api/youtube-auth/callback';

function getOAuthClient() {
  return new google.auth.OAuth2(
    config.google.clientId,
    config.google.clientSecret,
    REDIRECT_URI
  );
}

export async function youtubeAuthRoutes(app: FastifyInstance): Promise<void> {
  // GET /youtube-auth/connect — initiate OAuth
  app.get('/youtube-auth/connect', { preHandler: [authMiddleware] }, async (_request, reply) => {
    const oauth2Client = getOAuthClient();
    const url = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: SCOPES,
    });
    reply.redirect(url);
  });

  // GET /youtube-auth/callback — handle OAuth callback
  app.get('/youtube-auth/callback', async (request, reply) => {
    const { code, state } = request.query as { code?: string; state?: string };
    if (!code) {
      reply.code(400).send({ detail: 'Missing authorization code' });
      return;
    }

    const isClips = state === 'clips';
    const oauth2Client = getOAuthClient();

    try {
      const { tokens } = await oauth2Client.getToken(code);

      if (!tokens.refresh_token) {
        reply.type('text/html').send(`
          <html><body style="font-family:Helvetica Neue,sans-serif;text-align:center;padding:60px;background:#1a1612;color:#ebe6e0">
          <h2>No refresh token received</h2>
          <p>Try revoking access at <a href="https://myaccount.google.com/permissions" style="color:#7c63ff">myaccount.google.com/permissions</a> then try again.</p>
          <p><a href="/dashboard" style="color:#7c63ff">Back to Dashboard</a></p>
          </body></html>
        `);
        return;
      }

      if (isClips) {
        // Save clips token separately
        const clipsTokenPath = config.ytAnalyticsTokenPath?.replace('.json', '_clips.json') || 'data/yt_clips_token.json';
        writeFileSync(clipsTokenPath, JSON.stringify({
          refresh_token: tokens.refresh_token,
          channel_id: 'UC36A0yALoD0LeRr7NoCCZtg',
          saved_at: new Date().toISOString(),
        }));
        console.log('[youtube-auth] Clips channel token saved to', clipsTokenPath);

        reply.type('text/html').send(`
          <html><body style="font-family:Helvetica Neue,sans-serif;text-align:center;padding:60px;background:#1a1612;color:#ebe6e0">
          <h2 style="color:#7c63ff">Clips Channel Connected</h2>
          <p>You can now test thumbnails on the Toni and Ryan Clips channel.</p>
          <p style="margin-top:24px"><a href="/tests/new" style="color:#7c63ff;text-decoration:none;background:#7c63ff22;padding:8px 20px;border-radius:8px">Create a Test</a></p>
          </body></html>
        `);
        return;
      }

      // Save to the shared TARPGPT token file (main channel)
      const tokenData = JSON.stringify({
        refresh_token: tokens.refresh_token,
        saved_at: new Date().toISOString(),
      });

      if (config.ytAnalyticsTokenPath) {
        writeFileSync(config.ytAnalyticsTokenPath, tokenData);
        console.log('[youtube-auth] Refresh token saved to', config.ytAnalyticsTokenPath);
      }

      // Propagate to socials DB so podcast-analytics (and socials project) stay in sync
      try {
        const SOCIALS_DB_PATH = '/Users/charlespatterson/Projects/socials/data/socials.db';
        const Database = (await import('better-sqlite3')).default;
        const socialsDb = new Database(SOCIALS_DB_PATH);
        const updated = socialsDb.prepare(`
          UPDATE platform_accounts
          SET refresh_token = ?, updated_at = datetime('now')
          WHERE platform = 'youtube' AND account_name = 'Toni and Ryan'
        `).run(tokens.refresh_token);
        socialsDb.close();
        console.log('[youtube-auth] Propagated refresh token to socials DB (' + updated.changes + ' rows)');
      } catch (err: any) {
        console.error('[youtube-auth] Failed to propagate to socials DB:', err.message);
      }

      reply.type('text/html').send(`
        <html><body style="font-family:Helvetica Neue,sans-serif;text-align:center;padding:60px;background:#1a1612;color:#ebe6e0">
        <h2 style="color:#7c63ff">YouTube Connected</h2>
        <p>Analytics, scheduled videos, and thumbnail swapping are now available.</p>
        <p style="margin-top:24px"><a href="/dashboard" style="color:#7c63ff;text-decoration:none;background:#7c63ff22;padding:8px 20px;border-radius:8px">Back to Dashboard</a></p>
        </body></html>
      `);
    } catch (err: any) {
      reply.type('text/html').send(`
        <html><body style="font-family:Helvetica Neue,sans-serif;text-align:center;padding:60px;background:#1a1612;color:#ebe6e0">
        <h2>Connection Failed</h2>
        <p>${err.message}</p>
        <p><a href="/dashboard" style="color:#7c63ff">Back to Dashboard</a></p>
        </body></html>
      `);
    }
  });

  // GET /youtube-auth/status — check connection
  app.get('/youtube-auth/status', { preHandler: [authMiddleware] }, async () => {
    const connected = config.ytAnalyticsTokenPath ? existsSync(config.ytAnalyticsTokenPath) : false;

    let valid = false;
    let savedAt: string | null = null;
    let expiresAt: string | null = null;
    if (connected && config.ytAnalyticsTokenPath) {
      try {
        const { readFileSync } = await import('fs');
        const tokenData = JSON.parse(readFileSync(config.ytAnalyticsTokenPath, 'utf-8'));
        savedAt = tokenData.saved_at || null;
        if (savedAt) {
          // Dev mode tokens expire after 7 days
          expiresAt = new Date(new Date(savedAt).getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
        }
        const { getAccessToken } = await import('../services/youtube-auth.js');
        await getAccessToken();
        valid = true;
      } catch {
        valid = false;
      }
    }

    return { connected, valid, savedAt, expiresAt };
  });

  // GET /youtube-auth/connect-clips — OAuth for clips channel
  app.get('/youtube-auth/connect-clips', { preHandler: [authMiddleware] }, async (_request, reply) => {
    const oauth2Client = new google.auth.OAuth2(
      config.google.clientId,
      config.google.clientSecret,
      REDIRECT_URI
    );
    const url = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: [
        'https://www.googleapis.com/auth/youtube',
        'https://www.googleapis.com/auth/youtube.upload',
        'https://www.googleapis.com/auth/yt-analytics.readonly',
      ],
      state: 'clips',
    });
    reply.redirect(url);
  });
}
