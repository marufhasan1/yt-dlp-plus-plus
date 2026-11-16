import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { BRIDGE_KEY } from '@shared/constants/app'
import { IPC_EVENTS, IPC_INVOKE } from '@shared/constants/ipc-channels'
import type { IpcEventContract, IpcInvokeContract, IpcResult, YtDlppApi, Unsubscribe } from '@shared/types/ipc'

/*
 * The renderer never sees ipcRenderer. It gets a fixed set of functions, each
 * bound to one declared channel. Input validation happens in the main process.
 */

type InvokeArgs<C extends keyof IpcInvokeContract> = IpcInvokeContract[C]['request'] extends void
  ? []
  : [IpcInvokeContract[C]['request']]

function invoke<C extends keyof IpcInvokeContract>(
  channel: C,
  ...args: InvokeArgs<C>
): Promise<IpcResult<IpcInvokeContract[C]['response']>> {
  return ipcRenderer.invoke(channel, ...args)
}

function subscribe<E extends keyof IpcEventContract>(
  channel: E,
  listener: (payload: IpcEventContract[E]) => void
): Unsubscribe {
  // The IpcRendererEvent is deliberately not forwarded: it exposes `sender`.
  const forward = (_event: IpcRendererEvent, payload: IpcEventContract[E]): void => listener(payload)
  ipcRenderer.on(channel, forward)
  return () => {
    ipcRenderer.removeListener(channel, forward)
  }
}

const api: YtDlppApi = {
  app: {
    getInfo: () => invoke(IPC_INVOKE.appGetInfo),
    openLogsFolder: () => invoke(IPC_INVOKE.appOpenLogsFolder),
    readClipboard: () => invoke(IPC_INVOKE.appReadClipboard)
  },
  settings: {
    get: () => invoke(IPC_INVOKE.settingsGet),
    update: (patch) => invoke(IPC_INVOKE.settingsUpdate, patch),
    chooseDownloadDirectory: () => invoke(IPC_INVOKE.settingsChooseDownloadDirectory),
    resetDownloadDirectory: () => invoke(IPC_INVOKE.settingsResetDownloadDirectory),
    onChanged: (listener) => subscribe(IPC_EVENTS.settingsChanged, listener)
  },
  engines: {
    getStatus: () => invoke(IPC_INVOKE.enginesGetStatus),
    refresh: (deep) => invoke(IPC_INVOKE.enginesRefresh, { deep }),
    install: (target) => invoke(IPC_INVOKE.enginesInstall, { target }),
    cancelInstall: () => invoke(IPC_INVOKE.enginesCancelInstall),
    openFolder: () => invoke(IPC_INVOKE.enginesOpenFolder),
    onChanged: (listener) => subscribe(IPC_EVENTS.enginesChanged, listener)
  },
  media: {
    analyze: (url) => invoke(IPC_INVOKE.mediaAnalyze, { url }),
    cancelAnalyze: () => invoke(IPC_INVOKE.mediaCancelAnalyze)
  },
  downloads: {
    list: () => invoke(IPC_INVOKE.downloadsList),
    start: (request) => invoke(IPC_INVOKE.downloadsStart, request),
    cancel: (id) => invoke(IPC_INVOKE.downloadsCancel, { id }),
    retry: (id) => invoke(IPC_INVOKE.downloadsRetry, { id }),
    remove: (id) => invoke(IPC_INVOKE.downloadsRemove, { id }),
    showInFolder: (id) => invoke(IPC_INVOKE.downloadsShowInFolder, { id }),
    pause: (id) => invoke(IPC_INVOKE.downloadsPause, { id }),
    resume: (id) => invoke(IPC_INVOKE.downloadsResume, { id }),
    pauseAll: () => invoke(IPC_INVOKE.downloadsPauseAll),
    resumeAll: () => invoke(IPC_INVOKE.downloadsResumeAll),
    onChanged: (listener) => subscribe(IPC_EVENTS.downloadChanged, listener),
    onRemoved: (listener) => subscribe(IPC_EVENTS.downloadRemoved, (payload) => listener(payload.id))
  },
  history: {
    list: (query) => invoke(IPC_INVOKE.historyList, query),
    delete: (id, deleteFile) => invoke(IPC_INVOKE.historyDelete, { id, deleteFile }),
    retry: (id) => invoke(IPC_INVOKE.historyRetry, { id }),
    showInFolder: (id) => invoke(IPC_INVOKE.historyShowInFolder, { id })
  },
  updates: {
    getStatus: () => invoke(IPC_INVOKE.updatesGetStatus),
    check: (component) => invoke(IPC_INVOKE.updatesCheck, { component }),
    updateEngine: (target) => invoke(IPC_INVOKE.updatesUpdateEngine, { target }),
    cancelWaiting: (target) => invoke(IPC_INVOKE.updatesCancelWaiting, { target }),
    rollback: (target) => invoke(IPC_INVOKE.updatesRollback, { target }),
    downloadApp: () => invoke(IPC_INVOKE.updatesDownloadApp),
    cancelAppDownload: () => invoke(IPC_INVOKE.updatesCancelAppDownload),
    installApp: () => invoke(IPC_INVOKE.updatesInstallApp),
    history: () => invoke(IPC_INVOKE.updatesHistory),
    openReleaseNotes: (component) => invoke(IPC_INVOKE.updatesOpenReleaseNotes, { component }),
    onChanged: (listener) => subscribe(IPC_EVENTS.updatesChanged, listener),
    onNotice: (listener) => subscribe(IPC_EVENTS.updatesNotice, listener)
  },
  playlists: {
    list: () => invoke(IPC_INVOKE.playlistsList),
    get: (id) => invoke(IPC_INVOKE.playlistsGet, { id }),
    refresh: (id) => invoke(IPC_INVOKE.playlistsRefresh, { id }),
    remove: (id) => invoke(IPC_INVOKE.playlistsRemove, { id }),
    download: (request) => invoke(IPC_INVOKE.playlistsDownload, request),
    thumbnail: (id, position) => invoke(IPC_INVOKE.playlistsThumbnail, { id, position })
  },
  converter: {
    pickFiles: () => invoke(IPC_INVOKE.converterPickFiles),
    chooseFolder: () => invoke(IPC_INVOKE.converterChooseFolder),
    start: (request) => invoke(IPC_INVOKE.converterStart, request),
    list: () => invoke(IPC_INVOKE.converterList),
    cancel: (id) => invoke(IPC_INVOKE.converterCancel, { id }),
    remove: (id) => invoke(IPC_INVOKE.converterRemove, { id }),
    showInFolder: (id) => invoke(IPC_INVOKE.converterShowInFolder, { id }),
    onChanged: (listener) => subscribe(IPC_EVENTS.conversionChanged, listener),
    onRemoved: (listener) => subscribe(IPC_EVENTS.conversionRemoved, (payload) => listener(payload.id))
  }
}

contextBridge.exposeInMainWorld(BRIDGE_KEY, api)
