import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { ClientRequest, ClientRequestConstructorOptions } from 'electron'
import { createProxyAuthFetch, type ProxyLogin } from '../../electron/services/network/proxy-fetch'

/** A scripted stand-in for Electron's net.request. */
class FakeRequest extends EventEmitter {
  headers: Record<string, string> = {}
  ended = false
  aborted = false
  followed = 0
  constructor(readonly options: ClientRequestConstructorOptions) {
    super()
  }
  setHeader(name: string, value: string): void {
    this.headers[name] = value
  }
  end(): void {
    this.ended = true
  }
  abort(): void {
    this.aborted = true
  }
  followRedirect(): void {
    this.followed++
  }
  /** Asks for credentials like Chromium does on HTTP 401/407. */
  challenge(isProxy: boolean, host: string): unknown[] {
    let given: unknown[] = []
    this.emit('login', { isProxy, host, port: 3128, scheme: 'basic', realm: 'r' }, (...args: unknown[]) => {
      given = args
    })
    return given
  }
  respond(status: number, headers: Record<string, string | string[]>, chunks: string[]): EventEmitter {
    const incoming = Object.assign(new EventEmitter(), { statusCode: status, statusMessage: 'OK', headers })
    this.emit('response', incoming)
    setImmediate(() => {
      for (const chunk of chunks) incoming.emit('data', Buffer.from(chunk))
      incoming.emit('end')
    })
    return incoming
  }
}

const LOGIN: ProxyLogin = { host: 'proxy.example', username: 'mf', password: 's3cret' }

function setup(login: ProxyLogin | null = LOGIN) {
  const requests: FakeRequest[] = []
  const fetch = createProxyAuthFetch((options) => {
    const request = new FakeRequest(options)
    requests.push(request)
    return request as unknown as ClientRequest
  }, () => login)
  return { fetch, requests }
}

describe('fetch that answers proxy authentication', () => {
  it('answers only the configured proxy, never a website', async () => {
    const { fetch, requests } = setup()
    const pending = fetch('https://i.ytimg.com/vi/x/hqdefault.jpg', { headers: { Accept: 'image/*' } })
    const request = requests[0]!
    expect(request.options).toMatchObject({ method: 'GET', redirect: 'manual', useSessionCookies: false })
    expect(request.headers).toEqual({ accept: 'image/*' })
    expect(request.challenge(true, 'PROXY.example')).toEqual(['mf', 's3cret'])
    expect(request.challenge(true, 'other-proxy.example')).toEqual([])
    expect(request.challenge(false, 'i.ytimg.com')).toEqual([]) // a site asking for a password gets nothing
    request.respond(200, { 'content-type': 'image/jpeg', 'set-cookie': ['a=1', 'b=2'] }, ['ab', 'cd'])
    const response = await pending
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/jpeg')
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe('abcd')
    expect(response.url).toBe('https://i.ytimg.com/vi/x/hqdefault.jpg')
  })

  it('reports where redirects led, so allow-lists can be checked', async () => {
    const { fetch, requests } = setup()
    const pending = fetch('https://github.com/yt-dlp/yt-dlp/releases/download/x/SHA2-256SUMS', { redirect: 'follow' })
    const request = requests[0]!
    request.emit('redirect', 302, 'GET', 'https://release-assets.githubusercontent.com/abc', {})
    expect(request.followed).toBe(1)
    request.respond(200, {}, ['sums'])
    const response = await pending
    expect(response.url).toBe('https://release-assets.githubusercontent.com/abc')
    expect(response.redirected).toBe(true)
    expect(await response.text()).toBe('sums')

    const refused = fetch('https://example.com/', { redirect: 'error' })
    requests[1]!.emit('redirect', 301, 'GET', 'https://elsewhere.example/', {})
    await expect(refused).rejects.toThrow('Redirect not allowed')
    expect(requests[1]!.aborted).toBe(true)
  })

  it('stops on abort, before and after the response', async () => {
    const { fetch, requests } = setup()
    const early = new AbortController()
    const pending = fetch('https://i.ytimg.com/a.jpg', { signal: early.signal })
    early.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(requests[0]!.aborted).toBe(true)

    const late = new AbortController()
    const second = fetch('https://i.ytimg.com/b.jpg', { signal: late.signal })
    const incoming = Object.assign(new EventEmitter(), { statusCode: 200, statusMessage: 'OK', headers: {} })
    requests[1]!.emit('response', incoming)
    const response = await second
    const reading = response.text()
    late.abort()
    incoming.emit('aborted')
    await expect(reading).rejects.toBeDefined()
    expect(requests[1]!.aborted).toBe(true)

    const already = new AbortController()
    already.abort()
    await expect(fetch('https://i.ytimg.com/c.jpg', { signal: already.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(requests).toHaveLength(2) // never started
  })

  it('passes network errors through and handles empty bodies', async () => {
    const { fetch, requests } = setup(null)
    const failing = fetch('https://i.ytimg.com/a.jpg', {})
    expect(requests[0]!.challenge(true, 'proxy.example')).toEqual([]) // no credentials configured
    requests[0]!.emit('error', new Error('net::ERR_PROXY_CONNECTION_FAILED'))
    await expect(failing).rejects.toThrow('ERR_PROXY_CONNECTION_FAILED')

    const empty = fetch('https://i.ytimg.com/b.jpg', {})
    requests[1]!.respond(204, {}, [])
    expect((await empty).body).toBeNull()
    vi.restoreAllMocks()
  })
})
