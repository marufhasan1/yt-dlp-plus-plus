/** One downloadable archive and the SHA-256 its provider publishes for it. */
export interface PackageArchive {
  url: string
  fileName: string
  sha256: string
  /** Null when the provider does not publish the size up front. */
  size: number | null
}

/** An engine release delivered as one or more archives, extracted together. */
export interface ArchivePackage {
  /** e.g. "9.0.2" or "2.9.8" */
  version: string
  archives: PackageArchive[]
}
