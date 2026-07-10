import { FastifyRequest, FastifyReply } from 'fastify';
import { nanoid } from 'nanoid';
import { getDb } from '../db/client.js';
import { config } from '../config.js';
import { touchSession } from '../services/activity.js';
import { verifyTarpSso, expToISO } from '../lib/tarp-sso.js';
import type { User } from '../types/index.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: User;
  }
}

// Core team — auto-provisioned with admin access on first SSO arrival (a
// deliberate, owner-authorised exception to the existing-users-only rule).
const TEAM_AUTO_APPROVE = new Set([
  'team@example.com',
  'team@example.com',
  'team@example.com',
  'team@example.com',
  'team@example.com',
]);

const SSO_USER_SELECT = `SELECT id as uid, google_id, email, name, avatar, role, status,
       created_at as user_created_at, updated_at as user_updated_at
  FROM users WHERE lower(email) = ?`;

function buildUser(row: any): User {
  return {
    id: row.uid,
    google_id: row.google_id,
    email: row.email,
    name: row.name,
    avatar: row.avatar,
    role: row.role,
    status: row.status,
    created_at: row.user_created_at,
    updated_at: row.user_updated_at,
  };
}

function lookupSession(token: string): any {
  const db = getDb();
  // datetime() wrapping so ISO timestamps compare correctly against datetime('now').
  return db.prepare(`
    SELECT s.*, u.id as uid, u.google_id, u.email, u.name, u.avatar, u.role, u.status,
           u.created_at as user_created_at, u.updated_at as user_updated_at
    FROM sessions s
    JOIN users u ON s.user_id = u.id
    WHERE s.token = ? AND datetime(s.expires_at) > datetime('now')
  `).get(token) as any;
}

// Admin impersonation overlay. Applies to the REAL resolved user (cookie- or
// SSO-derived); SSO itself never asserts the impersonated identity.
function applyImpersonation(request: FastifyRequest, realRole: string, realName: string): void {
  const impersonateId = request.cookies?.impersonate || (request.query as any)?.impersonate;
  if (impersonateId && realRole === 'admin') {
    const db = getDb();
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(parseInt(impersonateId)) as any;
    if (target) {
      request.user = {
        id: target.id,
        google_id: target.google_id,
        email: target.email,
        name: target.name,
        avatar: target.avatar,
        role: target.role,
        status: target.status,
        created_at: target.created_at,
        updated_at: target.updated_at,
        impersonated_by: realName,
      } as any;
    }
  }
}

// Finalize a resolved session row: enforce active, mark presence, set user + impersonation.
// Returns 'ok' or 'inactive'.
function finish(request: FastifyRequest, session: any, token: string): 'ok' | 'inactive' {
  if (session.status !== 'active') return 'inactive';
  if (typeof token === 'string') touchSession(token);
  request.user = buildUser(session);
  applyImpersonation(request, session.role, session.name);
  return 'ok';
}

/**
 * Bootstrap a local session from a valid fleet SSO cookie. Only signs in an
 * existing, active user. Returns 'ok' | 'inactive' | 'none'. Never mutates users.
 */
function bootstrapFromSso(request: FastifyRequest, reply: FastifyReply): 'ok' | 'inactive' | 'none' {
  const claims = verifyTarpSso(request.cookies?.tarp_sso);
  if (!claims) return 'none';

  const db = getDb();
  const email = claims.email.toLowerCase();
  const isTeam = TEAM_AUTO_APPROVE.has(email);
  let rows = db.prepare(SSO_USER_SELECT).all(email) as any[];
  if (rows.length > 1) {
    console.error('[sso] ambiguous email match; refusing to bootstrap');
    return 'none';
  }

  if (rows.length === 0) {
    if (!isTeam) return 'none'; // never auto-create a non-team account
    db.prepare("INSERT INTO users (email, name, role, status) VALUES (?, ?, 'admin', 'active')")
      .run(email, email.split('@')[0]);
    rows = db.prepare(SSO_USER_SELECT).all(email) as any[];
  } else if (isTeam && rows[0].status !== 'active' && rows[0].status !== 'suspended') {
    // Activate a still-pending team member, but DO NOT touch their role — so any
    // manual per-app adjustment sticks across future logins. A deliberately
    // suspended account is left as-is (handled by the status check below).
    db.prepare("UPDATE users SET status = 'active', updated_at = datetime('now') WHERE id = ?")
      .run(rows[0].uid);
    rows = db.prepare(SSO_USER_SELECT).all(email) as any[];
  }

  const u = rows[0];
  if (u.status !== 'active') return 'inactive';

  const now = Math.floor(Date.now() / 1000);
  const remaining = claims.exp - now;
  if (remaining <= 0) return 'none';

  const token = nanoid(48);
  db.prepare(
    "INSERT INTO sessions (token, user_id, expires_at, auth_source) VALUES (?, ?, ?, 'tarp_sso')",
  ).run(token, u.uid, expToISO(claims.exp));

  reply.setCookie('session', token, {
    httpOnly: true,
    secure: !config.isDev,
    sameSite: 'lax',
    path: '/',
    maxAge: remaining,
  });

  if (typeof token === 'string') touchSession(token);
  request.user = buildUser(u);
  applyImpersonation(request, u.role, u.name);
  return 'ok';
}

export async function authMiddleware(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const authHeader = request.headers.authorization;
  const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  // Explicit, non-browser credentials (SSE query token / extension Bearer).
  const explicitToken = ((request.query as any)?.token as string | undefined) || bearerToken || null;
  const cookieToken = (request.cookies?.session as string | undefined) || null;
  const anyToken = cookieToken || explicitToken;

  // Internal token — watchdog/cron calls, no session needed. Stays first.
  if (anyToken && config.internalToken && anyToken === config.internalToken) {
    return;
  }

  // An explicitly-supplied query/Bearer credential must validate on its own and
  // never silently falls back to a browser SSO cookie.
  if (explicitToken) {
    const session = lookupSession(explicitToken);
    if (!session) {
      reply.code(401).send({ detail: 'Not authenticated' });
      return;
    }
    const r = finish(request, session, explicitToken);
    if (r === 'inactive') reply.code(403).send({ detail: 'Account not active' });
    return;
  }

  // Browser cookie session — a valid one wins.
  if (cookieToken) {
    const session = lookupSession(cookieToken);
    if (session) {
      const r = finish(request, session, cookieToken);
      if (r === 'inactive') reply.code(403).send({ detail: 'Account not active' });
      return;
    }
  }

  // Only a missing/expired browser session cookie may fall back to fleet SSO.
  const sso = bootstrapFromSso(request, reply);
  if (sso === 'ok') return;
  if (sso === 'inactive') {
    reply.code(403).send({ detail: 'Account not active' });
    return;
  }

  // Nothing valid. Clear a stale cookie only now (avoids ambiguous clear+set).
  if (cookieToken) reply.clearCookie('session');
  reply.code(401).send({ detail: cookieToken ? 'Session expired' : 'Not authenticated' });
}
