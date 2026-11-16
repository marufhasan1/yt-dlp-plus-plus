import { shell } from 'electron'
import { z } from 'zod'
import { IPC_INVOKE } from '@shared/constants/ipc-channels'
import { installRequestSchema, updateCheckRequestSchema, updateComponentRequestSchema } from '@shared/validation/engines'
import type { UpdateService } from '../services/updates/update.service'
import { AppError } from '../utils/errors'
import type { IpcRegistrar } from './ipc-registrar'

/** Hosts whose release pages may be opened in the browser. */
const RELEASE_NOTE_HOSTS = new Set(['github.com', 'ffmpeg.martin-riedl.de'])

export function registerUpdateIpc(ipc: IpcRegistrar, updates: UpdateService): void {
  ipc.handle(IPC_INVOKE.updatesGetStatus, z.undefined(), () => updates.snapshot())
  ipc.handle(IPC_INVOKE.updatesCheck, updateCheckRequestSchema, ({ component }) =>
    component === 'all' ? updates.checkAll('manual') : updates.check(component)
  )
  ipc.handle(IPC_INVOKE.updatesUpdateEngine, installRequestSchema, ({ target }) => updates.updateEngine(target))
  ipc.handle(IPC_INVOKE.updatesCancelWaiting, installRequestSchema, ({ target }) => updates.cancelWaiting(target))
  ipc.handle(IPC_INVOKE.updatesRollback, installRequestSchema, ({ target }) => updates.rollback(target))
  ipc.handle(IPC_INVOKE.updatesDownloadApp, z.undefined(), () => updates.downloadApp())
  ipc.handle(IPC_INVOKE.updatesCancelAppDownload, z.undefined(), () => updates.cancelAppDownload())
  ipc.handle(IPC_INVOKE.updatesInstallApp, z.undefined(), () => updates.installApp())
  ipc.handle(IPC_INVOKE.updatesHistory, z.undefined(), () => updates.history())

  // The renderer names a component; the link is the one the update check recorded.
  ipc.handle(IPC_INVOKE.updatesOpenReleaseNotes, updateComponentRequestSchema, async ({ component }) => {
    const link = updates.snapshot().components[component].notesUrl
    let url: URL | null = null
    try {
      url = link ? new URL(link) : null
    } catch {
      url = null
    }
    if (!url || url.protocol !== 'https:' || !RELEASE_NOTE_HOSTS.has(url.hostname)) {
      throw new AppError('NOT_FOUND', 'No release notes page is known for this component.')
    }
    await shell.openExternal(url.toString())
  })
}
