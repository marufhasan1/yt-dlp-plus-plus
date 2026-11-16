# Changelog

All notable changes to YT-DLP++ are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). The release workflow publishes the section
matching the tag as the release notes.

## [1.0.0] - 2026-11-16

First public release.

### Downloads

- Paste a link to analyse a video: title, thumbnail, duration and every available format,
  discovered from the source rather than a fixed list.
- Download video (MP4, WebM, MKV) at the chosen resolution and codec, or audio only (MP3,
  M4A, WAV, FLAC, OPUS) with quality options; embed metadata, cover art and subtitles.
- Playlists and channels: list up to 1000 entries, select individual videos, ranges or all,
  and download them with one format profile into an optional playlist folder. Unavailable
  entries are shown and skipped.
- Download manager: queue with configurable concurrency, live progress (speed, time left,
  size), pause and resume that keep partial files, cancel, manual and automatic retries for
  network errors.
- Recovery after a crash or restart: interrupted downloads come back paused with their
  partial files, and leftover engine processes are stopped.
- History with search and filters; open the file's location, retry, or remove an entry (the
  file is moved to the Recycle Bin / Trash only if you ask). Duplicate downloads are detected.
- Advanced settings: retries, network timeout, speed limit, proxy (with authentication), log
  detail.

### Audio converter

- Convert local audio and video files to MP3, M4A, OPUS, FLAC or WAV, up to 200 at a time,
  keeping metadata and cover art. Outputs are checked with FFprobe before they appear under
  their final name, and existing files are never overwritten.

### Engines and updates

- yt-dlp, FFmpeg/FFprobe and Deno are installed on request from their official sources and
  verified (checksums, plus the yt-dlp maintainers' signature) before use. System copies are
  detected and never modified.
- Update checks for every engine, with stable and nightly yt-dlp channels; updates are
  verified, run in place, and wait for running downloads. The previous version is kept so an
  update can be rolled back.
- YT-DLP++ updates itself from GitHub Releases (installer and AppImage builds), with release
  notes, download progress and SHA-512 verification.

### Interface

- Dark (default), light and system themes; sidebar navigation with markers for available
  updates; in-app notices for updates and recovered downloads.

### Security

- Sandboxed interface with context isolation, a strict Content Security Policy and the app's
  own `app://` scheme instead of `file://`; every IPC message is validated.
- Packaged apps cannot be run as plain Node.js, ignore `NODE_OPTIONS` and inspector flags,
  and load only their integrity-checked app archive (Electron fuses).
- Files reported by the download engine outside the chosen folder are ignored; FFmpeg reads
  local files only; yt-dlp plugins are not loaded; the clipboard is read only for links;
  thumbnails are not decoded in the main process.

### Distribution

- Windows installer (x64 and ARM64 in one file) and portable build; macOS DMG and ZIP (Intel
  and Apple silicon); Linux AppImage, DEB and RPM (x64 and ARM64).
- `SHA256SUMS.txt` with every release; full license texts for all bundled components in the
  app.
