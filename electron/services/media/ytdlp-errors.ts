import type { DownloadErrorCode } from '@shared/types/downloads'

export interface ClassifiedError {
  code: DownloadErrorCode
  /** Safe to show to the user. */
  message: string
}

/** Ordered: the first matching rule wins, so specific causes come before generic ones. */
const RULES: { code: DownloadErrorCode; pattern: RegExp; message: string }[] = [
  {
    code: 'FFMPEG_MISSING',
    pattern: /ffmpeg (is )?not (found|installed)|ffprobe (is )?not (found|installed)/i,
    message: 'FFmpeg is required for this download but is not available. Install it from Software Updates.'
  },
  {
    code: 'DISK_FULL',
    pattern: /No space left on device|Errno 28|not enough space on the disk/i,
    message: 'There is not enough free disk space for this download.'
  },
  {
    code: 'PERMISSION_DENIED',
    pattern: /Permission denied|Errno 13|Access is denied/i,
    message: 'MediaFlow is not allowed to write to the download folder. Choose another folder in Settings.'
  },
  {
    code: 'PRIVATE_VIDEO',
    pattern: /Private video|This video is private/i,
    message: 'This video is private.'
  },
  {
    code: 'AGE_RESTRICTED',
    pattern: /confirm your age|age[- ]restricted|inappropriate for some users/i,
    message: 'This video is age-restricted and requires signing in, which MediaFlow does not do.'
  },
  {
    code: 'BOT_CHECK',
    pattern: /confirm you(’|')?re not a bot/i,
    message: 'The site asked to confirm you are not a bot. Wait a while and try again.'
  },
  {
    code: 'LOGIN_REQUIRED',
    pattern: /members[- ]only|Join this channel|requires payment|purchase|This video is only available for|login required|sign in to/i,
    message: 'This content requires an account or a purchase.'
  },
  {
    code: 'GEO_BLOCKED',
    pattern: /available in your country|geo[ -]?restrict|blocked it in your country/i,
    message: 'This content is not available in your country.'
  },
  {
    code: 'LIVE_STREAM',
    pattern: /live event will begin|Premieres in|is_upcoming|This live stream recording is not available/i,
    message: 'This live stream has not started or is not available for download yet.'
  },
  {
    code: 'PLAYLIST_UNAVAILABLE',
    pattern: /playlist does not exist|This playlist is private|playlist type is unviewable/i,
    message: 'This playlist does not exist or is private.'
  },
  {
    code: 'VIDEO_UNAVAILABLE',
    pattern: /video is unavailable|Video unavailable|has been removed|account associated with this video has been terminated|does not exist|HTTP Error 404|HTTP Error 410/i,
    message: 'This video is unavailable. It may have been removed, or the link may be wrong.'
  },
  {
    code: 'RATE_LIMITED',
    pattern: /HTTP Error 429|Too Many Requests/i,
    message: 'The site is limiting requests. Wait a few minutes and try again.'
  },
  {
    code: 'UNSUPPORTED_URL',
    pattern: /Unsupported URL|is not a valid URL|no suitable InfoExtractor/i,
    message: 'This link is not supported.'
  },
  {
    code: 'FORMAT_UNAVAILABLE',
    pattern: /Requested format is not available|No video formats found/i,
    message: 'The selected format is no longer available. Analyze the link again and pick another format.'
  },
  {
    code: 'NETWORK',
    pattern:
      /Failed to resolve|getaddrinfo|Name or service not known|timed out|Connection (refused|reset|aborted)|Network is unreachable|TransportError|urlopen error|Remote end closed|SSL|certificate verify failed|IncompleteRead/i,
    message: 'Network connection failed. Check your internet connection and try again.'
  }
]

/**
 * Maps yt-dlp's stderr to a stable error code and a user-facing message.
 * Unknown errors keep yt-dlp's own text (it is written for end users), with
 * the "ERROR: [extractor] id:" prefix removed.
 */
export function classifyYtDlpError(stderr: string): ClassifiedError {
  const lines = stderr.split(/\r?\n/).map((line) => line.trim())
  // Some errors are printed as "ERROR: \r[download] Got error: …", so the message lands on a line of its own.
  const errorLines = lines.filter((line) => line.startsWith('ERROR:') && line.replace(/^ERROR:\s*/, '') !== '')
  const gotErrors = lines.filter((line) => /^\[[^\]]+\] Got error:/.test(line))
  const meaningful = [...errorLines, ...gotErrors]
  const text = meaningful.length > 0 ? meaningful.join('\n') : stderr
  for (const rule of RULES) {
    if (rule.pattern.test(text)) return { code: rule.code, message: rule.message }
  }
  const last = meaningful.at(-1)
  const cleaned = last
    ?.replace(/^ERROR:\s*/, '')
    .replace(/^\[[^\]]+\]\s*Got error:\s*/, '')
    .replace(/^\[[^\]]+\]\s*[^:\s]+:\s*/, '')
    .trim()
  return {
    code: 'UNKNOWN',
    message: cleaned ? truncate(cleaned, 300) : 'yt-dlp stopped unexpectedly. Details were written to the log file.'
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}
