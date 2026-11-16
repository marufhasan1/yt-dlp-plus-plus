import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  OWNER_FILE,
  isSameProcess,
  readOwner,
  stopOrphan,
  systemInspector,
  systemKiller,
  writeOwner
} from '../../electron/services/download/orphan-guard'
import { silentLogger } from '../../electron/utils/logger'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ytdlpp-orphan-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('owner records', () => {
  it('round-trips and rejects anything malformed', async () => {
    writeOwner(dir, { pid: 1234, executable: '/engines/yt-dlp', startedAt: '2026-11-10T05:00:00.000Z' })
    expect(await readOwner(dir)).toEqual({ pid: 1234, executable: '/engines/yt-dlp', startedAt: '2026-11-10T05:00:00.000Z' })
    for (const bad of ['not json', '{"pid":-1,"executable":"/y","startedAt":"2026-11-10T05:00:00Z"}', '{"pid":1.5,"executable":"/y","startedAt":"x"}', '{"pid":12,"executable":"","startedAt":"2026-11-10T05:00:00Z"}', 'null']) {
      writeFileSync(join(dir, OWNER_FILE), bad)
      expect(await readOwner(dir)).toBeNull()
    }
  })

  it('matches only the same executable started at the recorded time', () => {
    const record = { pid: 7, executable: 'C:\\Engines\\yt-dlp.exe', startedAt: '2026-11-10T05:00:00.000Z' }
    const at = (iso: string | null) => (iso ? new Date(iso) : null)
    expect(isSameProcess(record, { executable: 'c:\\engines\\YT-DLP.exe', startedAt: at('2026-11-10T05:00:01.000Z') }, 'win32')).toBe(true)
    expect(isSameProcess(record, { executable: 'C:\\Windows\\notepad.exe', startedAt: at('2026-11-10T05:00:01.000Z') }, 'win32')).toBe(false)
    // A reused PID running the same program, started much later, is someone else's.
    expect(isSameProcess(record, { executable: 'C:\\Engines\\yt-dlp.exe', startedAt: at('2026-11-10T07:00:00.000Z') }, 'win32')).toBe(false)
    expect(isSameProcess(record, { executable: null, startedAt: null }, 'win32')).toBe(false)
    expect(isSameProcess({ ...record, executable: '/opt/yt-dlp' }, { executable: '/opt/YT-DLP', startedAt: null }, 'linux')).toBe(false)
  })

  it('stops a matching process and forgets the record either way', async () => {
    const kill = vi.fn(async () => {})
    writeOwner(dir, { pid: 42, executable: '/engines/yt-dlp', startedAt: new Date().toISOString() })
    expect(await stopOrphan(dir, { inspect: async () => ({ executable: '/engines/yt-dlp', startedAt: new Date() }), kill, logger: silentLogger, platform: 'linux' })).toBe(true)
    expect(kill).toHaveBeenCalledWith(42)
    expect(existsSync(join(dir, OWNER_FILE))).toBe(false)

    writeOwner(dir, { pid: 43, executable: '/engines/yt-dlp', startedAt: new Date().toISOString() })
    expect(await stopOrphan(dir, { inspect: async () => null, kill, logger: silentLogger, platform: 'linux' })).toBe(false)
    expect(kill).toHaveBeenCalledOnce()
    expect(existsSync(join(dir, OWNER_FILE))).toBe(false)
    expect(await stopOrphan(dir, { inspect: async () => null, kill, logger: silentLogger })).toBe(false) // no record
  })
})

describe('with real processes', () => {
  it('identifies a running process and stops it with its children', async () => {
    // A process that starts a child, like yt-dlp's launcher does; detached so it leads a group on Unix.
    const script = "require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); setInterval(() => {}, 1000)"
    const parent = spawn(process.execPath, ['-e', script], { detached: process.platform !== 'win32', stdio: 'ignore', windowsHide: true })
    const startedAt = new Date().toISOString()
    try {
      await new Promise((resolve) => setTimeout(resolve, 500))
      const info = await systemInspector()(parent.pid!)
      expect(info?.executable?.toLowerCase()).toBe(process.execPath.toLowerCase())
      if (process.platform === 'win32') expect(Math.abs(info!.startedAt!.getTime() - Date.parse(startedAt))).toBeLessThan(10_000)

      writeOwner(dir, { pid: parent.pid!, executable: process.execPath, startedAt })
      const exited = new Promise((resolve) => parent.once('exit', resolve))
      expect(await stopOrphan(dir, { inspect: systemInspector(), kill: systemKiller(), logger: silentLogger })).toBe(true)
      await exited
      await vi.waitFor(async () => expect(await systemInspector()(parent.pid!)).toBeNull(), { timeout: 10_000 })
    } finally {
      try {
        process.kill(parent.pid!)
      } catch {
        // already stopped
      }
    }
  }, 60_000)

  it('leaves an unrelated process alone', async () => {
    const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true })
    try {
      await new Promise((resolve) => setTimeout(resolve, 300))
      writeOwner(dir, { pid: other.pid!, executable: join(dir, 'yt-dlp.exe'), startedAt: new Date().toISOString() })
      expect(await stopOrphan(dir, { inspect: systemInspector(), kill: systemKiller(), logger: silentLogger })).toBe(false)
      expect(other.exitCode).toBeNull()
      expect(await systemInspector()(other.pid!)).not.toBeNull()
    } finally {
      other.kill()
    }
  }, 60_000)
})
