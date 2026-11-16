import { join } from 'node:path'
import { app, net } from 'electron'
import { createSessionFetch } from '../network/session-proxy'
import { createArchiveExtractor, findSystemTar } from '../../utils/archive'
import { scopedLogger } from '../../utils/logger'
import type { AppPaths } from '../../utils/paths'
import { runProcess } from '../../utils/process'
import { TrustedHttpClient } from '../network/trusted-http'
import type { SqliteDatabase } from '../storage/database'
import { EngineVersionsRepository } from '../storage/engine-versions.repository'
import { UpdateHistoryRepository } from '../storage/update-history.repository'
import { DENO_PROVIDER, denoAssetName } from './deno-engine'
import { EngineInstaller } from './engine-installer'
import { systemSearchDirs } from './engine-locator'
import { EngineManager } from './engine-manager'
import { EngineManifestStore } from './engine-manifest'
import { EngineProber } from './engine-probe'
import { ENGINE_DOWNLOAD_HOSTS, ffmpegProviderFor } from './ffmpeg-engine'
import { detectPlatform } from './platform'
import { YTDLP_PROVIDER, ytDlpAssetName, type YtDlpChannel } from './ytdlp-engine'
import { engineCheckers, type EngineChecker } from '../updates/engine-update-check'
import type { InstallTarget } from '@shared/types/engines'

/** Wires the engine services with their production dependencies. */
export function createEngineManager(
  paths: AppPaths,
  db: SqliteDatabase,
  ytdlpChannel: () => YtDlpChannel
): { manager: EngineManager; checkers: Partial<Record<InstallTarget, EngineChecker>> } {
  const target = detectPlatform()
  const logger = scopedLogger('engines')
  const managed = join(paths.engines, target.key)
  // Optional engines shipped inside the package: resources/engines/<platform>/<arch>.
  const resourcesRoot = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources')
  const bundled = join(resourcesRoot, 'engines', target.platform, target.arch)

  const http = new TrustedHttpClient({
    // Electron's network stack: the configured or system proxy, and the system certificate store.
    fetch: createSessionFetch((url, init) => net.fetch(url, init), (options) => net.request(options)),
    allowedHosts: ENGINE_DOWNLOAD_HOSTS,
    userAgent: `${app.getName()}/${app.getVersion()} (+engine-installer)`
  })
  const prober = new EngineProber(runProcess)
  const manifest = new EngineManifestStore(managed)
  const ffmpegProvider = ffmpegProviderFor(target)

  const installer = new EngineInstaller({
    http,
    target,
    engineDir: managed,
    stagingRoot: join(paths.engines, '.staging'),
    prober,
    manifest,
    ffmpegProvider,
    extract: createArchiveExtractor(findSystemTar(target.platform)),
    logger
  })

  logger.info(`Platform ${target.key}${target.libc ? ` (${target.libc})` : ''}; managed engines in ${managed}`)

  const manager = new EngineManager({
    target,
    locations: { managed, bundled, system: systemSearchDirs(process.env['PATH'], target.platform) },
    prober,
    installer,
    manifest,
    versions: new EngineVersionsRepository(db),
    history: new UpdateHistoryRepository(db),
    providers: {
      'yt-dlp': ytDlpAssetName(target) ? YTDLP_PROVIDER : null,
      ffmpeg: ffmpegProvider?.info ?? null,
      deno: denoAssetName(target) ? DENO_PROVIDER : null
    },
    logger,
    ytdlpChannel
  })
  return { manager, checkers: engineCheckers(http, target, ffmpegProvider) }
}
