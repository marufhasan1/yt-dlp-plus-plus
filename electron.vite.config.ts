import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import type { Plugin } from 'vite'

const sharedAlias = { '@shared': resolve(__dirname, 'shared') }

/**
 * Injects the Content Security Policy into index.html.
 * The dev server needs a WebSocket connection for HMR and inline <style> tags
 * for CSS injection; production builds get the strict policy.
 */
function contentSecurityPolicy(): Plugin {
  let isDev = false
  return {
    name: 'mediaflow:csp',
    configResolved(config) {
      isDev = config.command === 'serve'
    },
    transformIndexHtml() {
      const directives = [
        "default-src 'self'",
        "script-src 'self'",
        isDev ? "style-src 'self' 'unsafe-inline'" : "style-src 'self'",
        "img-src 'self' data:",
        "font-src 'self'",
        isDev ? "connect-src 'self' ws:" : "connect-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-src 'none'",
        "worker-src 'none'"
      ]
      return [
        {
          tag: 'meta',
          attrs: { 'http-equiv': 'Content-Security-Policy', content: directives.join('; ') },
          injectTo: 'head-prepend'
        }
      ]
    }
  }
}

/**
 * Records which npm packages end up inside a bundle (main, preload or
 * renderer), so scripts/licenses.mjs can ship their license texts: code that
 * is bundled no longer carries its package's LICENSE file.
 */
function bundledPackages(target: 'main' | 'preload' | 'renderer'): Plugin {
  return {
    name: 'mediaflow:bundled-packages',
    apply: 'build',
    generateBundle(_options, bundle) {
      const packages = new Set<string>()
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk') continue
        for (const id of Object.keys(chunk.modules)) {
          const match = /node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)/.exec(id.split('?')[0] ?? '')
          if (match?.[1]) packages.add(match[1].replace(/\\/g, '/'))
        }
      }
      const dir = resolve(__dirname, 'out')
      mkdirSync(dir, { recursive: true })
      writeFileSync(resolve(dir, `bundled-packages.${target}.json`), `${JSON.stringify([...packages].sort(), null, 2)}\n`)
    }
  }
}

export default defineConfig({
  main: {
    resolve: { alias: sharedAlias },
    plugins: [bundledPackages('main')],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'electron/main.ts') }
      }
    }
  },
  preload: {
    resolve: { alias: sharedAlias },
    plugins: [bundledPackages('preload')],
    build: {
      // Sandboxed preload scripts can only require('electron'), so shared
      // modules must be bundled into the single preload file.
      externalizeDeps: false,
      rollupOptions: {
        input: { index: resolve(__dirname, 'electron/preload.ts') }
      }
    }
  },
  renderer: {
    root: __dirname,
    resolve: {
      alias: {
        ...sharedAlias,
        '@': resolve(__dirname, 'src')
      }
    },
    plugins: [vue(), tailwindcss(), contentSecurityPolicy(), bundledPackages('renderer')],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'index.html') }
      }
    }
  }
})
