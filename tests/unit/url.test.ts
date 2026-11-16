import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { isRendererUrl, isSafeExternalUrl, type RendererSource } from '../../electron/utils/url'

describe('isSafeExternalUrl', () => {
  it.each(['https://github.com/yt-dlp/yt-dlp', 'https://example.com/path?q=1#x'])('allows %s', (url) => {
    expect(isSafeExternalUrl(url)).toBe(true)
  })

  it.each([
    'http://example.com',
    'file:///C:/Windows/System32/calc.exe',
    'javascript:alert(1)',
    'ms-settings:privacy',
    'smb://server/share',
    'https://user:pass@example.com',
    'not a url',
    ''
  ])('blocks %s', (url) => {
    expect(isSafeExternalUrl(url)).toBe(false)
  })
})

describe('isRendererUrl', () => {
  const appSource: RendererSource = { kind: 'app', root: join(process.cwd(), 'out', 'renderer') }

  it('accepts the UI on app://mediaflow/index.html, including router hashes', () => {
    expect(isRendererUrl('app://mediaflow/index.html', appSource)).toBe(true)
    expect(isRendererUrl('app://mediaflow/index.html#/settings', appSource)).toBe(true)
  })

  it('rejects local files, other app:// pages and remote pages', () => {
    expect(isRendererUrl(pathToFileURL(join(process.cwd(), 'out', 'renderer', 'index.html')).href, appSource)).toBe(false)
    expect(isRendererUrl('app://mediaflow/evil.html', appSource)).toBe(false)
    expect(isRendererUrl('app://other/index.html', appSource)).toBe(false)
    expect(isRendererUrl('app://user@mediaflow/index.html', appSource)).toBe(false)
    expect(isRendererUrl('https://example.com/index.html', appSource)).toBe(false)
    expect(isRendererUrl('garbage', appSource)).toBe(false)
  })

  it('matches the dev server by origin only', () => {
    const source: RendererSource = { kind: 'dev-server', url: 'http://localhost:5173' }
    expect(isRendererUrl('http://localhost:5173/#/downloads', source)).toBe(true)
    expect(isRendererUrl('http://localhost:5174/', source)).toBe(false)
    expect(isRendererUrl('http://127.0.0.1:5173/', source)).toBe(false)
  })
})
