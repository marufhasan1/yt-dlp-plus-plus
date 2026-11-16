import { stat } from 'node:fs/promises'
import { shell } from 'electron'
import { z } from 'zod'
import { IPC_INVOKE } from '@shared/constants/ipc-channels'
import { historyDeleteSchema, historyQuerySchema } from '@shared/validation/downloads'
import { downloadRequestSchema, jobIdSchema } from '@shared/validation/media'
import type { DownloadManager } from '../services/download/download-manager'
import { AppError } from '../utils/errors'
import type { IpcRegistrar } from './ipc-registrar'

export function registerDownloadIpc(ipc: IpcRegistrar, downloads: DownloadManager): void {
  ipc.handle(IPC_INVOKE.downloadsList, z.undefined(), () => downloads.list())
  ipc.handle(IPC_INVOKE.downloadsStart, downloadRequestSchema, (request) => downloads.start(request))
  ipc.handle(IPC_INVOKE.downloadsCancel, jobIdSchema, ({ id }) => downloads.cancel(id))
  ipc.handle(IPC_INVOKE.downloadsRetry, jobIdSchema, ({ id }) => downloads.retry(id))
  ipc.handle(IPC_INVOKE.downloadsRemove, jobIdSchema, ({ id }) => downloads.remove(id))
  ipc.handle(IPC_INVOKE.downloadsPause, jobIdSchema, ({ id }) => downloads.pause(id))
  ipc.handle(IPC_INVOKE.downloadsResume, jobIdSchema, ({ id }) => downloads.resume(id))
  ipc.handle(IPC_INVOKE.downloadsPauseAll, z.undefined(), () => downloads.pauseAll())
  ipc.handle(IPC_INVOKE.downloadsResumeAll, z.undefined(), () => downloads.resumeAll())
  // The renderer names a job, never a path: only locations the manager recorded can be revealed.
  ipc.handle(IPC_INVOKE.downloadsShowInFolder, jobIdSchema, ({ id }) => reveal(downloads.location(id)))

  ipc.handle(IPC_INVOKE.historyList, historyQuerySchema, (query) => downloads.history(query))
  ipc.handle(IPC_INVOKE.historyDelete, historyDeleteSchema, ({ id, deleteFile }) => downloads.deleteRecord(id, deleteFile))
  ipc.handle(IPC_INVOKE.historyRetry, jobIdSchema, ({ id }) => downloads.retry(id))
  ipc.handle(IPC_INVOKE.historyShowInFolder, jobIdSchema, ({ id }) => reveal(downloads.location(id)))
}

/** Selects a file in the system file manager, or opens a folder. */
async function reveal(location: string): Promise<void> {
  let info
  try {
    info = await stat(location)
  } catch {
    throw new AppError('NOT_FOUND', 'The file is no longer there. It may have been moved or deleted.')
  }
  if (info.isDirectory()) {
    const failure = await shell.openPath(location)
    if (failure) throw new AppError('OPERATION_FAILED', 'The folder could not be opened.', { cause: failure })
  } else {
    shell.showItemInFolder(location)
  }
}
