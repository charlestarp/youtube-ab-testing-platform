/**
 * Lightweight activity log + presence. Records who did what and when (logins,
 * test creation, test start/complete) and tracks who is currently online via a
 * per-session last_seen stamp updated on every authenticated request.
 */
import { getDb } from '../db/client.js';

let ensured = false;
export function ensureActivitySchema(): void {
  if (ensured) return;
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER, action TEXT NOT NULL, detail TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_log(created_at);
  `);
  try { db.prepare(`SELECT last_seen FROM sessions LIMIT 1`).get(); } catch { db.exec(`ALTER TABLE sessions ADD COLUMN last_seen TEXT`); }
  ensured = true;
}

/** Record an event. Fire-and-forget; never throws. */
export function logActivity(userId: number | null | undefined, action: string, detail?: string): void {
  try {
    ensureActivitySchema();
    getDb().prepare(`INSERT INTO activity_log (user_id, action, detail) VALUES (?, ?, ?)`).run(userId ?? null, action, detail ?? null);
  } catch { /* logging must never break the app */ }
}

// Map a mutating request to a human-readable action. Returns null to skip.
export function describeAction(method: string, url: string): { action: string; detail: string } | null {
  const path = url.split('?')[0].replace(/^\/api/, '');
  // These are already logged with richer detail by their route handlers.
  const speciallyLogged = [/^\/tests$/, /^\/tests\/\d+\/start$/, /^\/tests\/\d+\/set-winner$/, /^\/producer\/conversations\/\d+\/create-test$/];
  if (method === 'POST' && speciallyLogged.some(re => re.test(path))) return null;
  const rules: [RegExp, string, string][] = [
    [/^\/tests\/\d+\/variants/, 'test_variant_added', 'added a variant to a test'],
    [/^\/tests\/\d+\/(complete|pause|start-now)/, 'test_updated', 'updated a test'],
    [/^\/tests\/\d+$/, method === 'DELETE' ? 'test_deleted' : 'test_edited', method === 'DELETE' ? 'deleted a test' : 'edited a test'],
    [/^\/tags\/auto-tag/, 'tags_autotag', 'ran auto-tagging'],
    [/^\/tags\/.*\/retag|^\/title-insights\/retag/, 'tags_retag', 're-tagged'],
    [/^\/tags/, 'tags_updated', 'updated tags'],
    [/^\/producer\/conversations\/\d+\/stream/, 'chat_message', 'sent an Ask AI message'],
    [/^\/producer\/conversations\/\d+\/attach-episode/, 'chat_episode', 'loaded an episode into the chat'],
    [/^\/producer\/conversations\/\d+$/, method === 'DELETE' ? 'chat_deleted' : 'chat_renamed', method === 'DELETE' ? 'deleted a chat' : 'renamed a chat'],
    [/^\/producer\/conversations/, 'chat_new', 'started a new chat'],
    [/^\/producer\/process-doc/, 'process_doc', 'edited the Process doc'],
    [/^\/schedules/, 'schedule_changed', 'changed a schedule'],
    [/^\/competitors/, 'competitors_updated', 'updated competitors'],
    [/^\/sync/, 'sync', 'ran a sync'],
    [/^\/admin\/users/, 'admin_user', 'changed a user'],
    [/^\/admin\/invite/, 'admin_invite', 'sent an invite'],
    [/^\/auth\/logout/, 'logout', 'logged out'],
  ];
  for (const [re, action, detail] of rules) if (re.test(path)) return { action, detail };
  return { action: 'action', detail: `${method} ${path}` };
}

/** Update a session's last_seen (called from auth middleware, throttled). */
export function touchSession(token: string): void {
  try {
    ensureActivitySchema();
    getDb().prepare(`UPDATE sessions SET last_seen = datetime('now') WHERE token = ?`).run(token);
  } catch { /* ignore */ }
}

export function recentActivity(limit = 100): any[] {
  ensureActivitySchema();
  return getDb().prepare(`
    SELECT a.id, a.action, a.detail, a.created_at, u.name AS user_name, u.avatar, u.email
    FROM activity_log a LEFT JOIN users u ON u.id = a.user_id
    ORDER BY a.id DESC LIMIT ?
  `).all(limit);
}

/** Users seen within the last `minutes` minutes. */
export function onlineUsers(minutes = 5): any[] {
  ensureActivitySchema();
  return getDb().prepare(`
    SELECT u.id, u.name, u.avatar, u.email, MAX(s.last_seen) AS last_seen
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.last_seen > datetime('now', '-' || ? || ' minutes')
    GROUP BY u.id ORDER BY last_seen DESC
  `).all(minutes);
}
