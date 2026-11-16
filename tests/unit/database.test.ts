import { afterEach, describe, expect, it } from 'vitest'
import { MIGRATIONS, type Migration } from '../../electron/database/migrations'
import { openDatabase, runMigrations, type SqliteDatabase } from '../../electron/services/storage/database'
import { silentLogger } from '../../electron/utils/logger'

const opened: SqliteDatabase[] = []
function open(migrations?: readonly Migration[]): SqliteDatabase {
  const db = openDatabase(':memory:', silentLogger, migrations)
  opened.push(db)
  return db
}

afterEach(() => {
  for (const db of opened.splice(0)) db.close()
})

function tableNames(db: SqliteDatabase): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as {
      name: string
    }[]
  )
    .map((row) => row.name)
    .sort()
}

describe('database migrations', () => {
  it('creates the initial schema', () => {
    const db = open()
    expect(tableNames(db)).toEqual([
      'app_state',
      'downloads',
      'engine_versions',
      'playlist_items',
      'playlists',
      'schema_migrations',
      'settings',
      'update_checks',
      'update_history'
    ])
    const versions = db.prepare('SELECT version FROM schema_migrations').all()
    expect(versions).toEqual(MIGRATIONS.map((m) => ({ version: m.version })))
  })

  it('is idempotent when run again', () => {
    const db = open()
    expect(runMigrations(db, MIGRATIONS, silentLogger)).toEqual([])
  })

  it('enables foreign keys and cascades playlist item deletion', () => {
    const db = open()
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)

    db.prepare("INSERT INTO playlists (id, playlist_url, title) VALUES ('p1', 'https://example.com/list', 'List')").run()
    db.prepare(
      "INSERT INTO playlist_items (id, playlist_id, video_url, position) VALUES ('i1', 'p1', 'https://example.com/v', 0)"
    ).run()

    expect(() =>
      db
        .prepare(
          "INSERT INTO playlist_items (id, playlist_id, video_url, position) VALUES ('i2', 'missing', 'https://example.com/v', 1)"
        )
        .run()
    ).toThrow(/FOREIGN KEY/)

    db.prepare("DELETE FROM playlists WHERE id = 'p1'").run()
    expect(db.prepare('SELECT COUNT(*) AS n FROM playlist_items').get()).toEqual({ n: 0 })
  })

  it('enforces status and progress constraints on downloads', () => {
    const db = open()
    const insert = db.prepare(
      `INSERT INTO downloads (id, url, title, media_type, output_format, output_path, status, progress)
       VALUES (?, 'https://example.com', 'T', 'video', 'mp4', '/tmp/out.mp4', ?, ?)`
    )
    expect(() => insert.run('a', 'queued', 0)).not.toThrow()
    expect(() => insert.run('b', 'bogus', 0)).toThrow(/CHECK/)
    expect(() => insert.run('c', 'queued', 101)).toThrow(/CHECK/)
  })

  it('rolls back a failing migration completely', () => {
    const latest = MIGRATIONS.at(-1)!.version
    const broken: Migration = {
      version: latest + 1,
      name: 'broken',
      up(db) {
        db.exec('CREATE TABLE half_done (id INTEGER)')
        throw new Error('boom')
      }
    }
    const db = open()
    expect(() => runMigrations(db, [...MIGRATIONS, broken], silentLogger)).toThrow('boom')
    expect(tableNames(db)).not.toContain('half_done')
    expect(db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get()).toEqual({ v: latest })
  })

  it('upgrades a version-1 database without losing engine rows', () => {
    const db = open(MIGRATIONS.slice(0, 1))
    db.prepare("INSERT INTO engine_versions (engine_name, installed_version) VALUES ('yt-dlp', '2026.10.26')").run()
    db.prepare("INSERT INTO update_history (component, new_version, status) VALUES ('ffmpeg', '9.0.2', 'success')").run()
    db.prepare(
      "INSERT INTO downloads (id, url, title, media_type, output_format, output_path, status) VALUES ('d1', 'https://x', 'T', 'video', 'mp4', '/tmp', 'completed')"
    ).run()

    expect(runMigrations(db, MIGRATIONS, silentLogger)).toEqual(MIGRATIONS.slice(1).map((m) => m.version))
    expect(db.prepare('SELECT engine_name, installed_version FROM engine_versions').all()).toEqual([
      { engine_name: 'yt-dlp', installed_version: '2026.10.26' }
    ])
    expect(db.prepare('SELECT component, new_version FROM update_history').all()).toEqual([
      { component: 'ffmpeg', new_version: '9.0.2' }
    ])
    // Deno is now an accepted engine, and download rows gained the new columns.
    db.prepare("INSERT INTO engine_versions (engine_name, installed_version) VALUES ('deno', '2.9.8')").run()
    expect(db.prepare("SELECT plan_json, dismissed_at FROM downloads WHERE id = 'd1'").get()).toEqual({
      plan_json: null,
      dismissed_at: null
    })
  })

  it('refuses a database created by a newer application version', () => {
    const db = open()
    db.prepare("INSERT INTO schema_migrations (version, name) VALUES (99, 'future')").run()
    expect(() => runMigrations(db, MIGRATIONS, silentLogger)).toThrow(/newer than this application supports/)
  })

  it('rejects out-of-order migration lists', () => {
    const noop = (version: number): Migration => ({ version, name: `m${version}`, up: () => {} })
    expect(() => open([noop(2), noop(1)])).toThrow(/strictly increasing/)
  })
})
