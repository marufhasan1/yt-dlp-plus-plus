import { stat } from 'node:fs/promises'
import { shell } from 'electron'
import { z } from 'zod'
import { IPC_INVOKE } from '@shared/constants/ipc-channels'
import { conversionIdSchema, conversionRequestSchema } from '@shared/validation/converter'
import type { ConversionService } from '../services/media/conversion.service'
import { AppError } from '../utils/errors'
import type { IpcRegistrar } from './ipc-registrar'

export function registerConverterIpc(ipc: IpcRegistrar, converter: ConversionService): void {
  ipc.handle(IPC_INVOKE.converterPickFiles, z.undefined(), () => converter.pickFiles())
  ipc.handle(IPC_INVOKE.converterChooseFolder, z.undefined(), () => converter.chooseFolder())
  ipc.handle(IPC_INVOKE.converterStart, conversionRequestSchema, (request) => converter.start(request))
  ipc.handle(IPC_INVOKE.converterList, z.undefined(), () => converter.list())
  ipc.handle(IPC_INVOKE.converterCancel, conversionIdSchema, ({ id }) => converter.cancel(id))
  ipc.handle(IPC_INVOKE.converterRemove, conversionIdSchema, ({ id }) => converter.remove(id))

  // The renderer names a job; the location is the one the converter recorded.
  ipc.handle(IPC_INVOKE.converterShowInFolder, conversionIdSchema, async ({ id }) => {
    const location = converter.location(id)
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
  })
}
