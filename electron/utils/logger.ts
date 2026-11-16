import { join } from 'node:path'
import log from 'electron-log/main'

/** Minimal logging contract so services can be tested without electron-log. */
export interface Logger {
  error(...params: unknown[]): void
  warn(...params: unknown[]): void
  info(...params: unknown[]): void
  debug(...params: unknown[]): void
}

/**
 * Configures electron-log to write to `<logsDir>/main.log`.
 * Must be called after the logs path has been resolved.
 */
export function initLogger(logsDir: string, isPackaged: boolean): Logger {
  log.transports.file.resolvePathFn = () => join(logsDir, 'main.log')
  log.transports.file.level = 'info'
  log.transports.file.maxSize = 5 * 1024 * 1024
  log.transports.file.format = '[{iso}] [{level}]{scope} {text}'
  log.transports.console.level = isPackaged ? false : 'debug'
  log.errorHandler.startCatching({ showDialog: false })
  return log
}

/** Detail written to the log file (Settings → Advanced). */
export function setLogLevel(level: 'info' | 'debug'): void {
  log.transports.file.level = level
}

export function scopedLogger(scope: string): Logger {
  return log.scope(scope)
}

/** A logger that discards everything, for tests. */
export const silentLogger: Logger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {}
}
