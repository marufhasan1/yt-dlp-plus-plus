import { mkdir } from 'node:fs/promises'
import { shell } from 'electron'
import { z } from 'zod'
import { IPC_INVOKE } from '@shared/constants/ipc-channels'
import { installRequestSchema, refreshRequestSchema } from '@shared/validation/engines'
import type { EngineManager } from '../services/engines/engine-manager'
import { AppError } from '../utils/errors'
import type { IpcRegistrar } from './ipc-registrar'

export function registerEnginesIpc(ipc: IpcRegistrar, engines: EngineManager): void {
  ipc.handle(IPC_INVOKE.enginesGetStatus, z.undefined(), () => engines.snapshot())
  ipc.handle(IPC_INVOKE.enginesRefresh, refreshRequestSchema, ({ deep }) => engines.refresh(deep))
  ipc.handle(IPC_INVOKE.enginesInstall, installRequestSchema, ({ target }) => engines.installTarget(target))
  ipc.handle(IPC_INVOKE.enginesCancelInstall, z.undefined(), () => engines.cancelInstall())

  ipc.handle(IPC_INVOKE.enginesOpenFolder, z.undefined(), async () => {
    const folder = engines.snapshot().enginesDir
    await mkdir(folder, { recursive: true })
    const failure = await shell.openPath(folder)
    if (failure) {
      throw new AppError('OPERATION_FAILED', 'The engines folder could not be opened.', { cause: failure })
    }
  })
}
