import { join } from 'node:path'
import { BrowserWindow, app } from 'electron'
import { WINDOW_BACKGROUND } from '@shared/constants/app'
import { APP_ENTRY_URL } from './app-protocol'
import type { RendererSource } from './security'
import type { Logger } from './utils/logger'

export interface MainWindowOptions {
  source: RendererSource
  darkBackground: boolean
  logger: Logger
}

export function createMainWindow({ source, darkBackground, logger }: MainWindowOptions): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: app.getName(),
    backgroundColor: darkBackground ? WINDOW_BACKGROUND.dark : WINDOW_BACKGROUND.light,
    autoHideMenuBar: true,
    // Windows and macOS take the icon from the executable/bundle; Linux window managers need it here.
    ...(process.platform === 'linux'
      ? { icon: app.isPackaged ? join(process.resourcesPath, 'icon.png') : join(app.getAppPath(), 'resources', 'build', 'icon.png') }
      : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      devTools: !app.isPackaged
    }
  })

  window.once('ready-to-show', () => window.show())

  window.webContents.on('render-process-gone', (_event, details) => {
    logger.error('Renderer process gone', details)
  })
  window.webContents.on('preload-error', (_event, preloadPath, error) => {
    logger.error(`Preload script failed: ${preloadPath}`, error)
  })

  const load = window.loadURL(source.kind === 'dev-server' ? source.url : APP_ENTRY_URL)
  load.catch((error: unknown) => logger.error('Failed to load renderer', error))

  return window
}
