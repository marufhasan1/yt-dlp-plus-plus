import type { ClientRequest, ClientRequestConstructorOptions, IncomingMessage } from 'electron'
import type { FetchFn } from './trusted-http'

/*
 * Electron's net.fetch goes through the session proxy but never answers a
 * proxy's authentication challenge (no `login` event reaches the app; verified:
 * it returns HTTP 407). net.request does emit `login`. So when the configured
 * proxy has credentials, MediaFlow's own requests (thumbnails, engine
 * downloads) use this small fetch built on net.request instead.
 */

export type RequestFactory = (options: ClientRequestConstructorOptions) => ClientRequest

export interface ProxyLogin {
  /** Host of the configured proxy; only challenges from it are answered. */
  host: string
  username: string
  password: string
}

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304])
const MAX_REDIRECTS = 10

/**
 * fetch() semantics for GET-style requests: redirects are followed, the final
 * URL is reported in `response.url` (callers check it against allow-lists),
 * aborting rejects with an AbortError, and the body is streamed.
 */
export function createProxyAuthFetch(request: RequestFactory, login: () => ProxyLogin | null): FetchFn {
  return (url, init) =>
    new Promise<Response>((resolve, reject) => {
      const signal = init.signal ?? undefined
      if (signal?.aborted) {
        reject(abortError(signal))
        return
      }
      let finalUrl = url
      let redirects = 0
      let settled = false
      const req = request({ url, method: init.method ?? 'GET', redirect: 'manual', useSessionCookies: false })
      for (const [name, value] of new Headers(init.headers).entries()) req.setHeader(name, value)

      const fail = (error: unknown): void => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', onAbort)
        reject(error)
      }
      const onAbort = (): void => {
        req.abort()
        fail(abortError(signal))
      }
      signal?.addEventListener('abort', onAbort, { once: true })

      req.on('login', (authInfo, callback) => {
        const credentials = login()
        const bare = (host: string) => host.replace(/^\[|\]$/g, '').toLowerCase()
        // Websites asking for a password get nothing; only the configured proxy is answered.
        if (authInfo.isProxy && credentials && bare(authInfo.host) === bare(credentials.host)) {
          callback(credentials.username, credentials.password)
        } else {
          callback()
        }
      })
      req.on('redirect', (_status, _method, redirectUrl) => {
        if (init.redirect === 'error' || ++redirects > MAX_REDIRECTS) {
          req.abort()
          fail(new TypeError(redirects > MAX_REDIRECTS ? 'Too many redirects' : 'Redirect not allowed'))
          return
        }
        finalUrl = redirectUrl
        req.followRedirect()
      })
      req.on('response', (incoming: IncomingMessage) => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', onAbort)
        const headers = new Headers()
        for (const [name, value] of Object.entries(incoming.headers)) {
          for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item)
        }
        const status = incoming.statusCode
        const body = NULL_BODY_STATUSES.has(status) ? null : streamOf(incoming, () => req.abort())
        if (signal) signal.addEventListener('abort', () => req.abort(), { once: true })
        const response = new Response(body, { status, statusText: incoming.statusMessage, headers })
        // A constructed Response has an empty url; report where the redirects led.
        Object.defineProperty(response, 'url', { value: finalUrl })
        Object.defineProperty(response, 'redirected', { value: redirects > 0 })
        resolve(response)
      })
      req.on('error', (error) => fail(error))
      req.end()
    })
}

/** The response body as a web stream; cancelling it aborts the request. */
function streamOf(incoming: IncomingMessage, abort: () => void): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      incoming.on('data', (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)))
      incoming.on('end', () => controller.close())
      incoming.on('error', (error: Error) => controller.error(error))
      incoming.on('aborted', () => controller.error(new DOMException('The response was aborted.', 'AbortError')))
    },
    cancel() {
      abort()
    }
  })
}

function abortError(signal: AbortSignal | undefined): unknown {
  return signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError')
}
