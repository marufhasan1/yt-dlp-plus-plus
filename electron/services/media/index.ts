import { BrowserWindow, dialog, net, shell } from 'electron'
import { scopedLogger } from '../../utils/logger'
import type { AppPaths } from '../../utils/paths'
import { runProcess } from '../../utils/process'
import { DownloadManager } from '../download/download-manager'
import { DownloadWorker } from '../download/download-worker'
import { systemInspector, systemKiller } from '../download/orphan-guard'
import { createSessionFetch } from '../network/session-proxy'
import type { EngineManager } from '../engines/engine-manager'
import type { SettingsService } from '../settings/settings.service'
import type { SqliteDatabase } from '../storage/database'
import { PlaylistService } from '../playlist/playlist.service'
import { DownloadRepository } from '../storage/download.repository'
import { PlaylistRepository } from '../storage/playlist.repository'
import { ConversionService } from './conversion.service'
import { LinkAnalyzer } from './link-analyzer'
import { MediaInfoService } from './media-info.service'
import { ThumbnailService, passThroughImage } from './thumbnail.service'


/** Wires media analysis and the download manager with their production dependencies. */
export async function createMediaServices(
  paths: AppPaths,
  db: SqliteDatabase,
  engines: EngineManager,
  settings: SettingsService
): Promise<{ links: LinkAnalyzer; downloads: DownloadManager; playlists: PlaylistService; converter: ConversionService }> {
  const fetch = createSessionFetch((url, init) => net.fetch(url, init), (options) => net.request(options))
  // Thumbnails are passed through (signature-checked) and decoded only by the sandboxed renderer.
  const thumbnails = new ThumbnailService(fetch, passThroughImage, scopedLogger('thumbnails'))
  // Every yt-dlp run uses the current connection settings (Settings → Advanced).
  const runtime = async () => {
    const current = settings.get()
    return {
      ...(await engines.waitForRuntime()),
      network: { timeoutSeconds: current.networkTimeoutSeconds, proxy: current.proxy, speedLimitKib: current.speedLimitKib }
    }
  }
  const media = new MediaInfoService({
    runtime,
    acquire: (ids) => engines.acquire(ids),
    run: runProcess,
    thumbnails,
    logger: scopedLogger('media')
  })

  const downloads = new DownloadManager({
    repository: new DownloadRepository(db),
    media,
    engines: { runtime, acquire: (ids) => engines.acquire(ids) },
    settings: () => settings.get(),
    defaultDownloadDir: paths.downloads,
    tempRoot: paths.downloadTemp,
    createWorker: () => new DownloadWorker({ logger: scopedLogger('download') }),
    trash: (path) => shell.trashItem(path),
    orphans: { inspect: systemInspector(), kill: systemKiller() },
    logger: scopedLogger('downloads')
  })
  downloads.initialize()
  // Partial files of paused and failed jobs are kept for resuming; anything else is left over.
  await downloads.cleanTemp()

  const playlists = new PlaylistService({
    runtime,
    acquire: (ids) => engines.acquire(ids),
    run: runProcess,
    thumbnails,
    repository: new PlaylistRepository(db),
    downloads,
    settings: () => settings.get(),
    logger: scopedLogger('playlists')
  })
  const converter = new ConversionService({
    toolchain: () => engines.waitForToolchain(),
    acquire: (ids) => engines.acquire(ids),
    run: runProcess,
    dialogs: { pickFiles: pickMediaFiles, pickFolder: pickOutputFolder },
    settings: () => settings.get(),
    defaultDownloadDir: paths.downloads,
    logger: scopedLogger('converter')
  })
  const links = new LinkAnalyzer(media, playlists, (sourceId) => downloads.previous(sourceId))
  return { links, downloads, playlists, converter }
}

const MEDIA_EXTENSIONS = [
  'mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'oga', 'opus', 'wma', 'aiff', 'aif', 'alac', 'ape', 'wv', 'ac3', 'mka',
  'mp4', 'm4v', 'mkv', 'webm', 'mov', 'avi', 'wmv', 'flv', 'mpg', 'mpeg', 'ts', 'mts', '3gp'
]

async function pickMediaFiles(): Promise<string[]> {
  const options: Electron.OpenDialogOptions = {
    title: 'Choose audio or video files to convert',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Audio and video', extensions: MEDIA_EXTENSIONS },
      { name: 'All files', extensions: ['*'] }
    ]
  }
  const parent = BrowserWindow.getFocusedWindow()
  const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
  return result.canceled ? [] : result.filePaths
}

async function pickOutputFolder(): Promise<string | null> {
  const options: Electron.OpenDialogOptions = {
    title: 'Choose where converted files are saved',
    properties: ['openDirectory', 'createDirectory', 'promptToCreate']
  }
  const parent = BrowserWindow.getFocusedWindow()
  const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
  return result.canceled ? null : (result.filePaths[0] ?? null)
}
