import { FastifyInstance } from 'fastify';
import { google } from 'googleapis';
import { nanoid } from 'nanoid';
import { config } from '../config.js';
import { getDb } from '../db/client.js';
import { authMiddleware } from '../middleware/auth.js';

function getOAuthClient() {
  return new google.auth.OAuth2(
    config.google.clientId,
    config.google.clientSecret,
    config.google.redirectUri
  );
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // GET /auth/login -- redirect to Google OAuth
  app.get('/auth/login', async (_request, reply) => {
    const oauth2Client = getOAuthClient();
    const url = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: [
        'openid',
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/userinfo.profile',
      ],
    });
    reply.redirect(url);
  });

  // GET /auth/callback -- handle Google OAuth callback
  app.get('/auth/callback', async (request, reply) => {
    const { code } = request.query as { code?: string };
    if (!code) {
      reply.code(400).send({ detail: 'Missing authorization code' });
      return;
    }

    const oauth2Client = getOAuthClient();
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const { data: profile } = await oauth2.userinfo.get();

    if (!profile.id || !profile.email) {
      reply.code(400).send({ detail: 'Could not retrieve user info' });
      return;
    }

    const db = getDb();

    // Check if user exists
    const existing = db.prepare('SELECT * FROM users WHERE google_id = ?').get(profile.id) as any;

    if (!existing) {
      // New user — check if they have an invite or are in allowed domain
      const invite = db.prepare("SELECT * FROM invites WHERE email = ? AND used_at IS NULL").get(profile.email) as any;
      const userCount = (db.prepare('SELECT COUNT(*) as count FROM users').get() as any).count;
      const isFirstUser = userCount === 0;

      if (!isFirstUser && !invite) {
        // Check domain allowlist
        if (config.allowedDomains.length > 0) {
          const domain = profile.email!.split('@')[1];
          if (!config.allowedDomains.includes(domain)) {
            reply.type('text/html').send(`
              <html><body style="font-family:Helvetica Neue,sans-serif;text-align:center;padding:60px;background:#1a1612;color:#ebe6e0">
              <h2>Access Denied</h2>
              <p>You need an invite to access YT Testing.</p>
              <p style="color:#888;font-size:13px">Contact the admin to request access.</p>
              </body></html>
            `);
            return;
          }
        }
      }
    }

    let userId: number;

    if (existing) {
      db.prepare(`
        UPDATE users SET email = ?, name = ?, avatar = ?, updated_at = datetime('now')
        WHERE google_id = ?
      `).run(profile.email, profile.name || profile.email, profile.picture || null, profile.id);
      userId = existing.id;
    } else {
      const userCount = (db.prepare('SELECT COUNT(*) as count FROM users').get() as any).count;
      const invite = db.prepare("SELECT * FROM invites WHERE email = ? AND used_at IS NULL").get(profile.email) as any;
      const role = userCount === 0 ? 'admin' : (invite?.role || 'viewer');
      const status = 'active';

      const result = db.prepare(`
        INSERT INTO users (google_id, email, name, avatar, role, status)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(profile.id, profile.email, profile.name || profile.email, profile.picture || null, role, status);
      userId = Number(result.lastInsertRowid);

      // Mark invite as used
      if (invite) {
        db.prepare("UPDATE invites SET used_at = datetime('now') WHERE id = ?").run(invite.id);
      }
    }

    // Create session
    const sessionToken = nanoid(48);
    const expiresAt = new Date(Date.now() + config.sessionMaxAge).toISOString();
    db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(
      sessionToken, userId, expiresAt
    );
    try { (await import('../services/activity.js')).logActivity(userId, 'login'); } catch {}

    reply.setCookie('session', sessionToken, {
      httpOnly: true,
      secure: !config.isDev,
      sameSite: 'lax',
      path: '/',
      maxAge: config.sessionMaxAge / 1000,
    });

    reply.redirect('/dashboard');
  });

  // GET /auth/me -- current user
  app.get('/auth/me', { preHandler: [authMiddleware] }, async (request) => {
    return request.user;
  });

  // POST /auth/logout
  app.post('/auth/logout', async (request, reply) => {
    const token = request.cookies?.session;
    if (token) {
      const db = getDb();
      db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    }
    reply.clearCookie('session', { path: '/' });
    // Also clear the parent-domain SSO cookie so logout sticks instead of being
    // silently re-bootstrapped on the next request. Detect domain from host.
    const host = request.headers?.host || '';
    if (!host.includes('localhost') && !host.includes('127.0.0.1')) {
      reply.clearCookie('tarp_sso', { path: '/', domain: '.tarpgpt.com' });
    } else {
      reply.clearCookie('tarp_sso', { path: '/' });
    }
    return { ok: true };
  });

  // Cleanup expired sessions hourly. datetime() wrapping so ISO timestamps
  // compare correctly against datetime('now').
  const db = getDb();
  setInterval(() => {
    db.prepare("DELETE FROM sessions WHERE datetime(expires_at) < datetime('now')").run();
  }, 60 * 60 * 1000);
}
