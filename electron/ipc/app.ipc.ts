import { mkdir } from 'node:fs/promises'
import { app, clipboard, shell } from 'electron'
import { z } from 'zod'
import { mediaUrlSchema } from '@shared/validation/media'
import { IPC_INVOKE } from '@shared/constants/ipc-channels'
import type { AppInfo } from '@shared/types/app'
import { AppError } from '../utils/errors'
import type { AppPaths } from '../utils/paths'
import type { IpcRegistrar } from './ipc-registrar'

const MAX_CLIPBOARD_CHARS = 4096

export function registerAppIpc(ipc: IpcRegistrar, paths: AppPaths): void {
  ipc.handle(IPC_INVOKE.appGetInfo, z.undefined(), (): AppInfo => ({
    name: app.getName(),
    version: app.getVersion(),
    isPackaged: app.isPackaged,
    platform: process.platform,
    arch: process.arch,
    versions: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node
    },
    paths: {
      userData: paths.userData,
      logs: paths.logs,
      engines: paths.engines,
      downloads: paths.downloads
    }
  }))

  // Read on demand in the main process; the renderer is never granted clipboard permission.
  // Only a media link is handed over (that is all Paste is for), so the clipboard cannot be
  // used to read passwords or codes the user copied elsewhere.
  ipc.handle(IPC_INVOKE.appReadClipboard, z.undefined(), async () => {
    const text = (await clipboard.readText()).trim().slice(0, MAX_CLIPBOARD_CHARS)
    return mediaUrlSchema.safeParse(text).success ? text : ''
  })

  ipc.handle(IPC_INVOKE.appOpenLogsFolder, z.undefined(), async () => {
    await mkdir(paths.logs, { recursive: true })
    const failure = await shell.openPath(paths.logs)
    if (failure) {
      throw new AppError('OPERATION_FAILED', 'The logs folder could not be opened.', { cause: failure })
    }
  })
}
