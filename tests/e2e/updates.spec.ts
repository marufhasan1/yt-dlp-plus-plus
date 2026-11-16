import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { USER_DATA_DIR_ENV } from '../../shared/constants/app'

/*
 * Software Updates on the built app, offline. The application updater is
 * pointed (development builds only) at a local update feed served here, so
 * electron-updater's real check, download and SHA-512 verification run
 * without the internet. Nothing is ever installed.
 */

const projectRoot = join(__dirname, '..', '..')
let userDataDir: string
let server: Server | null = null
let cacheDirName: string
const launched: ElectronApplication[] = []

async function launch(extraEnv: Record<string, string> = {}): Promise<{ app: ElectronApplication; page: Page; consoleErrors: string[] }> {
  const excluded = new Set(['ELECTRON_RENDERER_URL', 'ELECTRON_RUN_AS_NODE', 'PATH', 'MEDIAFLOW_DEV_UPDATE_CONFIG'])
  const fakePath = join(userDataDir, 'fake-path')
  mkdirSync(fakePath, { recursive: true })
  const env: Record<string, string> = { [USER_DATA_DIR_ENV]: userDataDir, PATH: fakePath, ...extraEnv }
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

/** Serves latest.yml and a stand-in installer like a GitHub release would. */
async function serveFeed(options: { corruptDownload?: boolean } = {}): Promise<string> {
  const installer = Buffer.alloc(256 * 1024, 7)
  const sha512 = createHash('sha512').update(installer).digest('base64')
  const name = 'MediaFlow-Setup-0.2.0-x64.exe'
  const latest = [
    'version: 0.2.0',
    'files:',
    `  - url: ${name}`,
    `    sha512: ${sha512}`,
    `    size: ${installer.length}`,
    `path: ${name}`,
    `sha512: ${sha512}`,
    "releaseDate: '2026-11-08T10:00:00.000Z'",
    "releaseNotes: '<h2>MediaFlow 0.2.0</h2><ul><li>Faster downloads</li><li>Fixes &amp; improvements</li></ul><script>alert(1)</script>'"
  ].join('\n')
  server = createServer((request, response) => {
    if (request.url?.startsWith('/latest.yml')) {
      response.writeHead(200, { 'content-type': 'text/yaml' })
      response.end(latest)
    } else if (request.url === `/${name}`) {
      const body = options.corruptDownload ? Buffer.alloc(installer.length, 9) : installer
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(body.length) })
      response.end(body)
    } else {
      response.writeHead(404)
      response.end()
    }
  })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  const config = join(userDataDir, 'dev-app-update.yml')
  writeFileSync(config, `provider: generic\nurl: http://127.0.0.1:${port}/\nupdaterCacheDirName: ${cacheDirName}\n`)
  return config
}

test.beforeEach(() => {
  userDataDir = mkdtempSync(join(tmpdir(), 'mediaflow-e2e-up-'))
  cacheDirName = `mediaflow-e2e-updater-${randomUUID().slice(0, 8)}`
})

test.afterEach(async () => {
  for (const app of launched.splice(0)) await app.close().catch(() => {})
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  server = null
  rmSync(userDataDir, { recursive: true, force: true })
  // electron-updater's download cache (per user, named by updaterCacheDirName).
  const base = process.platform === 'win32' ? (process.env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local')) : join(homedir(), '.cache')
  rmSync(join(base, cacheDirName), { recursive: true, force: true })
})

test('shows every component and explains what cannot be updated here', async () => {
  const { app, page, consoleErrors } = await launch()
  await page.getByTestId('nav-updates').click()
  const appCard = page.getByTestId('update-card-app')
  await expect(appCard.getByTestId('update-state')).toHaveAttribute('data-state', 'unavailable')
  await expect(appCard).toContainText('Application updates are checked in installed builds only.')
  await expect(appCard.getByTestId('installed-version')).toHaveText(/^\d+\.\d+\.\d+$/)
  // No engines on this machine: nothing to update, Install is offered instead.
  for (const target of ['yt-dlp', 'ffmpeg', 'deno']) {
    await expect(page.getByTestId(`update-row-${target}`)).toHaveAttribute('data-state', 'unavailable')
    await expect(page.getByTestId(`update-${target}`)).toBeHidden()
    await expect(page.getByTestId(`engine-install-${target}`)).toBeVisible()
  }
  await expect(page.getByTestId('update-schedule')).toContainText('Not checked yet')
  await expect(page.getByTestId('update-history')).toContainText('Nothing has been installed or updated yet.')
  expect(consoleErrors).toEqual([])
  await app.close()
})

test('lists the update history', async () => {
  const first = await launch()
  await first.app.close()
  const db = new Database(join(userDataDir, 'mediaflow.db'))
  const insert = db.prepare('INSERT INTO update_history (component, previous_version, new_version, status, error_message, created_at) VALUES (?, ?, ?, ?, ?, ?)')
  insert.run('yt-dlp', '2026.09.01', '2026.10.26', 'success', null, '2026-11-01T10:00:00.000Z')
  insert.run('ffmpeg', '9.0.1', '9.0.2', 'rolled_back', 'The new FFmpeg did not work after installation. The previous version was restored.', '2026-11-02T10:00:00.000Z')
  insert.run('app', '0.1.0', '0.2.0', 'failed', 'Update verification failed.', '2026-11-03T10:00:00.000Z')
  db.close()

  const { app, page } = await launch()
  await page.getByTestId('nav-updates').click()
  const rows = page.getByTestId('update-history').locator('tbody tr')
  await expect(rows).toHaveCount(3)
  await expect(rows.nth(0)).toContainText('MediaFlow')
  await expect(rows.nth(0)).toHaveAttribute('data-status', 'failed')
  await expect(rows.nth(1)).toContainText('9.0.1 → 9.0.2')
  await expect(rows.nth(1)).toContainText('Rolled back')
  await expect(rows.nth(1)).toContainText('previous version was restored')
  await expect(rows.nth(2)).toContainText('Installed')
  await app.close()
})

test('saves update settings', async () => {
  let { app, page } = await launch()
  await page.getByTestId('nav-updates').click()
  await page.getByTestId('update-settings').click()
  await expect(page.locator('#updates')).toBeInViewport()
  await page.getByTestId('setting-check-interval').locator('select').selectOption('72')
  await page.getByTestId('setting-ytdlp-channel').getByTestId('segment-nightly').click()
  await page.getByTestId('setting-auto-update-ytdlp').click()
  await page.getByTestId('setting-check-engines').click()
  await expect
    .poll(() => page.evaluate(async () => (await (globalThis as unknown as { mediaflow: { settings: { get(): Promise<{ data: Record<string, unknown> }> } } }).mediaflow.settings.get()).data))
    .toMatchObject({ updateCheckIntervalHours: 72, ytdlpChannel: 'nightly', autoUpdateYtdlp: true, checkEngineUpdates: false })
  await page.getByTestId('setting-auto-check').click()
  await page.getByTestId('nav-updates').click()
  await expect(page.getByTestId('update-schedule')).toContainText('automatic checks are off')
  await app.close()

  ;({ app, page } = await launch())
  await page.getByTestId('nav-settings').click()
  await expect(page.getByTestId('setting-check-interval').locator('select')).toHaveValue('72')
  await expect(page.getByTestId('setting-ytdlp-channel').getByTestId('segment-nightly')).toHaveAttribute('aria-checked', 'true')
  await app.close()
})

test('guards update IPC', async () => {
  const { app, page } = await launch()
  const results = await page.evaluate(async () => {
    type Result = Promise<unknown>
    const updates = (globalThis as unknown as { mediaflow: { updates: Record<string, (arg?: unknown) => Result> } }).mediaflow.updates
    return {
      badComponent: await updates['check']!('python'),
      badTarget: await updates['updateEngine']!('../../yt-dlp'),
      appAsEngine: await updates['rollback']!('app'),
      noRelease: await updates['downloadApp']!(),
      notDownloaded: await updates['installApp']!(),
      notInstalled: await updates['updateEngine']!('yt-dlp'),
      nothingToRollBack: await updates['rollback']!('ffmpeg'),
      notes: await updates['openReleaseNotes']!('yt-dlp'),
      notesUrl: await updates['openReleaseNotes']!('https://evil.example')
    }
  })
  const code = (result: unknown) => (result as { error?: { code: string } }).error?.code
  expect(code(results.badComponent)).toBe('VALIDATION_FAILED')
  expect(code(results.badTarget)).toBe('VALIDATION_FAILED')
  expect(code(results.appAsEngine)).toBe('VALIDATION_FAILED')
  expect(code(results.noRelease)).toBe('VALIDATION_FAILED')
  expect(code(results.notDownloaded)).toBe('VALIDATION_FAILED')
  expect(code(results.notInstalled)).toBe('VALIDATION_FAILED')
  expect(code(results.nothingToRollBack)).toBe('NOT_FOUND')
  expect(code(results.notes)).toBe('NOT_FOUND')
  expect(code(results.notesUrl)).toBe('VALIDATION_FAILED')
  await app.close()
})

test('checks, downloads and verifies an application update from its feed', async () => {
  test.skip(process.platform !== 'win32', 'The NSIS updater is exercised on Windows; macOS and Linux need signed or AppImage builds.')
  const config = await serveFeed()
  const { app, page, consoleErrors } = await launch({ MEDIAFLOW_DEV_UPDATE_CONFIG: config })
  await page.getByTestId('nav-updates').click()
  const card = page.getByTestId('update-card-app')
  await card.getByTestId('app-check').click()
  await expect(card.getByTestId('update-state')).toHaveAttribute('data-state', 'available')
  await expect(card.getByTestId('latest-version')).toContainText('0.2.0')
  // Release notes are shown as text; the script tag never reaches the page.
  await card.getByTestId('app-release-notes').locator('summary').click()
  await expect(card.getByTestId('app-release-notes')).toContainText('• Faster downloads')
  await expect(card.getByTestId('app-release-notes')).toContainText('Fixes & improvements')
  await expect(card.getByTestId('app-release-notes')).not.toContainText('alert')
  // With engines missing, the sidebar keeps showing the more urgent "needs attention" marker.
  await expect(page.getByTestId('nav-updates-attention')).toBeVisible()

  await card.getByTestId('app-download').click()
  await expect(card.getByTestId('update-state')).toHaveAttribute('data-state', 'ready', { timeout: 30_000 })
  await expect(card.getByTestId('app-ready')).toContainText('Downloaded and verified')
  await expect(card.getByTestId('app-install')).toBeVisible()
  expect(consoleErrors).toEqual([])
  await app.close()
})

test('rejects an application update whose download does not match its checksum', async () => {
  test.skip(process.platform !== 'win32', 'The NSIS updater is exercised on Windows.')
  const config = await serveFeed({ corruptDownload: true })
  const { app, page } = await launch({ MEDIAFLOW_DEV_UPDATE_CONFIG: config })
  await page.getByTestId('nav-updates').click()
  const card = page.getByTestId('update-card-app')
  await card.getByTestId('app-check').click()
  await card.getByTestId('app-download').click()
  await expect(card.getByTestId('update-state')).toHaveAttribute('data-state', 'failed', { timeout: 30_000 })
  await expect(card.getByTestId('app-message')).toContainText('Update verification failed')
  await expect(page.getByTestId('update-history').locator('tbody tr').first()).toContainText('Failed')
  expect(existsSync(join(userDataDir, 'dev-app-update.yml'))).toBe(true)
  await app.close()
})
