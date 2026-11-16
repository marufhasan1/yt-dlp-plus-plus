import type { PreviousDownload } from '@shared/types/downloads'
import type { AnalyzeResult } from '@shared/types/media'
import type { PlaylistService } from '../playlist/playlist.service'
import { PlaylistDetected, type MediaInfoService } from './media-info.service'

/**
 * Sends a pasted link to the right service: single videos to MediaInfoService,
 * playlists and channels to PlaylistService. Links yt-dlp only recognises as
 * playlists after fetching them (non-YouTube sites) are re-routed.
 */
export class LinkAnalyzer {
  constructor(
    private readonly media: MediaInfoService,
    private readonly playlists: PlaylistService,
    /** Earlier downloads of a video, for the "already downloaded" notice. */
    private readonly previous: (sourceId: string) => Promise<PreviousDownload[]> = async () => []
  ) {}

  async analyze(url: string): Promise<AnalyzeResult> {
    try {
      const media = await this.media.analyze(url)
      return { kind: 'media', media, previousDownloads: await this.previous(media.sourceId) }
    } catch (error) {
      if (error instanceof PlaylistDetected) {
        return { kind: 'playlist', playlist: await this.playlists.analyze(url) }
      }
      throw error
    }
  }

  cancel(): void {
    this.media.cancel()
    this.playlists.cancel()
  }
}
