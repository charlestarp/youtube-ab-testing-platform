import Database from 'better-sqlite3';
import { readFileSync, mkdirSync, existsSync, copyFileSync, renameSync } from 'fs';
import { dirname, resolve } from 'path';
import { config } from '../config.js';

let _db: Database.Database | null = null;

function tryRestoreFromBackup(dbPath: string): boolean {
  const backupDir = resolve(dirname(dbPath), 'backups');
  const latestBackup = resolve(backupDir, 'testing_latest.db');
  if (!existsSync(latestBackup)) return false;
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    renameSync(dbPath, `${dbPath}.corrupt.${timestamp}`);
    copyFileSync(latestBackup, dbPath);
    console.error(`[db] Restored from ${latestBackup}`);
    return true;
  } catch (err: any) {
    console.error(`[db] Restore failed: ${err.message}`);
    return false;
  }
}

export function getDb(): Database.Database {
  if (_db) return _db;

  // Ensure data directory exists
  mkdirSync(dirname(config.dbPath), { recursive: true });

  _db = new Database(config.dbPath);

  // Integrity check before doing anything — catch corruption early
  try {
    const check = _db.pragma('quick_check', { simple: true }) as string;
    if (check !== 'ok') {
      console.error(`[db] CORRUPTION DETECTED: quick_check returned "${check}". Attempting restore...`);
      _db.close();
      _db = null;
      if (tryRestoreFromBackup(config.dbPath)) {
        _db = new Database(config.dbPath);
        console.error('[db] Restored from backup. Some recent data may be lost (up to 24h).');
      } else {
        throw new Error(`Database corrupted and no backup available. Manual recovery required.`);
      }
    }
  } catch (err: any) {
    if (err.message?.includes('Manual recovery')) throw err;
    // If quick_check itself throws, the DB is unreadable
    console.error(`[db] Cannot open database: ${err.message}. Attempting restore...`);
    _db?.close();
    _db = null;
    if (tryRestoreFromBackup(config.dbPath)) {
      _db = new Database(config.dbPath);
    } else {
      throw new Error(`Database unreadable and no backup available. Manual recovery required.`);
    }
  }

  // WAL mode for better concurrent access
  _db.pragma('journal_mode = WAL');
  _db.pragma('synchronous = NORMAL');
  _db.pragma('busy_timeout = 5000');
  _db.pragma('foreign_keys = ON');
  _db.pragma('wal_autocheckpoint = 1000');

  // Run migrations
  const schemaPath = resolve(import.meta.dirname, 'schema.sql');
  const schema = readFileSync(schemaPath, 'utf-8');
  _db.exec(schema);

  // Column migrations (safe to run repeatedly)
  for (const stmt of [
    "ALTER TABLE sessions ADD COLUMN auth_source TEXT NOT NULL DEFAULT 'native'",
    'ALTER TABLE comments ADD COLUMN author_channel_url TEXT',
    'ALTER TABLE comments ADD COLUMN author_profile_image TEXT',
    "ALTER TABLE tests ADD COLUMN test_format TEXT NOT NULL DEFAULT 'classic'",
    "ALTER TABLE tests ADD COLUMN test_speed TEXT NOT NULL DEFAULT 'daily'",
    "ALTER TABLE tests ADD COLUMN run_days TEXT NOT NULL DEFAULT 'mon,tue,wed,thu,fri,sat,sun'",
    'ALTER TABLE tests ADD COLUMN run_duration_days INTEGER NOT NULL DEFAULT 8',
    "ALTER TABLE tests ADD COLUMN auto_winner TEXT NOT NULL DEFAULT 'disabled'",
    "ALTER TABLE tests ADD COLUMN auto_placeholder TEXT NOT NULL DEFAULT 'disabled'",
    'ALTER TABLE tests ADD COLUMN include_original INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE tests ADD COLUMN delay_after_publish_days INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE tests ADD COLUMN scheduled_start TEXT',
    'ALTER TABLE tests ADD COLUMN video_thumbnail_url TEXT',
    "ALTER TABLE tests ADD COLUMN metric_target TEXT NOT NULL DEFAULT 'time'",
    'ALTER TABLE tests ADD COLUMN metric_target_value INTEGER NOT NULL DEFAULT 0',
    "ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'viewer'",
    "ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active'",
    "ALTER TABLE users ADD COLUMN invited_by INTEGER",
    "ALTER TABLE users ADD COLUMN invited_at TEXT",
    "ALTER TABLE competitors ADD COLUMN thumbnail TEXT",
    "ALTER TABLE tests ADD COLUMN channel TEXT NOT NULL DEFAULT 'main'",
    "ALTER TABLE tests ADD COLUMN category TEXT NOT NULL DEFAULT 'test'",
    // 0 = winner title/thumbnail not yet pushed live (e.g. YouTube API quota was exhausted at
    // completion); a retry pass re-applies it until it succeeds so the winner always goes live.
    'ALTER TABLE tests ADD COLUMN winner_applied INTEGER NOT NULL DEFAULT 1',
    "ALTER TABLE studio_snapshots ADD COLUMN comments INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE thumbnail_tags ADD COLUMN category TEXT NOT NULL DEFAULT 'other'",
    "ALTER TABLE episode_proposals ADD COLUMN video_id TEXT",
    "ALTER TABLE episode_proposals ADD COLUMN source TEXT NOT NULL DEFAULT 'transcript'",
    // Settled-results sweep: one-time final report after YouTube's 48h data settle,
    // plus a record of any winner flip the settled data caused (JSON {from,to,at}).
    'ALTER TABLE tests ADD COLUMN settled_report_sent INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE tests ADD COLUMN settled_flip TEXT',
    // 1 = a human chose this winner (set-winner route); the settled re-eval and
    // winner-verify sweeps must never override a manual decision.
    'ALTER TABLE tests ADD COLUMN winner_manual INTEGER NOT NULL DEFAULT 0',
  ]) {
    try { _db.exec(stmt); } catch {}
  }

  // Attach YouTube historical DB (read-only) if available
  if (config.youtubeDbPath && existsSync(config.youtubeDbPath)) {
    try {
      _db.exec(`ATTACH DATABASE '${config.youtubeDbPath}' AS yt`);
      console.log('Attached youtube.db as read-only');
    } catch (err: any) {
      console.warn(`Could not attach youtube.db: ${err.message}`);
    }
  }

  // Attach podcast transcript DB (read-only) if available
  if (config.podcastDbPath && existsSync(config.podcastDbPath)) {
    try {
      _db.exec(`ATTACH DATABASE '${config.podcastDbPath}' AS podcast`);
      console.log('Attached podcast.db as read-only');
    } catch (err: any) {
      console.warn(`Could not attach podcast.db: ${err.message}`);
    }
  }

  console.log('Database initialized');
  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
