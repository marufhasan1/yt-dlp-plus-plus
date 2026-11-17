import type { IPC_EVENTS, IPC_INVOKE } from '../constants/ipc-channels'
import type { AppInfo } from './app'
import type { ConversionJob, ConversionRequest, ConverterInput, PickedFolder } from './converter'
import type { DownloadJob, HistoryPage, HistoryQuery } from './downloads'
import type { EnginesSnapshot, InstallTarget } from './engines'
import type { AnalyzeResult, DownloadRequest } from './media'
import type { PlaylistDetails, PlaylistDownloadRequest, PlaylistDownloadResult, PlaylistSummary } from './playlists'
import type { AppSettings, SettingsPatch } from './settings'
import type { UpdateComponentId, UpdateHistoryEntry, UpdatesSnapshot } from './updates'

/** A notice about an update found or applied in the background. */
export interface UpdateNoticeEvent {
  component: UpdateComponentId
  version: string
  kind: 'available' | 'updated' | 'failed'
  message: string | null
}

/** Stable, user-presentable error codes. Raw messages and stacks stay in the main-process log. */
export type IpcErrorCode =
  | 'VALIDATION_FAILED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'OPERATION_FAILED'
  | 'INTERNAL'
  | 'NETWORK'
  | 'INTEGRITY'
  | 'INSUFFICIENT_SPACE'
  | 'BUSY'
  | 'CANCELLED'
  | 'UNSUPPORTED'
  | 'ENGINE_MISSING'
  | 'DUPLICATE'

export interface IpcError {
  code: IpcErrorCode
  message: string
}

/**
 * Every invoke handler resolves to this envelope instead of rejecting.
 * Electron flattens rejected errors into a string, which loses the error code.
 */
export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: IpcError }

type JobRef = { id: string }

/** Request/response types for each invoke channel. */
export interface IpcInvokeContract {
  [IPC_INVOKE.appGetInfo]: { request: void; response: AppInfo }
  [IPC_INVOKE.appOpenLogsFolder]: { request: void; response: void }
  [IPC_INVOKE.appReadClipboard]: { request: void; response: string }
  [IPC_INVOKE.settingsGet]: { request: void; response: AppSettings }
  [IPC_INVOKE.settingsUpdate]: { request: SettingsPatch; response: AppSettings }
  [IPC_INVOKE.settingsChooseDownloadDirectory]: { request: void; response: AppSettings }
  [IPC_INVOKE.settingsResetDownloadDirectory]: { request: void; response: AppSettings }
  [IPC_INVOKE.enginesGetStatus]: { request: void; response: EnginesSnapshot }
  [IPC_INVOKE.enginesRefresh]: { request: { deep: boolean }; response: EnginesSnapshot }
  [IPC_INVOKE.enginesInstall]: { request: { target: InstallTarget }; response: EnginesSnapshot }
  [IPC_INVOKE.enginesCancelInstall]: { request: void; response: void }
  [IPC_INVOKE.enginesOpenFolder]: { request: void; response: void }
  [IPC_INVOKE.mediaAnalyze]: { request: { url: string }; response: AnalyzeResult }
  [IPC_INVOKE.mediaCancelAnalyze]: { request: void; response: void }
  [IPC_INVOKE.downloadsList]: { request: void; response: DownloadJob[] }
  [IPC_INVOKE.downloadsStart]: { request: DownloadRequest; response: DownloadJob }
  [IPC_INVOKE.downloadsCancel]: { request: JobRef; response: void }
  [IPC_INVOKE.downloadsRetry]: { request: JobRef; response: DownloadJob }
  [IPC_INVOKE.downloadsRemove]: { request: JobRef; response: void }
  [IPC_INVOKE.downloadsShowInFolder]: { request: JobRef; response: void }
  [IPC_INVOKE.downloadsPause]: { request: JobRef; response: void }
  [IPC_INVOKE.downloadsResume]: { request: JobRef; response: DownloadJob }
  [IPC_INVOKE.downloadsPauseAll]: { request: void; response: number }
  [IPC_INVOKE.downloadsResumeAll]: { request: void; response: number }
  [IPC_INVOKE.historyList]: { request: HistoryQuery; response: HistoryPage }
  [IPC_INVOKE.historyDelete]: { request: { id: string; deleteFile: boolean }; response: { fileDeleted: boolean } }
  [IPC_INVOKE.historyRetry]: { request: JobRef; response: DownloadJob }
  [IPC_INVOKE.historyShowInFolder]: { request: JobRef; response: void }
  [IPC_INVOKE.playlistsList]: { request: void; response: PlaylistSummary[] }
  [IPC_INVOKE.playlistsGet]: { request: { id: string }; response: PlaylistDetails }
  [IPC_INVOKE.playlistsRefresh]: { request: { id: string }; response: PlaylistDetails }
  [IPC_INVOKE.playlistsRemove]: { request: { id: string }; response: void }
  [IPC_INVOKE.playlistsDownload]: { request: PlaylistDownloadRequest; response: PlaylistDownloadResult }
  [IPC_INVOKE.playlistsThumbnail]: { request: { id: string; position: number }; response: string | null }
  [IPC_INVOKE.updatesGetStatus]: { request: void; response: UpdatesSnapshot }
  [IPC_INVOKE.updatesCheck]: { request: { component: UpdateComponentId | 'all' }; response: UpdatesSnapshot }
  [IPC_INVOKE.updatesUpdateEngine]: { request: { target: InstallTarget }; response: { deferred: boolean } }
  [IPC_INVOKE.updatesCancelWaiting]: { request: { target: InstallTarget }; response: void }
  [IPC_INVOKE.updatesRollback]: { request: { target: InstallTarget }; response: UpdatesSnapshot }
  [IPC_INVOKE.updatesDownloadApp]: { request: void; response: void }
  [IPC_INVOKE.updatesCancelAppDownload]: { request: void; response: void }
  [IPC_INVOKE.updatesInstallApp]: { request: void; response: void }
  [IPC_INVOKE.updatesHistory]: { request: void; response: UpdateHistoryEntry[] }
  [IPC_INVOKE.updatesOpenReleaseNotes]: { request: { component: UpdateComponentId }; response: void }
  [IPC_INVOKE.converterPickFiles]: { request: void; response: ConverterInput[] }
  [IPC_INVOKE.converterChooseFolder]: { request: void; response: PickedFolder | null }
  [IPC_INVOKE.converterStart]: { request: ConversionRequest; response: ConversionJob[] }
  [IPC_INVOKE.converterList]: { request: void; response: ConversionJob[] }
  [IPC_INVOKE.converterCancel]: { request: JobRef; response: void }
  [IPC_INVOKE.converterRemove]: { request: JobRef; response: void }
  [IPC_INVOKE.converterShowInFolder]: { request: JobRef; response: void }
}

/** Payload types for each main → renderer event channel. */
export interface IpcEventContract {
  [IPC_EVENTS.settingsChanged]: AppSettings
  [IPC_EVENTS.enginesChanged]: EnginesSnapshot
  [IPC_EVENTS.downloadChanged]: DownloadJob
  [IPC_EVENTS.downloadRemoved]: JobRef
  [IPC_EVENTS.conversionChanged]: ConversionJob
  [IPC_EVENTS.conversionRemoved]: JobRef
  [IPC_EVENTS.updatesChanged]: UpdatesSnapshot
  [IPC_EVENTS.updatesNotice]: UpdateNoticeEvent
}

export type Unsubscribe = () => void

/** The API surface exposed to the renderer as `window.ytdlpp`. */
export interface YtDlppApi {
  app: {
    getInfo(): Promise<IpcResult<AppInfo>>
    openLogsFolder(): Promise<IpcResult<void>>
    /** Text from the system clipboard (trimmed, at most a few KB). Only call on a user action. */
    readClipboard(): Promise<IpcResult<string>>
  }
  settings: {
    get(): Promise<IpcResult<AppSettings>>
    update(patch: SettingsPatch): Promise<IpcResult<AppSettings>>
    /** Opens the native folder picker. Settings are returned unchanged if the user cancels. */
    chooseDownloadDirectory(): Promise<IpcResult<AppSettings>>
    resetDownloadDirectory(): Promise<IpcResult<AppSettings>>
    onChanged(listener: (settings: AppSettings) => void): Unsubscribe
  }
  engines: {
    getStatus(): Promise<IpcResult<EnginesSnapshot>>
    /** Re-detects all engines. `deep` also re-hashes managed binaries against their install records. */
    refresh(deep: boolean): Promise<IpcResult<EnginesSnapshot>>
    /** Downloads, verifies and installs an engine. Resolves when the installation has finished. */
    install(target: InstallTarget): Promise<IpcResult<EnginesSnapshot>>
    cancelInstall(): Promise<IpcResult<void>>
    openFolder(): Promise<IpcResult<void>>
    onChanged(listener: (snapshot: EnginesSnapshot) => void): Unsubscribe
  }
  updates: {
    getStatus(): Promise<IpcResult<UpdatesSnapshot>>
    check(component: UpdateComponentId | 'all'): Promise<IpcResult<UpdatesSnapshot>>
    /** Updates an engine; `deferred` when it waits for downloads and conversions using it to finish. */
    updateEngine(target: InstallTarget): Promise<IpcResult<{ deferred: boolean }>>
    cancelWaiting(target: InstallTarget): Promise<IpcResult<void>>
    rollback(target: InstallTarget): Promise<IpcResult<UpdatesSnapshot>>
    downloadApp(): Promise<IpcResult<void>>
    cancelAppDownload(): Promise<IpcResult<void>>
    /** Quits, installs the downloaded update and restarts. */
    installApp(): Promise<IpcResult<void>>
    history(): Promise<IpcResult<UpdateHistoryEntry[]>>
    /** Opens the release notes page the main process recorded for the component. */
    openReleaseNotes(component: UpdateComponentId): Promise<IpcResult<void>>
    onChanged(listener: (snapshot: UpdatesSnapshot) => void): Unsubscribe
    onNotice(listener: (notice: UpdateNoticeEvent) => void): Unsubscribe
  }
  media: {
    /**
     * Reads a link. Single videos come back with their formats; playlists and
     * channels are listed and saved. Starting a new analysis cancels the previous one.
     */
    analyze(url: string): Promise<IpcResult<AnalyzeResult>>
    cancelAnalyze(): Promise<IpcResult<void>>
  }
  downloads: {
    list(): Promise<IpcResult<DownloadJob[]>>
    start(request: DownloadRequest): Promise<IpcResult<DownloadJob>>
    cancel(id: string): Promise<IpcResult<void>>
    retry(id: string): Promise<IpcResult<DownloadJob>>
    /** Removes the job from the list; downloaded files are kept. */
    remove(id: string): Promise<IpcResult<void>>
    showInFolder(id: string): Promise<IpcResult<void>>
    /** Stops a download and keeps its partial files; queued jobs just leave the queue. */
    pause(id: string): Promise<IpcResult<void>>
    resume(id: string): Promise<IpcResult<DownloadJob>>
    pauseAll(): Promise<IpcResult<number>>
    resumeAll(): Promise<IpcResult<number>>
    onChanged(listener: (job: DownloadJob) => void): Unsubscribe
    onRemoved(listener: (id: string) => void): Unsubscribe
  }
  history: {
    list(query: HistoryQuery): Promise<IpcResult<HistoryPage>>
    /** Deletes the record; the file only when `deleteFile` is true (moved to the Recycle Bin / Trash). */
    delete(id: string, deleteFile: boolean): Promise<IpcResult<{ fileDeleted: boolean }>>
    retry(id: string): Promise<IpcResult<DownloadJob>>
    showInFolder(id: string): Promise<IpcResult<void>>
  }
  playlists: {
    list(): Promise<IpcResult<PlaylistSummary[]>>
    get(id: string): Promise<IpcResult<PlaylistDetails>>
    /** Lists the playlist again; download state of existing entries is kept. */
    refresh(id: string): Promise<IpcResult<PlaylistDetails>>
    /** Forgets the playlist. Download jobs and files are kept. */
    remove(id: string): Promise<IpcResult<void>>
    download(request: PlaylistDownloadRequest): Promise<IpcResult<PlaylistDownloadResult>>
    /** A small thumbnail data URL for one entry, fetched by the main process. */
    thumbnail(id: string, position: number): Promise<IpcResult<string | null>>
  }
  converter: {
    /** Opens the native file picker and inspects the chosen files. Empty if cancelled. */
    pickFiles(): Promise<IpcResult<ConverterInput[]>>
    /** Opens the native folder picker. Null if cancelled. */
    chooseFolder(): Promise<IpcResult<PickedFolder | null>>
    start(request: ConversionRequest): Promise<IpcResult<ConversionJob[]>>
    list(): Promise<IpcResult<ConversionJob[]>>
    cancel(id: string): Promise<IpcResult<void>>
    /** Removes the job from the list; files are kept. */
    remove(id: string): Promise<IpcResult<void>>
    showInFolder(id: string): Promise<IpcResult<void>>
    onChanged(listener: (job: ConversionJob) => void): Unsubscribe
    onRemoved(listener: (id: string) => void): Unsubscribe
  }
}
