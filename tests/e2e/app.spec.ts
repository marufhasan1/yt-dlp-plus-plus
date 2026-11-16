import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { USER_DATA_DIR_ENV } from '../../shared/constants/app'

/*
 * Launches the built application (out/) with an isolated, throw-away user data
 * directory and a controlled PATH, so engines installed on the test machine
 * cannot influence results. Run through `npm run test:e2e`, which builds first.
 */

const projectRoot = join(__dirname, '..', '..')
let userDataDir: string
/** The only directory on the app's PATH. Empty unless a test puts a stand-in engine there. */
let fakePathDir: string
const launched: ElectronApplication[] = []

async function launch(options: { extraPath?: string } = {}): Promise<{ app: ElectronApplication; page: Page; consoleErrors: string[] }> {
  // ELECTRON_RUN_AS_NODE is set when tests start from a terminal inside VS Code (itself an
  // Electron app); it would make the binary run as plain Node instead of launching the app.
  const excluded = new Set(['ELECTRON_RENDERER_URL', 'ELECTRON_RUN_AS_NODE', 'PATH'])
  const path = options.extraPath ? `${fakePathDir}${delimiter}${options.extraPath}` : fakePathDir
  const env: Record<string, string> = { [USER_DATA_DIR_ENV]: userDataDir, PATH: path }
  for (const [key, value] of Object.entries(process.env)) {
    // Environment names are case-insensitive on Windows ("Path").
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

test.beforeEach(() => {
  userDataDir = mkdtempSync(join(tmpdir(), 'ytdlpp-e2e-'))
  fakePathDir = join(userDataDir, 'fake-path')
  mkdirSync(fakePathDir)
})

test.afterEach(async () => {
  // A failed assertion skips a test's own close(); the app would keep its files locked.
  for (const app of launched.splice(0)) await app.close().catch(() => {})
  rmSync(userDataDir, { recursive: true, force: true })
})

test('starts with a hardened window and the main layout', async () => {
  const { app, page, consoleErrors } = await launch()

  await expect(page).toHaveTitle('YT-DLP++')
  await expect(page.getByTestId('app-version')).toContainText(/v\d+\.\d+\.\d+/)
  await expect(page.locator('html')).toHaveClass(/dark/)

  // ProcessMetric.sandboxed is only reported on Windows and macOS.
  if (process.platform !== 'linux') {
    const sandboxed = await app.evaluate(({ app: electronApp, BrowserWindow }) => {
      const pid = BrowserWindow.getAllWindows()[0]!.webContents.getOSProcessId()
      return electronApp.getAppMetrics().find((metric) => metric.pid === pid)?.sandboxed
    })
    expect(sandboxed).toBe(true)
  }

  // The renderer must see the typed bridge and nothing from Node or Electron.
  // (The bridge only exists because contextBridge works, which requires contextIsolation.)
  const surface = await page.evaluate(() => {
    const scope = globalThis as Record<string, unknown>
    const bridge = scope['ytdlpp'] as Record<string, Record<string, unknown>>
    return {
      bridgeKeys: Object.keys(bridge).sort(),
      appKeys: Object.keys(bridge['app'] ?? {}).sort(),
      settingsKeys: Object.keys(bridge['settings'] ?? {}).sort(),
      enginesKeys: Object.keys(bridge['engines'] ?? {}).sort(),
      mediaKeys: Object.keys(bridge['media'] ?? {}).sort(),
      downloadsKeys: Object.keys(bridge['downloads'] ?? {}).sort(),
      historyKeys: Object.keys(bridge['history'] ?? {}).sort(),
      updatesKeys: Object.keys(bridge['updates'] ?? {}).sort(),
      playlistsKeys: Object.keys(bridge['playlists'] ?? {}).sort(),
      converterKeys: Object.keys(bridge['converter'] ?? {}).sort(),
      require: typeof scope['require'],
      process: typeof scope['process'],
      ipcRenderer: typeof scope['ipcRenderer']
    }
  })
  expect(surface).toEqual({
    bridgeKeys: ['app', 'converter', 'downloads', 'engines', 'history', 'media', 'playlists', 'settings', 'updates'],
    appKeys: ['getInfo', 'openLogsFolder', 'readClipboard'],
    settingsKeys: ['chooseDownloadDirectory', 'get', 'onChanged', 'resetDownloadDirectory', 'update'],
    enginesKeys: ['cancelInstall', 'getStatus', 'install', 'onChanged', 'openFolder', 'refresh'],
    mediaKeys: ['analyze', 'cancelAnalyze'],
    downloadsKeys: ['cancel', 'list', 'onChanged', 'onRemoved', 'pause', 'pauseAll', 'remove', 'resume', 'resumeAll', 'retry', 'showInFolder', 'start'],
    historyKeys: ['delete', 'list', 'retry', 'showInFolder'],
    updatesKeys: ['cancelAppDownload', 'cancelWaiting', 'check', 'downloadApp', 'getStatus', 'history', 'installApp', 'onChanged', 'onNotice', 'openReleaseNotes', 'rollback', 'updateEngine'],
    playlistsKeys: ['download', 'get', 'list', 'refresh', 'remove', 'thumbnail'],
    converterKeys: ['cancel', 'chooseFolder', 'list', 'onChanged', 'onRemoved', 'pickFiles', 'remove', 'showInFolder', 'start'],
    require: 'undefined',
    process: 'undefined',
    ipcRenderer: 'undefined'
  })

  expect(consoleErrors).toEqual([])
  await app.close()
})

test('navigates between every section', async () => {
  const { app, page, consoleErrors } = await launch()

  const sections: [string, string][] = [
    ['downloads', 'Downloads'],
    ['playlists', 'Playlists'],
    ['converter', 'Audio Converter'],
    ['history', 'History'],
    ['settings', 'Settings'],
    ['updates', 'Software Updates'],
    ['home', 'Home']
  ]
  for (const [name, title] of sections) {
    await page.getByTestId(`nav-${name}`).click()
    await expect(page.getByTestId('page-title')).toHaveText(title)
    await expect(page.getByTestId(`nav-${name}`)).toHaveAttribute('aria-current', 'page')
  }

  await page.getByTestId('nav-settings').click()
  await expect(page.getByTestId('about')).toContainText('Electron')

  expect(consoleErrors).toEqual([])
  await app.close()
})

test('rejects invalid settings over IPC', async () => {
  const { app, page } = await launch()

  const result = await page.evaluate(() => {
    const bridge = (globalThis as Record<string, unknown>)['ytdlpp'] as {
      settings: { update(patch: unknown): Promise<unknown> }
    }
    return bridge.settings.update({ theme: 'neon', extra: true })
  })
  expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
  await expect(page.locator('html')).toHaveClass(/dark/)

  await app.close()
})

test('switches theme and persists it across restarts', async () => {
  let { app, page } = await launch()

  await page.getByTestId('theme-toggle').click()
  await expect(page.locator('html')).not.toHaveClass(/dark/)
  expect(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('light')

  await page.getByTestId('nav-settings').click()
  await expect(page.getByTestId('segment-light')).toHaveAttribute('aria-checked', 'true')
  await page.getByTestId('segment-dark').click()
  await expect(page.locator('html')).toHaveClass(/dark/)
  await page.getByTestId('segment-light').click()
  await expect(page.locator('html')).not.toHaveClass(/dark/)
  await app.close()

  ;({ app, page } = await launch())
  await expect(page.locator('html')).not.toHaveClass(/dark/)
  await app.close()
})

test('guides the user to set up missing engines', async () => {
  const { app, page, consoleErrors } = await launch()

  const banner = page.getByTestId('engine-banner')
  await expect(banner).toContainText('yt-dlp, FFmpeg and FFprobe are not installed')
  await expect(page.getByTestId('nav-updates-attention')).toBeVisible()

  await banner.getByRole('button', { name: 'Set up engines' }).click()
  await expect(page.getByTestId('page-title')).toHaveText('Software Updates')
  await expect(banner).toBeHidden()
  for (const engine of ['yt-dlp', 'ffmpeg', 'ffprobe']) {
    await expect(page.getByTestId(`engine-${engine}`).locator('[data-health]')).toHaveAttribute('data-health', 'missing')
  }
  await expect(page.getByTestId('engine-install-yt-dlp')).toHaveText('Install')
  await expect(page.getByTestId('engine-install-ffmpeg')).toHaveText('Install')

  // Installing is opt-in: the dialog names the source, and cancelling starts nothing.
  await page.getByTestId('engine-install-yt-dlp').click()
  const dialog = page.locator('[data-testid="confirm-dialog"][open]')
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('github.com/yt-dlp/yt-dlp')
  await dialog.getByTestId('confirm-cancel').click()
  await expect(dialog).toBeHidden()
  const install = await page.evaluate(async () => {
    const bridge = (globalThis as Record<string, unknown>)['ytdlpp'] as {
      engines: { getStatus(): Promise<{ ok: boolean; data: { install: unknown } }> }
    }
    return (await bridge.engines.getStatus()).data.install
  })
  expect(install).toBeNull()

  expect(consoleErrors).toEqual([])
  await app.close()
})

test('reports a system engine that does not work', async () => {
  // A real executable that is not yt-dlp: it runs, but never prints a yt-dlp version.
  const impostor = join(fakePathDir, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp')
  try {
    linkSync(process.execPath, impostor)
  } catch {
    copyFileSync(process.execPath, impostor)
  }

  const { app, page } = await launch()
  await page.getByTestId('nav-updates').click()

  const row = page.getByTestId('engine-yt-dlp')
  await expect(row.locator('[data-health]')).toHaveAttribute('data-health', 'broken', { timeout: 30_000 })
  await expect(row).toContainText('System installation')
  await expect(row).toContainText('did not report a recognisable version')
  await expect(page.getByTestId('engine-install-yt-dlp')).toHaveText('Repair')
  await expect(page.getByTestId('engine-banner')).toBeHidden()

  await app.close()
})

test('rejects malformed engine requests over IPC', async () => {
  const { app, page } = await launch()
  const results = await page.evaluate(async () => {
    const invoke = (globalThis as Record<string, unknown>)['ytdlpp'] as {
      engines: { install(target: unknown): Promise<unknown>; refresh(deep: unknown): Promise<unknown> }
    }
    return [await invoke.engines.install('python'), await invoke.engines.refresh('yes')]
  })
  for (const result of results) expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
  await app.close()
})

type Bridge = {
  settings: { update(patch: unknown): Promise<unknown>; get(): Promise<{ data: Record<string, unknown> }> }
  media: { analyze(url: unknown): Promise<unknown> }
  downloads: { start(request: unknown): Promise<unknown> }
  converter: {
    start(request: unknown): Promise<unknown>
    cancel(id: unknown): Promise<unknown>
    showInFolder(id: unknown): Promise<unknown>
  }
}

test('validates links before analysing and explains missing engines', async () => {
  const { app, page, consoleErrors } = await launch()

  await page.getByTestId('url-input').fill('not a link')
  await page.getByTestId('url-analyze').click()
  await expect(page.getByTestId('url-error')).toHaveText('Enter a valid http:// or https:// link')

  await page.getByTestId('url-input').fill('https://www.youtube.com/playlist?list=PL123')
  await expect(page.getByText('Playlist links open on the Playlists page')).toBeVisible()

  // With no engines installed, analysis fails with an actionable message.
  await expect(page.getByTestId('engine-banner')).toBeVisible()
  await page.getByTestId('url-input').fill('https://www.youtube.com/watch?v=aqz-KE-bpKQ')
  await page.getByTestId('url-analyze').click()
  await expect(page.getByTestId('url-error')).toContainText('yt-dlp is not installed')

  await page.getByTestId('url-clear').click()
  await expect(page.getByTestId('url-input')).toHaveValue('')

  expect(consoleErrors).toEqual([])
  await app.close()
})

test('guards media and download IPC', async () => {
  const { app, page } = await launch()
  const results = await page.evaluate(async () => {
    const bridge = (globalThis as Record<string, unknown>)['ytdlpp'] as Bridge
    return {
      fileUrl: await bridge.media.analyze('file:///C:/Windows/win.ini'),
      script: await bridge.media.analyze('javascript:alert(1)'),
      unknownAnalysis: await bridge.downloads.start({
        analysisId: '00000000-0000-4000-8000-000000000000',
        selection: { kind: 'audio', format: 'mp3', quality: '192' },
        options: { embedMetadata: true, embedThumbnail: true, subtitles: null }
      }),
      injectedSelector: await bridge.downloads.start({
        analysisId: '00000000-0000-4000-8000-000000000000',
        selection: { kind: 'video', container: 'mp4', height: 'best', codec: 'auto', format: 'bv*;rm -rf /' },
        options: { embedMetadata: true, embedThumbnail: true, subtitles: null }
      }),
      // The download folder can only be chosen through the native dialog.
      folderFromRenderer: await bridge.settings.update({ downloadDirectory: 'C:\Windows\System32' })
    }
  })
  expect(results.fileUrl).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
  expect(results.script).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
  expect(results.unknownAnalysis).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
  expect(results.injectedSelector).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
  expect(results.folderFromRenderer).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
  await app.close()
})

test('persists download settings', async () => {
  let { app, page } = await launch()
  await page.getByTestId('nav-settings').click()
  await page.getByTestId('concurrency').locator('select').selectOption('4')
  await expect.poll(() => page.evaluate(async () => {
    const bridge = (globalThis as Record<string, unknown>)['ytdlpp'] as Bridge
    return (await bridge.settings.get()).data['maxConcurrentDownloads']
  })).toBe(4)
  await app.close()

  ;({ app, page } = await launch())
  await page.getByTestId('nav-settings').click()
  await expect(page.getByTestId('concurrency').locator('select')).toHaveValue('4')
  await app.close()
})

test('guards converter IPC and explains missing FFmpeg', async () => {
  const { app, page, consoleErrors } = await launch()
  const unknown = '00000000-0000-4000-8000-000000000000'
  const results = await page.evaluate(async (token) => {
    const bridge = (globalThis as Record<string, unknown>)['ytdlpp'] as Bridge
    const request = (inputs: unknown, destination: unknown = { kind: 'downloads' }) =>
      bridge.converter.start({ inputs, format: 'mp3', quality: '192', destination })
    return {
      // Files can only be chosen through the native dialog; paths are never accepted.
      pathAsInput: await request(['C:\\Windows\\win.ini']),
      unknownToken: await request([token]),
      pathAsFolder: await request([token], { kind: 'custom', path: 'C:\\Windows' }),
      badFormat: await bridge.converter.start({ inputs: [token], format: 'exe', quality: '192', destination: { kind: 'downloads' } }),
      extraField: await bridge.converter.start({ inputs: [token], format: 'mp3', quality: '192', destination: { kind: 'downloads' }, args: ['-f'] }),
      badId: await bridge.converter.cancel('../../etc'),
      unknownJob: await bridge.converter.showInFolder(token)
    }
  }, unknown)
  expect(results.pathAsInput).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
  expect(results.unknownToken).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
  expect(results.pathAsFolder).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
  expect(results.badFormat).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
  expect(results.extraField).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
  expect(results.badId).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
  expect(results.unknownJob).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })

  // Without FFmpeg, adding files explains what to do before any dialog opens.
  await app.evaluate(({ dialog }) => {
    const scope = globalThis as Record<string, unknown>
    scope['dialogOpened'] = false
    dialog.showOpenDialog = (async () => {
      scope['dialogOpened'] = true
      return { canceled: true, filePaths: [] }
    }) as typeof dialog.showOpenDialog
  })
  await page.getByTestId('nav-converter').click()
  await expect(page.getByTestId('no-inputs')).toBeVisible()
  await expect(page.getByTestId('start-conversion')).toBeDisabled()
  await page.getByTestId('add-files').click()
  await expect(page.getByText('FFmpeg is not installed or not working')).toBeVisible({ timeout: 20_000 })
  expect(await app.evaluate(() => (globalThis as Record<string, unknown>)['dialogOpened'])).toBe(false)

  expect(consoleErrors).toEqual([])
  await app.close()
})

/** FFmpeg's folder on the test machine's PATH, when both FFmpeg and FFprobe are there. */
function hostFfmpegDir(): string | null {
  const exe = process.platform === 'win32' ? '.exe' : ''
  for (const dir of (process.env['PATH'] ?? process.env['Path'] ?? '').split(delimiter)) {
    if (dir && existsSync(join(dir, `ffmpeg${exe}`)) && existsSync(join(dir, `ffprobe${exe}`))) return dir
  }
  return null
}

test('converts local files with FFmpeg through the UI', async () => {
  const ffmpegDir = hostFfmpegDir()
  test.skip(!ffmpegDir, 'FFmpeg is not installed on this machine')
  const ffmpeg = join(ffmpegDir!, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')

  const media = join(userDataDir, 'media')
  const output = join(userDataDir, 'converted')
  mkdirSync(media)
  mkdirSync(output)
  const song = join(media, 'Chanson ünïcode 🎵.wav')
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5', '-ac', '2', '-metadata', 'title=E2E Tone', song])
  const broken = join(media, 'broken.mp3')
  writeFileSync(broken, 'definitely not audio')

  const { app, page, consoleErrors } = await launch({ extraPath: dirname(ffmpeg) })
  // Stands in for the native dialogs: files for the file picker, the output folder for the folder picker.
  await app.evaluate(({ dialog }, paths) => {
    dialog.showOpenDialog = (async (...args: unknown[]) => {
      const options = args.at(-1) as Electron.OpenDialogOptions
      const folder = options.properties?.includes('openDirectory') ?? false
      return { canceled: false, filePaths: folder ? [paths.output] : paths.files }
    }) as typeof dialog.showOpenDialog
  }, { files: [song, broken], output })

  await page.getByTestId('nav-converter').click()
  await page.getByTestId('add-files').click()
  const good = page.getByTestId('input-Chanson ünïcode 🎵.wav')
  await expect(good).toHaveAttribute('data-valid', 'true', { timeout: 30_000 })
  await expect(good.getByTestId('input-details')).toContainText('PCM 16-bit · 44.1 kHz · stereo')
  await expect(good).toContainText('E2E Tone')
  await expect(page.getByTestId('input-broken.mp3').getByTestId('input-error')).toHaveText('This file is damaged or is not a supported audio or video file.')
  await expect(page.getByTestId('start-conversion')).toHaveText('Convert 1 file')

  await page.getByTestId('convert-format').getByTestId('segment-flac').click()
  await expect(page.getByTestId('convert-format').getByTestId('segment-flac')).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('convert-quality').locator('select')).toBeDisabled()
  await expect(page.getByTestId('convert-notes')).toContainText('FLAC keeps the audio without further loss')
  await page.getByTestId('convert-destination').getByTestId('segment-custom').click()
  await expect(page.getByTestId('convert-destination').getByTestId('segment-custom')).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('destination-path')).toContainText(output)
  await page.getByTestId('start-conversion').click()

  const job = page.getByTestId('conversion-list').locator('li').first()
  await expect(job).toHaveAttribute('data-status', 'completed', { timeout: 60_000 })
  await expect(job).toContainText('Lossless')
  await expect(job.getByTestId('output-path')).toHaveText(join(output, 'Chanson ünïcode 🎵.flac'))
  expect(readdirSync(output)).toEqual(['Chanson ünïcode 🎵.flac'])
  // The unreadable file stays listed; the converted one leaves the selection.
  await expect(page.getByTestId('input-list').locator('li')).toHaveCount(1)

  // Converting the same file again never overwrites the first result.
  await page.getByTestId('add-files').click()
  await expect(page.getByTestId('start-conversion')).toBeEnabled({ timeout: 30_000 })
  await page.getByTestId('start-conversion').click()
  await expect(page.getByTestId('conversion-list').locator('li[data-status="completed"]')).toHaveCount(2, { timeout: 60_000 })
  expect(readdirSync(output).sort()).toEqual(['Chanson ünïcode 🎵 (1).flac', 'Chanson ünïcode 🎵.flac'])

  await page.getByTestId('clear-finished').click()
  await expect(page.getByTestId('conversions')).toBeHidden()
  expect(consoleErrors).toEqual([])
  await app.close()
})
