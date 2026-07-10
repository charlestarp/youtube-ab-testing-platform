import { FastifyInstance } from 'fastify';
import { getDb } from '../db/client.js';
import { authMiddleware } from '../middleware/auth.js';

export async function scheduleRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware);

  // GET /schedules
  app.get('/schedules', async () => {
    const db = getDb();
    const schedules = db.prepare('SELECT * FROM test_schedules ORDER BY created_at DESC').all();
    return schedules;
  });

  // POST /schedules
  app.post('/schedules', async (request) => {
    const { name, video_ids, variant_configs, cron, duration_hours, min_impressions } = request.body as any;

    if (!name || !video_ids?.length) return { detail: 'name and video_ids required' };

    const db = getDb();
    const result = db.prepare(`
      INSERT INTO test_schedules (name, video_ids_json, variant_configs_json, cron, duration_hours, min_impressions)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      name,
      JSON.stringify(video_ids),
      JSON.stringify(variant_configs || []),
      cron || '0 * * * *',
      duration_hours || 4,
      min_impressions || 500
    );

    return { id: Number(result.lastInsertRowid) };
  });

  // PUT /schedules/:id
  app.put('/schedules/:id', async (request) => {
    const { id } = request.params as { id: string };
    const { name, video_ids, variant_configs, cron, duration_hours, min_impressions, is_active } = request.body as any;
    const db = getDb();

    const fields: string[] = [];
    const params: any[] = [];

    if (name !== undefined) { fields.push('name = ?'); params.push(name); }
    if (video_ids !== undefined) { fields.push('video_ids_json = ?'); params.push(JSON.stringify(video_ids)); }
    if (variant_configs !== undefined) { fields.push('variant_configs_json = ?'); params.push(JSON.stringify(variant_configs)); }
    if (cron !== undefined) { fields.push('cron = ?'); params.push(cron); }
    if (duration_hours !== undefined) { fields.push('duration_hours = ?'); params.push(duration_hours); }
    if (min_impressions !== undefined) { fields.push('min_impressions = ?'); params.push(min_impressions); }
    if (is_active !== undefined) { fields.push('is_active = ?'); params.push(is_active ? 1 : 0); }

    if (fields.length === 0) return { detail: 'No fields to update' };

    params.push(parseInt(id));
    db.prepare(`UPDATE test_schedules SET ${fields.join(', ')} WHERE id = ?`).run(...params);
    return { ok: true };
  });

  // DELETE /schedules/:id
  app.delete('/schedules/:id', async (request) => {
    const { id } = request.params as { id: string };
    const db = getDb();
    db.prepare('DELETE FROM test_schedules WHERE id = ?').run(parseInt(id));
    return { ok: true };
  });

  // POST /schedules/:id/run -- trigger immediate run
  app.post('/schedules/:id/run', async (request) => {
    const { id } = request.params as { id: string };
    const db = getDb();

    const schedule = db.prepare('SELECT * FROM test_schedules WHERE id = ?').get(parseInt(id)) as any;
    if (!schedule) return { detail: 'Schedule not found' };

    const videoIds = JSON.parse(schedule.video_ids_json) as string[];
    const created: number[] = [];

    for (const videoId of videoIds) {
      // Check no running test for this video
      const existing = db.prepare('SELECT id FROM tests WHERE video_id = ? AND status IN ("pending", "running")').get(videoId);
      if (existing) continue;

      const result = db.prepare(`
        INSERT INTO tests (video_id, test_type, schedule_id, duration_hours_per_variant, min_impressions)
        VALUES (?, 'thumbnail', ?, ?, ?)
      `).run(videoId, schedule.id, schedule.duration_hours, schedule.min_impressions);
      created.push(Number(result.lastInsertRowid));
    }

    db.prepare("UPDATE test_schedules SET last_run_at = datetime('now') WHERE id = ?").run(parseInt(id));

    return { ok: true, tests_created: created.length, test_ids: created };
  });
}
