import type { EngineSource, InstallTarget } from '@shared/types/engines'
import type { YtDlpChannel } from '@shared/types/updates'
import type { TrustedHttpClient } from '../network/trusted-http'
import { latestDeno } from '../engines/deno-engine'
import type { ManifestEntry } from '../engines/engine-manifest'
import { parseRiedlDownloadUrl, type FfmpegProvider } from '../engines/ffmpeg-engine'
import type { PlatformTarget } from '../engines/platform'
import { YTDLP_PROVIDER_IDS, latestYtDlpRelease } from '../engines/ytdlp-engine'
import { compareFfmpegBuilds, compareVersions, parseFfmpegBuild, versionParts } from './versions'

/** The newest version a provider offers for this platform. */
export interface EngineCandidate {
  version: string
  /** Provider build identifier; equals `version` where the provider has no separate builds. */
  build: string
  releasedAt: string | null
  notesUrl: string | null
  channel: YtDlpChannel | null
}

export type EngineChecker = (channel: YtDlpChannel, signal?: AbortSignal) => Promise<EngineCandidate>

/** Update lookups per install target. They read release metadata only; nothing is downloaded or run. */
export function engineCheckers(http: TrustedHttpClient, target: PlatformTarget, ffmpeg: FfmpegProvider | null): Partial<Record<InstallTarget, EngineChecker>> {
  return {
    'yt-dlp': async (channel, signal) => {
      const { release } = await latestYtDlpRelease(http, target, channel, signal)
      return { version: release.tag_name, build: release.tag_name, releasedAt: release.published_at ?? null, notesUrl: release.html_url ?? null, channel }
    },
    ...(ffmpeg
      ? {
          ffmpeg: async (_channel: YtDlpChannel, signal?: AbortSignal) => {
            const latest = await ffmpeg.latest(http, signal)
            return { ...latest, channel: null }
          }
        }
      : {}),
    deno: async (_channel, signal) => {
      const latest = await latestDeno(http, target, signal)
      return { version: latest.version, build: latest.version, releasedAt: latest.releasedAt, notesUrl: latest.notesUrl, channel: null }
    }
  }
}

/** What is installed now, as far as update decisions need it. */
export interface InstalledEngineInfo {
  version: string | null
  /** Full build string reported by the binary (FFmpeg: "n9.0.2-48-gd4070a14ce-20261109"). */
  build: string | null
  source: EngineSource | null
  /** Install record, for copies YT-DLP++ manages. */
  record: ManifestEntry | null
}

/** The yt-dlp channel an installed copy came from. Nightly versions carry a time part (2026.11.04.232659). */
export function installedYtDlpChannel(installed: InstalledEngineInfo): YtDlpChannel {
  if (installed.record?.provider === YTDLP_PROVIDER_IDS.nightly) return 'nightly'
  if (installed.record?.provider === YTDLP_PROVIDER_IDS.stable) return 'stable'
  return (versionParts(installed.version ?? '')?.length ?? 0) >= 4 ? 'nightly' : 'stable'
}

export interface UpdateDecision {
  available: boolean
  /** yt-dlp: the update moves to another channel (from nightly back to stable may be an older version). */
  channelSwitch: boolean
}

/**
 * Whether `candidate` should be offered over what is installed. Never offers
 * an older version, except when the user switched the yt-dlp channel.
 */
export function evaluateEngineUpdate(target: InstallTarget, installed: InstalledEngineInfo, candidate: EngineCandidate): UpdateDecision {
  const none = { available: false, channelSwitch: false }
  if (!installed.version) return none

  if (target === 'yt-dlp') {
    const order = compareVersions(candidate.version, installed.version)
    const switching = candidate.channel !== null && installedYtDlpChannel(installed) !== candidate.channel
    if (order > 0) return { available: true, channelSwitch: switching }
    if (switching && order !== 0) return { available: true, channelSwitch: true }
    return none
  }

  if (target === 'ffmpeg') {
    // Martin Riedl's builds: the build id starts with its build time.
    if (installed.record?.provider === 'martin-riedl') {
      const ours = parseRiedlDownloadUrl(installed.record.sourceUrl.split(' ')[0] ?? '')
      const theirs = /^(\d+)_/.exec(candidate.build)
      const order = compareVersions(candidate.version, installed.version)
      if (order !== 0) return { available: order > 0, channelSwitch: false }
      return { available: Boolean(ours && theirs && Number(theirs[1]) > ours.builtAt), channelSwitch: false }
    }
    // BtbN release-branch builds: same version, more commits = newer build.
    const ours = installed.build ? parseFfmpegBuild(installed.build) : null
    const theirs = parseFfmpegBuild(candidate.build)
    if (ours && theirs) return { available: compareFfmpegBuilds(theirs, ours) > 0, channelSwitch: false }
    return { available: compareVersions(candidate.version, installed.version) > 0, channelSwitch: false }
  }

  return { available: compareVersions(candidate.version, installed.version) > 0, channelSwitch: false }
}
