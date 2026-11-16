import { BrowserWindow, dialog } from 'electron'
import { z } from 'zod'
import { IPC_INVOKE } from '@shared/constants/ipc-channels'
import { settingsPatchSchema } from '@shared/validation/settings'
import type { SettingsService } from '../services/settings/settings.service'
import type { IpcRegistrar } from './ipc-registrar'

export function registerSettingsIpc(ipc: IpcRegistrar, settings: SettingsService, defaultDownloadDir: string): void {
  ipc.handle(IPC_INVOKE.settingsGet, z.undefined(), () => settings.get())
  ipc.handle(IPC_INVOKE.settingsUpdate, settingsPatchSchema, (patch) => settings.update(patch))

  // The folder comes from the OS dialog, never from the renderer.
  ipc.handle(IPC_INVOKE.settingsChooseDownloadDirectory, z.undefined(), async (_input, event) => {
    const options: Electron.OpenDialogOptions = {
      title: 'Choose download folder',
      defaultPath: settings.get().downloadDirectory ?? defaultDownloadDir,
      properties: ['openDirectory', 'createDirectory', 'promptToCreate']
    }
    const parent = BrowserWindow.fromWebContents(event.sender)
    const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
    const [folder] = result.filePaths
    if (result.canceled || !folder) return settings.get()
    return settings.setDownloadDirectory(folder)
  })

  ipc.handle(IPC_INVOKE.settingsResetDownloadDirectory, z.undefined(), () => settings.setDownloadDirectory(null))
}
