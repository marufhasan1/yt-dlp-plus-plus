import { z } from 'zod'

/** Proxy schemes yt-dlp supports. */
export const PROXY_PROTOCOLS = ['http', 'https', 'socks4', 'socks4a', 'socks5', 'socks5h'] as const
export type ProxyProtocol = (typeof PROXY_PROTOCOLS)[number]

export interface ParsedProxy {
  protocol: ProxyProtocol
  host: string
  port: number | null
  username: string | null
  password: string | null
}

/**
 * Parses a proxy address such as "socks5h://127.0.0.1:9050" or
 * "http://user:pass@proxy.example:8080". Returns null for anything else:
 * other schemes, paths, queries, fragments, whitespace or control characters.
 */
export function parseProxy(value: string): ParsedProxy | null {
  if (value.length > 2048 || /[\s\x00-\x1f\x7f]/.test(value)) return null
  const match = /^([a-z0-9]+):\/\//i.exec(value)
  const protocol = match?.[1]?.toLowerCase()
  if (!protocol || !(PROXY_PROTOCOLS as readonly string[]).includes(protocol)) return null
  let url: URL
  try {
    // WHATWG URL treats unknown schemes as opaque; parse as http to get host and port, then keep the real scheme.
    url = new URL(`http://${value.slice(match![0].length)}`)
  } catch {
    return null
  }
  const rest = value.slice(match![0].length)
  if (/[/?#]/.test(rest.replace(/\/$/, ''))) return null
  if (!url.hostname) return null
  const port = url.port ? Number(url.port) : null
  if (port !== null && (port < 1 || port > 65535)) return null
  return {
    protocol: protocol as ProxyProtocol,
    host: url.hostname,
    port,
    username: url.username ? decodeURIComponent(url.username) : null,
    password: url.password ? decodeURIComponent(url.password) : null
  }
}

/** Canonical form passed to yt-dlp: scheme://[user[:pass]@]host[:port] */
export function formatProxy(proxy: ParsedProxy): string {
  const auth = proxy.username
    ? `${encodeURIComponent(proxy.username)}${proxy.password ? `:${encodeURIComponent(proxy.password)}` : ''}@`
    : ''
  return `${proxy.protocol}://${auth}${proxy.host}${proxy.port ? `:${proxy.port}` : ''}`
}

/** The address without credentials, safe to log or display. */
export function redactProxy(value: string): string {
  const parsed = parseProxy(value)
  return parsed ? formatProxy({ ...parsed, username: parsed.username ? '***' : null, password: null }) : 'invalid proxy'
}

/** A proxy address, normalised; null means a direct connection. */
export const proxySchema = z
  .string()
  .trim()
  .transform((value, context) => {
    const parsed = parseProxy(value)
    if (!parsed) {
      context.addIssue({
        code: 'custom',
        message: 'Enter a proxy such as http://proxy.example:8080 or socks5h://127.0.0.1:9050'
      })
      return z.NEVER
    }
    return formatProxy(parsed)
  })
  .nullable()
