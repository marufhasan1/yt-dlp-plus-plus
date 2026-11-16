import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { DownloadErrorCode } from '@shared/types/downloads'
import type { Logger } from '../../utils/logger'
import { killProcessTree } from '../../utils/process-tree'
import type { PlannedStream } from '../media/format-selection'
import { YTDLP_ENV } from '../media/ytdlp-command'
import { classifyYtDlpError } from '../media/ytdlp-errors'
import { ProgressAggregator, parseProgressLine, type AggregateProgress } from './download-progress'

export class DownloadFailure extends Error {
  constructor(
    readonly code: DownloadErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'DownloadFailure'
  }
}

export class DownloadCancelled extends Error {
  constructor() {
    super('Cancelled')
    this.name = 'DownloadCancelled'
  }
}

export type SpawnFn = (file: string, args: readonly string[]) => ChildProcess
export type KillFn = (child: ChildProcess) => Promise<void>

export interface WorkerDeps {
  spawn?: SpawnFn
  kill?: KillFn
  logger: Logger
}

/** Lines of stderr kept for error classification. */
const STDERR_TAIL = 200

const defaultSpawn: SpawnFn = (file, args) =>
  spawn(file, [...args], {
    env: { ...process.env, ...YTDLP_ENV },
    shell: false,
    windowsHide: true,
    // Own process group on Unix, so cancelling also stops FFmpeg and Deno.
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe']
  })

/**
 * Runs one yt-dlp download process and turns its template output into
 * progress updates. Resolves with the final file path (when yt-dlp reports
 * one), rejects with DownloadFailure or DownloadCancelled.
 */
export class DownloadWorker {
  private child: ChildProcess | null = null
  private cancelled = false
  private readonly spawn: SpawnFn
  private readonly kill: KillFn

  constructor(private readonly deps: WorkerDeps) {
    this.spawn = deps.spawn ?? defaultSpawn
    this.kill = deps.kill ?? ((child) => killProcessTree(child))
  }

  run(
    file: string,
    args: readonly string[],
    streams: readonly PlannedStream[],
    onUpdate: (progress: AggregateProgress) => void,
    /** Called once the process is running, with its PID. */
    onSpawn?: (pid: number) => void
  ): Promise<{ outputPath: string | null }> {
    if (this.cancelled) return Promise.reject(new DownloadCancelled())
    const aggregator = new ProgressAggregator(streams)
    const stderrTail: string[] = []
    let outputPath: string | null = null

    return new Promise((resolve, reject) => {
      let child: ChildProcess
      try {
        child = this.spawn(file, args)
      } catch (error) {
        this.deps.logger.error('yt-dlp could not be started', error)
        reject(new DownloadFailure('ENGINE_MISSING', 'yt-dlp could not be started. Check Software Updates.'))
        return
      }
      this.child = child
      if (child.pid !== undefined) onSpawn?.(child.pid)

      const handle = (line: string, fromStderr: boolean): void => {
        const event = parseProgressLine(line)
        if (event?.type === 'file') {
          // Only yt-dlp's --print output (stdout) names the final file; stderr carries messages
          // that may include text from the site, which must never be taken for a path.
          if (!fromStderr) outputPath = event.path
        } else if (event) {
          onUpdate(aggregator.apply(event))
        } else if (fromStderr && line.trim()) {
          stderrTail.push(line)
          if (stderrTail.length > STDERR_TAIL) stderrTail.shift()
          if (line.startsWith('WARNING:')) this.deps.logger.debug(line)
        }
      }
      if (child.stdout) createInterface({ input: child.stdout }).on('line', (line) => handle(line, false))
      if (child.stderr) createInterface({ input: child.stderr }).on('line', (line) => handle(line, true))

      child.once('error', (error) => {
        this.deps.logger.error('yt-dlp process error', error)
        reject(new DownloadFailure('ENGINE_MISSING', 'yt-dlp could not be started. Check Software Updates.'))
      })
      child.once('close', (code) => {
        this.child = null
        if (this.cancelled) {
          reject(new DownloadCancelled())
        } else if (code === 0) {
          resolve({ outputPath })
        } else {
          const classified = classifyYtDlpError(stderrTail.join('\n'))
          this.deps.logger.warn(`yt-dlp exited with ${code}: ${classified.code}`, stderrTail.slice(-5).join(' | '))
          reject(new DownloadFailure(classified.code, classified.message))
        }
      })
    })
  }

  /** Stops yt-dlp and every process it started. */
  async cancel(): Promise<void> {
    this.cancelled = true
    if (this.child) await this.kill(this.child)
  }
}
