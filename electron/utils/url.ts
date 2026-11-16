/**
 * Where the renderer is loaded from: the Vite dev server, or the bundled UI
 * served from `root` on app://mediaflow/ (see app-protocol.ts).
 */
export type RendererSource = { kind: 'dev-server'; url: string } | { kind: 'app'; root: string }

/** The UI's address on the app:// scheme (kept in sync with app-protocol.ts). */
const APP_ORIGIN = 'app://mediaflow'
const APP_ENTRY_PATH = '/index.html'

/**
 * Links opened outside the app go to the user's browser, and only over HTTPS.
 * This blocks file:, javascript:, custom protocol handlers and plain HTTP.
 */
export function isSafeExternalUrl(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  return url.protocol === 'https:' && url.hostname.length > 0 && url.username === '' && url.password === ''
}

/**
 * Returns true when `raw` points at our own renderer document and nothing else.
 * Query strings and hashes (used by the router) are ignored.
 */
export function isRendererUrl(raw: string, source: RendererSource): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (source.kind === 'dev-server') {
    return url.origin === new URL(source.url).origin
  }
  return `${url.protocol}//${url.host}` === APP_ORIGIN && url.pathname === APP_ENTRY_PATH && url.username === '' && url.port === ''
}
