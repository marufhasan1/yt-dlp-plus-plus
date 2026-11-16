import { readFile } from 'node:fs/promises'
import { extname, relative, resolve, sep } from 'node:path'
import { protocol } from 'electron'
import type { Logger } from './utils/logger'

/**
 * The UI is served from app://mediaflow/ instead of file://. Pages loaded from
 * file:// share one origin with every local file and get extra privileges;
 * this scheme gives the renderer its own origin (CSP 'self' means only the
 * app's files) and lets the grantFileProtocolExtraPrivileges fuse stay off.
 */
export const APP_SCHEME = 'app'
export const APP_HOST = 'mediaflow'
export const APP_ENTRY_URL = `${APP_SCHEME}://${APP_HOST}/index.html`

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff'
}

/** Must run before the app is ready. */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } }
  ])
}

/**
 * Maps an app:// URL to a file inside `root`, or null for anything else:
 * another host, a path outside the folder (including encoded "..", absolute or
 * drive paths) or a file type the UI does not use.
 */
export function resolveAppAsset(root: string, raw: string): string | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== `${APP_SCHEME}:` || url.host !== APP_HOST) return null
  let pathname: string
  try {
    pathname = decodeURIComponent(url.pathname)
  } catch {
    return null
  }
  if (pathname.includes('\0')) return null
  const base = resolve(root)
  const file = resolve(base, `.${pathname === '/' ? '/index.html' : pathname}`)
  const inside = relative(base, file)
  if (inside === '' || inside.startsWith('..') || inside.includes(`..${sep}`) || resolve(inside) === inside) return null
  return extname(file).toLowerCase() in CONTENT_TYPES ? file : null
}

/** Serves the renderer build from `root` on app://mediaflow/. */
export function handleAppScheme(root: string, logger: Logger): void {
  protocol.handle(APP_SCHEME, async (request) => {
    const file = resolveAppAsset(root, request.url)
    if (!file) {
      logger.warn(`Refused app:// request for ${request.url}`)
      return new Response('Not found', { status: 404 })
    }
    try {
      const body = await readFile(file)
      return new Response(body, {
        status: 200,
        headers: { 'content-type': CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream', 'x-content-type-options': 'nosniff' }
      })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}
