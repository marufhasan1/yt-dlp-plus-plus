import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveAppAsset } from '../../electron/app-protocol'

describe('app:// asset resolution', () => {
  const root = resolve('/opt/ytdlpp/resources/app.asar/out/renderer')

  it('serves the UI files', () => {
    expect(resolveAppAsset(root, 'app://ytdlpp/index.html')).toBe(join(root, 'index.html'))
    expect(resolveAppAsset(root, 'app://ytdlpp/')).toBe(join(root, 'index.html'))
    expect(resolveAppAsset(root, 'app://ytdlpp/assets/index-BhyOHZnx.js')).toBe(join(root, 'assets', 'index-BhyOHZnx.js'))
    expect(resolveAppAsset(root, 'app://ytdlpp/index.html#/settings')).toBe(join(root, 'index.html'))
    expect(resolveAppAsset(root, 'app://ytdlpp/assets/a%20b.css')).toBe(join(root, 'assets', 'a b.css'))
  })

  it('keeps dot segments inside the folder (the URL parser removes them first)', () => {
    expect(resolveAppAsset(root, 'app://ytdlpp/../main/index.js')).toBe(join(root, 'main', 'index.js'))
    expect(resolveAppAsset(root, 'app://ytdlpp/%2e%2e/main/index.js')).toBe(join(root, 'main', 'index.js'))
  })

  it.each([
    'app://ytdlpp/assets/..%2f..%2f..%2fpackage.json',
    'app://ytdlpp/..%5c..%5cpackage.json',
    'app://ytdlpp/C:%5cWindows%5cwin.ini',
    'app://ytdlpp/%00index.html',
    'app://ytdlpp/%E0%A4%A',
    'app://other/index.html',
    'file:///opt/ytdlpp/resources/app.asar/out/renderer/index.html',
    'app://ytdlpp/assets/script.exe',
    'app://ytdlpp/preload.cjs',
    'not a url'
  ])('refuses %s', (url) => {
    expect(resolveAppAsset(root, url)).toBeNull()
  })
})
