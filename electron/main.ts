import { join } from 'node:path'
import { BrowserWindow, app, dialog, ipcMain, nativeTheme, session } from 'electron'
import { IPC_EVENTS } from '@shared/constants/ipc-channels'
import type { IpcEventContract } from '@shared/types/ipc'
import type { AppSettings } from '@shared/types/settings'
import { registerAppIpc } from './ipc/app.ipc'
import { registerConverterIpc } from './ipc/converter.ipc'
import { registerDownloadIpc } from './ipc/download.ipc'
import { registerEnginesIpc } from './ipc/engines.ipc'
import { createIpcRegistrar, type IpcRegistrar } from './ipc/ipc-registrar'
import { registerMediaIpc } from './ipc/media.ipc'
import { registerPlaylistIpc } from './ipc/playlist.ipc'
import { registerSettingsIpc } from './ipc/settings.ipc'
import { registerUpdateIpc } from './ipc/update.ipc'
import { handleAppScheme, registerAppScheme } from './app-protocol'
import { createMainWindow } from './main-window'
import { createSenderValidator, installSecurityPolicies, type RendererSource } from './security'
import type { DownloadManager } from './services/download/download-manager'
import type { ConversionService } from './services/media/conversion.service'
import { createEngineManager } from './services/engines'
import type { EngineManager } from './services/engines/engine-manager'
import { createMediaServices } from './services/media'
import { applySessionProxy } from './services/network/session-proxy'
import { SettingsService } from './services/settings/settings.service'
import { openDatabase, type SqliteDatabase } from './services/storage/database'
import { EngineVersionsRepository } from './services/storage/engine-versions.repository'
import { SettingsRepository } from './services/storage/settings.repository'
import { UpdateChecksRepository } from './services/storage/update-checks.repository'
import { UpdateHistoryRepository } from './services/storage/update-history.repository'
import { createElectronAppUpdater } from './services/updates/app-updater'
import { UpdateService } from './services/updates/update.service'
import { initLogger, scopedLogger, setLogLevel } from './utils/logger'
import { configureAppPaths, ensureDirectories, getAppPaths } from './utils/paths'

configureAppPaths()
const paths = getAppPaths()
ensureDirectories(paths)
const log = initLogger(paths.logs, app.isPackaged)

const devServerUrl = process.env['ELECTRON_RENDERER_URL']
const rendererSource: RendererSource =
  !app.isPackaged && devServerUrl ? { kind: 'dev-server', url: devServerUrl } : { kind: 'app', root: join(__dirname, '../renderer') }
// The scheme the UI is served on must be registered before the app is ready.
registerAppScheme()

let mainWindow: BrowserWindow | null = null
let database: SqliteDatabase | null = null
let ipc: IpcRegistrar | null = null
let settingsService: SettingsService | null = null
let engineManager: EngineManager | null = null
let downloadManager: DownloadManager | null = null
let conversionService: ConversionService | null = null
let updateService: UpdateService | null = null
let quitting = false

function broadcast<E extends keyof IpcEventContract>(channel: E, payload: IpcEventContract[E]): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload)
  }
}

function applyTheme(settings: AppSettings): void {
  // Drives native UI (menus, dialogs, scrollbars) and prefers-color-scheme in the renderer.
  nativeTheme.themeSource = settings.theme
}

let appliedProxy: string | null | undefined
/** YT-DLP++'s own requests (thumbnails, engine downloads) use the same proxy as yt-dlp. */
function applyNetwork(settings: AppSettings): void {
  setLogLevel(settings.logLevel)
  if (settings.proxy === appliedProxy) return
  appliedProxy = settings.proxy
  applySessionProxy(session.defaultSession, settings.proxy).catch((error: unknown) => log.error('Applying the proxy failed', error))
}

function openMainWindow(): void {
  mainWindow = createMainWindow({
    source: rendererSource,
    darkBackground: nativeTheme.shouldUseDarkColors,
    logger: scopedLogger('window')
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

async function bootstrap(): Promise<void> {
  log.info(
    `Starting ${app.getName()} ${app.getVersion()} (${process.platform}/${process.arch}, ` +
      `electron ${process.versions.electron}, packaged=${app.isPackaged})`
  )

  installSecurityPolicies(rendererSource, scopedLogger('security'))
  if (rendererSource.kind === 'app') handleAppScheme(rendererSource.root, scopedLogger('app-protocol'))

  database = openDatabase(paths.database, scopedLogger('database'))
  settingsService = new SettingsService(new SettingsRepository(database), scopedLogger('settings'))
  applyTheme(settingsService.get())
  applyNetwork(settingsService.get())
  settingsService.onChanged((settings) => {
    applyTheme(settings)
    applyNetwork(settings)
    downloadManager?.settingsChanged()
    broadcast(IPC_EVENTS.settingsChanged, settings)
  })

  ipc = createIpcRegistrar({
    ipcMain,
    isTrustedSender: createSenderValidator(rendererSource),
    logger: scopedLogger('ipc')
  })
  registerAppIpc(ipc, paths)
  registerSettingsIpc(ipc, settingsService, paths.downloads)

  const settings = settingsService
  const { manager, checkers } = createEngineManager(paths, database, () => settings.get().ytdlpChannel)
  engineManager = manager
  engineManager.onChanged((snapshot) => broadcast(IPC_EVENTS.enginesChanged, snapshot))
  registerEnginesIpc(ipc, engineManager)

  updateService = new UpdateService({
    engines: engineManager,
    checkers,
    app: createElectronAppUpdater({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      logger: scopedLogger('app-updater'),
      // Development only (ignored when packaged): a feed description for testing, e.g. against a local server.
      devConfigPath: process.env['YTDLPP_DEV_UPDATE_CONFIG'] ?? join(app.getAppPath(), 'dev-app-update.yml'),
      portableExecutable: process.env['PORTABLE_EXECUTABLE_FILE'] ?? null
    }),
    appVersion: app.getVersion(),
    checks: new UpdateChecksRepository(database),
    versions: new EngineVersionsRepository(database),
    history: new UpdateHistoryRepository(database),
    settings: () => settings.get(),
    logger: scopedLogger('updates')
  })
  updateService.onChanged((snapshot) => broadcast(IPC_EVENTS.updatesChanged, snapshot))
  updateService.onNotice((notice) => broadcast(IPC_EVENTS.updatesNotice, notice))
  registerUpdateIpc(ipc, updateService)

  const { links, downloads, playlists, converter } = await createMediaServices(paths, database, engineManager, settingsService)
  conversionService = converter
  converter.onChanged((job) => broadcast(IPC_EVENTS.conversionChanged, job))
  converter.onRemoved((id) => broadcast(IPC_EVENTS.conversionRemoved, { id }))
  registerConverterIpc(ipc, converter)
  downloadManager = downloads
  downloads.onChanged((job) => broadcast(IPC_EVENTS.downloadChanged, job))
  downloads.onRemoved((id) => broadcast(IPC_EVENTS.downloadRemoved, { id }))
  registerMediaIpc(ipc, links)
  registerPlaylistIpc(ipc, playlists)
  registerDownloadIpc(ipc, downloads)

  openMainWindow()
  log.info('Startup complete')

  // Engine detection spawns processes; it runs after the window is up and reports through events.
  // Automatic update checks start once the engines are known.
  const updates = updateService
  engineManager
    .initialize()
    .catch((error: unknown) => log.error('Engine initialization failed', error))
    .finally(() => updates.start())
}

function shutdown(): void {
  updateService?.stop()
  updateService = null
  downloadManager = null
  conversionService = null
  // Aborts an in-flight engine download; the staging folder is cleared on next start.
  engineManager?.dispose()
  engineManager = null
  ipc?.dispose()
  ipc = null
  if (database?.open) {
    database.close()
    log.info('Database closed')
  }
  database = null
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('activate', () => {
    if (app.isReady() && BrowserWindow.getAllWindows().length === 0 && settingsService) {
      openMainWindow()
    }
  })

  // Running downloads are stopped (with their FFmpeg/Deno children) before the app exits.
  app.on('before-quit', (event) => {
    if (quitting || (!downloadManager?.hasActiveJobs() && !conversionService?.hasActiveJobs())) return
    event.preventDefault()
    quitting = true
    log.info('Stopping active downloads and conversions before quitting')
    Promise.all([downloadManager?.shutdown(), conversionService?.shutdown()])
      .catch((error: unknown) => log.error('Stopping work before quitting failed', error))
      .finally(() => app.quit())
  })

  app.on('will-quit', shutdown)

  app
    .whenReady()
    .then(bootstrap)
    .catch((error: unknown) => {
      log.error('Fatal startup error', error)
      shutdown()
      dialog.showErrorBox(
        `${app.getName()} could not start`,
        `An error occurred during startup. Details were written to:\n${join(paths.logs, 'main.log')}`
      )
      app.exit(1)
    })
}
