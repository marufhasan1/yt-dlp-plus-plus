import type { IpcError, IpcErrorCode, IpcResult } from '@shared/types/ipc'

/** Thrown in the renderer when a bridge call returns an error envelope. */
export class BridgeError extends Error {
  readonly code: IpcErrorCode

  constructor(error: IpcError) {
    super(error.message)
    this.name = 'BridgeError'
    this.code = error.code
  }
}

/** Unwraps an IpcResult envelope, throwing a BridgeError on failure. */
export async function unwrap<T>(call: Promise<IpcResult<T>>): Promise<T> {
  const result = await call
  if (!result.ok) throw new BridgeError(result.error)
  return result.data
}

export function errorMessage(error: unknown): string {
  if (error instanceof BridgeError) return error.message
  return 'Something went wrong. Please try again.'
}

/** The typed bridge exposed by the preload script. */
export const bridge = window.ytdlpp
