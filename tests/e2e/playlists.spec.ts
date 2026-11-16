import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { USER_DATA_DIR_ENV } from '../../shared/constants/app'

/*
 * Playlist UI tests on the built app, offline: a saved playlist is planted in
 * the profile's database, and PATH is empty so no engines are found.
 */

const projectRoot = join(__dirname, '..', '..')
const PLAYLIST_ID = '7a0f3c2e-1b4d-4e6f-8a9b-0c1d2e3f4a5b'
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

/** Real titles from Blender's "Official Blender Open Movies" playlist, plus one private entry. */
async function seedPlaylist(): Promise<void> {
  const first = await launch()
  await first.app.close()
  const db = new Database(join(userDataDir, 'mediaflow.db'))
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO playlists (id, source_id, playlist_url, title, uploader, total_items, created_at, updated_at)
     VALUES (?, 'youtubetab:PL6B3937A5D230E335', 'https://www.youtube.com/playlist?list=PL6B3937A5D230E335',
             'Official Blender Open Movies', 'Blender', 5, ?, ?)`
  ).run(PLAYLIST_ID, now, now)
  const items: [string, string, number | null, string | null][] = [
    ['l5OZu-IrXpw', 'SINGULARITY - Painterly Space Adventure', 391, null],
    ['u9lj-c29dxI', 'WING IT! - Blender Open Movie', 238, null],
    ['UXqq0ZvbOnk', '[Private video]', null, 'Private video'],
    ['_cMxraX_5RE', 'Sprite Fright - Blender Open Movie', 630, null],
    ['PVGeM40dABA', 'Coffee Run - Blender Open Movie', 185, null]
  ]
  const insert = db.prepare(
    `INSERT INTO playlist_items (id, playlist_id, video_url, title, position, status, video_id, duration_seconds, unavailable_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  items.forEach(([videoId, title, duration, reason], i) =>
    insert.run(`item-${i}`, PLAYLIST_ID, `https://www.youtube.com/watch?v=${videoId}`, title, i + 1, reason ? 'unavailable' : 'pending', videoId, duration, reason)
  )
  db.close()
}

test.beforeEach(() => {
  userDataDir = mkdtempSync(join(tmpdir(), 'mediaflow-e2e-pl-'))
})

test.afterEach(async () => {
  for (const app of launched.splice(0)) await app.close().catch(() => {})
  rmSync(userDataDir, { recursive: true, force: true })
})

test('lists a saved playlist and supports selecting its videos', async () => {
  await seedPlaylist()
  const { app, page, consoleErrors } = await launch()
  await page.getByTestId('nav-playlists').click()
  await page.getByTestId(`library-${PLAYLIST_ID}`).click()

  await expect(page.getByTestId('playlist-title')).toHaveText('Official Blender Open Movies')
  await expect(page.getByTestId('playlist-count')).toHaveText('5 videos')
  await expect(page.getByTestId('playlist-details')).toContainText('1 unavailable')
  await expect(page.getByTestId('entry-3')).toContainText('Private video')
  await expect(page.getByTestId('entry-3').locator('input')).toBeDisabled()

  await page.getByTestId('select-all').click()
  await expect(page.getByTestId('selection-count')).toHaveText('4 selected')
  await page.getByTestId('select-none').click()
  await expect(page.getByTestId('selection-count')).toHaveText('0 selected')

  // Shift+click selects a range, skipping the unavailable entry.
  await page.getByTestId('entry-1').locator('input').click()
  await page.getByTestId('entry-4').locator('input').click({ modifiers: ['Shift'] })
  await expect(page.getByTestId('selection-count')).toHaveText('3 selected')
  await expect(page.getByTestId('download-selected')).toHaveText(/Download selected \(3\)/)
  await expect(page.getByTestId('download-all')).toHaveText(/Download all \(4\)/)

  await page.getByTestId('entry-filter').fill('coffee')
  await expect(page.getByTestId('entry-list').locator('li')).toHaveCount(1)
  await page.getByTestId('entry-filter').fill('')

  // Without engines the batch is refused with an actionable message, and nothing is queued.
  await page.getByTestId('download-selected').click()
  await expect(page.getByTestId('toast-host')).toContainText('yt-dlp is not installed')
  const jobs = await page.evaluate(async () => {
    const bridge = (globalThis as Record<string, unknown>)['mediaflow'] as { downloads: { list(): Promise<{ data: unknown[] }> } }
    return (await bridge.downloads.list()).data.length
  })
  expect(jobs).toBe(0)

  expect(consoleErrors).toEqual([])
  await app.close()
})

test('guards playlist IPC and removes playlists without touching downloads', async () => {
  await seedPlaylist()
  const { app, page } = await launch()
  const results = await page.evaluate(async (id) => {
    const bridge = (globalThis as Record<string, unknown>)['mediaflow'] as {
      playlists: {
        download(request: unknown): Promise<unknown>
        get(id: string): Promise<unknown>
        thumbnail(id: unknown, position: unknown): Promise<unknown>
      }
    }
    const base = {
      playlistId: id,
      selection: { kind: 'audio', format: 'mp3', quality: '192' },
      options: { embedMetadata: true, embedThumbnail: true },
      numberFiles: true
    }
    return {
      badPositions: await bridge.playlists.download({ ...base, positions: [0, -1] }),
      injectedPath: await bridge.playlists.download({ ...base, positions: 'all', destination: 'C:\\Windows' }),
      unknownPlaylist: await bridge.playlists.get('00000000-0000-4000-8000-000000000000'),
      badThumbnail: await bridge.playlists.thumbnail('../etc', 1)
    }
  }, PLAYLIST_ID)
  expect(results.badPositions).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
  expect(results.injectedPath).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
  expect(results.unknownPlaylist).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
  expect(results.badThumbnail).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })

  await page.getByTestId('nav-playlists').click()
  await page.getByTestId(`library-${PLAYLIST_ID}`).click()
  await page.getByTestId('playlist-remove').click()
  await page.getByTestId('confirm-accept').click()
  await expect(page.getByText('No playlists yet')).toBeVisible()
  await app.close()
})

test('playlist links explain that engines are needed and are validated', async () => {
  const { app, page } = await launch()
  await page.getByTestId('url-input').fill('https://www.youtube.com/playlist?list=PL6B3937A5D230E335')
  await expect(page.getByText('Playlist links open on the Playlists page')).toBeVisible()
  await page.getByTestId('url-analyze').click()
  await expect(page.getByTestId('url-error')).toContainText('yt-dlp is not installed')

  await page.getByTestId('nav-playlists').click()
  await expect(page.getByText('No playlists yet')).toBeVisible()
  await page.getByTestId('playlist-url').fill('nope')
  await page.getByTestId('playlist-analyze').click()
  await expect(page.getByTestId('playlist-error')).toHaveText('Enter a valid http:// or https:// link')
  await app.close()
})
