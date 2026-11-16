import { randomUUID } from 'node:crypto'
import type { Statement } from 'better-sqlite3'
import type { PlaylistDetails, PlaylistEntry, PlaylistEntryStatus, PlaylistSummary } from '@shared/types/playlists'
import type { SqliteDatabase } from './database'

/** One entry as read from yt-dlp, before it has any download state. */
export interface PlaylistEntryInput {
  position: number
  videoId: string
  url: string
  title: string
  durationSeconds: number | null
  uploader: string | null
  thumbnailUrl: string | null
  unavailableReason: string | null
}

export interface PlaylistInput {
  sourceId: string
  url: string
  title: string
  uploader: string | null
  thumbnail: string | null
  truncated: boolean
  entries: PlaylistEntryInput[]
}

interface SummaryRow {
  id: string
  source_id: string
  playlist_url: string
  title: string
  uploader: string | null
  thumbnail: string | null
  total_items: number
  unavailable_items: number
  truncated: number
  created_at: string
  updated_at: string | null
}

interface ItemRow {
  position: number
  video_id: string
  video_url: string
  title: string | null
  duration_seconds: number | null
  uploader: string | null
  thumbnail_url: string | null
  unavailable_reason: string | null
  status: PlaylistEntryStatus
  download_id: string | null
}

const SUMMARY_SELECT = `
  SELECT p.id, p.source_id, p.playlist_url, p.title, p.uploader, p.thumbnail, p.total_items, p.truncated,
         p.created_at, p.updated_at,
         (SELECT COUNT(*) FROM playlist_items i WHERE i.playlist_id = p.id AND i.status = 'unavailable') AS unavailable_items
  FROM playlists p`

export class PlaylistRepository {
  private readonly findBySource: Statement<[string], { id: string }>
  private readonly insertPlaylist: Statement
  private readonly updatePlaylist: Statement
  private readonly existingItems: Statement<[string], { video_id: string; download_id: string | null; status: PlaylistEntryStatus }>
  private readonly deleteItems: Statement<[string]>
  private readonly insertItem: Statement
  private readonly listStmt: Statement<[], SummaryRow>
  private readonly getStmt: Statement<[string], SummaryRow>
  private readonly itemsStmt: Statement<[string], ItemRow>
  private readonly itemStmt: Statement<[string, number], ItemRow>
  private readonly removeStmt: Statement<[string]>
  private readonly linkStmt: Statement<[string, PlaylistEntryStatus, string, number]>
  private readonly statusByDownload: Statement<[PlaylistEntryStatus, string]>

  constructor(private readonly db: SqliteDatabase) {
    this.findBySource = db.prepare('SELECT id FROM playlists WHERE source_id = ?')
    this.insertPlaylist = db.prepare(`
      INSERT INTO playlists (id, source_id, playlist_url, title, thumbnail, uploader, total_items, truncated, created_at, updated_at)
      VALUES (@id, @sourceId, @url, @title, @thumbnail, @uploader, @totalItems, @truncated, @now, @now)
    `)
    this.updatePlaylist = db.prepare(`
      UPDATE playlists SET playlist_url = @url, title = @title, thumbnail = COALESCE(@thumbnail, thumbnail), uploader = @uploader,
             total_items = @totalItems, truncated = @truncated, updated_at = @now
      WHERE id = @id
    `)
    this.existingItems = db.prepare('SELECT video_id, download_id, status FROM playlist_items WHERE playlist_id = ?')
    this.deleteItems = db.prepare('DELETE FROM playlist_items WHERE playlist_id = ?')
    this.insertItem = db.prepare(`
      INSERT INTO playlist_items (id, playlist_id, download_id, video_url, title, position, status, video_id,
                                  duration_seconds, uploader, thumbnail_url, unavailable_reason)
      VALUES (@id, @playlistId, @downloadId, @url, @title, @position, @status, @videoId,
              @durationSeconds, @uploader, @thumbnailUrl, @unavailableReason)
    `)
    this.listStmt = db.prepare(`${SUMMARY_SELECT} ORDER BY COALESCE(p.updated_at, p.created_at) DESC`)
    this.getStmt = db.prepare(`${SUMMARY_SELECT} WHERE p.id = ?`)
    this.itemsStmt = db.prepare(`
      SELECT position, video_id, video_url, title, duration_seconds, uploader, thumbnail_url, unavailable_reason, status, download_id
      FROM playlist_items WHERE playlist_id = ? ORDER BY position
    `)
    this.itemStmt = db.prepare(`
      SELECT position, video_id, video_url, title, duration_seconds, uploader, thumbnail_url, unavailable_reason, status, download_id
      FROM playlist_items WHERE playlist_id = ? AND position = ?
    `)
    this.removeStmt = db.prepare('DELETE FROM playlists WHERE id = ?')
    this.linkStmt = db.prepare('UPDATE playlist_items SET download_id = ?, status = ? WHERE playlist_id = ? AND position = ?')
    this.statusByDownload = db.prepare(
      "UPDATE playlist_items SET status = ? WHERE download_id = ? AND status <> 'unavailable'"
    )
  }

  /**
   * Saves a freshly analysed playlist. Analysing the same playlist again
   * refreshes it in place, keeping each video's download link and status.
   */
  save(input: PlaylistInput, now: Date = new Date()): string {
    return this.db.transaction(() => {
      const existing = this.findBySource.get(input.sourceId)
      const id = existing?.id ?? randomUUID()
      const params = {
        id,
        sourceId: input.sourceId,
        url: input.url,
        title: input.title,
        thumbnail: input.thumbnail,
        uploader: input.uploader,
        totalItems: input.entries.length,
        truncated: input.truncated ? 1 : 0,
        now: now.toISOString()
      }
      if (existing) this.updatePlaylist.run(params)
      else this.insertPlaylist.run(params)

      const previous = new Map(this.existingItems.all(id).map((row) => [row.video_id, row]))
      this.deleteItems.run(id)
      for (const entry of input.entries) {
        const before = previous.get(entry.videoId)
        const status: PlaylistEntryStatus = entry.unavailableReason ? 'unavailable' : (before && before.status !== 'unavailable' ? before.status : 'pending')
        this.insertItem.run({
          id: randomUUID(),
          playlistId: id,
          downloadId: before?.download_id ?? null,
          ...entry,
          status
        })
      }
      return id
    })()
  }

  list(): PlaylistSummary[] {
    return this.listStmt.all().map(toSummary)
  }

  get(id: string): PlaylistDetails | null {
    const row = this.getStmt.get(id)
    if (!row) return null
    return { ...toSummary(row), entries: this.itemsStmt.all(id).map(toEntry) }
  }

  /** An entry plus its remote thumbnail URL (kept out of the renderer-facing model). */
  entry(id: string, position: number): (PlaylistEntry & { thumbnailUrl: string | null }) | null {
    const row = this.itemStmt.get(id, position)
    return row ? { ...toEntry(row), thumbnailUrl: row.thumbnail_url } : null
  }

  /** Removes the playlist and its entries. Download jobs and files are kept. */
  remove(id: string): void {
    this.removeStmt.run(id)
  }

  linkDownload(playlistId: string, position: number, downloadId: string, status: PlaylistEntryStatus): void {
    this.linkStmt.run(downloadId, status, playlistId, position)
  }

  /** Mirrors a download job's status onto the playlist entry it belongs to. */
  setStatusForDownload(downloadId: string, status: PlaylistEntryStatus): void {
    this.statusByDownload.run(status, downloadId)
  }
}

function toSummary(row: SummaryRow): PlaylistSummary {
  return {
    id: row.id,
    sourceId: row.source_id,
    url: row.playlist_url,
    title: row.title,
    uploader: row.uploader,
    thumbnail: row.thumbnail,
    totalItems: row.total_items,
    unavailableItems: row.unavailable_items,
    truncated: row.truncated === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? row.created_at
  }
}

function toEntry(row: ItemRow): PlaylistEntry {
  return {
    position: row.position,
    videoId: row.video_id,
    url: row.video_url,
    title: row.title ?? row.video_id,
    durationSeconds: row.duration_seconds,
    uploader: row.uploader,
    available: row.unavailable_reason === null,
    unavailableReason: row.unavailable_reason,
    status: row.status,
    downloadId: row.download_id
  }
}
