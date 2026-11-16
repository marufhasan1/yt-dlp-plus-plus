import { describe, expect, it } from 'vitest'
import { historyDeleteSchema, historyQuerySchema } from '@shared/validation/downloads'
import { formatProxy, parseProxy, proxySchema, redactProxy } from '@shared/validation/network'
import { DEFAULT_SETTINGS, settingsPatchSchema } from '@shared/validation/settings'
import { analyzeArgs, downloadArgs, type EngineRuntime } from '../../electron/services/media/ytdlp-command'
import { chromiumProxyRules, proxyLoginFor } from '../../electron/services/network/session-proxy'

describe('proxy addresses', () => {
  it.each([
    ['http://proxy.example:8080', 'http://proxy.example:8080'],
    ['HTTPS://Proxy.Example', 'https://proxy.example'],
    ['socks5h://127.0.0.1:9050/', 'socks5h://127.0.0.1:9050'],
    ['socks4a://10.0.0.1:1080', 'socks4a://10.0.0.1:1080'],
    ['http://user:p%40ss@proxy.example:3128', 'http://user:p%40ss@proxy.example:3128'],
    ['  http://[::1]:8080  ', 'http://[::1]:8080']
  ])('accepts %s', (input, normalised) => {
    expect(proxySchema.parse(input)).toBe(normalised)
  })

  it.each([
    'proxy.example:8080', // no scheme
    'ftp://proxy.example',
    'file:///etc/passwd',
    'http://',
    'http://proxy.example:99999',
    'http://proxy.example/path',
    'http://proxy.example?x=1',
    'http://proxy.example#frag',
    'http://proxy example:80',
    'http://proxy.example:80\n--exec rm',
    '--proxy=http://x',
    `http://${'a'.repeat(2050)}`
  ])('rejects %s', (input) => {
    expect(parseProxy(input)).toBeNull()
    expect(proxySchema.safeParse(input).success).toBe(false)
  })

  it('keeps credentials out of logs', () => {
    expect(redactProxy('http://user:secret@proxy.example:3128')).toBe('http://***@proxy.example:3128')
    expect(formatProxy(parseProxy('socks5://a:b@h:1')!)).toBe('socks5://a:b@h:1')
  })

  it('maps to Chromium rules and extracts the proxy login', () => {
    expect(chromiumProxyRules(parseProxy('socks5h://127.0.0.1:9050')!)).toBe('socks5://127.0.0.1:9050')
    expect(chromiumProxyRules(parseProxy('http://[::1]:8080')!)).toBe('http://[::1]:8080')
    expect(proxyLoginFor('http://user:p%40ss@proxy.example:3128')).toEqual({ host: 'proxy.example', username: 'user', password: 'p@ss' })
    expect(proxyLoginFor('http://proxy.example:3128')).toBeNull()
    expect(proxyLoginFor(null)).toBeNull()
  })
})

describe('advanced settings', () => {
  it('validates ranges and keeps defaults sensible', () => {
    expect(DEFAULT_SETTINGS).toMatchObject({ maxRetries: 3, networkTimeoutSeconds: 30, proxy: null, speedLimitKib: null, logLevel: 'info' })
    expect(settingsPatchSchema.safeParse({ maxRetries: 11 }).success).toBe(false)
    expect(settingsPatchSchema.safeParse({ networkTimeoutSeconds: 1 }).success).toBe(false)
    expect(settingsPatchSchema.safeParse({ speedLimitKib: 10 }).success).toBe(false)
    expect(settingsPatchSchema.safeParse({ logLevel: 'trace' }).success).toBe(false)
    expect(settingsPatchSchema.parse({ proxy: ' socks5://127.0.0.1:1080 ' })).toEqual({ proxy: 'socks5://127.0.0.1:1080' })
    expect(settingsPatchSchema.parse({ proxy: null })).toEqual({ proxy: null })
  })

  it('passes connection settings to every yt-dlp run', () => {
    const runtime: EngineRuntime = {
      ytdlp: '/y',
      ffmpegLocation: '/f',
      deno: null,
      network: { timeoutSeconds: 60, proxy: 'socks5h://127.0.0.1:9050', speedLimitKib: 2048 }
    }
    const analyze = analyzeArgs(runtime, 'https://youtu.be/x')
    expect(analyze.join(' ')).toContain('--socket-timeout 60 --proxy socks5h://127.0.0.1:9050')
    expect(analyze).not.toContain('--limit-rate') // only downloads are limited

    const download = downloadArgs({
      runtime,
      plan: { kind: 'audio', args: ['-f', 'ba'], outputFormat: 'mp3', qualityLabel: null, streams: [], estimatedBytes: null },
      url: 'https://youtu.be/x',
      destination: '/d',
      tempDir: '/t',
      filenameTemplate: 'title',
      skipExisting: true,
      platform: 'linux'
    })
    expect(download.join(' ')).toContain('--limit-rate 2048K')
    expect(download.slice(-2)).toEqual(['--', 'https://youtu.be/x'])

    const plain = analyzeArgs({ ytdlp: '/y', ffmpegLocation: null, deno: null }, 'https://youtu.be/x')
    expect(plain.join(' ')).toContain('--socket-timeout 30')
    expect(plain).not.toContain('--proxy')
  })
})

describe('history requests', () => {
  it('accepts filters and normalises dates', () => {
    expect(
      historyQuerySchema.parse({ search: '  bunny ', format: 'mp4', status: 'failed', from: '2026-01-15T00:00:00+06:00', to: '2026-01-16T00:00:00Z', offset: 0, limit: 50 })
    ).toEqual({ search: 'bunny', format: 'mp4', status: 'failed', from: '2026-01-14T18:00:00.000Z', to: '2026-01-16T00:00:00.000Z', offset: 0, limit: 50 })
  })

  it.each([
    { offset: 0, limit: 500 },
    { offset: -1, limit: 10 },
    { offset: 0, limit: 10, format: "mp4' OR 1=1 --" },
    { offset: 0, limit: 10, status: 'downloading' },
    { offset: 0, limit: 10, from: 'yesterday' },
    { offset: 0, limit: 10, from: '2026-02-01T00:00:00Z', to: '2026-01-01T00:00:00Z' },
    { offset: 0, limit: 10, search: 'x'.repeat(201) },
    { offset: 0, limit: 10, sql: 'DROP TABLE downloads' }
  ])('rejects %o', (query) => {
    expect(historyQuerySchema.safeParse(query).success).toBe(false)
  })

  it('needs an explicit choice about the file', () => {
    expect(historyDeleteSchema.safeParse({ id: '00000000-0000-4000-8000-000000000000' }).success).toBe(false)
    expect(historyDeleteSchema.safeParse({ id: '00000000-0000-4000-8000-000000000000', deleteFile: 'yes' }).success).toBe(false)
    expect(historyDeleteSchema.safeParse({ id: '00000000-0000-4000-8000-000000000000', deleteFile: true, path: '/' }).success).toBe(false)
  })
})
