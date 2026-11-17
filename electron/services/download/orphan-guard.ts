import { writeFileSync } from 'node:fs'
import { readFile, readlink, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { Logger } from '../../utils/logger'
import { runProcess, type ProcessRunner } from '../../utils/process'

/*
 * yt-dlp outlives a crashed YT-DLP++: on Windows nothing ends a child when its
 * parent dies, and on Unix it runs in its own process group. Observed with the
 * real app: after a hard kill, yt-dlp kept downloading into the job's partial
 * files. Resuming that job would then start a second yt-dlp writing the same
 * files. So each running download records which process owns its scratch
 * folder, and at the next start any still-running owner is stopped first.
 */

export const OWNER_FILE = '.ytdlpp-owner.json'

export interface OwnerRecord {
  pid: number
  /** The yt-dlp executable that was started. */
  executable: string
  /** When it was started (ISO 8601). */
  startedAt: string
}

/** What the OS reports about a running process, or null when no such process runs. */
export interface ProcessInfo {
  executable: string | null
  startedAt: Date | null
}

export type ProcessInspector = (pid: number) => Promise<ProcessInfo | null>
export type GroupKiller = (pid: number) => Promise<void>

/** Written synchronously right after spawning, so it cannot race the run's own clean-up. */
export function writeOwner(dir: string, record: OwnerRecord): void {
  writeFileSync(join(dir, OWNER_FILE), JSON.stringify(record), 'utf8')
}

export async function clearOwner(dir: string): Promise<void> {
  await rm(join(dir, OWNER_FILE), { force: true })
}

export async function readOwner(dir: string): Promise<OwnerRecord | null> {
  try {
    const value: unknown = JSON.parse(await readFile(join(dir, OWNER_FILE), 'utf8'))
    if (typeof value !== 'object' || value === null) return null
    const { pid, executable, startedAt } = value as Record<string, unknown>
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0 || pid > 4_294_967_295) return null
    if (typeof executable !== 'string' || executable.length === 0) return null
    if (typeof startedAt !== 'string' || Number.isNaN(Date.parse(startedAt))) return null
    return { pid, executable, startedAt }
  } catch {
    return null
  }
}

/** Process start times are compared loosely: the record is written right after spawning. */
const START_TOLERANCE_MS = 60_000

/**
 * True only when the recorded process is still running the same executable and,
 * where the OS reports it, was started at the recorded time. A reused PID
 * belonging to anything else is never touched.
 */
export function isSameProcess(record: OwnerRecord, info: ProcessInfo, platform: NodeJS.Platform): boolean {
  if (!info.executable) return false
  const normalise = (p: string) => (platform === 'win32' || platform === 'darwin' ? p.toLowerCase() : p)
  if (normalise(info.executable) !== normalise(record.executable)) return false
  if (info.startedAt && Math.abs(info.startedAt.getTime() - Date.parse(record.startedAt)) > START_TOLERANCE_MS) return false
  return true
}

/**
 * Stops the process recorded as owning `dir`, if it is still running, then
 * removes the record. Returns whether a process was stopped.
 */
export async function stopOrphan(
  dir: string,
  deps: { inspect: ProcessInspector; kill: GroupKiller; logger: Logger; platform?: NodeJS.Platform }
): Promise<boolean> {
  const record = await readOwner(dir)
  if (!record) return false
  let stopped = false
  try {
    const info = await deps.inspect(record.pid)
    if (info && isSameProcess(record, info, deps.platform ?? process.platform)) {
      deps.logger.warn(`yt-dlp (pid ${record.pid}) from an earlier session was still running; stopping it`)
      await deps.kill(record.pid)
      stopped = true
    }
  } catch (error) {
    deps.logger.warn(`Could not check process ${record.pid} from an earlier session`, error)
  }
  await clearOwner(dir)
  return stopped
}

// ─── Platform implementations ────────────────────────────────────────────────

/** Reads a process's executable path and start time from the OS. */
export function systemInspector(platform: NodeJS.Platform = process.platform, run: ProcessRunner = runProcess): ProcessInspector {
  return async (pid) => {
    if (!Number.isInteger(pid) || pid <= 0) return null
    if (platform === 'win32') {
      const powershell = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      // pid is a validated integer; nothing else is interpolated.
      const script =
        `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; ` +
        `if ($p) { $p.ExecutablePath; $p.CreationDate.ToUniversalTime().ToString('o') }`
      const result = await run(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], { timeoutMs: 15_000 })
      const [executable, started] = result.stdout.split(/\r?\n/).map((line) => line.trim())
      if (result.exitCode !== 0 || !executable) return null
      const startedAt = started ? new Date(started) : null
      return { executable, startedAt: startedAt && !Number.isNaN(startedAt.getTime()) ? startedAt : null }
    }
    if (platform === 'linux') {
      try {
        return { executable: (await readlink(`/proc/${pid}/exe`)).replace(/ \(deleted\)$/, ''), startedAt: null }
      } catch {
        return null
      }
    }
    // macOS and other Unix systems: `comm` is the executable path.
    const result = await run('/bin/ps', ['-p', String(pid), '-o', 'comm='], { timeoutMs: 10_000 })
    const executable = result.stdout.trim()
    return result.exitCode === 0 && executable ? { executable, startedAt: null } : null
  }
}

/** Ends a process and its children (Windows) or its process group (Unix, where downloads run detached). */
export function systemKiller(platform: NodeJS.Platform = process.platform, run: ProcessRunner = runProcess): GroupKiller {
  return async (pid) => {
    if (platform === 'win32') {
      const taskkill = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'taskkill.exe')
      await run(taskkill, ['/PID', String(pid), '/T', '/F'], { timeoutMs: 15_000 })
      return
    }
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      // Already gone.
    }
  }
}
