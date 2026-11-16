import type { Database } from 'better-sqlite3'

export interface Migration {
  /** Strictly increasing, never reused. */
  version: number
  name: string
  /** Runs inside a transaction together with the bookkeeping insert. */
  up(db: Database): void
}
