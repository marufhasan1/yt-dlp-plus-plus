import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type SqliteDatabase } from '../../electron/services/storage/database'
import { EngineVersionsRepository } from '../../electron/services/storage/engine-versions.repository'
import { UpdateHistoryRepository } from '../../electron/services/storage/update-history.repository'
import { silentLogger } from '../../electron/utils/logger'

let db: SqliteDatabase
beforeEach(() => {
  db = openDatabase(':memory:', silentLogger)
})
afterEach(() => {
  db.close()
})

describe('EngineVersionsRepository', () => {
  it('only moves updated_at when the version changes', () => {
    const repo = new EngineVersionsRepository(db)
    repo.setInstalledVersion('yt-dlp', '2026.10.01', new Date('2026-10-01T00:00:00Z'))
    repo.setInstalledVersion('yt-dlp', '2026.10.01', new Date('2026-10-15T00:00:00Z'))
    expect(repo.get('yt-dlp')).toMatchObject({ installedVersion: '2026.10.01', updatedAt: '2026-10-01T00:00:00.000Z' })

    repo.setInstalledVersion('yt-dlp', '2026.10.26', new Date('2026-10-27T00:00:00Z'))
    expect(repo.get('yt-dlp')).toMatchObject({ installedVersion: '2026.10.26', updatedAt: '2026-10-27T00:00:00.000Z' })

    repo.setInstalledVersion('yt-dlp', null, new Date('2026-10-28T00:00:00Z'))
    expect(repo.get('yt-dlp')).toMatchObject({ installedVersion: null, updatedAt: '2026-10-28T00:00:00.000Z' })
  })

  it('returns null for unknown engines', () => {
    expect(new EngineVersionsRepository(db).get('ffprobe')).toBeNull()
  })
})

describe('UpdateHistoryRepository', () => {
  it('records entries newest first', () => {
    const repo = new UpdateHistoryRepository(db)
    repo.record({ component: 'ffmpeg', previousVersion: null, newVersion: '9.0.2', status: 'success' })
    repo.record({ component: 'yt-dlp', previousVersion: '2026.10.01', newVersion: '2026.10.26', status: 'failed', errorMessage: 'Network' })
    expect(repo.recent().map((e) => [e.component, e.status, e.errorMessage])).toEqual([
      ['yt-dlp', 'failed', 'Network'],
      ['ffmpeg', 'success', null]
    ])
  })

  it('enforces valid components and statuses', () => {
    const repo = new UpdateHistoryRepository(db)
    expect(() =>
      repo.record({ component: 'python' as never, previousVersion: null, newVersion: null, status: 'success' })
    ).toThrow(/CHECK/)
  })
})
