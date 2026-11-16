import { ZodError } from 'zod'
import type { IpcError, IpcErrorCode } from '@shared/types/ipc'

/**
 * An error whose message is safe to show to the user. Anything else that
 * reaches the IPC boundary is logged and replaced with a generic message.
 */
export class AppError extends Error {
  readonly code: IpcErrorCode

  constructor(code: IpcErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'AppError'
    this.code = code
  }
}

export function formatZodError(error: ZodError): string {
  return error.issues
    .map((issue) => (issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message))
    .join('; ')
}

export function toIpcError(error: unknown): IpcError {
  if (error instanceof AppError) {
    return { code: error.code, message: error.message }
  }
  if (error instanceof ZodError) {
    return { code: 'VALIDATION_FAILED', message: `Invalid request: ${formatZodError(error)}` }
  }
  return {
    code: 'INTERNAL',
    message: 'An unexpected error occurred. Details were written to the log file.'
  }
}
