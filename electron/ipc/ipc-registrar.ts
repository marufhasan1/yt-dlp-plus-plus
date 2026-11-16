import type { IpcMain, IpcMainInvokeEvent, WebFrameMain } from 'electron'
import type { z } from 'zod'
import type { IpcInvokeContract, IpcResult } from '@shared/types/ipc'
import { formatZodError, toIpcError } from '../utils/errors'
import type { Logger } from '../utils/logger'

type Channel = keyof IpcInvokeContract
type RequestOf<C extends Channel> = IpcInvokeContract[C]['request']
type ResponseOf<C extends Channel> = IpcInvokeContract[C]['response']

export type InvokeHandler<C extends Channel> = (
  input: RequestOf<C>,
  event: IpcMainInvokeEvent
) => ResponseOf<C> | Promise<ResponseOf<C>>

export interface IpcRegistrarDeps {
  ipcMain: Pick<IpcMain, 'handle' | 'removeHandler'>
  isTrustedSender(frame: WebFrameMain | null): boolean
  logger: Logger
}

export interface IpcRegistrar {
  /**
   * Registers a handler that only runs for trusted senders and schema-valid input.
   * The handler's result or error is always returned as an IpcResult envelope.
   */
  handle<C extends Channel>(channel: C, schema: z.ZodType<RequestOf<C>>, handler: InvokeHandler<C>): void
  dispose(): void
}

export function createIpcRegistrar({ ipcMain, isTrustedSender, logger }: IpcRegistrarDeps): IpcRegistrar {
  const registered = new Set<string>()

  return {
    handle(channel, schema, handler) {
      if (registered.has(channel)) {
        throw new Error(`IPC handler already registered for "${channel}"`)
      }
      registered.add(channel)

      ipcMain.handle(channel, async (event, ...args: unknown[]): Promise<IpcResult<ResponseOf<typeof channel>>> => {
        if (!isTrustedSender(event.senderFrame)) {
          logger.warn(`Rejected IPC "${channel}" from untrusted sender ${event.senderFrame?.url ?? '<unknown>'}`)
          return { ok: false, error: { code: 'FORBIDDEN', message: 'This request is not allowed.' } }
        }
        if (args.length > 1) {
          return { ok: false, error: { code: 'VALIDATION_FAILED', message: 'Invalid request: too many arguments' } }
        }

        const parsed = schema.safeParse(args[0])
        if (!parsed.success) {
          logger.warn(`Rejected IPC "${channel}" with invalid input: ${formatZodError(parsed.error)}`)
          return {
            ok: false,
            error: { code: 'VALIDATION_FAILED', message: `Invalid request: ${formatZodError(parsed.error)}` }
          }
        }

        try {
          return { ok: true, data: await handler(parsed.data, event) }
        } catch (error) {
          logger.error(`IPC "${channel}" failed`, error)
          return { ok: false, error: toIpcError(error) }
        }
      })
    },

    dispose() {
      for (const channel of registered) {
        ipcMain.removeHandler(channel)
      }
      registered.clear()
    }
  }
}
