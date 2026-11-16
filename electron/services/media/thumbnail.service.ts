import { isIP } from 'node:net'
import type { Logger } from '../../utils/logger'
import type { FetchFn } from '../network/trusted-http'

export interface RawThumbnail {
  url: string
  width?: number | null
  height?: number | null
  preference?: number | null
}

/** Turns downloaded image bytes into a data URL for the renderer, or null if they are not an acceptable image. */
export type ImageEncoder = (data: Buffer, maxWidth: number) => string | null

const MAX_BYTES = 5 * 1024 * 1024
const TIMEOUT_MS = 15_000
const DEFAULT_WIDTH = 480
/** Decoded thumbnails kept in memory, so scrolling a long playlist back and forth is free. */
const CACHE_ENTRIES = 600

/**
 * Picks a thumbnail around `targetWidth` px wide (never much smaller),
 * preferring JPEG/PNG (always decodable) over WebP, and falls back to the
 * info dict's main thumbnail.
 */
export function selectThumbnailUrl(
  thumbnails: readonly RawThumbnail[] | null | undefined,
  fallback: string | null,
  targetWidth = DEFAULT_WIDTH
): string | null {
  const minimum = Math.round(targetWidth * 0.66)
  const usable = (thumbnails ?? []).filter((t) => typeof t.url === 'string' && t.url.startsWith('https://'))
  const scored = usable
    .map((t) => {
      const isWebp = /\.webp(\?|$)/i.test(t.url)
      const width = t.width ?? null
      const distance =
        width === null ? 10_000 : width < minimum ? 5_000 + (minimum - width) : Math.abs(width - targetWidth)
      return { url: t.url, score: distance + (isWebp ? 20_000 : 0) }
    })
    .sort((a, b) => a.score - b.score)
  return scored[0]?.url ?? (fallback?.startsWith('https://') ? fallback : null)
}

const MAX_PASSTHROUGH_BYTES = 512 * 1024

/**
 * Electron's image encoder cannot read WebP, yet YouTube serves its signed
 * thumbnail URLs (`hqdefault.jpg?sqp=…`, the only kind flat playlist entries
 * carry) as WebP despite the `.jpg` name. Small, genuine WebP files (checked by
 * their RIFF/WEBP signature, not the header) are handed to the renderer as-is;
 * its sandboxed image decoder displays them and the CSP already allows data: images.
 */
export function passThroughWebp(bytes: Buffer): string | null {
  const isWebp = bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
  return isWebp && bytes.length <= MAX_PASSTHROUGH_BYTES ? `data:image/webp;base64,${bytes.toString('base64')}` : null
}

/** The image type named by the file's own signature (never by headers or extension). */
export function sniffImage(bytes: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  return null
}

/**
 * The production encoder: images from page metadata are never decoded in the
 * main process (an image-decoder bug there would run with full privileges).
 * Small JPEG/PNG/WebP files, identified by their signature, are handed to the
 * sandboxed renderer as they are; anything else is dropped.
 */
export const passThroughImage: ImageEncoder = (bytes) => {
  const type = sniffImage(bytes)
  return type && bytes.length <= MAX_PASSTHROUGH_BYTES ? `data:${type};base64,${bytes.toString('base64')}` : null
}

/**
 * Thumbnail URLs come from untrusted page metadata, so they must not be able
 * to make the app contact local or private-network services.
 */
export function isPublicHttpsUrl(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol !== 'https:' || url.username || url.password) return false
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return false
  }
  const version = isIP(host)
  if (version === 4) {
    const [a = 0, b = 0] = host.split('.').map(Number)
    return !(a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224)
  }
  if (version === 6) {
    return !(host === '::' || host === '::1' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host) || host.startsWith('::ffff:'))
  }
  return true
}

/**
 * Downloads a thumbnail in the main process and hands the renderer a data URL,
 * so the renderer's Content Security Policy never has to allow remote images
 * and the user's IP and referrer are not sent from the UI. Failures return
 * null: a missing thumbnail is never fatal.
 */
export class ThumbnailService {
  private readonly cache = new Map<string, string>()

  constructor(
    private readonly fetch: FetchFn,
    private readonly encode: ImageEncoder,
    private readonly logger: Logger
  ) {}

  /** Like `load`, but remembers successful results per URL and width. Failures are retried next time. */
  async cached(url: string | null, maxWidth: number, signal?: AbortSignal): Promise<string | null> {
    if (!url) return null
    const key = `${maxWidth}|${url}`
    const hit = this.cache.get(key)
    if (hit) return hit
    const result = await this.load(url, signal, maxWidth)
    if (!result) return null
    this.cache.set(key, result)
    while (this.cache.size > CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value
      if (oldest === undefined) break
      this.cache.delete(oldest)
    }
    return result
  }

  async load(url: string | null, signal?: AbortSignal, maxWidth = DEFAULT_WIDTH): Promise<string | null> {
    if (!url || !isPublicHttpsUrl(url)) return null
    const timeout = AbortSignal.timeout(TIMEOUT_MS)
    try {
      // No redirects: the public-address check above must hold for the only host contacted.
      const response = await this.fetch(url, {
        method: 'GET',
        redirect: 'error',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: { Accept: 'image/*' }
      })
      if (!response.ok || !isPublicHttpsUrl(response.url || url)) {
        await response.body?.cancel()
        return null
      }
      const type = response.headers.get('content-type') ?? ''
      const declared = Number(response.headers.get('content-length'))
      if (!type.startsWith('image/') || declared > MAX_BYTES) {
        await response.body?.cancel()
        return null
      }
      const bytes = Buffer.from(await response.arrayBuffer())
      if (bytes.length === 0 || bytes.length > MAX_BYTES) return null
      return this.encode(bytes, maxWidth) ?? passThroughWebp(bytes)
    } catch (error) {
      this.logger.debug('Thumbnail could not be loaded', error)
      return null
    }
  }
}
