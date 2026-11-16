import type { IpcMainInvokeEvent, WebFrameMain } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { IPC_INVOKE } from '@shared/constants/ipc-channels'
import type { AppSettings } from '@shared/types/settings'
import { DEFAULT_SETTINGS, settingsPatchSchema } from '@shared/validation/settings'
import { createIpcRegistrar } from '../../electron/ipc/ipc-registrar'
import { AppError } from '../../electron/utils/errors'
import { silentLogger } from '../../electron/utils/logger'

type Listener = (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>

function setup(trusted = true) {
  const listeners = new Map<string, Listener>()
  const ipcMain = {
    handle: vi.fn((channel: string, listener: Listener) => {
      listeners.set(channel, listener)
    }),
    removeHandler: vi.fn((channel: string) => {
      listeners.delete(channel)
    })
  }
  const frame = { url: 'file:///app/index.html', parent: null } as unknown as WebFrameMain
  const registrar = createIpcRegistrar({ ipcMain, isTrustedSender: () => trusted, logger: silentLogger })
  const call = (channel: string, ...args: unknown[]) => {
    const listener = listeners.get(channel)
    if (!listener) throw new Error(`no handler for ${channel}`)
    return listener({ senderFrame: frame } as IpcMainInvokeEvent, ...args)
  }
  return { registrar, ipcMain, listeners, call }
}

describe('createIpcRegistrar', () => {
  it('passes validated input to the handler and wraps the result', async () => {
    const { registrar, call } = setup()
    const handler = vi.fn((patch: Partial<AppSettings>) => ({ ...DEFAULT_SETTINGS, ...patch }))
    registrar.handle(IPC_INVOKE.settingsUpdate, settingsPatchSchema, handler)

    await expect(call(IPC_INVOKE.settingsUpdate, { theme: 'light' })).resolves.toEqual({
      ok: true,
      data: { ...DEFAULT_SETTINGS, theme: 'light' }
    })
    expect(handler).toHaveBeenCalledOnce()
  })

  it('rejects invalid input without calling the handler', async () => {
    const { registrar, call } = setup()
    const handler = vi.fn()
    registrar.handle(IPC_INVOKE.settingsUpdate, settingsPatchSchema, handler)

    const result = await call(IPC_INVOKE.settingsUpdate, { theme: 'neon' })
    expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    expect(handler).not.toHaveBeenCalled()
  })

  it('rejects extra arguments', async () => {
    const { registrar, call } = setup()
    const handler = vi.fn()
    registrar.handle(IPC_INVOKE.settingsGet, z.undefined(), handler)

    expect(await call(IPC_INVOKE.settingsGet, undefined, 'extra')).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED' }
    })
    expect(handler).not.toHaveBeenCalled()
  })

  it('refuses untrusted senders', async () => {
    const { registrar, call } = setup(false)
    const handler = vi.fn()
    registrar.handle(IPC_INVOKE.settingsGet, z.undefined(), handler)

    expect(await call(IPC_INVOKE.settingsGet)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(handler).not.toHaveBeenCalled()
  })

  it('exposes AppError messages but hides unexpected errors', async () => {
    const { registrar, call } = setup()
    registrar.handle(IPC_INVOKE.appOpenLogsFolder, z.undefined(), () => {
      throw new AppError('OPERATION_FAILED', 'Folder could not be opened.')
    })
    registrar.handle(IPC_INVOKE.appGetInfo, z.undefined(), () => {
      throw new Error('SQLITE_CORRUPT at C:\\Users\\someone\\secret.db')
    })

    expect(await call(IPC_INVOKE.appOpenLogsFolder)).toEqual({
      ok: false,
      error: { code: 'OPERATION_FAILED', message: 'Folder could not be opened.' }
    })
    const hidden = (await call(IPC_INVOKE.appGetInfo)) as { ok: false; error: { code: string; message: string } }
    expect(hidden.error.code).toBe('INTERNAL')
    expect(hidden.error.message).not.toContain('secret')
  })

  it('prevents double registration and removes handlers on dispose', () => {
    const { registrar, ipcMain, listeners } = setup()
    registrar.handle(IPC_INVOKE.settingsGet, z.undefined(), vi.fn())
    expect(() => registrar.handle(IPC_INVOKE.settingsGet, z.undefined(), vi.fn())).toThrow(/already registered/)

    registrar.dispose()
    expect(ipcMain.removeHandler).toHaveBeenCalledWith(IPC_INVOKE.settingsGet)
    expect(listeners.size).toBe(0)
  })
})
