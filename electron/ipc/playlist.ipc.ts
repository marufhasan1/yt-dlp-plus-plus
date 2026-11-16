import { z } from 'zod'
import { IPC_INVOKE } from '@shared/constants/ipc-channels'
import { playlistDownloadRequestSchema, playlistIdSchema, playlistThumbnailSchema } from '@shared/validation/media'
import type { PlaylistService } from '../services/playlist/playlist.service'
import type { IpcRegistrar } from './ipc-registrar'

export function registerPlaylistIpc(ipc: IpcRegistrar, playlists: PlaylistService): void {
  ipc.handle(IPC_INVOKE.playlistsList, z.undefined(), () => playlists.list())
  ipc.handle(IPC_INVOKE.playlistsGet, playlistIdSchema, ({ id }) => playlists.get(id))
  ipc.handle(IPC_INVOKE.playlistsRefresh, playlistIdSchema, ({ id }) => playlists.refresh(id))
  ipc.handle(IPC_INVOKE.playlistsRemove, playlistIdSchema, ({ id }) => playlists.remove(id))
  ipc.handle(IPC_INVOKE.playlistsDownload, playlistDownloadRequestSchema, (request) => playlists.download(request))
  // The renderer names an entry; the URL fetched is the one stored at analysis time.
  ipc.handle(IPC_INVOKE.playlistsThumbnail, playlistThumbnailSchema, ({ id, position }) => playlists.thumbnail(id, position))
}
