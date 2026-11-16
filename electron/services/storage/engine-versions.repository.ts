import type { Statement } from 'better-sqlite3'
import type { EngineId } from '@shared/types/engines'
import type { SqliteDatabase } from './database'

export interface EngineVersionRow {
  engineName: EngineId
  installedVersion: string | null
  latestVersion: string | null
  checkedAt: string | null
  updatedAt: string | null
}

type RawRow = {
  engine_name: EngineId
  installed_version: string | null
  latest_version: string | null
  checked_at: string | null
  updated_at: string | null
}

/** Tracks the version of each engine in use. `latest_version`/`checked_at` are filled by update checks (Phase 7). */
export class EngineVersionsRepository {
  private readonly selectOne: Statement<[EngineId], RawRow>
  private readonly upsertInstalled: Statement<[EngineId, string | null, string]>
  private readonly upsertLatest: Statement<[EngineId, string | null, string]>

  constructor(db: SqliteDatabase) {
    this.selectOne = db.prepare(
      'SELECT engine_name, installed_version, latest_version, checked_at, updated_at FROM engine_versions WHERE engine_name = ?'
    )
    // updated_at only moves when the installed version actually changes.
    this.upsertInstalled = db.prepare(`
      INSERT INTO engine_versions (engine_name, installed_version, updated_at) VALUES (?, ?, ?)
      ON CONFLICT (engine_name) DO UPDATE SET
        updated_at = CASE WHEN installed_version IS excluded.installed_version THEN updated_at ELSE excluded.updated_at END,
        installed_version = excluded.installed_version
    `)
    this.upsertLatest = db.prepare(`
      INSERT INTO engine_versions (engine_name, latest_version, checked_at) VALUES (?, ?, ?)
      ON CONFLICT (engine_name) DO UPDATE SET latest_version = excluded.latest_version, checked_at = excluded.checked_at
    `)
  }

  get(engine: EngineId): EngineVersionRow | null {
    const row = this.selectOne.get(engine)
    if (!row) return null
    return {
      engineName: row.engine_name,
      installedVersion: row.installed_version,
      latestVersion: row.latest_version,
      checkedAt: row.checked_at,
      updatedAt: row.updated_at
    }
  }

  setInstalledVersion(engine: EngineId, version: string | null, now: Date = new Date()): void {
    this.upsertInstalled.run(engine, version, now.toISOString())
  }

  /** Result of an update check: the newest version the provider offers. */
  setLatestVersion(engine: EngineId, version: string | null, checkedAt: string): void {
    this.upsertLatest.run(engine, version, checkedAt)
  }
}
