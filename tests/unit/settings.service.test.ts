import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ZodError } from 'zod'
import { DEFAULT_SETTINGS } from '@shared/validation/settings'
import { SettingsService } from '../../electron/services/settings/settings.service'
import { openDatabase, type SqliteDatabase } from '../../electron/services/storage/database'
import { SettingsRepository } from '../../electron/services/storage/settings.repository'
import { AppError } from '../../electron/utils/errors'
import { silentLogger } from '../../electron/utils/logger'

let db: SqliteDatabase
let repository: SettingsRepository

beforeEach(() => {
  db = openDatabase(':memory:', silentLogger)
  repository = new SettingsRepository(db)
})

afterEach(() => {
  db.close()
})

describe('SettingsService', () => {
  it('returns defaults when nothing is stored', () => {
    expect(new SettingsService(repository, silentLogger).get()).toEqual(DEFAULT_SETTINGS)
  })

  it('persists updates across instances', () => {
    new SettingsService(repository, silentLogger).update({ theme: 'light' })
    expect(new SettingsService(repository, silentLogger).get().theme).toBe('light')
  })

  it('notifies listeners only when a value actually changes', () => {
    const service = new SettingsService(repository, silentLogger)
    const listener = vi.fn()
    const unsubscribe = service.onChanged(listener)

    service.update({ theme: 'dark' }) // already the default
    expect(listener).not.toHaveBeenCalled()

    service.update({ theme: 'system' })
    expect(listener).toHaveBeenCalledExactlyOnceWith({ ...DEFAULT_SETTINGS, theme: 'system' })

    unsubscribe()
    service.update({ theme: 'light' })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['an unknown value', { theme: 'sepia' }],
    ['an unknown key', { theme: 'dark', fontSize: 20 }],
    ['an empty patch', {}],
    ['a non-object', 'dark'],
    ['null', null],
    ['the main-process-only download folder', { downloadDirectory: 'C:\\Windows\\System32' }],
    ['too many simultaneous downloads', { maxConcurrentDownloads: 50 }],
    ['a free-form file name template', { filenameTemplate: '../../%(title)s' }]
  ])('rejects %s', (_label, patch) => {
    const service = new SettingsService(repository, silentLogger)
    expect(() => service.update(patch)).toThrow(ZodError)
    expect(service.get()).toEqual(DEFAULT_SETTINGS)
  })

  it('falls back to the default for corrupt or invalid stored values', () => {
    const warn = vi.fn()
    db.prepare("INSERT INTO settings (key, value) VALUES ('theme', '{not json')").run()
    expect(new SettingsService(repository, { ...silentLogger, warn }).get().theme).toBe('dark')

    db.prepare("UPDATE settings SET value = '\"neon\"' WHERE key = 'theme'").run()
    expect(new SettingsService(repository, { ...silentLogger, warn }).get().theme).toBe('dark')
    expect(warn).toHaveBeenCalledTimes(2)
  })

  it('ignores stored keys that are no longer part of the schema', () => {
    db.prepare("INSERT INTO settings (key, value) VALUES ('retiredSetting', 'true')").run()
    expect(new SettingsService(repository, silentLogger).get()).toEqual(DEFAULT_SETTINGS)
  })

  it('returns copies so callers cannot mutate internal state', () => {
    const service = new SettingsService(repository, silentLogger)
    const snapshot = service.get()
    snapshot.theme = 'light'
    expect(service.get().theme).toBe('dark')
  })
})

describe('SettingsService download folder (main process only)', () => {
  let folder: string
  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'mediaflow-dl-'))
  })
  afterEach(() => {
    rmSync(folder, { recursive: true, force: true })
  })

  it('accepts an existing, writable, absolute folder and can reset to the default', async () => {
    const service = new SettingsService(repository, silentLogger)
    expect((await service.setDownloadDirectory(folder)).downloadDirectory).toBe(folder)
    expect(new SettingsService(repository, silentLogger).get().downloadDirectory).toBe(folder)
    expect((await service.setDownloadDirectory(null)).downloadDirectory).toBeNull()
  })

  it.each([
    ['a relative path', 'downloads'],
    ['a missing folder', join(tmpdir(), 'mediaflow-does-not-exist-12345')]
  ])('rejects %s', async (_label, path) => {
    const service = new SettingsService(repository, silentLogger)
    await expect(service.setDownloadDirectory(path)).rejects.toBeInstanceOf(AppError)
    expect(service.get().downloadDirectory).toBeNull()
  })

  it('rejects a file where a folder is expected', async () => {
    const file = join(folder, 'file.txt')
    writeFileSync(file, 'x')
    await expect(new SettingsService(repository, silentLogger).setDownloadDirectory(file)).rejects.toBeInstanceOf(AppError)
  })
})
