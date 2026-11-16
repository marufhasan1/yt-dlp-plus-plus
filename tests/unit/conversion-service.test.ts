import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConversionJob } from '@shared/types/converter'
import { DEFAULT_SETTINGS } from '@shared/validation/settings'
import { ConversionService, type ConversionServiceDeps } from '../../electron/services/media/conversion.service'
import { AppError } from '../../electron/utils/errors'
import { silentLogger } from '../../electron/utils/logger'
import type { RunResult } from '../../electron/utils/process'

/*
 * The converter's queue, verification and clean-up, with FFmpeg replaced by a
 * scripted stand-in. Real FFmpeg runs in tests/integration/conversion.test.ts.
 */

const fixture = (name: string) => readFileSync(join(__dirname, '..', 'fixtures', 'ffmpeg', name), 'utf8')
const inputProbe = fixture('probe-wav-pcm16.json') // 20 s, 44.1 kHz stereo PCM

/** FFprobe output for a converted file. */
function outputProbe(codec: string, duration: number): string {
  return JSON.stringify({ streams: [{ codec_type: 'audio', codec_name: codec, sample_rate: '44100', channels: 2 }], format: { duration: String(duration) } })
}

class FakeFfmpeg extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  constructor(readonly args: readonly string[]) {
    super()
  }
  /** The output path FFmpeg was asked to write. */
  get output(): string {
    return this.args.at(-1)!.replace(/^file:/, '')
  }
  progress(seconds: number, speed: number): void {
    this.stdout.write(`out_time_us=${seconds * 1_000_000}\nspeed=${speed}x\nprogress=continue\n`)
  }
  finish(code: number, stderr = ''): void {
    if (code === 0) writeFileSync(this.output, 'converted audio')
    else if (stderr) this.stderr.write(`${stderr}\n`)
    this.stdout.end()
    this.stderr.end()
    setTimeout(() => this.emit('close', code), 10)
  }
}

let dir: string
let files: string[]
let children: FakeFfmpeg[]
let outputCheck: () => string
let killed: number

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mediaflow-convsvc-'))
  mkdirSync(join(dir, 'music'))
  mkdirSync(join(dir, 'out'))
  files = ['One.wav', 'Two.wav'].map((name) => {
    const path = join(dir, 'music', name)
    writeFileSync(path, 'RIFF fake wav data')
    return path
  })
  children = []
  killed = 0
  outputCheck = () => outputProbe('mp3', 20)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function service(overrides: Partial<ConversionServiceDeps> = {}): ConversionService {
  return new ConversionService({
    toolchain: async () => ({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' }),
    acquire: () => () => {},
    run: async (_file, args): Promise<RunResult> => {
      const target = args.at(-1)!
      const stdout = target.includes('.mediaflow-') ? outputCheck() : inputProbe
      return { exitCode: 0, signal: null, stdout, stderr: '', timedOut: false }
    },
    dialogs: { pickFiles: async () => files, pickFolder: async () => join(dir, 'chosen') },
    settings: () => ({ ...DEFAULT_SETTINGS, downloadDirectory: join(dir, 'out') }),
    defaultDownloadDir: join(dir, 'default'),
    logger: silentLogger,
    spawn: (_file, args) => {
      const child = new FakeFfmpeg(args)
      children.push(child)
      return child as unknown as ChildProcess
    },
    kill: async (child) => {
      killed++
      ;(child as unknown as FakeFfmpeg).finish(255)
    },
    ...overrides
  })
}

const job = (s: ConversionService, id: string): ConversionJob => s.list().find((j) => j.id === id)!
const settle = (s: ConversionService, id: string, status: ConversionJob['status']) =>
  vi.waitFor(() => expect(job(s, id).status).toBe(status), { timeout: 3000 })

describe('ConversionService', () => {
  it('converts one file at a time and reports progress', async () => {
    const s = service()
    const [one, two] = await s.pickFiles()
    const [a, b] = await s.start({ inputs: [one!.token, two!.token], format: 'mp3', quality: '192', destination: { kind: 'downloads' } })

    await vi.waitFor(() => expect(children).toHaveLength(1))
    expect(job(s, a!.id).status).toBe('converting')
    expect(job(s, b!.id).status).toBe('queued')
    expect(children[0]!.output).toBe(join(dir, 'out', `One.mediaflow-${a!.id.slice(0, 8)}.mp3`))

    children[0]!.progress(5, 50)
    await vi.waitFor(() => expect(job(s, a!.id)).toMatchObject({ progress: 25, speed: 50, eta: 0 }))
    children[0]!.finish(0)
    await settle(s, a!.id, 'completed')
    expect(job(s, a!.id)).toMatchObject({ outputPath: join(dir, 'out', 'One.mp3'), outputSizeBytes: 15, progress: 100, qualityLabel: '192 kbps' })

    await vi.waitFor(() => expect(children).toHaveLength(2))
    children[1]!.finish(0)
    await settle(s, b!.id, 'completed')
    expect(readdirSync(join(dir, 'out')).sort()).toEqual(['One.mp3', 'Two.mp3'])
  })

  it('rejects output that fails verification and removes it', async () => {
    outputCheck = () => outputProbe('mp3', 4) // FFmpeg stopped early
    const s = service()
    const [one] = await s.pickFiles()
    const [a] = await s.start({ inputs: [one!.token], format: 'mp3', quality: '192', destination: { kind: 'downloads' } })
    await vi.waitFor(() => expect(children).toHaveLength(1))
    children[0]!.finish(0)
    await settle(s, a!.id, 'failed')
    expect(job(s, a!.id).error).toMatch(/incomplete/)
    expect(readdirSync(join(dir, 'out'))).toEqual([])
  })

  it('explains FFmpeg failures', async () => {
    const s = service()
    const [one] = await s.pickFiles()
    const [a] = await s.start({ inputs: [one!.token], format: 'mp3', quality: '192', destination: { kind: 'downloads' } })
    await vi.waitFor(() => expect(children).toHaveLength(1))
    children[0]!.finish(1, '[out#0/mp3] Error opening output: No space left on device')
    await settle(s, a!.id, 'failed')
    expect(job(s, a!.id).error).toMatch(/disk space/)
  })

  it('cancels running and queued conversions', async () => {
    const s = service()
    const [one, two] = await s.pickFiles()
    const [a, b] = await s.start({ inputs: [one!.token, two!.token], format: 'flac', quality: 'best', destination: { kind: 'downloads' } })
    await vi.waitFor(() => expect(children).toHaveLength(1))
    writeFileSync(children[0]!.output, 'partial')

    await s.cancel(b!.id)
    expect(job(s, b!.id).status).toBe('cancelled')
    await s.cancel(a!.id)
    await settle(s, a!.id, 'cancelled')
    expect(killed).toBe(1)
    expect(children).toHaveLength(1) // the cancelled queued job never started
    expect(readdirSync(join(dir, 'out'))).toEqual([])
    s.remove(a!.id)
    expect(s.list().map((j) => j.id)).toEqual([b!.id])
  })

  it('resolves destinations without trusting the renderer', async () => {
    const s = service()
    const [one] = await s.pickFiles()
    const folder = await s.chooseFolder()
    const [a] = await s.start({ inputs: [one!.token], format: 'mp3', quality: '192', destination: { kind: 'custom', token: folder!.token } })
    await vi.waitFor(() => expect(children).toHaveLength(1))
    expect(children[0]!.output.startsWith(join(dir, 'chosen'))).toBe(true)
    children[0]!.finish(0)
    await settle(s, a!.id, 'completed')

    const [b] = await s.start({ inputs: [one!.token], format: 'mp3', quality: '192', destination: { kind: 'source' } })
    await vi.waitFor(() => expect(children).toHaveLength(2))
    expect(children[1]!.output.startsWith(join(dir, 'music'))).toBe(true)
    children[1]!.finish(0)
    await settle(s, b!.id, 'completed')
    expect(s.location(b!.id)).toBe(join(dir, 'music', 'One.mp3'))

    await expect(s.start({ inputs: [one!.token], format: 'mp3', quality: '192', destination: { kind: 'custom', token: crypto.randomUUID() } })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(s.start({ inputs: [crypto.randomUUID()], format: 'mp3', quality: '192', destination: { kind: 'downloads' } })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(() => s.remove(crypto.randomUUID())).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }))
  })

  it('reports unreadable files and refuses to convert them', async () => {
    files.push(join(dir, 'music', 'missing.mp3'))
    writeFileSync(join(dir, 'music', 'empty.mp3'), '')
    files.push(join(dir, 'music', 'empty.mp3'))
    const s = service()
    const inputs = await s.pickFiles()
    expect(inputs.map((i) => [i.name, i.error])).toEqual([
      ['One.wav', null],
      ['Two.wav', null],
      ['missing.mp3', 'This file could not be read as audio or video.'],
      ['empty.mp3', 'This file is empty.']
    ])
    await expect(s.start({ inputs: [inputs[3]!.token], format: 'mp3', quality: '192', destination: { kind: 'downloads' } })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
  })

  it('checks for FFmpeg before showing the file dialog', async () => {
    const pickFiles = vi.fn(async () => files)
    const s = service({
      toolchain: async () => {
        throw new AppError('ENGINE_MISSING', 'FFmpeg is not installed or not working.')
      },
      dialogs: { pickFiles, pickFolder: async () => null }
    })
    await expect(s.pickFiles()).rejects.toMatchObject({ code: 'ENGINE_MISSING' })
    expect(pickFiles).not.toHaveBeenCalled()
  })

  it('stops everything on shutdown', async () => {
    const s = service()
    const [one, two] = await s.pickFiles()
    await s.start({ inputs: [one!.token, two!.token], format: 'mp3', quality: '192', destination: { kind: 'downloads' } })
    await vi.waitFor(() => expect(children).toHaveLength(1))
    expect(s.hasActiveJobs()).toBe(true)
    await s.shutdown()
    expect(killed).toBe(1)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(children).toHaveLength(1)
  })
})
