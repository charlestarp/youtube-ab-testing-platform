import { FastifyInstance } from 'fastify';
import { authMiddleware } from '../middleware/auth.js';
import { config } from '../config.js';

// Fleet feedback: the in-app widget POSTs here (same-origin, authenticated). We attach
// the verified user server-side (so it can't be spoofed) and forward to home's ingest.
export async function feedbackRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware);

  // bodyLimit raised: screenshot payloads can be ~8MB of base64 (global default is 1MB).
  app.post('/feedback', { bodyLimit: 12 * 1024 * 1024 }, async (request, reply) => {
    const b = (request.body || {}) as Record<string, unknown>;
    const kind = ['bug', 'idea', 'feature'].includes(b.kind as string) ? (b.kind as string) : 'idea';
    const text = String(b.text || '').trim().slice(0, 4000);
    if (!text) return reply.code(400).send({ error: 'empty' });
    const user = request.user;
    try {
      const r = await fetch(config.homeFeedbackUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: config.homeFeedbackToken,
          app: 'testing',
          kind,
          text,
          severity: String(b.severity || '').slice(0, 20),
          url: String(b.url || '').slice(0, 500),
          context: b.context || null,
          screenshot: typeof b.screenshot === 'string' ? b.screenshot : null,
          email: user?.email || '',
          name: user?.name || '',
        }),
      });
      // Never break the caller, but never lose a failure silently either.
      if (!r.ok) console.error(`[feedback] home ingest rejected: HTTP ${r.status}`);
    } catch (e) {
      console.error('[feedback] forward failed:', (e as Error)?.message || e);
    }
    return reply.code(204).send();
  });

  // Resolution notices: the widget asks "any notes from Charles for me?" on load,
  // and acks after showing them. Forwarded server-to-server with the verified user.
  const noticesUrl = config.homeFeedbackUrl.replace('/ingest', '/notices');
  app.post('/feedback/notices', async (request, reply) => {
    const user = request.user;
    try {
      const r = await fetch(noticesUrl, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: config.homeFeedbackToken, app: 'testing', email: user?.email || '' }),
      });
      return reply.send(r.ok ? await r.json() : { notices: [] });
    } catch { return reply.send({ notices: [] }); }
  });
  app.post('/feedback/notices/ack', async (request, reply) => {
    const user = request.user;
    const ids = Array.isArray((request.body as any)?.ids) ? (request.body as any).ids : [];
    try {
      await fetch(noticesUrl + '/ack', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: config.homeFeedbackToken, app: 'testing', email: user?.email || '', ids }),
      });
    } catch { /* best-effort */ }
    return reply.code(204).send();
  });
}
