/**
 * Release notes arrive as HTML (GitHub renders the release's Markdown). They
 * are shown as plain text: no remote markup ever reaches the renderer.
 */
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" }
const MAX_LENGTH = 20_000

export function htmlToText(html: string): string {
  const text = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li(\s[^>]*)?>/gi, '\n• ')
    .replace(/<\/?(p|div|h[1-6]|ul|ol|pre|blockquote|tr)(\s[^>]*)?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+|#39);/gi, (entity, name: string) => {
      const lower = name.toLowerCase()
      if (lower.startsWith('#x')) return safeChar(Number.parseInt(lower.slice(2), 16))
      if (lower.startsWith('#') && lower !== '#39') return safeChar(Number.parseInt(lower.slice(1), 10))
      return ENTITIES[lower] ?? entity
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return text.length > MAX_LENGTH ? `${text.slice(0, MAX_LENGTH - 1)}…` : text
}

function safeChar(code: number): string {
  return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
}

/** electron-updater gives a string, a list of { version, note }, or nothing. */
export function releaseNotesText(notes: string | readonly { version: string; note: string | null }[] | null | undefined): string | null {
  if (!notes) return null
  if (typeof notes === 'string') return htmlToText(notes) || null
  const parts = notes.filter((n) => n.note).map((n) => `${n.version}\n${htmlToText(n.note ?? '')}`)
  return parts.length > 0 ? htmlToText(parts.join('\n\n')) : null
}
