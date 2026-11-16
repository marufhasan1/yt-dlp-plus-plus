import type { Migration } from './types'

/** Pause/resume, restart recovery and history queries. */
export const downloadRecovery: Migration = {
  version: 5,
  name: 'download_recovery',
  up(db) {
    db.exec(`
      -- 1 when a job was paused by the app closing (or crashing) rather than by the user.
      ALTER TABLE downloads ADD COLUMN interrupted INTEGER NOT NULL DEFAULT 0 CHECK (interrupted IN (0, 1));
      -- Before this version an interrupted job was marked failed and its partial files deleted;
      -- those rows stay failed (there is nothing to resume).
      CREATE INDEX idx_downloads_format ON downloads (output_format, created_at);
    `)
  }
}
