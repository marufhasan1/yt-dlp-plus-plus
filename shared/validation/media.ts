import { z } from 'zod'

export const MAX_URL_LENGTH = 2048

/**
 * A link the user wants to download from. yt-dlp supports well over a thousand
 * sites, so any http(s) URL is accepted; anything else (file:, javascript:,
 * embedded credentials, oversized input) is rejected before it reaches yt-dlp.
 */
export const mediaUrlSchema = z
  .string()
  .trim()
  .min(1, 'Enter a link')
  .max(MAX_URL_LENGTH, 'This link is too long')
  .refine((value) => parseMediaUrl(value) !== null, 'Enter a valid http:// or https:// link')

export function parseMediaUrl(value: string): URL | null {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  if (!url.hostname || url.username || url.password) return null
  return url
}

export type UrlKind = 'youtube-video' | 'youtube-playlist' | 'youtube-channel' | 'other'

export interface UrlClassification {
  kind: UrlKind
  videoId: string | null
  playlistId: string | null
}

const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com'
])
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/

/**
 * Recognises the common YouTube link shapes so the UI can explain what will be
 * downloaded. Unrecognised links are still valid; yt-dlp decides whether it supports them.
 */
export function classifyMediaUrl(value: string): UrlClassification {
  const url = parseMediaUrl(value)
  const none: UrlClassification = { kind: 'other', videoId: null, playlistId: null }
  if (!url) return none

  const host = url.hostname.toLowerCase()
  const playlistId = url.searchParams.get('list')
  if (host === 'youtu.be') {
    const id = url.pathname.slice(1).split('/')[0] ?? ''
    return VIDEO_ID.test(id) ? { kind: 'youtube-video', videoId: id, playlistId } : none
  }
  if (!YOUTUBE_HOSTS.has(host)) return none

  const [first, second] = url.pathname.split('/').filter(Boolean)
  if (first === 'watch') {
    const id = url.searchParams.get('v') ?? ''
    if (VIDEO_ID.test(id)) return { kind: 'youtube-video', videoId: id, playlistId }
    return playlistId ? { kind: 'youtube-playlist', videoId: null, playlistId } : none
  }
  if ((first === 'shorts' || first === 'live' || first === 'embed' || first === 'v') && second && VIDEO_ID.test(second)) {
    return { kind: 'youtube-video', videoId: second, playlistId }
  }
  if (first === 'playlist' && playlistId) return { kind: 'youtube-playlist', videoId: null, playlistId }
  if (first?.startsWith('@') || first === 'channel' || first === 'c' || first === 'user') {
    return { kind: 'youtube-channel', videoId: null, playlistId: null }
  }
  return none
}

export const analyzeRequestSchema = z.object({ url: mediaUrlSchema }).strict()

const subtitleLanguage = z.string().regex(/^[A-Za-z0-9-]{1,32}$/)

export const downloadSelectionSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('video'),
      container: z.enum(['mp4', 'webm', 'mkv']),
      height: z.union([z.literal('best'), z.number().int().min(1).max(8640)]),
      codec: z.enum(['auto', 'h264', 'hevc', 'vp9', 'av1', 'vp8'])
    })
    .strict(),
  z
    .object({
      kind: z.literal('audio'),
      format: z.enum(['mp3', 'm4a', 'wav', 'flac', 'opus']),
      quality: z.enum(['best', '128', '192', '256', '320'])
    })
    .strict()
])

export const downloadRequestSchema = z
  .object({
    analysisId: z.uuid(),
    selection: downloadSelectionSchema,
    options: z
      .object({
        embedMetadata: z.boolean(),
        embedThumbnail: z.boolean(),
        subtitles: z
          .object({
            languages: z.array(subtitleLanguage).min(1).max(20),
            format: z.enum(['srt', 'vtt']),
            only: z.boolean()
          })
          .strict()
          .nullable()
      })
      .strict()
  })
  .strict()

export const jobIdSchema = z.object({ id: z.uuid() }).strict()

/** Upper bound on entries YT-DLP++ lists for one playlist or channel. */
export const MAX_PLAYLIST_ENTRIES = 1000

export const playlistIdSchema = z.object({ id: z.uuid() }).strict()

export const playlistThumbnailSchema = z
  .object({ id: z.uuid(), position: z.number().int().min(1).max(MAX_PLAYLIST_ENTRIES) })
  .strict()

export const playlistDownloadRequestSchema = z
  .object({
    playlistId: z.uuid(),
    positions: z.union([
      z.literal('all'),
      z.array(z.number().int().min(1).max(MAX_PLAYLIST_ENTRIES)).min(1).max(MAX_PLAYLIST_ENTRIES)
    ]),
    selection: downloadSelectionSchema,
    options: z.object({ embedMetadata: z.boolean(), embedThumbnail: z.boolean() }).strict(),
    numberFiles: z.boolean(),
    skipDownloaded: z.boolean()
  })
  .strict()

/**
 * Turns a bare YouTube channel link into its Videos tab. The bare page lists
 * the channel's tabs (Videos, Shorts, Live) as nested playlists, which is slow
 * to expand and not what "download this channel" usually means.
 */
export function channelVideosUrl(value: string): string {
  const url = parseMediaUrl(value)
  if (!url) return value
  const parts = url.pathname.split('/').filter(Boolean)
  const [first] = parts
  const isChannelRoot =
    (first?.startsWith('@') && parts.length === 1) ||
    ((first === 'channel' || first === 'c' || first === 'user') && parts.length === 2)
  if (!isChannelRoot) return value
  url.pathname = `/${parts.join('/')}/videos`
  url.search = ''
  return url.toString()
}
