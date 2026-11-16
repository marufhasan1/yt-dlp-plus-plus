import { app, session, type WebFrameMain } from 'electron'
import type { Logger } from './utils/logger'
import { isRendererUrl, type RendererSource } from './utils/url'

export type { RendererSource } from './utils/url'

/** IPC is accepted only from the top-level frame of our own renderer. */
export function createSenderValidator(source: RendererSource) {
  return (frame: WebFrameMain | null): boolean =>
    frame !== null && frame.parent === null && isRendererUrl(frame.url, source)
}

/**
 * Applies process-wide restrictions: no permission grants, no new windows,
 * no navigation away from the renderer, no <webview>.
 */
export function installSecurityPolicies(source: RendererSource, logger: Logger): void {
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
    logger.warn(`Denied permission request: ${permission}`)
    callback(false)
  })
  session.defaultSession.setPermissionCheckHandler(() => false)

  app.on('web-contents-created', (_event, contents) => {
    // The UI never opens windows; external pages are opened by the main process
    // through specific IPC calls (e.g. release notes) with their own allow-lists.
    contents.setWindowOpenHandler(({ url }) => {
      logger.warn(`Blocked window.open to ${url}`)
      return { action: 'deny' }
    })

    const blockForeignNavigation = (event: Electron.Event, url: string): void => {
      if (!isRendererUrl(url, source)) {
        event.preventDefault()
        logger.warn(`Blocked navigation to ${url}`)
      }
    }
    contents.on('will-navigate', blockForeignNavigation)
    contents.on('will-redirect', blockForeignNavigation)

    contents.on('will-attach-webview', (event) => {
      event.preventDefault()
      logger.warn('Blocked <webview> attachment')
    })
  })
}
