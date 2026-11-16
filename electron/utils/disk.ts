import { statfs } from 'node:fs/promises'
import { AppError } from './errors'

export async function freeBytes(directory: string): Promise<number> {
  const stats = await statfs(directory)
  return stats.bavail * stats.bsize
}

/** Throws INSUFFICIENT_SPACE when `directory`'s volume has less than `requiredBytes` available. */
export async function ensureFreeSpace(directory: string, requiredBytes: number): Promise<void> {
  const available = await freeBytes(directory)
  if (available < requiredBytes) {
    throw new AppError(
      'INSUFFICIENT_SPACE',
      `Not enough disk space. ${formatMegabytes(requiredBytes)} is needed but only ${formatMegabytes(available)} is available.`
    )
  }
}

function formatMegabytes(bytes: number): string {
  return `${Math.ceil(bytes / (1024 * 1024))} MB`
}
