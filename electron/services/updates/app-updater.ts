import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import electronUpdater, { CancellationToken, type AppUpdater, type ProgressInfo } from 'electron-updater'
import type { Logger } from '../../utils/logger'
import { releaseNotesText } from './release-notes'

/** A newer application release. */
export interface AppRelease {
  version: string
  releasedAt: string | null
  /** Plain text. */
  notes: string | null
  notesUrl: string | null
}

/** What the update service needs from the application updater; electron-updater in production, a fake in tests. */
export interface AppUpdateBackend {
  /** Null when this build can update itself; otherwise why not. */
  unavailableReason(): string | null
  /** The newer release, or null when this is the latest version. */
  check(): Promise<AppRelease | null>
  /** Downloads and verifies the release found by the last check. */
  download(onProgress: (percent: number) => void): Promise<void>
  cancelDownload(): void
  /** Quits, installs the downloaded release and starts the new version. */
  install(): void
}

export interface ElectronUpdaterOptions {
  isPackaged: boolean
  resourcesPath: string
  logger: Logger
  /**
   * Development only: an update feed description (dev-app-update.yml) to test
   * against, e.g. a local server. Ignored in packaged builds.
   */
  devConfigPath?: string | null
  /** Set by electron-builder's portable target, which cannot update itself. */
  portableExecutable?: string | null
}

/** Reads `owner`/`repo` from the app-update.yml electron-builder writes, for the release page link. */
function githubRepository(configPath: string): { owner: string; repo: string } | null {
  try {
    const text = readFileSync(configPath, 'utf8')
    const value = (key: string) => new RegExp(`^${key}:\\s*['"]?([\\w.-]+)['"]?\\s*$`, 'm').exec(text)?.[1] ?? null
    const owner = value('owner')
    const repo = value('repo')
    return value('provider') === 'github' && owner && repo ? { owner, repo } : null
  } catch {
    return null
  }
}

/** electron-updater with GitHub Releases (configured at build time, see electron-builder.config.mjs). */
export function createElectronAppUpdater(options: ElectronUpdaterOptions): AppUpdateBackend {
  const { isPackaged, resourcesPath, logger } = options
  const packagedConfig = join(resourcesPath, 'app-update.yml')
  const devConfig = !isPackaged && options.devConfigPath && existsSync(options.devConfigPath) ? options.devConfigPath : null
  const configPath = isPackaged ? packagedConfig : devConfig

  let reason: string | null = null
  if (options.portableExecutable) reason = 'The portable version cannot update itself. Download the new version from the releases page.'
  else if (!isPackaged && !devConfig) reason = 'Application updates are checked in installed builds only.'
  else if (isPackaged && !existsSync(packagedConfig)) reason = 'This build was made without an update feed, so it cannot check for new versions.'

  let updater: AppUpdater | null = null
  const get = (): AppUpdater => {
    if (updater) return updater
    updater = electronUpdater.autoUpdater
    updater.logger = logger
    updater.autoDownload = false
    updater.autoInstallOnAppQuit = true
    updater.allowPrerelease = false
    updater.allowDowngrade = false
    if (devConfig) {
      updater.forceDevUpdateConfig = true
      updater.updateConfigPath = devConfig
    }
    return updater
  }
  const repository = configPath ? githubRepository(configPath) : null
  let cancellation: CancellationToken | null = null

  return {
    unavailableReason: () => reason,

    async check() {
      if (reason) return null
      const result = await get().checkForUpdates()
      if (!result?.isUpdateAvailable) return null
      const info = result.updateInfo
      return {
        version: info.version,
        releasedAt: info.releaseDate || null,
        notes: releaseNotesText(info.releaseNotes),
        notesUrl: repository ? `https://github.com/${repository.owner}/${repository.repo}/releases/tag/v${info.version}` : null
      }
    },

    async download(onProgress) {
      const instance = get()
      const listener = (progress: ProgressInfo) => onProgress(progress.percent)
      instance.on('download-progress', listener)
      cancellation = new CancellationToken()
      try {
        await instance.downloadUpdate(cancellation)
      } finally {
        instance.off('download-progress', listener)
        cancellation = null
      }
    },

    cancelDownload() {
      cancellation?.cancel()
    },

    install() {
      // isSilent=false shows the installer's progress; isForceRunAfter=true starts the new version.
      get().quitAndInstall(false, true)
    }
  }
}

/** User-presentable text for updater failures; details stay in the log. */
export function describeAppUpdateError(error: unknown): string {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error)
  if (/sha512 checksum mismatch|checksum mismatch/i.test(text)) {
    return 'Update verification failed: the downloaded file does not match the published checksum. It was discarded.'
  }
  if (/not signed by the application owner|code signature|SignatureVerification/i.test(text)) {
    return 'Update verification failed: the downloaded installer is not signed by the YT-DLP++ publisher.'
  }
  if (/cancel/i.test(text)) return 'The download was cancelled.'
  // GitHub answers a missing repository or release feed with 404 ("HttpError" + "404 …releases.atom").
  if (/HttpError:?\s*404|status code 404|Cannot find latest|No published versions/i.test(text)) {
    return 'No published release was found on the update server.'
  }
  if (/ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION|ENOTFOUND|ETIMEDOUT|ECONNREFUSED|net::|socket hang up/i.test(text)) {
    return 'The update server could not be reached. Check your internet connection and try again.'
  }
  if (/rate limit|status code 403/i.test(text)) return 'GitHub limited update checks for now. Try again later.'
  return 'The update could not be completed. Details were written to the log file.'
}
