import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { app } from 'electron'
import { DATABASE_FILENAME, USER_DATA_DIR_ENV } from '@shared/constants/app'

export interface AppPaths {
  /** Per-user configuration and state (database, settings). */
  userData: string
  logs: string
  /** Managed yt-dlp / FFmpeg / FFprobe binaries. Kept apart from the install directory so updates never need elevation. */
  engines: string
  /** Per-download scratch folders for partial files. */
  downloadTemp: string
  database: string
  /** The OS download folder, used as the initial default destination. */
  downloads: string
}

/**
 * Must run before `app.whenReady()`. Tests may redirect user data to a temporary
 * directory; packaged builds always use the OS default location.
 */
export function configureAppPaths(): void {
  const override = process.env[USER_DATA_DIR_ENV]
  if (override && !app.isPackaged) {
    app.setPath('userData', resolve(override))
  }
  // Uses <userData>/logs on Windows and Linux, ~/Library/Logs/<name> on macOS.
  app.setAppLogsPath()
}

export function getAppPaths(): AppPaths {
  const userData = app.getPath('userData')
  return {
    userData,
    logs: app.getPath('logs'),
    engines: join(userData, 'engines'),
    downloadTemp: join(userData, 'downloads-tmp'),
    database: join(userData, DATABASE_FILENAME),
    downloads: app.getPath('downloads')
  }
}

export function ensureDirectories(paths: AppPaths): void {
  for (const dir of [paths.userData, paths.logs]) {
    mkdirSync(dir, { recursive: true })
  }
}
