import { resolve, sep } from 'node:path'

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i
const MAX_LENGTH = 100

/**
 * Turns untrusted text (e.g. a playlist title) into a single folder name that
 * is valid on Windows, macOS and Linux: no path separators or reserved
 * characters, no control characters, no trailing dots/spaces, no reserved
 * device names, and a bounded length.
 */
export function sanitizeFolderName(raw: string, fallback = 'Playlist'): string {
  let name = raw
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  name = [...name].slice(0, MAX_LENGTH).join('').trim()
  // No leading dots (hidden files, "..") and no trailing dots/spaces (invalid on Windows).
  name = name.replace(/^[. ]+/, '').replace(/[. ]+$/, '')
  if (!name || WINDOWS_RESERVED.test(name)) return fallback
  return name
}

/** Joins `child` onto `parent`, refusing anything that would land outside `parent`. */
export function childPath(parent: string, child: string): string {
  const base = resolve(parent)
  const target = resolve(base, child)
  if (target === base || !target.startsWith(base + sep)) {
    throw new Error(`Refusing a path outside ${base}`)
  }
  return target
}
