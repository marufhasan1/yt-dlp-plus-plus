import type { EngineProblem } from '@shared/types/engines'
import type { ProcessRunner } from '../../utils/process'

export interface EngineVersion {
  /** Display version, e.g. "2026.10.26" or "9.0.2". */
  version: string
  /** Full build string reported by the binary. */
  build: string
}

export type ProbeResult = { ok: true; version: EngineVersion; problems: EngineProblem[] } | { ok: false; problem: EngineProblem }

/** Encoders needed for the audio formats YT-DLP++ offers (MP3, M4A, WAV, FLAC, OPUS). */
export const REQUIRED_ENCODERS = ['libmp3lame', 'aac', 'pcm_s16le', 'flac', 'libopus'] as const
/** Muxers needed to write MP4, WebM, MKV and the audio containers. */
export const REQUIRED_MUXERS = ['mp4', 'webm', 'matroska', 'ipod', 'mp3', 'wav', 'flac', 'opus'] as const

/** yt-dlp prints e.g. "2026.10.26" (stable) or "2026.10.26.232912" (nightly). */
export function parseYtDlpVersion(output: string): EngineVersion | null {
  const line = output.trim().split(/\r?\n/)[0]?.trim() ?? ''
  if (!/^\d{4}\.\d{2}\.\d{2}(\.\d+)?$/.test(line)) return null
  return { version: line, build: line }
}

/** Deno prints e.g. "deno 2.9.8 (stable, release, x86_64-pc-windows-msvc)" followed by v8/typescript lines. */
export function parseDenoVersion(output: string): EngineVersion | null {
  const match = /^deno (\d+\.\d+\.\d+\S*)/m.exec(output)
  return match?.[1] ? { version: match[1], build: match[1] } : null
}

/**
 * Parses the first line of `ffmpeg -version` / `ffprobe -version`, e.g.
 *   "ffmpeg version n9.0-12-g1a2b3c4-20261101 Copyright …"  (BtbN release branch)
 *   "ffmpeg version 9.0.2 Copyright …"                      (tagged release)
 *   "ffmpeg version 7.1.1-essentials_build-www.gyan.dev …"
 *   "ffmpeg version N-121456-g1234abcd-20261101 …"          (git master)
 */
export function parseFfmpegVersion(output: string, tool: 'ffmpeg' | 'ffprobe'): EngineVersion | null {
  const match = new RegExp(`^${tool} version (\\S+)`, 'm').exec(output)
  const build = match?.[1]
  if (!build) return null
  const release = /^n?(\d+\.\d+(?:\.\d+)?)/.exec(build)
  return { version: release?.[1] ?? build, build }
}

/**
 * Extracts component names from `ffmpeg -encoders` or `ffmpeg -muxers` output.
 * Both print a legend, a dashed separator line, then "<flags> <name> <description>"
 * rows. The flags column is never blank ("A....D" for encoders; "E", "DE" or "Ed"
 * for muxers), so the name is always the second token.
 */
export function parseFfmpegComponentList(output: string): Set<string> {
  const names = new Set<string>()
  const lines = output.split(/\r?\n/)
  const separator = lines.findIndex((line) => /^\s*-{2,}\s*$/.test(line))
  if (separator === -1) return names
  for (const line of lines.slice(separator + 1)) {
    const name = line.trim().split(/\s+/)[1]
    if (name) {
      for (const part of name.split(',')) names.add(part)
    }
  }
  return names
}

export class EngineProber {
  constructor(private readonly run: ProcessRunner) {}

  async probeYtDlp(path: string): Promise<ProbeResult> {
    // Single-file builds unpack themselves on first run, which can be slow (and slower under antivirus scanning).
    const result = await this.runVersion(path, ['--version'], 90_000)
    if (!result.ok) return result
    const version = parseYtDlpVersion(result.stdout)
    if (!version) return failure('VERSION_FAILED', 'yt-dlp did not report a recognisable version.')
    return { ok: true, version, problems: [] }
  }

  async probeDeno(path: string): Promise<ProbeResult> {
    const result = await this.runVersion(path, ['--version'], 30_000)
    if (!result.ok) return result
    const version = parseDenoVersion(result.stdout)
    if (!version) return failure('VERSION_FAILED', 'Deno did not report a recognisable version.')
    return { ok: true, version, problems: [] }
  }

  async probeFfprobe(path: string): Promise<ProbeResult> {
    const result = await this.runVersion(path, ['-hide_banner', '-version'], 30_000)
    if (!result.ok) return result
    const version = parseFfmpegVersion(result.stdout, 'ffprobe')
    if (!version) return failure('VERSION_FAILED', 'FFprobe did not report a recognisable version.')
    return { ok: true, version, problems: [] }
  }

  /** Also checks that the encoders and muxers YT-DLP++ relies on are present. */
  async probeFfmpeg(path: string): Promise<ProbeResult> {
    const result = await this.runVersion(path, ['-hide_banner', '-version'], 30_000)
    if (!result.ok) return result
    const version = parseFfmpegVersion(result.stdout, 'ffmpeg')
    if (!version) return failure('VERSION_FAILED', 'FFmpeg did not report a recognisable version.')

    const problems: EngineProblem[] = []
    const [encoders, muxers] = await Promise.all([
      this.listComponents(path, '-encoders'),
      this.listComponents(path, '-muxers')
    ])
    const missing = [
      ...REQUIRED_ENCODERS.filter((name) => !encoders.has(name)).map((name) => `${name} encoder`),
      ...REQUIRED_MUXERS.filter((name) => !muxers.has(name)).map((name) => `${name} muxer`)
    ]
    if (missing.length > 0) {
      problems.push({
        code: 'MISSING_CAPABILITIES',
        message: `This FFmpeg build lacks: ${missing.join(', ')}. Some formats will be unavailable.`
      })
    }
    return { ok: true, version, problems }
  }

  private async listComponents(path: string, flag: '-encoders' | '-muxers'): Promise<Set<string>> {
    try {
      const result = await this.run(path, ['-hide_banner', flag], { timeoutMs: 30_000 })
      return result.exitCode === 0 ? parseFfmpegComponentList(result.stdout) : new Set()
    } catch {
      return new Set()
    }
  }

  private async runVersion(
    path: string,
    args: string[],
    timeoutMs: number
  ): Promise<{ ok: true; stdout: string } | { ok: false; problem: EngineProblem }> {
    try {
      const result = await this.run(path, args, { timeoutMs })
      if (result.timedOut) return failure('VERSION_FAILED', 'The program did not respond in time.')
      if (result.exitCode !== 0) {
        return failure('VERSION_FAILED', `The program exited with code ${result.exitCode ?? result.signal}.`)
      }
      return { ok: true, stdout: result.stdout }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EACCES' || code === 'EPERM') return failure('NOT_EXECUTABLE', 'The program is not allowed to run.')
      return failure('VERSION_FAILED', 'The program could not be started.')
    }
  }
}

function failure(code: EngineProblem['code'], message: string): { ok: false; problem: EngineProblem } {
  return { ok: false, problem: { code, message } }
}
