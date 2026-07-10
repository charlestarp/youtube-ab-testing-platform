import { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { getDb } from '../db/client.js';
import { authMiddleware } from '../middleware/auth.js';
import { getTodayUsage, getQuotaHistory } from '../services/quota-tracker.js';
import { recentActivity, onlineUsers } from '../services/activity.js';

function requireAdmin(request: any, reply: any) {
  if (!request.user || request.user.role !== 'admin') {
    reply.code(403).send({ detail: 'Admin access required' });
    return false;
  }
  return true;
}

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware);

  // GET /admin/users — list all users
  app.get('/admin/users', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const db = getDb();
    return db.prepare('SELECT id, google_id, email, name, avatar, role, status, created_at, updated_at FROM users ORDER BY created_at').all();
  });

  // GET /admin/activity — recent activity feed + who is online now
  app.get('/admin/activity', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    return { activity: recentActivity(150), online: onlineUsers(5) };
  });

  // PATCH /admin/users/:id — update user role/status
  app.patch('/admin/users/:id', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const { id } = request.params as { id: string };
    const { role, status } = request.body as { role?: string; status?: string };
    const db = getDb();

    const fields: string[] = [];
    const params: any[] = [];
    if (role) { fields.push('role = ?'); params.push(role); }
    if (status) { fields.push('status = ?'); params.push(status); }
    if (fields.length === 0) return { detail: 'No fields to update' };

    params.push(parseInt(id));
    db.prepare(`UPDATE users SET ${fields.join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...params);
    return { ok: true };
  });

  // DELETE /admin/users/:id — delete user
  app.delete('/admin/users/:id', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const { id } = request.params as { id: string };
    const db = getDb();
    db.prepare('DELETE FROM users WHERE id = ?').run(parseInt(id));
    return { ok: true };
  });

  // POST /admin/invite — create invite and send email
  app.post('/admin/invite', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const { email, role } = request.body as { email: string; role?: string };
    if (!email) return { detail: 'email required' };

    const db = getDb();
    const token = nanoid(32);

    db.prepare('INSERT INTO invites (token, email, invited_by, role) VALUES (?, ?, ?, ?)').run(
      token, email, request.user!.id, role || 'viewer'
    );

    const inviteUrl = `https://app.example.com/invite/${token}`;

    // Send invite email via Resend API (if configured) or log it
    const resendKey = process.env.RESEND_API_KEY;
    if (resendKey) {
      try {
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: 'YT Testing <noreply@tarpgpt.com>',
            to: [email],
            subject: `You've been invited to YT Testing`,
            html: `
              <div style="font-family:Helvetica Neue,sans-serif;max-width:500px;margin:0 auto;padding:40px 20px">
                <h2 style="color:#7c63ff">You've been invited to YT Testing</h2>
                <p>${request.user!.name} has invited you to join the YouTube A/B testing platform.</p>
                <p style="margin:24px 0">
                  <a href="${inviteUrl}" style="background:#7c63ff;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:500">
                    Accept Invite
                  </a>
                </p>
                <p style="color:#888;font-size:13px">Or copy this link: ${inviteUrl}</p>
              </div>
            `,
          }),
        });
        if (!res.ok) {
          const err = await res.json();
          console.error(`[invite] Resend error:`, err);
        }
      } catch (err: any) {
        console.error(`[invite] Email send failed: ${err.message}`);
      }
    } else {
      console.log(`[invite] No RESEND_API_KEY set. Invite link: ${inviteUrl}`);
    }

    return { ok: true, token, invite_url: inviteUrl };
  });

  // GET /admin/invites — list all invites
  app.get('/admin/invites', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const db = getDb();
    return db.prepare(`
      SELECT i.*, u.name as invited_by_name
      FROM invites i LEFT JOIN users u ON i.invited_by = u.id
      ORDER BY i.created_at DESC
    `).all();
  });

  // DELETE /admin/invites/:id — revoke invite
  app.delete('/admin/invites/:id', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const { id } = request.params as { id: string };
    const db = getDb();
    db.prepare('DELETE FROM invites WHERE id = ? AND used_at IS NULL').run(parseInt(id));
    return { ok: true };
  });

  // POST /admin/impersonate/:id — start impersonating a user
  app.post('/admin/impersonate/:id', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const { id } = request.params as { id: string };
    reply.setCookie('impersonate', id, { path: '/', httpOnly: false, secure: false, sameSite: 'lax' });
    return { ok: true };
  });

  // POST /admin/stop-impersonation — stop impersonating
  app.post('/admin/stop-impersonation', async (_request, reply) => {
    reply.clearCookie('impersonate', { path: '/' });
    return { ok: true };
  });

  // GET /admin/quota — API quota usage
  app.get('/admin/quota', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const today = getTodayUsage();
    const history = getQuotaHistory(14);
    return { today, history };
  });
}
