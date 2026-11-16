import type { Statement } from 'better-sqlite3'
import type { SqliteDatabase } from './database'

/** Raw key/value access to the `settings` table. Values are stored as JSON text. */
export class SettingsRepository {
  private readonly selectAll: Statement<[], { key: string; value: string }>
  private readonly upsert: Statement<[string, string]>

  constructor(private readonly db: SqliteDatabase) {
    this.selectAll = db.prepare('SELECT key, value FROM settings')
    this.upsert = db.prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT (key) DO UPDATE
        SET value = excluded.value,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    `)
  }

  /** Returns the stored JSON text for every key. */
  getAllRaw(): Map<string, string> {
    return new Map(this.selectAll.all().map((row) => [row.key, row.value]))
  }

  /** Writes all entries atomically. */
  setMany(entries: Record<string, unknown>): void {
    this.db.transaction(() => {
      for (const [key, value] of Object.entries(entries)) {
        this.upsert.run(key, JSON.stringify(value))
      }
    })()
  }
}
