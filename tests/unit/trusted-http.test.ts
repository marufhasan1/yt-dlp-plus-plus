import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { TrustedHttpClient } from '../../electron/services/network/trusted-http'
import { AppError } from '../../electron/utils/errors'
import { fakeFetch, type FakeRoute } from '../helpers/fake-fetch'

const HOSTS = ['api.github.com', 'github.com', 'release-assets.githubusercontent.com']

function client(routes: Record<string, FakeRoute>, idleTimeoutMs?: number) {
  const fetch = fakeFetch(routes)
  return { http: new TrustedHttpClient({ fetch, allowedHosts: HOSTS, userAgent: 'test', idleTimeoutMs }), fetch }
}

async function expectAppError(promise: Promise<unknown>, code: string): Promise<AppError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e
  )
  expect(error).toBeInstanceOf(AppError)
  expect((error as AppError).code).toBe(code)
  return error as AppError
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mediaflow-http-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('TrustedHttpClient', () => {
  it('fetches and validates JSON', async () => {
    const { http } = client({ 'https://api.github.com/x': { body: '{"tag":"v1"}' } })
    expect(await http.getJson('https://api.github.com/x', z.object({ tag: z.string() }))).toEqual({ tag: 'v1' })
    await expectAppError(http.getJson('https://api.github.com/x', z.object({ other: z.string() })), 'OPERATION_FAILED')
  })

  it.each([
    ['an unlisted host', 'https://evil.example.com/yt-dlp.exe'],
    ['plain HTTP', 'http://github.com/yt-dlp.exe'],
    ['a look-alike host', 'https://github.com.evil.example/yt-dlp.exe'],
    ['garbage', 'not a url']
  ])('refuses %s without making a request', async (_label, url) => {
    const { http, fetch } = client({})
    await expectAppError(http.getText(url), 'FORBIDDEN')
    expect(fetch.calls).toHaveLength(0)
  })

  it('refuses a redirect to an unlisted host', async () => {
    const { http } = client({ 'https://github.com/file': { body: 'x', finalUrl: 'https://cdn.evil.example/file' } })
    await expectAppError(http.getText('https://github.com/file'), 'FORBIDDEN')
  })

  it('follows a redirect to an allowed host', async () => {
    const { http } = client({
      'https://github.com/file': { finalUrl: 'https://release-assets.githubusercontent.com/abc' }
    })
    expect(await http.resolveRedirects('https://github.com/file')).toBe('https://release-assets.githubusercontent.com/abc')
  })

  it('maps HTTP and network failures to user-facing errors', async () => {
    const { http } = client({
      'https://github.com/missing': { status: 404 },
      'https://api.github.com/limited': { status: 403, headers: { 'x-ratelimit-remaining': '0' } },
      'https://github.com/offline': { error: new TypeError('fetch failed') }
    })
    expect((await expectAppError(http.getText('https://github.com/missing'), 'NETWORK')).message).toContain('404')
    expect((await expectAppError(http.getText('https://api.github.com/limited'), 'NETWORK')).message).toContain(
      'rate limit'
    )
    expect((await expectAppError(http.getText('https://github.com/offline'), 'NETWORK')).message).toContain(
      'Network connection failed'
    )
  })

  it('downloads to disk while hashing and reporting progress', async () => {
    const payload = Buffer.alloc(300_000, 7)
    const { http } = client({
      'https://github.com/bin': { body: payload, headers: { 'content-length': String(payload.length) } }
    })
    const progress: number[] = []
    const destination = join(dir, 'bin')
    const result = await http.download('https://github.com/bin', destination, {
      maxBytes: 1_000_000,
      onProgress: (p) => progress.push(p.receivedBytes)
    })
    expect(result.size).toBe(payload.length)
    expect(result.sha256).toBe(createHash('sha256').update(payload).digest('hex'))
    expect(readFileSync(destination).equals(payload)).toBe(true)
    expect(progress.at(-1)).toBe(payload.length)
  })

  it('rejects bodies over the size limit, declared or streamed', async () => {
    const big = Buffer.alloc(2048)
    const { http } = client({
      'https://github.com/declared': { body: big, headers: { 'content-length': '2048' } },
      'https://github.com/streamed': { body: big }
    })
    await expectAppError(http.download('https://github.com/declared', join(dir, 'a'), { maxBytes: 1024 }), 'INTEGRITY')
    await expectAppError(http.download('https://github.com/streamed', join(dir, 'b'), { maxBytes: 1024 }), 'INTEGRITY')
    await expectAppError(http.getText('https://github.com/streamed', undefined, 1024), 'INTEGRITY')
  })

  it('reports cancellation', async () => {
    const { http } = client({ 'https://github.com/bin': { body: 'x' } })
    const controller = new AbortController()
    controller.abort()
    await expectAppError(http.download('https://github.com/bin', join(dir, 'c'), { maxBytes: 10, signal: controller.signal }), 'CANCELLED')
  })

  it('gives up on a stalled download', async () => {
    const stalled = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]))
        // Never closes.
      }
    })
    const { http } = client({ 'https://github.com/slow': { body: stalled } }, 50)
    const error = await expectAppError(http.download('https://github.com/slow', join(dir, 'd'), { maxBytes: 100 }), 'NETWORK')
    expect(error.message).toContain('stalled')
  })
})
