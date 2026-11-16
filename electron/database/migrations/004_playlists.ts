import type { Migration } from './types'

/** Columns for playlist analysis and for linking download jobs to playlist entries. */
export const playlists: Migration = {
  version: 4,
  name: 'playlists',
  up(db) {
    db.exec(`
      -- "<extractor>:<playlist id>": analysing the same playlist again refreshes it instead of duplicating it.
      ALTER TABLE playlists ADD COLUMN source_id TEXT;
      -- 1 when the playlist has more entries than MediaFlow lists.
      ALTER TABLE playlists ADD COLUMN truncated INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0, 1));
      ALTER TABLE playlists ADD COLUMN updated_at TEXT;
      CREATE UNIQUE INDEX idx_playlists_source ON playlists (source_id) WHERE source_id IS NOT NULL;

      ALTER TABLE playlist_items ADD COLUMN video_id TEXT;
      ALTER TABLE playlist_items ADD COLUMN duration_seconds INTEGER;
      ALTER TABLE playlist_items ADD COLUMN uploader TEXT;
      -- Remote thumbnail URL; fetched on demand by the main process, never by the renderer.
      ALTER TABLE playlist_items ADD COLUMN thumbnail_url TEXT;
      ALTER TABLE playlist_items ADD COLUMN unavailable_reason TEXT;
      CREATE INDEX idx_playlist_items_playlist ON playlist_items (playlist_id, position);

      ALTER TABLE downloads ADD COLUMN playlist_id TEXT REFERENCES playlists (id) ON DELETE SET NULL;
      ALTER TABLE downloads ADD COLUMN playlist_position INTEGER;
      ALTER TABLE downloads ADD COLUMN playlist_title TEXT;
      CREATE INDEX idx_downloads_playlist ON downloads (playlist_id);
    `)
  }
}
