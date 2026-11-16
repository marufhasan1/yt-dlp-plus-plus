/*
 * Version comparison for update checks. Versions are compared numerically,
 * part by part — never as strings, where "2026.9.1" would sort after
 * "2026.10.26" and "9.0.10" before "9.0.2".
 */

/** Numeric parts of a version: "v2.9.8" → [2, 9, 8], "2026.11.04.232659" → [2026, 11, 4, 232659]. */
export function versionParts(version: string): number[] | null {
  const match = /^[vn]?(\d+(?:\.\d+)*)/i.exec(version.trim())
  if (!match?.[1]) return null
  return match[1].split('.').map(Number)
}

/** -1, 0 or 1. Missing parts count as 0 ("9.0" equals "9.0.0"). Unparseable versions compare equal. */
export function compareVersions(a: string, b: string): number {
  const left = versionParts(a)
  const right = versionParts(b)
  if (!left || !right) return 0
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0)
    if (difference !== 0) return Math.sign(difference)
  }
  return 0
}

export interface FfmpegBuild {
  version: string
  /** Commits on the release branch after the tagged version (BtbN "n9.0.2-48-g…" builds); 0 for a tagged release. */
  commits: number
}

/**
 * Reads a release-branch build identifier such as "n9.0.2-48-gd4070a14ce" or
 * "n9.0.2-48-gd4070a14ce-20261109" (as `ffmpeg -version` prints it), or a plain
 * "9.0.2". Git master builds ("N-121456-g…") and vendor strings are not comparable: null.
 */
export function parseFfmpegBuild(build: string): FfmpegBuild | null {
  const match = /^n?(\d+\.\d+(?:\.\d+)?)(?:-(\d+)-g[0-9a-f]+)?(?:-\d{8})?$/i.exec(build.trim())
  if (!match?.[1]) return null
  return { version: match[1], commits: match[2] ? Number(match[2]) : 0 }
}

/** Positive when `candidate` is a newer FFmpeg build than `installed`. */
export function compareFfmpegBuilds(candidate: FfmpegBuild, installed: FfmpegBuild): number {
  return compareVersions(candidate.version, installed.version) || Math.sign(candidate.commits - installed.commits)
}
