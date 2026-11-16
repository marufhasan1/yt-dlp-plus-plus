import type { Migration } from './types'

/** Results of update checks, and small internal values such as when everything was last checked. */
export const updateChecks: Migration = {
  version: 6,
  name: 'update_checks',
  up(db) {
    db.exec(`
      CREATE TABLE update_checks (
        component      TEXT PRIMARY KEY CHECK (component IN ('app', 'yt-dlp', 'ffmpeg', 'deno')),
        latest_version TEXT,
        -- Provider build identifier (e.g. BtbN "n9.0.2-48-gd4070a14ce"), when it differs from the version.
        latest_build   TEXT,
        channel        TEXT CHECK (channel IS NULL OR channel IN ('stable', 'nightly')),
        released_at    TEXT,
        notes_url      TEXT,
        checked_at     TEXT NOT NULL,
        -- Set when the last check failed; the previous result columns are kept.
        error_message  TEXT
      );

      CREATE TABLE app_state (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `)
  }
}
