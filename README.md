# MediaFlow

A cross-platform desktop media downloader for Windows, macOS and Linux, built
on Electron, Vue 3 and TypeScript, using yt-dlp and FFmpeg as managed media
engines.

> **Status: Phase 4 (Playlist Downloader) complete.** You can download single
> videos and whole or partial playlists (and a channel's videos) with live
> progress. The audio converter, pause/resume, history and update checks arrive
> in later phases — see [PROJECT_PLAN.md](PROJECT_PLAN.md).

MediaFlow is intended for downloading content you own or are otherwise
authorized to download. Respect copyright and the terms of the platforms you
use.

## Requirements

- Node.js 22.12 or newer (Node 24 recommended)
- npm 10 or newer

No Python, C++ toolchain or separate yt-dlp installation is needed.

## Getting started

```bash
npm install
npm run dev
```

`npm run dev` starts the Vite dev server with hot reload for the interface and
launches Electron. Changes to `electron/` rebuild and restart the app.

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Run in development mode with hot reload |
| `npm run build` | Type-check, then build main, preload and renderer into `out/` |
| `npm run preview` | Run the production build locally |
| `npm run typecheck` | Type-check the main process and the renderer |
| `npm run lint` | ESLint (TypeScript + Vue) |
| `npm test` | Unit tests (Vitest) |
| `npm run test:e2e` | Build, then run Electron application tests (Playwright) |
| `npm run dist` | Build installers for the current platform into `release/` (see Building and releasing) |
| `npm run dist:dir` | Build an unpacked application (faster; no update feed on Windows) |

## Project layout

```
electron/            Main process and preload (Node.js side)
  main.ts            App lifecycle and service wiring
  preload.ts         The only bridge between renderer and main
  security.ts        Permission, navigation and IPC sender policies
  ipc/               Typed, validated IPC handlers
  services/          Business logic (settings, storage, … more per phase)
  database/          SQLite schema migrations
  utils/             Logging, paths, errors, URL checks
src/                 Renderer (Vue 3, no Node.js access)
  api/               Wrapper around the preload bridge
  components/        UI components (common, layout, settings, …)
  composables/       Reusable view logic (theme)
  layouts/ pages/    Application shell and routed pages
  stores/            Pinia stores
shared/              Code shared by both sides: IPC contract, types, Zod schemas
resources/           Packaging assets, per-platform engine folders, licenses
scripts/             Build helpers (dist.mjs adds the update feed to packaged builds)
tests/unit/          Vitest unit tests
tests/integration/   Tests that spawn real processes (Node.js, system tar, FFmpeg when installed)
tests/fixtures/      Real captured engine output and signed release data
tests/e2e/           Playwright tests that drive the real Electron app
```

## Downloading

1. Install the media engines once from **Software Updates** (yt-dlp and FFmpeg are required;
   the JavaScript runtime is recommended for YouTube).
2. On **Home**, paste a link and choose **Analyze**. MediaFlow lists only the formats and
   resolutions that video actually offers.
3. Choose **Video** (MP4, WebM or MKV and a resolution) or **Audio only** (MP3, M4A, OPUS,
   FLAC or WAV), optionally subtitles, and select **Download**.
4. Follow progress on **Downloads**: pause, resume, cancel, retry, show the file, or remove it
   from the list (the file is kept). **Pause all** / **Resume all** act on every download.

Defaults (formats, quality, folder, file names, simultaneous downloads) are in
**Settings → Downloads**. Partial files are kept in the app's data folder, never in your
download folder.

### Pausing, resuming and recovery

- **Pause** stops a download and keeps what was already downloaded; **Resume** continues
  from there. A download that is being finished (merging or converting) cannot be paused.
- If the connection drops, MediaFlow resumes the download automatically after 5 s, 15 s,
  45 s… (Settings → Advanced → Automatic retries).
- If MediaFlow is closed, or crashes, while downloading, the downloads come back paused on
  the next start with their partial files, and the Downloads page offers **Resume all**.
- Analysing a video you downloaded before shows when and in which format. Starting the same
  video in the same format while it is still downloading or paused is refused. Playlist
  downloads skip videos already downloaded in that format (option, on by default).

### History

**History** lists finished downloads, including ones removed from the Downloads page.
Search by title or link, filter by format, result (completed, failed, cancelled) and date,
open the file's folder, retry failed downloads, or delete entries. Deleting an entry keeps
the downloaded file unless you tick "Also move the downloaded file to the Recycle Bin /
Trash".

### Playlists and channels

Paste a playlist link (or a channel link, which lists the channel's videos) on **Home** or
**Playlists**. MediaFlow lists up to 1000 videos with their thumbnails and durations; private,
deleted and members-only videos are shown but skipped.

- Tick videos (Shift+click selects a range), or use **Select all**, then **Download selected**
  — or **Download all**.
- Choose one profile for the whole batch: video format with a maximum resolution and codec
  preference, or an audio format and quality. Each video gets the closest match it offers.
- Files go into a folder named after the playlist (turn off in **Settings → Downloads**)
  and can be numbered in playlist order (`003 - Title.mp4`).
- Every video becomes its own download with its own progress, retry and cancel; the playlist
  shows overall progress and each video's status, which is kept between sessions.
- **Refresh** re-lists a playlist (new videos appear; finished ones stay marked);
  removing a playlist from the list never deletes files.

## Converting audio

The **Audio Converter** converts files already on your computer. FFmpeg and FFprobe must be
installed (see Software Updates).

1. Choose **Add files** and pick audio files, or video files to take the audio from. Each file
   is checked with FFprobe and shown with its format, sample rate, channels, bitrate,
   length and tags. Damaged or unsupported files are marked and skipped.
2. Choose the output **format** (MP3, M4A, OPUS, FLAC or WAV) and, for MP3/M4A/OPUS, the
   **quality** (128–320 kbps, or Best). With Best, a file already in the target codec is
   kept as it is instead of being re-encoded.
3. Choose where to **save**: your download folder, next to each original, or another folder.
4. Select **Convert**. Files are converted one at a time, with progress, speed and time left;
   cancel at any time.

Existing files are never overwritten (`Song.mp3` becomes `Song (1).mp3`). Each result is
checked with FFprobe before it gets its final name, so a cancelled or failed conversion leaves
nothing behind. Titles, artists and other tags are kept; cover art is kept in MP3, M4A and FLAC.
The conversion list lasts until MediaFlow closes.

## Advanced settings

**Settings → Advanced**: automatic retries after network problems, network timeout, a speed
limit per download, a proxy, and the detail written to the log file.

The proxy (`http`, `https`, `socks4`, `socks4a`, `socks5`, `socks5h`, e.g.
`socks5h://127.0.0.1:9050` or `http://user:password@proxy.example:8080`) is used by
yt-dlp and by MediaFlow's own requests (thumbnails, engine downloads). A user name and
password are stored unencrypted in MediaFlow's settings on this computer. Speed limit and
proxy apply to downloads started or resumed after the change.

## Media engines

MediaFlow uses yt-dlp, FFmpeg, FFprobe and (recommended) Deno as separate programs. It finds them in
this order:

1. its own engines folder (`<userData>/engines/<platform>-<arch>`), where it installs them;
2. engines bundled with the package (none at the moment);
3. copies already installed on your system (`PATH`, Homebrew, `/usr/local/bin`, …).

Open **Software Updates** to see each engine's status, version and location. If one is
missing or broken, choose **Install** or **Repair**. Nothing is downloaded without
your confirmation. Downloads come only from fixed, trusted sources and are verified
before they are installed:

- **yt-dlp**: official GitHub releases; the checksum list's GPG signature is checked
  against yt-dlp's release key.
- **FFmpeg + FFprobe**: BtbN LGPL builds on Windows and Linux, Martin Riedl's
  builds on macOS; checked against the provider's SHA-256.
- **Deno** (the JavaScript runtime yt-dlp needs for full YouTube support): official
  GitHub releases, checked against the published SHA-256. yt-dlp runs it sandboxed.

**Check again** re-hashes managed engines to detect corruption. On Linux systems
using musl (e.g. Alpine), install FFmpeg with your package manager.

## Software updates

**Software Updates** shows MediaFlow and each media engine with the installed version, the
latest version, when it was last checked and its status. **Check all for updates** checks
everything; each card also has its own **Check** button.

- **Engines**: **Update** downloads the new version from the same trusted source as an
  install, verifies it, runs it, swaps it in and runs it again; if anything fails, the
  previous version stays. The replaced version is kept, so **Roll back** can restore it (and
  rolling back can be undone the same way). If downloads or conversions are using the engine,
  the update waits until they finish. Copies installed by your system are never replaced;
  MediaFlow can install its own copy instead.
- **yt-dlp channel**: stable (default) or nightly, in Settings → Updates. Switching offers the
  other channel's latest build.
- **MediaFlow itself**: **Download** fetches the new version and verifies it; **Restart to
  update** installs it. Running downloads are paused and can be resumed afterwards.
- **Automatic checks** (Settings → Updates): on by default, every day (6 hours to a week). They
  never install anything, except yt-dlp if you turn on automatic yt-dlp updates.
- The **Update history** lists every install, update and rollback, including failures.

## Building and releasing

Application updates come from GitHub Releases. Give the repository when building:

```bash
MEDIAFLOW_GITHUB_OWNER=<owner> MEDIAFLOW_GITHUB_REPO=<repo> npm run dist
```

`scripts/dist.mjs` adds the GitHub publish settings to `electron-builder.yml` for that build.
electron-builder then embeds `app-update.yml` in the app and writes `latest.yml` (and a
`.blockmap`) next to each installer. Upload the installers together with these files to a
GitHub release tagged `v<version>`. Builds made without the two variables have no update
feed; the Software Updates page says so. Nothing is published from local builds
(`--publish never`).

To try the updater in development, point it at a test feed (development runs only):
`MEDIAFLOW_DEV_UPDATE_CONFIG=/path/to/dev-app-update.yml npm run dev`, with e.g.
`provider: generic` and `url: http://127.0.0.1:8080/`.

## Renaming the product

The product name is read from `productName` in `package.json`. It is used for
the window title, the per-user data folder, the sidebar and the installers.
Change it there, plus the `<title>` in `index.html` and `appId` in
`electron-builder.yml`.

## Where data is stored

| Data | Location |
| --- | --- |
| Settings and database | `<userData>/mediaflow.db` |
| Logs | `<userData>/logs` (Windows, Linux), `~/Library/Logs/MediaFlow` (macOS) |
| Managed engines | `<userData>/engines/<platform>-<arch>` (with `manifest.json` install records) |
| Previous engine versions (for rolling back) | `<userData>/engines/<platform>-<arch>/.rollback` |
| Partial downloads | `<userData>/downloads-tmp` (kept for paused and failed downloads so they can be resumed) |

`<userData>` is `%APPDATA%\MediaFlow` on Windows,
`~/Library/Application Support/MediaFlow` on macOS and `~/.config/MediaFlow` on
Linux. Settings → Diagnostics opens the logs folder.

## Troubleshooting

**Electron starts as plain Node (`bad option: --remote-debugging-port` or
`Cannot read properties of undefined (reading 'setAppLogsPath')`).** The
`ELECTRON_RUN_AS_NODE` environment variable is set in your shell, usually
inherited from a tool that is itself built on Electron. Unset it before
running `npm run dev`. The end-to-end tests remove it automatically.

## License

MIT. Third-party components are listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
