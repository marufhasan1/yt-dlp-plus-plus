import type { Statement } from 'better-sqlite3'
import type { UpdateComponentId, YtDlpChannel } from '@shared/types/updates'
import type { SqliteDatabase } from './database'

export interface StoredCheck {
  component: UpdateComponentId
  latestVersion: string | null
  latestBuild: string | null
  channel: YtDlpChannel | null
  releasedAt: string | null
  notesUrl: string | null
  checkedAt: string
  errorMessage: string | null
}

type Row = {
  component: UpdateComponentId
  latest_version: string | null
  latest_build: string | null
  channel: YtDlpChannel | null
  released_at: string | null
  notes_url: string | null
  checked_at: string
  error_message: string | null
}

const LAST_CHECKED_ALL = 'updates.lastCheckedAll'

export class UpdateChecksRepository {
  private readonly upsertStmt: Statement
  private readonly failStmt: Statement
  private readonly allStmt: Statement<[], Row>
  private readonly getStateStmt: Statement<[string], { value: string }>
  private readonly setStateStmt: Statement<[string, string]>
  private readonly deleteStateStmt: Statement<[string]>

  constructor(db: SqliteDatabase) {
    this.upsertStmt = db.prepare(`
      INSERT INTO update_checks (component, latest_version, latest_build, channel, released_at, notes_url, checked_at, error_message)
      VALUES (@component, @latestVersion, @latestBuild, @channel, @releasedAt, @notesUrl, @checkedAt, NULL)
      ON CONFLICT (component) DO UPDATE SET
        latest_version = excluded.latest_version, latest_build = excluded.latest_build, channel = excluded.channel,
        released_at = excluded.released_at, notes_url = excluded.notes_url, checked_at = excluded.checked_at, error_message = NULL
    `)
    // A failed check keeps the last known result and records why it failed.
    this.failStmt = db.prepare(`
      INSERT INTO update_checks (component, checked_at, error_message) VALUES (@component, @checkedAt, @errorMessage)
      ON CONFLICT (component) DO UPDATE SET checked_at = excluded.checked_at, error_message = excluded.error_message
    `)
    this.allStmt = db.prepare('SELECT * FROM update_checks')
    this.getStateStmt = db.prepare('SELECT value FROM app_state WHERE key = ?')
    this.setStateStmt = db.prepare('INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
    this.deleteStateStmt = db.prepare('DELETE FROM app_state WHERE key = ?')
  }

  all(): StoredCheck[] {
    return this.allStmt.all().map((row) => ({
      component: row.component,
      latestVersion: row.latest_version,
      latestBuild: row.latest_build,
      channel: row.channel,
      releasedAt: row.released_at,
      notesUrl: row.notes_url,
      checkedAt: row.checked_at,
      errorMessage: row.error_message
    }))
  }

  saveResult(check: Omit<StoredCheck, 'errorMessage'>): void {
    const { component, latestVersion, latestBuild, channel, releasedAt, notesUrl, checkedAt } = check
    this.upsertStmt.run({ component, latestVersion, latestBuild, channel, releasedAt, notesUrl, checkedAt })
  }

  saveFailure(component: UpdateComponentId, errorMessage: string, checkedAt: string): void {
    this.failStmt.run({ component, errorMessage, checkedAt })
  }

  getState(key: string): string | null {
    return this.getStateStmt.get(key)?.value ?? null
  }

  setState(key: string, value: string): void {
    this.setStateStmt.run(key, value)
  }

  deleteState(key: string): void {
    this.deleteStateStmt.run(key)
  }

  lastCheckedAll(): string | null {
    return this.getStateStmt.get(LAST_CHECKED_ALL)?.value ?? null
  }

  setLastCheckedAll(at: string): void {
    this.setStateStmt.run(LAST_CHECKED_ALL, at)
  }
}
