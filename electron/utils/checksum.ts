import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'

const SHA256_HEX = /^[a-f0-9]{64}$/

export function isSha256(value: string): boolean {
  return SHA256_HEX.test(value)
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer)
  }
  return hash.digest('hex')
}

/**
 * Parses `sha256sum`-style output ("<hex>  <name>" or "<hex> *<name>") into a
 * name → lowercase hash map. Malformed lines are ignored.
 */
export function parseChecksumList(text: string): Map<string, string> {
  const entries = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const match = /^([a-fA-F0-9]{64})\s+\*?(.+?)\s*$/.exec(line)
    if (match?.[1] && match[2]) {
      entries.set(match[2], match[1].toLowerCase())
    }
  }
  return entries
}

/** GitHub release assets report `digest: "sha256:<hex>"`. Returns the hex part, or null if absent or another algorithm. */
export function sha256FromDigest(digest: string | null | undefined): string | null {
  if (!digest?.startsWith('sha256:')) return null
  const hex = digest.slice('sha256:'.length).toLowerCase()
  return isSha256(hex) ? hex : null
}
