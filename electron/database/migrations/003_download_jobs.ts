import type { Migration } from './types'

/** Columns the download manager needs beyond the initial schema. */
export const downloadJobs: Migration = {
  version: 3,
  name: 'download_jobs',
  up(db) {
    db.exec(`
      -- The resolved, validated download plan (format selector and options), so a job can be retried.
      ALTER TABLE downloads ADD COLUMN plan_json TEXT;
      -- Machine-readable failure reason; error_message holds the user-facing text.
      ALTER TABLE downloads ADD COLUMN error_code TEXT;
      -- Set when the user removes a job from the Downloads list. The row stays for history.
      ALTER TABLE downloads ADD COLUMN dismissed_at TEXT;
      -- "<extractor>:<id>" of the media, for duplicate detection.
      ALTER TABLE downloads ADD COLUMN source_id TEXT;
      ALTER TABLE downloads ADD COLUMN updated_at TEXT;
      CREATE INDEX idx_downloads_dismissed ON downloads (dismissed_at, created_at);
      CREATE INDEX idx_downloads_source ON downloads (source_id);
    `)
  }
}
