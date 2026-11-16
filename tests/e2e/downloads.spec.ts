import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { USER_DATA_DIR_ENV } from '../../shared/constants/app'

/*
 * Download management on the built app, offline: jobs are planted in the
 * profile's database (as an earlier session would have left them), and PATH
 * is empty so no engines are found.
 */

const projectRoot = join(__dirname, '..', '..')
let userDataDir: string
const launched: ElectronApplication[] = []

async function launch(): Promise<{ app: ElectronApplication; page: Page; consoleErrors: string[] }> {
  const excluded = new Set(['ELECTRON_RENDERER_URL', 'ELECTRON_RUN_AS_NODE', 'PATH'])
  const fakePath = join(userDataDir, 'fake-path')
  mkdirSync(fakePath, { recursive: true })
  const env: Record<string, string> = { [USER_DATA_DIR_ENV]: userDataDir, PATH: fakePath }
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !excluded.has(key.toUpperCase())) env[key] = value
  }
  const app = await electron.launch({ args: [projectRoot], cwd: projectRoot, env })
  launched.push(app)
  const page = await app.firstWindow()
  const consoleErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('pageerror', (error) => consoleErrors.push(error.message))
  await expect(page.getByTestId('sidebar')).toBeVisible()
  return { app, page, consoleErrors }
}

interface Seed {
  id: string
  title: string
  status: string
  format?: string
  outputPath?: string
  createdAt?: string
  error?: string | null
  errorCode?: string | null
  progress?: number
  dismissed?: boolean
  withPlan?: boolean
  sourceId?: string
}

const PLAN = JSON.stringify({
  plan: { kind: 'video', args: ['-f', '18'], outputFormat: 'mp4', qualityLabel: '360p · H.264', streams: [], estimatedBytes: null },
  destination: '',
  filenameTemplate: 'title-id',
  skipExisting: true
})

/** Creates the profile, then plants download rows as an earlier session would have left them. */
async function seed(rows: Seed[]): Promise<void> {
  const first = await launch()
  await first.app.close()
  const db = new Database(join(userDataDir, 'mediaflow.db'))
  const insert = db.prepare(
    `INSERT INTO downloads (id, url, title, media_type, output_format, quality, output_path, status, progress, downloaded_bytes,
                            total_bytes, created_at, completed_at, error_message, error_code, plan_json, dismissed_at, source_id)
     VALUES (@id, @url, @title, 'video', @format, '360p · H.264', @outputPath, @status, @progress, 0, @size, @createdAt,
             @completedAt, @error, @errorCode, @plan, @dismissed, @sourceId)`
  )
  for (const row of rows) {
    const createdAt = row.createdAt ?? new Date().toISOString()
    insert.run({
      id: row.id,
      url: `https://www.youtube.com/watch?v=${row.id.slice(0, 11)}`,
      title: row.title,
      format: row.format ?? 'mp4',
      outputPath: row.outputPath ?? userDataDir,
      status: row.status,
      progress: row.progress ?? (row.status === 'completed' ? 100 : 0),
      size: row.status === 'completed' ? 4096 : null,
      createdAt,
      completedAt: row.status === 'completed' ? createdAt : null,
      error: row.error ?? null,
      errorCode: row.errorCode ?? null,
      plan: row.withPlan === false ? null : PLAN.replace('"destination":""', `"destination":${JSON.stringify(userDataDir)}`),
      dismissed: row.dismissed ? createdAt : null,
      sourceId: row.sourceId ?? null
    })
  }
  db.close()
}

function row(id: string): Record<string, unknown> {
  const db = new Database(join(userDataDir, 'mediaflow.db'), { readonly: true })
  const result = db.prepare('SELECT * FROM downloads WHERE id = ?').get(id) as Record<string, unknown>
  db.close()
  return result
}

const uuid = (n: number) => `5f0c7a1e-3b7d-4c1a-9a6e-${String(n).padStart(12, '0')}`

test.beforeEach(() => {
  userDataDir = mkdtempSync(join(tmpdir(), 'mediaflow-e2e-dl-'))
})

test.afterEach(async () => {
  for (const app of launched.splice(0)) await app.close().catch(() => {})
  rmSync(userDataDir, { recursive: true, force: true })
})

test('offers downloads interrupted by the last session for resuming', async () => {
  await seed([
    { id: uuid(1), title: 'Interrupted while downloading', status: 'downloading', progress: 42 },
    { id: uuid(2), title: 'Interrupted while queued', status: 'queued' },
    { id: uuid(3), title: 'Paused by the user', status: 'paused', progress: 10 },
    { id: uuid(4), title: 'Left over from an old version', status: 'downloading', withPlan: false }
  ])
  // Partial files of the interrupted job are kept; a scratch folder nobody owns is cleared.
  mkdirSync(join(userDataDir, 'downloads-tmp', uuid(1)), { recursive: true })
  writeFileSync(join(userDataDir, 'downloads-tmp', uuid(1), 'video.f134.mp4.part'), 'partial')
  mkdirSync(join(userDataDir, 'downloads-tmp', 'orphan'), { recursive: true })

  const { app, page, consoleErrors } = await launch()
  await page.getByTestId('nav-downloads').click()
  const banner = page.getByTestId('recovery-banner')
  await expect(banner).toContainText('2 downloads were interrupted when MediaFlow closed')

  const interrupted = page.getByTestId(`download-${uuid(1)}`)
  await expect(interrupted).toHaveAttribute('data-status', 'paused')
  await expect(interrupted.getByTestId('paused-info')).toContainText('Interrupted when MediaFlow closed')
  await expect(interrupted.getByTestId('paused-info')).toContainText('42%')
  await expect(page.getByTestId(`download-${uuid(3)}`).getByTestId('paused-info')).toContainText('Paused — partial download kept')
  await expect(page.getByTestId(`download-${uuid(4)}`)).toHaveAttribute('data-status', 'failed')
  expect(existsSync(join(userDataDir, 'downloads-tmp', uuid(1), 'video.f134.mp4.part'))).toBe(true)
  expect(existsSync(join(userDataDir, 'downloads-tmp', 'orphan'))).toBe(false)

  await page.getByTestId('filter-paused').click()
  await expect(page.getByTestId('download-list').locator('li')).toHaveCount(3)
  await page.getByTestId('filter-all').click()
  await expect(page.getByTestId('downloads-summary')).toContainText('3 paused')

  // "Not now" hides the notice; the jobs stay paused.
  await page.getByTestId('recovery-later').click()
  await expect(banner).toBeHidden()

  // Resuming needs yt-dlp, which is not installed here: the job fails with a clear reason.
  await interrupted.getByTestId('resume').click()
  await expect(interrupted).toHaveAttribute('data-status', 'failed')
  await expect(interrupted).toContainText('yt-dlp is not installed')
  expect(row(uuid(1))).toMatchObject({ status: 'failed', interrupted: 0 })

  // Cancelling a paused job discards its partial files.
  await page.getByTestId(`download-${uuid(3)}`).getByTestId('cancel').click()
  await expect(page.getByTestId(`download-${uuid(3)}`)).toHaveAttribute('data-status', 'cancelled')
  // The other interrupted job is discarded too; nothing is left to pause.
  await page.getByTestId(`download-${uuid(2)}`).getByTestId('cancel').click()
  await expect(page.getByTestId('pause-all')).toBeHidden()

  expect(consoleErrors).toEqual([])
  await app.close()
})

test('pauses and resumes queued downloads, alone and all together', async () => {
  await seed([
    { id: uuid(5), title: 'First paused', status: 'paused', createdAt: '2026-11-01T10:00:00.000Z' },
    { id: uuid(6), title: 'Second paused', status: 'paused', createdAt: '2026-11-01T11:00:00.000Z' }
  ])
  const { app, page } = await launch()
  await page.getByTestId('nav-downloads').click()
  await expect(page.getByTestId('recovery-banner')).toBeHidden() // paused by the user, not interrupted

  // Without engines, resumed jobs fail at once; the point here is the controls and bookkeeping.
  await page.getByTestId('resume-all').click()
  for (const id of [uuid(5), uuid(6)]) await expect(page.getByTestId(`download-${id}`)).toHaveAttribute('data-status', 'failed')
  await expect(page.getByTestId('resume-all')).toBeHidden()
  await app.close()
})

test('lists, searches, filters and manages history', async () => {
  const kept = join(userDataDir, 'saved', 'Big Buck Bunny.mp4')
  const trashed = join(userDataDir, 'saved', 'Sintel.mp3')
  mkdirSync(join(userDataDir, 'saved'))
  writeFileSync(kept, 'video')
  writeFileSync(trashed, 'audio')
  const old = (day: number) => new Date(Date.UTC(2026, 0, day, 12)).toISOString()
  await seed([
    { id: uuid(10), title: 'Big Buck Bunny', status: 'completed', outputPath: kept, sourceId: 'youtube:aqz-KE-bpKQ' },
    { id: uuid(11), title: 'Sintel 100% [4K]', status: 'completed', format: 'mp3', outputPath: trashed },
    { id: uuid(12), title: 'Moved away', status: 'completed', outputPath: join(userDataDir, 'saved', 'gone.mp4') },
    { id: uuid(13), title: 'Private upload', status: 'failed', error: 'This video is private.', errorCode: 'PRIVATE_VIDEO', dismissed: true, createdAt: old(15) },
    { id: uuid(14), title: 'Still running', status: 'paused' },
    ...Array.from({ length: 55 }, (_, i) => ({ id: uuid(100 + i), title: `Archive clip ${i + 1}`, status: 'cancelled', createdAt: old(1) }))
  ])

  const { app, page, consoleErrors } = await launch()
  await app.evaluate(({ shell }) => {
    // Records instead of moving the file to the real Recycle Bin.
    const scope = globalThis as Record<string, unknown>
    scope['trashed'] = []
    shell.trashItem = async (path: string) => {
      ;(scope['trashed'] as string[]).push(path)
    }
  })
  await page.getByTestId('nav-history').click()
  const list = page.getByTestId('history-list')
  await expect(page.getByTestId('history-count')).toHaveText('59 downloads') // the paused job is not history yet
  await expect(list.locator('li')).toHaveCount(50)
  await page.getByTestId('history-more').click()
  await expect(list.locator('li')).toHaveCount(59)

  await expect(page.getByTestId(`history-${uuid(12)}`).getByTestId('file-missing')).toBeVisible()
  await expect(page.getByTestId(`history-${uuid(12)}`).getByTestId('show-in-folder')).toBeHidden()
  await expect(page.getByTestId(`history-${uuid(10)}`).getByTestId('show-in-folder')).toBeVisible()
  // A job removed from the Downloads list is still in history.
  await expect(page.getByTestId(`history-${uuid(13)}`)).toContainText('This video is private.')

  // Search matches literally, including "%".
  await page.getByTestId('history-search').fill('100%')
  await expect(list.locator('li')).toHaveCount(1)
  await expect(page.getByTestId('history-count')).toHaveText('1 download matches')
  await page.getByTestId('history-clear').click()
  await expect(list.locator('li')).toHaveCount(50)

  await page.getByTestId('history-format').locator('select').selectOption('mp3')
  await expect(list.locator('li')).toHaveCount(1)
  await page.getByTestId('history-format').locator('select').selectOption('any')
  await page.getByTestId('history-status').locator('select').selectOption('failed')
  await expect(list.locator('li')).toHaveCount(1)
  await page.getByTestId('history-status').locator('select').selectOption('any')
  await page.getByTestId('history-range').locator('select').selectOption('custom')
  await page.getByTestId('history-from').fill('2026-01-15')
  await page.getByTestId('history-to').fill('2026-01-15')
  await expect(list.locator('li')).toHaveCount(1)
  await expect(list.locator('li').first()).toContainText('Private upload')
  await page.getByTestId('history-range').locator('select').selectOption('today')
  await expect(page.getByTestId('history-count')).toHaveText('3 downloads match')
  await page.getByTestId('history-clear').click()

  // Deleting an entry keeps the file unless asked.
  await page.getByTestId(`history-${uuid(10)}`).getByTestId('delete').click()
  await expect(page.getByTestId('delete-file-option')).toBeVisible()
  await page.getByTestId('confirm-accept').click()
  await expect(page.getByTestId(`history-${uuid(10)}`)).toBeHidden()
  expect(existsSync(kept)).toBe(true)
  expect(row(uuid(10))).toBeUndefined()

  // ... and moves it to the Recycle Bin / Trash when asked.
  await page.getByTestId(`history-${uuid(11)}`).getByTestId('delete').click()
  await page.getByTestId('delete-file').check()
  await page.getByTestId('confirm-accept').click()
  await expect(page.getByTestId(`history-${uuid(11)}`)).toBeHidden()
  expect(await app.evaluate(() => (globalThis as Record<string, unknown>)['trashed'])).toEqual([trashed])

  // A missing file offers no file option.
  await page.getByTestId(`history-${uuid(12)}`).getByTestId('delete').click()
  await expect(page.getByTestId('delete-file-option')).toBeHidden()
  await page.getByTestId('confirm-cancel').click()

  // Retrying from history brings the job back to Downloads (where it fails: no engines here).
  await page.getByTestId(`history-${uuid(13)}`).getByTestId('retry').click()
  await page.getByTestId('nav-downloads').click()
  await expect(page.getByTestId(`download-${uuid(13)}`)).toBeVisible()
  expect(row(uuid(13))['dismissed_at']).toBeNull()

  expect(consoleErrors).toEqual([])
  await app.close()
})

test('guards download-management IPC', async () => {
  const { app, page } = await launch()
  const results = await page.evaluate(async () => {
    type Result = Promise<unknown>
    const bridge = (globalThis as Record<string, unknown>)['mediaflow'] as {
      downloads: { pause(id: unknown): Result; resume(id: unknown): Result }
      history: { list(query: unknown): Result; delete(id: unknown, deleteFile: unknown): Result; showInFolder(id: unknown): Result }
      settings: { update(patch: unknown): Result }
    }
    const unknown = '00000000-0000-4000-8000-000000000000'
    return {
      pauseUnknown: await bridge.downloads.pause(unknown),
      resumeBadId: await bridge.downloads.resume('../../x'),
      injectedFormat: await bridge.history.list({ offset: 0, limit: 10, format: "mp4' OR 1=1 --" }),
      hugePage: await bridge.history.list({ offset: 0, limit: 100000 }),
      badDate: await bridge.history.list({ offset: 0, limit: 10, from: 'yesterday' }),
      okQuery: await bridge.history.list({ offset: 0, limit: 10, search: "'; DROP TABLE downloads; --" }),
      deleteWithoutChoice: await bridge.history.delete(unknown, undefined),
      deleteUnknown: await bridge.history.delete(unknown, true),
      showUnknown: await bridge.history.showInFolder(unknown),
      badProxy: await bridge.settings.update({ proxy: 'file:///etc/passwd' }),
      argumentProxy: await bridge.settings.update({ proxy: 'http://x:1 --exec calc' }),
      retriesTooHigh: await bridge.settings.update({ maxRetries: 99 })
    }
  })
  expect(results.pauseUnknown).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
  expect(results.resumeBadId).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
  expect(results.injectedFormat).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
  expect(results.hugePage).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
  expect(results.badDate).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
  expect(results.okQuery).toMatchObject({ ok: true, data: { items: [], total: 0 } })
  expect(results.deleteWithoutChoice).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
  expect(results.deleteUnknown).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
  expect(results.showUnknown).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
  expect(results.badProxy).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
  expect(results.argumentProxy).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
  expect(results.retriesTooHigh).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
  await app.close()
})

test('saves advanced settings and applies the proxy to MediaFlow’s own requests', async () => {
  let { app, page, consoleErrors } = await launch()
  await page.getByTestId('nav-settings').click()
  await page.getByTestId('setting-retries').locator('select').selectOption('5')
  await page.getByTestId('setting-timeout').locator('select').selectOption('60')
  await page.getByTestId('setting-speed-limit').locator('select').selectOption('2048')
  await page.getByTestId('setting-log-level').getByTestId('segment-debug').click()

  await page.getByTestId('proxy-input').fill('ftp://proxy.example')
  await page.getByTestId('proxy-save').click()
  await expect(page.getByTestId('proxy-error')).toContainText('Enter a proxy such as')
  await page.getByTestId('proxy-input').fill('http://user:secret@127.0.0.1:3128')
  await page.getByTestId('proxy-save').click()
  await expect(page.getByTestId('proxy-current')).toContainText('http://***@127.0.0.1:3128')
  await expect(page.getByTestId('proxy-current')).not.toContainText('secret')
  await expect(page.getByTestId('proxy-input')).toHaveValue('')
  await expect
    .poll(() => app.evaluate(({ session }) => session.defaultSession.resolveProxy('https://i.ytimg.com/vi/x/hqdefault.jpg')))
    .toBe('PROXY 127.0.0.1:3128')
  expect(consoleErrors).toEqual([])
  await app.close()

  ;({ app, page, consoleErrors } = await launch())
  // Applied again at startup, before any request is made.
  expect(await app.evaluate(({ session }) => session.defaultSession.resolveProxy('https://github.com/'))).toBe('PROXY 127.0.0.1:3128')
  await page.getByTestId('nav-settings').click()
  await expect(page.getByTestId('setting-retries').locator('select')).toHaveValue('5')
  await expect(page.getByTestId('setting-timeout').locator('select')).toHaveValue('60')
  await expect(page.getByTestId('setting-speed-limit').locator('select')).toHaveValue('2048')
  await expect(page.getByTestId('setting-log-level').getByTestId('segment-debug')).toHaveAttribute('aria-checked', 'true')
  await page.getByTestId('proxy-clear').click()
  await expect(page.getByTestId('proxy-current')).toContainText('Direct connection')
  await expect.poll(() => app.evaluate(({ session }) => session.defaultSession.resolveProxy('https://github.com/'))).not.toContain('127.0.0.1:3128')
  expect(consoleErrors).toEqual([])
  await app.close()
})
