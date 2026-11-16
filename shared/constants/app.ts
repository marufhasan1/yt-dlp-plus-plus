/** Name of the API object exposed on `window` by the preload bridge. */
export const BRIDGE_KEY = 'mediaflow'

/** Environment variable that redirects user data during automated tests. Ignored in packaged builds. */
export const USER_DATA_DIR_ENV = 'MEDIAFLOW_USER_DATA_DIR'

export const DATABASE_FILENAME = 'mediaflow.db'

/** Window background colours, kept in sync with the --bg tokens in src/assets/main.css. */
export const WINDOW_BACKGROUND = {
  dark: '#0e1014',
  light: '#f5f6f8'
} as const
