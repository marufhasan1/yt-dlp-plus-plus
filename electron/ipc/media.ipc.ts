import { z } from 'zod'
import { IPC_INVOKE } from '@shared/constants/ipc-channels'
import { analyzeRequestSchema } from '@shared/validation/media'
import type { LinkAnalyzer } from '../services/media/link-analyzer'
import type { IpcRegistrar } from './ipc-registrar'

export function registerMediaIpc(ipc: IpcRegistrar, links: LinkAnalyzer): void {
  ipc.handle(IPC_INVOKE.mediaAnalyze, analyzeRequestSchema, ({ url }) => links.analyze(url))
  ipc.handle(IPC_INVOKE.mediaCancelAnalyze, z.undefined(), () => links.cancel())
}
