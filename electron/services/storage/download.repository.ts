import type { Statement } from 'better-sqlite3'
import type { DownloadErrorCode, DownloadJob, DownloadStatus, HistoryQuery } from '@shared/types/downloads'
import type { FilenameTemplateId } from '@shared/validation/settings'
import type { DownloadPlan } from '../media/format-selection'
import type { SqliteDatabase } from './database'

/** What is needed to run (or re-run) a job, stored as JSON next to it. */
export interface StoredPlan {
  plan: DownloadPlan
  destination: string
  filenameTemplate: FilenameTemplateId
  skipExisting: boolean
  /** Playlist position prefix such as "003 - ", added before the file name template. */
  filenamePrefix?: string
}

interface Row {
  id: string
  url: string
  title: string
  thumbnail: string | null
  media_type: DownloadJob['mediaType']
  output_format: string
  quality: string | null
  output_path: string
  status: DownloadStatus
  progress: number
  downloaded_bytes: number
  total_bytes: number | null
  created_at: string
  completed_at: string | null
  error_message: string | null
  error_code: DownloadErrorCode | null
  plan_json: string | null
  playlist_id: string | null
  playlist_position: number | null
  playlist_title: string | null
  source_id: string | null
  interrupted: number
  dismissed_at: string | null
}

/** Statuses of a job that was queued or running. */
const RUNNING_STATUSES: readonly DownloadStatus[] = ['queued', 'analyzing', 'downloading', 'processing']
/** Statuses shown on the History page; active and paused jobs live on the Downloads page. */
const FINISHED_STATUSES: readonly DownloadStatus[] = ['completed', 'failed', 'cancelled']
const quoted = (statuses: readonly DownloadStatus[]) => statuses.map((s) => `'${s}'`).join(', ')

export interface StoredJob {
  job: DownloadJob
  stored: StoredPlan | null
  /** Hidden from the Downloads list (kept for history). */
  dismissed: boolean
}

export class DownloadRepository {
  private readonly insertStmt: Statement
  private readonly updateStmt: Statement
  private readonly listStmt: Statement<[number], Row>
  private readonly getStmt: Statement<[string], Row>
  private readonly dismissStmt: Statement<[string, string]>
  private readonly undismissStmt: Statement<[string]>
  private readonly deleteStmt: Statement<[string]>
  private readonly thumbnailStmt: Statement<[string, string]>
  private readonly pauseInterruptedStmt: Statement<[string]>
  private readonly failUnplannedStmt: Statement<[string, string]>
  private readonly previousStmt: Statement<[string, number], Row>
  private readonly formatsStmt: Statement<[], { output_format: string }>

  constructor(private readonly db: SqliteDatabase) {
    this.insertStmt = db.prepare(`
      INSERT INTO downloads (id, url, title, thumbnail, media_type, output_format, quality, output_path, status,
                             progress, downloaded_bytes, total_bytes, created_at, plan_json, source_id, updated_at,
                             playlist_id, playlist_position, playlist_title, interrupted)
      VALUES (@id, @url, @title, @thumbnail, @mediaType, @outputFormat, @quality, @outputPath, @status,
              @progress, @downloadedBytes, @totalBytes, @createdAt, @planJson, @sourceId, @createdAt,
              @playlistId, @playlistPosition, @playlistTitle, @interrupted)
    `)
    this.updateStmt = db.prepare(`
      UPDATE downloads SET status = @status, progress = @progress, downloaded_bytes = @downloadedBytes,
             total_bytes = @totalBytes, output_path = @outputPath, completed_at = @completedAt,
             error_message = @error, error_code = @errorCode, interrupted = @interrupted, updated_at = @updatedAt
      WHERE id = @id
    `)
    this.listStmt = db.prepare('SELECT * FROM downloads WHERE dismissed_at IS NULL ORDER BY created_at DESC LIMIT ?')
    this.getStmt = db.prepare('SELECT * FROM downloads WHERE id = ?')
    this.dismissStmt = db.prepare('UPDATE downloads SET dismissed_at = ? WHERE id = ?')
    this.undismissStmt = db.prepare('UPDATE downloads SET dismissed_at = NULL WHERE id = ?')
    this.deleteStmt = db.prepare('DELETE FROM downloads WHERE id = ?')
    this.thumbnailStmt = db.prepare('UPDATE downloads SET thumbnail = ? WHERE id = ?')
    // Jobs cut off by a shutdown or crash become paused (their partial files are kept) ...
    this.pauseInterruptedStmt = db.prepare(`
      UPDATE downloads SET status = 'paused', interrupted = 1, updated_at = ?
      WHERE status IN (${quoted(RUNNING_STATUSES)}) AND plan_json IS NOT NULL
    `)
    // ... unless there is no stored plan to resume them with.
    this.failUnplannedStmt = db.prepare(`
      UPDATE downloads SET status = 'failed', error_code = 'INTERRUPTED', error_message = ?, updated_at = ?
      WHERE status IN (${quoted([...RUNNING_STATUSES, 'paused'])}) AND plan_json IS NULL
    `)
    this.previousStmt = db.prepare('SELECT * FROM downloads WHERE source_id = ? ORDER BY created_at DESC LIMIT ?')
    this.formatsStmt = db.prepare(
      `SELECT DISTINCT output_format FROM downloads WHERE status IN (${quoted(FINISHED_STATUSES)}) ORDER BY output_format`
    )
  }

  insert(job: DownloadJob, stored: StoredPlan, sourceId: string | null): void {
    this.insertStmt.run({
      ...job,
      progress: clampProgress(job.progress),
      planJson: JSON.stringify(stored),
      sourceId,
      interrupted: job.interrupted ? 1 : 0
    })
  }

  update(job: DownloadJob, now: Date = new Date()): void {
    this.updateStmt.run({
      id: job.id,
      status: job.status,
      progress: clampProgress(job.progress),
      downloadedBytes: Math.max(0, Math.round(job.downloadedBytes)),
      totalBytes: job.totalBytes === null ? null : Math.max(0, Math.round(job.totalBytes)),
      outputPath: job.outputPath,
      completedAt: job.completedAt,
      error: job.error,
      errorCode: job.errorCode,
      interrupted: job.interrupted ? 1 : 0,
      updatedAt: now.toISOString()
    })
  }

  /** Persists several job states in one transaction (used at shutdown). */
  updateMany(jobs: readonly DownloadJob[], now: Date = new Date()): void {
    this.db.transaction(() => {
      for (const job of jobs) this.update(job, now)
    })()
  }

  /** Jobs shown in the Downloads list, newest first. */
  list(limit = 500): DownloadJob[] {
    return this.listStmt.all(limit).map(toJob)
  }

  get(id: string): StoredJob | null {
    const row = this.getStmt.get(id)
    if (!row) return null
    let stored: StoredPlan | null = null
    try {
      stored = row.plan_json ? (JSON.parse(row.plan_json) as StoredPlan) : null
    } catch {
      stored = null
    }
    return { job: toJob(row), stored, dismissed: row.dismissed_at !== null }
  }

  setThumbnail(id: string, thumbnail: string): void {
    this.thumbnailStmt.run(thumbnail, id)
  }

  /** Hides a job from the Downloads list. The row is kept for history. */
  dismiss(id: string, now: Date = new Date()): void {
    this.dismissStmt.run(now.toISOString(), id)
  }

  /** Shows a job in the Downloads list again (e.g. when it is retried from History). */
  undismiss(id: string): void {
    this.undismissStmt.run(id)
  }

  /** Deletes the history record. Files on disk are the caller's concern. */
  delete(id: string): boolean {
    return this.deleteStmt.run(id).changes > 0
  }

  /**
   * Startup recovery. Jobs that were queued or running when the app last closed
   * become paused and flagged as interrupted; returns how many.
   */
  recoverInterrupted(message: string, now: Date = new Date()): number {
    const at = now.toISOString()
    return this.db.transaction(() => {
      this.failUnplannedStmt.run(message, at)
      return this.pauseInterruptedStmt.run(at).changes
    })()
  }

  /** Earlier downloads of the same media, newest first. */
  previous(sourceId: string, limit = 5): DownloadJob[] {
    return this.previousStmt.all(sourceId, limit).map(toJob)
  }

  /** Completed downloads of these media in this output format: source id → saved file. */
  completedFiles(sourceIds: readonly string[], outputFormat: string): Map<string, string[]> {
    const result = new Map<string, string[]>()
    for (let i = 0; i < sourceIds.length; i += 500) {
      const chunk = sourceIds.slice(i, i + 500)
      const rows = this.db
        .prepare<unknown[], { source_id: string; output_path: string }>(
          `SELECT source_id, output_path FROM downloads
           WHERE status = 'completed' AND output_format = ? AND source_id IN (${chunk.map(() => '?').join(', ')})`
        )
        .all(outputFormat, ...chunk)
      for (const row of rows) result.set(row.source_id, [...(result.get(row.source_id) ?? []), row.output_path])
    }
    return result
  }

  /** One page of finished downloads matching the query, newest first. */
  history(query: HistoryQuery): { items: { job: DownloadJob; dismissed: boolean }[]; total: number } {
    const where = [`status IN (${quoted(query.status ? [query.status] : FINISHED_STATUSES)})`]
    const params: (string | number)[] = []
    if (query.search) {
      const pattern = `%${query.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
      where.push("(title LIKE ? ESCAPE '\\' OR url LIKE ? ESCAPE '\\')")
      params.push(pattern, pattern)
    }
    if (query.format) {
      where.push('output_format = ?')
      params.push(query.format)
    }
    if (query.from) {
      where.push('created_at >= ?')
      params.push(query.from)
    }
    if (query.to) {
      where.push('created_at < ?')
      params.push(query.to)
    }
    const clause = where.join(' AND ')
    const total = this.db.prepare<unknown[], { n: number }>(`SELECT COUNT(*) AS n FROM downloads WHERE ${clause}`).get(...params)?.n ?? 0
    const rows = this.db
      .prepare<unknown[], Row>(`SELECT * FROM downloads WHERE ${clause} ORDER BY created_at DESC, id LIMIT ? OFFSET ?`)
      .all(...params, query.limit, query.offset)
    return { items: rows.map((row) => ({ job: toJob(row), dismissed: row.dismissed_at !== null })), total }
  }

  /** Output formats present in the history. */
  formats(): string[] {
    return this.formatsStmt.all().map((row) => row.output_format)
  }
}

function clampProgress(progress: number): number {
  return Math.min(100, Math.max(0, Number.isFinite(progress) ? progress : 0))
}

function toJob(row: Row): DownloadJob {
  return {
    id: row.id,
    url: row.url,
    title: row.title,
    thumbnail: row.thumbnail,
    mediaType: row.media_type,
    outputFormat: row.output_format,
    quality: row.quality,
    outputPath: row.output_path,
    status: row.status,
    progress: row.progress,
    speed: 0,
    eta: 0,
    downloadedBytes: row.downloaded_bytes,
    totalBytes: row.total_bytes,
    stage: null,
    error: row.error_message,
    errorCode: row.error_code,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    playlistId: row.playlist_id,
    playlistPosition: row.playlist_position,
    playlistTitle: row.playlist_title,
    sourceId: row.source_id,
    interrupted: row.interrupted === 1
  }
}
