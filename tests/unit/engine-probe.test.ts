import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  EngineProber,
  REQUIRED_ENCODERS,
  REQUIRED_MUXERS,
  parseFfmpegComponentList,
  parseFfmpegVersion,
  parseYtDlpVersion
} from '../../electron/services/engines/engine-probe'
import type { ProcessRunner, RunResult } from '../../electron/utils/process'

const fixture = (name: string): string => readFileSync(join(__dirname, '..', 'fixtures', 'engines', name), 'utf8')

const ok = (stdout: string): RunResult => ({ exitCode: 0, signal: null, stdout, stderr: '', timedOut: false })

describe('version parsing (real engine output)', () => {
  it('parses yt-dlp stable and nightly versions', () => {
    expect(parseYtDlpVersion(fixture('ytdlp-version.txt'))).toEqual({ version: '2026.10.26', build: '2026.10.26' })
    expect(parseYtDlpVersion('2026.10.26.232912\n')?.version).toBe('2026.10.26.232912')
    expect(parseYtDlpVersion('Usage: yt-dlp [OPTIONS] URL')).toBeNull()
  })

  it('parses a BtbN release-branch build', () => {
    expect(parseFfmpegVersion(fixture('ffmpeg-9-btbn-version.txt'), 'ffmpeg')).toEqual({
      version: '9.0.2',
      build: 'n9.0.2-42-gd7643a0fe3-20261101'
    })
    expect(parseFfmpegVersion(fixture('ffprobe-9-btbn-version.txt'), 'ffprobe')?.version).toBe('9.0.2')
  })

  it('parses a Gyan (WinGet) build', () => {
    expect(parseFfmpegVersion(fixture('ffmpeg-8-gyan-version.txt'), 'ffmpeg')).toEqual({
      version: '8.0',
      build: '8.0-full_build-www.gyan.dev'
    })
  })

  it('keeps git master builds as their raw build string', () => {
    expect(parseFfmpegVersion('ffmpeg version N-121456-g1234abcd-20261101 Copyright', 'ffmpeg')).toEqual({
      version: 'N-121456-g1234abcd-20261101',
      build: 'N-121456-g1234abcd-20261101'
    })
  })

  it('does not accept the other tool’s output', () => {
    expect(parseFfmpegVersion(fixture('ffmpeg-9-btbn-version.txt'), 'ffprobe')).toBeNull()
  })
})

describe('parseFfmpegComponentList (real engine output)', () => {
  it('finds every required encoder', () => {
    const encoders = parseFfmpegComponentList(fixture('ffmpeg-9-encoders.txt'))
    for (const name of REQUIRED_ENCODERS) expect(encoders).toContain(name)
    expect(encoders.size).toBeGreaterThan(50)
    // Legend rows above the separator are not components.
    expect(encoders).not.toContain('=')
  })

  it('finds every required muxer', () => {
    const muxers = parseFfmpegComponentList(fixture('ffmpeg-9-muxers.txt'))
    for (const name of REQUIRED_MUXERS) expect(muxers).toContain(name)
    expect(muxers).not.toContain('Demuxing')
  })

  it('returns nothing for unexpected output', () => {
    expect(parseFfmpegComponentList('Unrecognized option')).toEqual(new Set())
  })
})

describe('EngineProber', () => {
  function runnerFor(outputs: Record<string, RunResult | Error>): ProcessRunner {
    return vi.fn(async (_file: string, args: readonly string[]) => {
      const key = args.filter((a) => a !== '-hide_banner').join(' ')
      const output = outputs[key]
      if (!output) throw new Error(`unexpected args ${key}`)
      if (output instanceof Error) throw output
      return output
    })
  }

  it('reports a working yt-dlp', async () => {
    const prober = new EngineProber(runnerFor({ '--version': ok('2026.10.26\n') }))
    expect(await prober.probeYtDlp('/engines/yt-dlp')).toEqual({
      ok: true,
      version: { version: '2026.10.26', build: '2026.10.26' },
      problems: []
    })
  })

  it('reports a fully capable FFmpeg', async () => {
    const prober = new EngineProber(
      runnerFor({
        '-version': ok(fixture('ffmpeg-9-btbn-version.txt')),
        '-encoders': ok(fixture('ffmpeg-9-encoders.txt')),
        '-muxers': ok(fixture('ffmpeg-9-muxers.txt'))
      })
    )
    const result = await prober.probeFfmpeg('/engines/ffmpeg')
    expect(result).toMatchObject({ ok: true, problems: [] })
  })

  it('flags an FFmpeg build that lacks required encoders', async () => {
    const encoders = fixture('ffmpeg-9-encoders.txt')
      .split('\n')
      .filter((line) => !/ (libmp3lame|libopus) /.test(line))
      .join('\n')
    const prober = new EngineProber(
      runnerFor({
        '-version': ok(fixture('ffmpeg-9-btbn-version.txt')),
        '-encoders': ok(encoders),
        '-muxers': ok(fixture('ffmpeg-9-muxers.txt'))
      })
    )
    const result = await prober.probeFfmpeg('/engines/ffmpeg')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.problems).toHaveLength(1)
    expect(result.problems[0]?.code).toBe('MISSING_CAPABILITIES')
    expect(result.problems[0]?.message).toContain('libmp3lame encoder')
    expect(result.problems[0]?.message).toContain('libopus encoder')
  })

  it.each([
    ['a non-zero exit', { exitCode: 1, signal: null, stdout: '', stderr: 'boom', timedOut: false }, 'VERSION_FAILED'],
    ['a timeout', { exitCode: null, signal: 'SIGTERM' as const, stdout: '', stderr: '', timedOut: true }, 'VERSION_FAILED'],
    ['unrecognised output', ok('something else'), 'VERSION_FAILED'],
    ['a missing file', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }), 'VERSION_FAILED'],
    ['a permission error', Object.assign(new Error('spawn EACCES'), { code: 'EACCES' }), 'NOT_EXECUTABLE']
  ])('reports %s as a problem', async (_label, output, code) => {
    const prober = new EngineProber(runnerFor({ '--version': output }))
    expect(await prober.probeYtDlp('/engines/yt-dlp')).toMatchObject({ ok: false, problem: { code } })
  })
})
