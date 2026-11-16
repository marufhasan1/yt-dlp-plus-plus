import type { FetchFn } from '../../electron/services/network/trusted-http'

export interface FakeRoute {
  status?: number
  body?: string | Uint8Array | ReadableStream<Uint8Array>
  headers?: Record<string, string>
  /** Simulates redirects: the URL the response reports after following them. */
  finalUrl?: string
  /** Rejects the fetch, like a DNS or connection failure. */
  error?: Error
}

export interface FakeFetch extends FetchFn {
  calls: { url: string; method: string }[]
}

/** A fetch stand-in that serves fixed responses by exact URL. Unknown URLs get a 404. */
export function fakeFetch(routes: Record<string, FakeRoute>): FakeFetch {
  const calls: { url: string; method: string }[] = []
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, method: init.method ?? 'GET' })
    if (init.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const route = routes[url] ?? { status: 404, body: 'not found' }
    if (route.error) throw route.error
    const body = init.method === 'HEAD' ? null : (route.body ?? '')
    const response = new Response(body as ConstructorParameters<typeof Response>[0], { status: route.status ?? 200, headers: route.headers })
    Object.defineProperty(response, 'url', { value: route.finalUrl ?? url })
    return response
  }) as FakeFetch
  fn.calls = calls
  return fn
}
