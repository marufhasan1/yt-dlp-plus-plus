/**
 * The complete list of IPC channels. The preload bridge refuses any channel
 * that is not declared here, so adding a capability is always explicit.
 */
export const IPC_INVOKE = {
  appGetInfo: 'app:get-info',
  appOpenLogsFolder: 'app:open-logs-folder',
  appReadClipboard: 'app:read-clipboard',
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  settingsChooseDownloadDirectory: 'settings:choose-download-directory',
  settingsResetDownloadDirectory: 'settings:reset-download-directory',
  enginesGetStatus: 'engines:get-status',
  enginesRefresh: 'engines:refresh',
  enginesInstall: 'engines:install',
  enginesCancelInstall: 'engines:cancel-install',
  enginesOpenFolder: 'engines:open-folder',
  mediaAnalyze: 'media:analyze',
  mediaCancelAnalyze: 'media:cancel-analyze',
  downloadsList: 'downloads:list',
  downloadsStart: 'downloads:start',
  downloadsCancel: 'downloads:cancel',
  downloadsRetry: 'downloads:retry',
  downloadsRemove: 'downloads:remove',
  downloadsShowInFolder: 'downloads:show-in-folder',
  downloadsPause: 'downloads:pause',
  downloadsResume: 'downloads:resume',
  downloadsPauseAll: 'downloads:pause-all',
  downloadsResumeAll: 'downloads:resume-all',
  historyList: 'history:list',
  historyDelete: 'history:delete',
  historyRetry: 'history:retry',
  historyShowInFolder: 'history:show-in-folder',
  playlistsList: 'playlists:list',
  playlistsGet: 'playlists:get',
  playlistsRefresh: 'playlists:refresh',
  playlistsRemove: 'playlists:remove',
  playlistsDownload: 'playlists:download',
  playlistsThumbnail: 'playlists:thumbnail',
  converterPickFiles: 'converter:pick-files',
  converterChooseFolder: 'converter:choose-folder',
  converterStart: 'converter:start',
  converterList: 'converter:list',
  converterCancel: 'converter:cancel',
  converterRemove: 'converter:remove',
  converterShowInFolder: 'converter:show-in-folder',
  updatesGetStatus: 'updates:get-status',
  updatesCheck: 'updates:check',
  updatesUpdateEngine: 'updates:update-engine',
  updatesCancelWaiting: 'updates:cancel-waiting',
  updatesRollback: 'updates:rollback',
  updatesDownloadApp: 'updates:download-app',
  updatesCancelAppDownload: 'updates:cancel-app-download',
  updatesInstallApp: 'updates:install-app',
  updatesHistory: 'updates:history',
  updatesOpenReleaseNotes: 'updates:open-release-notes'
} as const

export const IPC_EVENTS = {
  settingsChanged: 'settings:changed',
  enginesChanged: 'engines:changed',
  downloadChanged: 'downloads:changed',
  downloadRemoved: 'downloads:removed',
  conversionChanged: 'converter:changed',
  conversionRemoved: 'converter:removed',
  updatesChanged: 'updates:changed',
  updatesNotice: 'updates:notice'
} as const

export type IpcInvokeChannel = (typeof IPC_INVOKE)[keyof typeof IPC_INVOKE]
export type IpcEventChannel = (typeof IPC_EVENTS)[keyof typeof IPC_EVENTS]
