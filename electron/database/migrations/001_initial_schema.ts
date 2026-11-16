import type { Migration } from './types'

const NOW = "(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))"

export const initialSchema: Migration = {
  version: 1,
  name: 'initial_schema',
  up(db) {
    db.exec(`
      CREATE TABLE downloads (
        id               TEXT PRIMARY KEY,
        url              TEXT NOT NULL,
        title            TEXT NOT NULL,
        thumbnail        TEXT,
        media_type       TEXT NOT NULL CHECK (media_type IN ('video', 'audio', 'playlist')),
        output_format    TEXT NOT NULL,
        quality          TEXT,
        output_path      TEXT NOT NULL,
        status           TEXT NOT NULL CHECK (status IN (
                           'queued', 'analyzing', 'downloading', 'processing',
                           'paused', 'completed', 'failed', 'cancelled')),
        progress         REAL NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
        downloaded_bytes INTEGER NOT NULL DEFAULT 0 CHECK (downloaded_bytes >= 0),
        total_bytes      INTEGER CHECK (total_bytes IS NULL OR total_bytes >= 0),
        created_at       TEXT NOT NULL DEFAULT ${NOW},
        completed_at     TEXT,
        error_message    TEXT
      );
      CREATE INDEX idx_downloads_status ON downloads (status);
      CREATE INDEX idx_downloads_created_at ON downloads (created_at);
      CREATE INDEX idx_downloads_url ON downloads (url);

      CREATE TABLE playlists (
        id           TEXT PRIMARY KEY,
        playlist_url TEXT NOT NULL,
        title        TEXT NOT NULL,
        thumbnail    TEXT,
        uploader     TEXT,
        total_items  INTEGER NOT NULL DEFAULT 0 CHECK (total_items >= 0),
        created_at   TEXT NOT NULL DEFAULT ${NOW}
      );
      CREATE INDEX idx_playlists_url ON playlists (playlist_url);

      CREATE TABLE playlist_items (
        id          TEXT PRIMARY KEY,
        playlist_id TEXT NOT NULL REFERENCES playlists (id) ON DELETE CASCADE,
        download_id TEXT REFERENCES downloads (id) ON DELETE SET NULL,
        video_url   TEXT NOT NULL,
        title       TEXT,
        position    INTEGER NOT NULL CHECK (position >= 0),
        status      TEXT NOT NULL DEFAULT 'pending',
        UNIQUE (playlist_id, position)
      );
      CREATE INDEX idx_playlist_items_download_id ON playlist_items (download_id);

      CREATE TABLE engine_versions (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        engine_name       TEXT NOT NULL UNIQUE CHECK (engine_name IN ('yt-dlp', 'ffmpeg', 'ffprobe')),
        installed_version TEXT,
        latest_version    TEXT,
        checked_at        TEXT,
        updated_at        TEXT
      );

      CREATE TABLE update_history (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        component        TEXT NOT NULL CHECK (component IN ('app', 'yt-dlp', 'ffmpeg', 'ffprobe')),
        previous_version TEXT,
        new_version      TEXT,
        status           TEXT NOT NULL CHECK (status IN ('success', 'failed', 'rolled_back')),
        created_at       TEXT NOT NULL DEFAULT ${NOW},
        error_message    TEXT
      );
      CREATE INDEX idx_update_history_component ON update_history (component, created_at);

      CREATE TABLE settings (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT ${NOW}
      );
    `)
  }
}
