import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import type { z } from 'zod'
import { AppError } from '../../utils/errors'

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>

export interface DownloadProgress {
  receivedBytes: number
  totalBytes: number | null
}

export interface DownloadOptions {
  signal?: AbortSignal
  /** Abort if the response is larger than this. */
  maxBytes: number
  onProgress?: (progress: DownloadProgress) => void
}

export interface DownloadResult {
  sha256: string
  size: number
  finalUrl: string
}

export interface TrustedHttpOptions {
  fetch: FetchFn
  /** Exact host names that may be contacted, including redirect targets. */
  allowedHosts: readonly string[]
  userAgent: string
  /** Abort a request when no data arrives for this long. */
  idleTimeoutMs?: number
}

const DEFAULT_TEXT_LIMIT = 1024 * 1024

/**
 * HTTPS client restricted to an allowlist of hosts. Both the requested URL and
 * the final URL after redirects are checked, and every body is size-limited.
 */
export class TrustedHttpClient {
  private readonly allowedHosts: ReadonlySet<string>
  private readonly idleTimeoutMs: number

  constructor(private readonly options: TrustedHttpOptions) {
    this.allowedHosts = new Set(options.allowedHosts)
    this.idleTimeoutMs = options.idleTimeoutMs ?? 60_000
  }

  async getJson<T>(url: string, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
    const text = await this.getText(url, signal, 8 * DEFAULT_TEXT_LIMIT)
    let data: unknown
    try {
      data = JSON.parse(text)
    } catch (error) {
      throw new AppError('OPERATION_FAILED', `Unexpected response from ${new URL(url).host}.`, { cause: error })
    }
    const parsed = schema.safeParse(data)
    if (!parsed.success) {
      throw new AppError('OPERATION_FAILED', `Unexpected response from ${new URL(url).host}.`, { cause: parsed.error })
    }
    return parsed.data
  }

  async getText(url: string, signal?: AbortSignal, maxBytes = DEFAULT_TEXT_LIMIT): Promise<string> {
    return Buffer.from(await this.getBytes(url, signal, maxBytes)).toString('utf8')
  }

  async getBytes(url: string, signal?: AbortSignal, maxBytes = DEFAULT_TEXT_LIMIT): Promise<Uint8Array> {
    const response = await this.request(url, 'GET', signal)
    const chunks: Uint8Array[] = []
    let size = 0
    await this.consume(response, signal, (chunk) => {
      size += chunk.length
      if (size > maxBytes) throw tooLarge(url)
      chunks.push(chunk)
    })
    return Buffer.concat(chunks)
  }

  /** Follows redirects without downloading the body and returns the final URL. */
  async resolveRedirects(url: string, signal?: AbortSignal): Promise<string> {
    const response = await this.request(url, 'HEAD', signal)
    await response.body?.cancel()
    return response.url || url
  }

  /** Streams the body to `destination`, hashing it on the way. */
  async download(url: string, destination: string, options: DownloadOptions): Promise<DownloadResult> {
    const response = await this.request(url, 'GET', options.signal)
    const declared = Number(response.headers.get('content-length'))
    const totalBytes = Number.isFinite(declared) && declared > 0 ? declared : null
    if (totalBytes !== null && totalBytes > options.maxBytes) {
      await response.body?.cancel()
      throw tooLarge(url)
    }

    const hash = createHash('sha256')
    const file = await open(destination, 'wx')
    let size = 0
    try {
      await this.consume(response, options.signal, async (chunk) => {
        size += chunk.length
        if (size > options.maxBytes) throw tooLarge(url)
        hash.update(chunk)
        await file.write(chunk)
        options.onProgress?.({ receivedBytes: size, totalBytes })
      })
    } finally {
      await file.close()
    }
    return { sha256: hash.digest('hex'), size, finalUrl: response.url || url }
  }

  private assertAllowed(raw: string): void {
    let url: URL
    try {
      url = new URL(raw)
    } catch {
      throw new AppError('FORBIDDEN', 'Refused to contact an invalid address.')
    }
    if (url.protocol !== 'https:' || !this.allowedHosts.has(url.hostname)) {
      throw new AppError('FORBIDDEN', `Refused to download from untrusted host ${url.hostname}.`)
    }
  }

  private async request(url: string, method: 'GET' | 'HEAD', signal?: AbortSignal): Promise<Response> {
    this.assertAllowed(url)
    let response: Response
    try {
      response = await this.options.fetch(url, {
        method,
        signal,
        redirect: 'follow',
        headers: { 'User-Agent': this.options.userAgent, Accept: '*/*' }
      })
    } catch (error) {
      throw toNetworkError(error, signal)
    }
    try {
      this.assertAllowed(response.url || url)
    } catch (error) {
      await response.body?.cancel()
      throw error
    }

    if (!response.ok) {
      await response.body?.cancel()
      if ((response.status === 403 || response.status === 429) && response.headers.get('x-ratelimit-remaining') === '0') {
        throw new AppError('NETWORK', 'The GitHub API rate limit has been reached. Please try again later.')
      }
      throw new AppError('NETWORK', `${new URL(url).host} responded with HTTP ${response.status}.`)
    }
    return response
  }

  private async consume(
    response: Response,
    signal: AbortSignal | undefined,
    onChunk: (chunk: Uint8Array) => void | Promise<void>
  ): Promise<void> {
    if (!response.body) return
    const reader = response.body.getReader()
    let idleTimer: ReturnType<typeof setTimeout> | undefined
    let idled = false
    const armIdle = (): void => {
      clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        idled = true
        void reader.cancel()
      }, this.idleTimeoutMs)
    }

    try {
      armIdle()
      for (;;) {
        if (signal?.aborted) throw new AppError('CANCELLED', 'The download was cancelled.')
        let chunk: Awaited<ReturnType<typeof reader.read>>
        try {
          chunk = await reader.read()
        } catch (error) {
          throw toNetworkError(error, signal)
        }
        if (idled) throw new AppError('NETWORK', 'The download stalled. Check your connection and try again.')
        if (chunk.done) break
        armIdle()
        await onChunk(chunk.value)
      }
    } catch (error) {
      await reader.cancel().catch(() => {})
      throw error
    } finally {
      clearTimeout(idleTimer)
    }
  }
}

function tooLarge(url: string): AppError {
  return new AppError('INTEGRITY', `The file from ${new URL(url).host} is larger than expected.`)
}

function toNetworkError(error: unknown, signal: AbortSignal | undefined): AppError {
  if (error instanceof AppError) return error
  if (signal?.aborted) return new AppError('CANCELLED', 'The download was cancelled.')
  return new AppError('NETWORK', 'Network connection failed. Check your internet connection and try again.', {
    cause: error
  })
}
