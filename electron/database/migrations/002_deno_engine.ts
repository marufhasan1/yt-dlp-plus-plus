import type { Migration } from './types'

const NOW = "(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))"

/**
 * Allows 'deno' (yt-dlp's JavaScript runtime) in the engine tables. SQLite
 * cannot alter a CHECK constraint, so both tables are rebuilt and their rows copied.
 */
export const denoEngine: Migration = {
  version: 2,
  name: 'deno_engine',
  up(db) {
    db.exec(`
      CREATE TABLE engine_versions_next (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        engine_name       TEXT NOT NULL UNIQUE CHECK (engine_name IN ('yt-dlp', 'ffmpeg', 'ffprobe', 'deno')),
        installed_version TEXT,
        latest_version    TEXT,
        checked_at        TEXT,
        updated_at        TEXT
      );
      INSERT INTO engine_versions_next (id, engine_name, installed_version, latest_version, checked_at, updated_at)
        SELECT id, engine_name, installed_version, latest_version, checked_at, updated_at FROM engine_versions;
      DROP TABLE engine_versions;
      ALTER TABLE engine_versions_next RENAME TO engine_versions;

      CREATE TABLE update_history_next (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        component        TEXT NOT NULL CHECK (component IN ('app', 'yt-dlp', 'ffmpeg', 'ffprobe', 'deno')),
        previous_version TEXT,
        new_version      TEXT,
        status           TEXT NOT NULL CHECK (status IN ('success', 'failed', 'rolled_back')),
        created_at       TEXT NOT NULL DEFAULT ${NOW},
        error_message    TEXT
      );
      INSERT INTO update_history_next (id, component, previous_version, new_version, status, created_at, error_message)
        SELECT id, component, previous_version, new_version, status, created_at, error_message FROM update_history;
      DROP TABLE update_history;
      ALTER TABLE update_history_next RENAME TO update_history;
      CREATE INDEX idx_update_history_component ON update_history (component, created_at);
    `)
  }
}
