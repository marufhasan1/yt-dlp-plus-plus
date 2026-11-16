import type { Session } from 'electron'
import { parseProxy, type ParsedProxy } from '@shared/validation/network'
import { createProxyAuthFetch, type ProxyLogin, type RequestFactory } from './proxy-fetch'
import type { FetchFn } from './trusted-http'

/**
 * Chromium proxy rules for MediaFlow's own requests (thumbnails, engine
 * downloads), matching what yt-dlp is given. Chromium has no "socks5h"/"socks4a":
 * its SOCKS5 already resolves names through the proxy, and SOCKS4 is the closest.
 */
export function chromiumProxyRules(proxy: ParsedProxy): string {
  const scheme = proxy.protocol === 'socks5h' ? 'socks5' : proxy.protocol === 'socks4a' ? 'socks4' : proxy.protocol
  // `host` keeps the brackets of an IPv6 address, as URL.hostname does.
  return `${scheme}://${proxy.host}${proxy.port ? `:${proxy.port}` : ''}`
}

/** The proxy currently applied to the session (normalised), or null. */
let configuredProxy: string | null = null

/** Applies the configured proxy (or the system's settings when none) to a session. */
export async function applySessionProxy(session: Session, proxy: string | null): Promise<void> {
  const parsed = proxy ? parseProxy(proxy) : null
  configuredProxy = parsed ? proxy : null
  if (parsed) {
    await session.setProxy({ mode: 'fixed_servers', proxyRules: chromiumProxyRules(parsed), proxyBypassRules: '<local>' })
  } else {
    await session.setProxy({ mode: 'system' })
  }
  await session.closeAllConnections()
}

/** Credentials for the proxy's authentication challenge, when the proxy has them. */
export function proxyLoginFor(proxy: string | null): ProxyLogin | null {
  const parsed = proxy ? parseProxy(proxy) : null
  if (!parsed?.username) return null
  return { host: parsed.host, username: parsed.username, password: parsed.password ?? '' }
}

/**
 * fetch for MediaFlow's own requests: Electron's net.fetch normally, or a
 * net.request-based fetch that can answer the proxy's challenge when the
 * configured proxy needs a user name and password.
 */
export function createSessionFetch(fetch: FetchFn, request: RequestFactory): FetchFn {
  const login = () => proxyLoginFor(configuredProxy)
  const authenticated = createProxyAuthFetch(request, login)
  return (url, init) => (login() ? authenticated(url, init) : fetch(url, init))
}
