import Database from 'better-sqlite3'
import { MIGRATIONS, type Migration } from '../../database/migrations'
import type { Logger } from '../../utils/logger'

export type SqliteDatabase = Database.Database

/**
 * Opens (or creates) the application database and brings its schema up to date.
 * Pass ':memory:' for tests.
 */
export function openDatabase(
  filename: string,
  logger: Logger,
  migrations: readonly Migration[] = MIGRATIONS
): SqliteDatabase {
  const db = new Database(filename)
  try {
    db.pragma('journal_mode = WAL')
    db.pragma('synchronous = NORMAL')
    db.pragma('foreign_keys = ON')
    db.pragma('busy_timeout = 5000')
    runMigrations(db, migrations, logger)
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

/** Applies pending migrations in order, each in its own transaction. Returns the versions applied. */
export function runMigrations(db: SqliteDatabase, migrations: readonly Migration[], logger: Logger): number[] {
  assertOrdered(migrations)

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `)

  const row = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as {
    version: number | null
  }
  const current = row.version ?? 0
  const latestKnown = migrations.at(-1)?.version ?? 0
  if (current > latestKnown) {
    throw new Error(
      `Database schema version ${current} is newer than this application supports (${latestKnown}).`
    )
  }

  const record = db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)')
  const applied: number[] = []
  for (const migration of migrations) {
    if (migration.version <= current) continue
    db.transaction(() => {
      migration.up(db)
      record.run(migration.version, migration.name)
    })()
    applied.push(migration.version)
    logger.info(`Applied database migration ${migration.version} (${migration.name})`)
  }
  return applied
}

function assertOrdered(migrations: readonly Migration[]): void {
  migrations.forEach((migration, index) => {
    const previous = migrations[index - 1]
    if (migration.version <= 0 || (previous && migration.version <= previous.version)) {
      throw new Error(`Migration versions must be positive and strictly increasing (at "${migration.name}")`)
    }
  })
}
