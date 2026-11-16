import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTarExtractor, findSystemTar } from '../../electron/utils/archive'
import { sha256File } from '../../electron/utils/checksum'
import { AppError } from '../../electron/utils/errors'
import { runProcess } from '../../electron/utils/process'

/*
 * These tests spawn real processes: Node.js itself stands in for an engine,
 * and the operating system's tar is exercised the same way the installer uses it.
 */

const node = process.execPath
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mediaflow-proc-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('runProcess', () => {
  it('captures output and exit codes', async () => {
    const result = await runProcess(node, ['-e', 'console.log("out"); console.error("err"); process.exit(3)'])
    expect(result).toMatchObject({ exitCode: 3, stdout: 'out\n', stderr: 'err\n', timedOut: false })
  })

  it('passes arguments literally, without shell interpretation', async () => {
    const hostile = ['https://example.com/watch?v=1&list=2', '"; echo injected; "', '$(whoami)', '%PATH%', 'ünïcødé 🎵 file.mp3']
    const result = await runProcess(node, ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))', ...hostile])
    expect(JSON.parse(result.stdout)).toEqual(hostile)
  })

  it('kills a process that exceeds its timeout', async () => {
    const result = await runProcess(node, ['-e', 'setTimeout(() => {}, 60_000)'], { timeoutMs: 300 })
    expect(result.timedOut).toBe(true)
    expect(result.exitCode === null || result.exitCode !== 0).toBe(true)
  })

  it('caps captured output', async () => {
    const result = await runProcess(node, ['-e', 'process.stdout.write("x".repeat(100_000))'], { maxOutputBytes: 1000 })
    expect(result.stdout.length).toBe(1000)
  })

  it('rejects when the program cannot be started', async () => {
    await expect(runProcess(join(dir, 'does-not-exist'), [])).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('stops when aborted', async () => {
    const controller = new AbortController()
    const pending = runProcess(node, ['-e', 'setTimeout(() => {}, 60_000)'], { signal: controller.signal })
    setTimeout(() => controller.abort(), 100)
    await expect(pending).rejects.toBeDefined()
  })
})

describe('tar extraction', () => {
  const tar = findSystemTar()

  it.runIf(tar !== null)('extracts a real archive, including Unicode and spaced names', async () => {
    const source = join(dir, 'source')
    mkdirSync(join(source, 'pkg', 'bin'), { recursive: true })
    writeFileSync(join(source, 'pkg', 'bin', 'ffmpeg tool ü.txt'), 'hello')
    const archive = join(dir, 'archive file.tar.gz')
    const create = await runProcess(tar!, ['-czf', archive, '-C', source, 'pkg'])
    expect(create.exitCode).toBe(0)

    const destination = join(dir, 'out')
    mkdirSync(destination)
    await createTarExtractor(tar)(archive, destination)
    expect(readFileSync(join(destination, 'pkg', 'bin', 'ffmpeg tool ü.txt'), 'utf8')).toBe('hello')
  })

  it.runIf(tar !== null)('reports a corrupt archive', async () => {
    const archive = join(dir, 'broken.tar.gz')
    writeFileSync(archive, 'definitely not an archive')
    const destination = join(dir, 'out')
    mkdirSync(destination)
    await expect(createTarExtractor(tar)(archive, destination)).rejects.toBeInstanceOf(AppError)
  })

  it('reports a missing tar program', async () => {
    await expect(createTarExtractor(null)('a', 'b')).rejects.toMatchObject({ code: 'UNSUPPORTED' })
  })
})

describe('sha256File', () => {
  it('hashes file contents', async () => {
    const file = join(dir, 'f')
    writeFileSync(file, 'abc')
    expect(await sha256File(file)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
})
