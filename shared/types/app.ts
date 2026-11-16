export interface AppInfo {
  name: string
  version: string
  isPackaged: boolean
  /** process.platform, e.g. win32, darwin or linux. */
  platform: string
  arch: string
  versions: {
    electron: string
    chrome: string
    node: string
  }
  paths: {
    userData: string
    logs: string
    engines: string
    downloads: string
  }
}
