import type { Statement } from 'better-sqlite3'
import type { SqliteDatabase } from './database'

export type UpdateComponent = 'app' | 'yt-dlp' | 'ffmpeg' | 'ffprobe' | 'deno'
export type UpdateOutcome = 'success' | 'failed' | 'rolled_back'

export interface UpdateHistoryEntry {
  id: number
  component: UpdateComponent
  previousVersion: string | null
  newVersion: string | null
  status: UpdateOutcome
  createdAt: string
  errorMessage: string | null
}

type RawRow = {
  id: number
  component: UpdateComponent
  previous_version: string | null
  new_version: string | null
  status: UpdateOutcome
  created_at: string
  error_message: string | null
}

export class UpdateHistoryRepository {
  private readonly insert: Statement<[UpdateComponent, string | null, string | null, UpdateOutcome, string | null]>
  private readonly selectRecent: Statement<[number], RawRow>

  constructor(db: SqliteDatabase) {
    this.insert = db.prepare(
      'INSERT INTO update_history (component, previous_version, new_version, status, error_message) VALUES (?, ?, ?, ?, ?)'
    )
    this.selectRecent = db.prepare('SELECT * FROM update_history ORDER BY id DESC LIMIT ?')
  }

  record(entry: {
    component: UpdateComponent
    previousVersion: string | null
    newVersion: string | null
    status: UpdateOutcome
    errorMessage?: string | null
  }): void {
    this.insert.run(entry.component, entry.previousVersion, entry.newVersion, entry.status, entry.errorMessage ?? null)
  }

  recent(limit = 50): UpdateHistoryEntry[] {
    return this.selectRecent.all(limit).map((row) => ({
      id: row.id,
      component: row.component,
      previousVersion: row.previous_version,
      newVersion: row.new_version,
      status: row.status,
      createdAt: row.created_at,
      errorMessage: row.error_message
    }))
  }
}
