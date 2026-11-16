import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveAppAsset } from '../../electron/app-protocol'

describe('app:// asset resolution', () => {
  const root = resolve('/opt/mediaflow/resources/app.asar/out/renderer')

  it('serves the UI files', () => {
    expect(resolveAppAsset(root, 'app://mediaflow/index.html')).toBe(join(root, 'index.html'))
    expect(resolveAppAsset(root, 'app://mediaflow/')).toBe(join(root, 'index.html'))
    expect(resolveAppAsset(root, 'app://mediaflow/assets/index-BhyOHZnx.js')).toBe(join(root, 'assets', 'index-BhyOHZnx.js'))
    expect(resolveAppAsset(root, 'app://mediaflow/index.html#/settings')).toBe(join(root, 'index.html'))
    expect(resolveAppAsset(root, 'app://mediaflow/assets/a%20b.css')).toBe(join(root, 'assets', 'a b.css'))
  })

  it('keeps dot segments inside the folder (the URL parser removes them first)', () => {
    expect(resolveAppAsset(root, 'app://mediaflow/../main/index.js')).toBe(join(root, 'main', 'index.js'))
    expect(resolveAppAsset(root, 'app://mediaflow/%2e%2e/main/index.js')).toBe(join(root, 'main', 'index.js'))
  })

  it.each([
    'app://mediaflow/assets/..%2f..%2f..%2fpackage.json',
    'app://mediaflow/..%5c..%5cpackage.json',
    'app://mediaflow/C:%5cWindows%5cwin.ini',
    'app://mediaflow/%00index.html',
    'app://mediaflow/%E0%A4%A',
    'app://other/index.html',
    'file:///opt/mediaflow/resources/app.asar/out/renderer/index.html',
    'app://mediaflow/assets/script.exe',
    'app://mediaflow/preload.cjs',
    'not a url'
  ])('refuses %s', (url) => {
    expect(resolveAppAsset(root, url)).toBeNull()
  })
})
