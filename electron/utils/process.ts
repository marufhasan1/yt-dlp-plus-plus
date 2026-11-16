import { spawn } from 'node:child_process'
import { killProcessTree } from './process-tree'

export interface RunOptions {
  /** Kill the process if it has not exited after this long. */
  timeoutMs?: number
  signal?: AbortSignal
  /** Output beyond this many bytes per stream is discarded. */
  maxOutputBytes?: number
  cwd?: string
  /** Extra environment variables, added to the inherited environment. */
  env?: Record<string, string>
  /** On timeout or abort, stop the whole process tree (for programs that start helpers). */
  killTree?: boolean
}

export interface RunResult {
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  timedOut: boolean
}

/** Runs an executable to completion. Pluggable so callers can be tested without real binaries. */
export type ProcessRunner = (file: string, args: readonly string[], options?: RunOptions) => Promise<RunResult>

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_OUTPUT = 1024 * 1024

/**
 * Spawns `file` directly — never through a shell — with each argument passed
 * as a separate element, so URLs and file names cannot be interpreted as
 * shell syntax. Rejects only if the process cannot be started (e.g. ENOENT,
 * EACCES); a non-zero exit code is reported in the result.
 */
export const runProcess: ProcessRunner = (file, args, options = {}) => {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal, maxOutputBytes = DEFAULT_MAX_OUTPUT, cwd, env, killTree = false } = options

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('Aborted'))
      return
    }

    const child = spawn(file, [...args], {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      shell: false,
      windowsHide: true,
      // A process group lets killProcessTree reach the helpers on Unix.
      detached: killTree && process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    })

    const stdout = new OutputBuffer(maxOutputBytes)
    const stderr = new OutputBuffer(maxOutputBytes)
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))

    const stop = (): void => {
      if (killTree) void killProcessTree(child)
      else child.kill()
    }
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      stop()
    }, timeoutMs)
    const onAbort = (): void => {
      stop()
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    const cleanup = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }

    child.once('error', (error) => {
      cleanup()
      reject(error)
    })
    child.once('close', (exitCode, exitSignal) => {
      cleanup()
      if (signal?.aborted) {
        reject(signal.reason ?? new Error('Aborted'))
        return
      }
      resolve({
        exitCode,
        signal: exitSignal,
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        timedOut
      })
    })
  })
}

class OutputBuffer {
  private readonly chunks: Buffer[] = []
  private size = 0

  constructor(private readonly limit: number) {}

  push(chunk: Buffer): void {
    if (this.size >= this.limit) return
    const remaining = this.limit - this.size
    const kept = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk
    this.chunks.push(kept)
    this.size += kept.length
  }

  toString(): string {
    return Buffer.concat(this.chunks).toString('utf8')
  }
}
