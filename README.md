# YT-DLP++

A cross-platform desktop media downloader for Windows, macOS and Linux, built
on Electron, Vue 3 and TypeScript, using yt-dlp and FFmpeg as managed media
engines.

> **Status: version 1.0.0.** Single videos, playlists and channels, audio conversion,
> pause/resume with crash recovery, history, managed engines with verified updates and
> rollback, and application updates from GitHub Releases. See [CHANGELOG.md](CHANGELOG.md)
> and [PROJECT_PLAN.md](PROJECT_PLAN.md).

YT-DLP++ is a graphical front end: the actual downloading is done by
[yt-dlp](https://github.com/yt-dlp/yt-dlp) and the media processing by
[FFmpeg](https://ffmpeg.org). Full credit to those projects and their contributors — see
[Credits](#credits). YT-DLP++ is an independent project and is **not affiliated with,
endorsed by or supported by** the yt-dlp or FFmpeg projects; please report problems with
YT-DLP++ here, not to them.

YT-DLP++ is intended for downloading content you own or are otherwise
authorized to download. Respect copyright and the terms of the platforms you
use.

## Installing

Download the file for your system from the project's GitHub Releases page:

| System | File |
| --- | --- |
| Windows 10/11 (x64 or ARM64) | `yt-dlp-plus-plus-<version>-setup.exe` (installer; updates itself) |
| Windows, without installing | `yt-dlp-plus-plus-<version>-portable-x64.exe` (does not update itself) |
| macOS (Intel or Apple silicon) | Not released yet — `yt-dlp-plus-plus-<version>-x64.dmg` / `-arm64.dmg` once available |
| Linux (x64 or ARM64) | Not released yet — `.AppImage` (updates itself), `.deb` or `.rpm` (command: `yt-dlp-plus-plus`) once available |

Version 1.0.0 is released for Windows only. The app is cross-platform, but the macOS and
Linux builds are held back until their automated tests pass.

Download files use the name `yt-dlp-plus-plus`, because `+` is not safe in download links
and Linux package names; the installed app is called YT-DLP++.

On first start YT-DLP++ offers to download its media engines (yt-dlp, FFmpeg/FFprobe and
Deno) from their official sources and verifies them before use; nothing is downloaded
without your confirmation.

**Verify a download.** Every release has a `SHA256SUMS.txt`. Compare the line for your file
with the hash of the file you downloaded:

```bash
sha256sum yt-dlp-plus-plus-1.0.0-x86_64.AppImage   # Linux
shasum -a 256 yt-dlp-plus-plus-1.0.0-arm64.dmg     # macOS
Get-FileHash yt-dlp-plus-plus-1.0.0-setup.exe      # Windows (PowerShell)
```

**Unsigned builds.** Releases are signed only when the maintainers have configured
code-signing certificates (see Building and releasing). For an unsigned build:

- Windows SmartScreen shows "Windows protected your PC": choose **More info → Run anyway**.
- macOS Gatekeeper refuses to open the app: right-click it in Applications and choose
  **Open**, or allow it in System Settings → Privacy & Security. In-app updates cannot be
  installed on macOS without a signature; download the new version from Releases instead.
- Linux: make the AppImage executable (`chmod +x`). Some distributions (Ubuntu 24.04 and
  later) restrict the user namespaces AppImages rely on; the `.deb` avoids that.

## Requirements (development)

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
| `npm run licenses` | Write `resources/licenses/THIRD_PARTY_LICENSES.txt` from the shipped packages (`dist` runs it) |
| `npm run licenses:check` | Check that every shipped package is listed in THIRD_PARTY_NOTICES.md with an approved license |
| `npm run verify:package` | Check packaged apps in `release/`: fuses, archive contents, native binary, license files |
| `npm run icons` | Render `resources/icons/icon.svg` into `resources/build/icon.png` and `icon.ico` |

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
scripts/             Build helpers: dist.mjs (packaging with the update feed), licenses.mjs,
                     verify-package.cjs, render-icon.cjs
.github/workflows/   CI (every push and pull request) and Release (version tags)
tests/unit/          Vitest unit tests
tests/integration/   Tests that spawn real processes (Node.js, system tar, FFmpeg when installed)
tests/fixtures/      Real captured engine output and signed release data
tests/e2e/           Playwright tests that drive the real Electron app
```

## Downloading

1. Install the media engines once from **Software Updates** (yt-dlp and FFmpeg are required;
   the JavaScript runtime is recommended for YouTube).
2. On **Home**, paste a link and choose **Analyze**. YT-DLP++ lists only the formats and
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
- If the connection drops, YT-DLP++ resumes the download automatically after 5 s, 15 s,
  45 s… (Settings → Advanced → Automatic retries).
- If YT-DLP++ is closed, or crashes, while downloading, the downloads come back paused on
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
**Playlists**. YT-DLP++ lists up to 1000 videos with their thumbnails and durations; private,
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
The conversion list lasts until YT-DLP++ closes.

## Advanced settings

**Settings → Advanced**: automatic retries after network problems, network timeout, a speed
limit per download, a proxy, and the detail written to the log file.

The proxy (`http`, `https`, `socks4`, `socks4a`, `socks5`, `socks5h`, e.g.
`socks5h://127.0.0.1:9050` or `http://user:password@proxy.example:8080`) is used by
yt-dlp and by YT-DLP++'s own requests (thumbnails, engine downloads). A user name and
password are stored unencrypted in YT-DLP++'s settings on this computer. Speed limit and
proxy apply to downloads started or resumed after the change.

## Media engines

YT-DLP++ uses yt-dlp, FFmpeg, FFprobe and (recommended) Deno as separate programs. It finds them in
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

**Software Updates** shows YT-DLP++ and each media engine with the installed version, the
latest version, when it was last checked and its status. **Check all for updates** checks
everything; each card also has its own **Check** button.

- **Engines**: **Update** downloads the new version from the same trusted source as an
  install, verifies it, runs it, swaps it in and runs it again; if anything fails, the
  previous version stays. The replaced version is kept, so **Roll back** can restore it (and
  rolling back can be undone the same way). If downloads or conversions are using the engine,
  the update waits until they finish. Copies installed by your system are never replaced;
  YT-DLP++ can install its own copy instead.
- **yt-dlp channel**: stable (default) or nightly, in Settings → Updates. Switching offers the
  other channel's latest build.
- **YT-DLP++ itself**: **Download** fetches the new version and verifies it; **Restart to
  update** installs it. Running downloads are paused and can be resumed afterwards.
- **Automatic checks** (Settings → Updates): on by default, every day (6 hours to a week). They
  never install anything, except yt-dlp if you turn on automatic yt-dlp updates.
- The **Update history** lists every install, update and rollback, including failures.

## Building and releasing

### Local builds

Application updates come from GitHub Releases. Give the repository when building:

```bash
YTDLPP_GITHUB_OWNER=<owner> YTDLPP_GITHUB_REPO=<repo> npm run dist
```

`scripts/dist.mjs` adds the GitHub publish settings to `electron-builder.yml` for that build.
electron-builder then embeds `app-update.yml` in the app and writes `latest.yml` (and a
`.blockmap`) next to each installer. Upload the installers together with these files to a
GitHub release tagged `v<version>`. Builds made without the two variables have no update
feed; the Software Updates page says so. Nothing is published from local builds
(`--publish never`).

Each platform's packages are built on that platform (macOS packages need a Mac); `--win`,
`--mac` or `--linux` select one. On Windows the NSIS installer covers x64 and ARM64 in one
file. `npm run verify:package` checks the unpacked apps afterwards.

To try the updater in development, point it at a test feed (development runs only):
`YTDLPP_DEV_UPDATE_CONFIG=/path/to/dev-app-update.yml npm run dev`, with e.g.
`provider: generic` and `url: http://127.0.0.1:8080/`.

### Continuous integration

`.github/workflows/ci.yml` runs on every push to `main` and every pull request, on Windows,
macOS and Linux: type-check, lint, unit and integration tests, build, license check, the
Playwright application tests, and an unpacked package checked by `verify-package.cjs`.

### Publishing a release

1. Set `version` in `package.json` (semantic versioning) and add a `## [x.y.z] - date`
   section to [CHANGELOG.md](CHANGELOG.md).
2. Commit, then tag and push: `git tag v1.0.0 && git push origin v1.0.0`.
3. `.github/workflows/release.yml` checks that the tag matches `package.json` and the
   changelog, runs type-check, lint, tests, the license check and `npm audit` for production
   dependencies (on Windows), then builds the packages, verifies them, and creates a **draft** GitHub Release with the installers, the
   `latest*.yml` update manifests, blockmaps and `SHA256SUMS.txt`. The release notes come
   from the changelog.
4. Review the draft and publish it. Only published releases reach the in-app updater.

Releases are currently **Windows-only**: the build matrix in `release.yml` lists Windows,
with the macOS and Linux entries commented out. Uncomment them once CI passes on those
systems.

Signing credentials live only in the repository's Actions secrets. All are optional; without
them the packages are unsigned:

| Secret | Purpose |
| --- | --- |
| `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` | Windows code-signing certificate (`.pfx`, base64) and its password |
| `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD` | macOS Developer ID Application certificate (`.p12`, base64) and its password |
| `APPLE_API_KEY_P8`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` | App Store Connect API key for notarization |

### Licenses

`THIRD_PARTY_NOTICES.md` lists every third-party component YT-DLP++ ships or downloads.
The build records which npm packages end up in each bundle, and `npm run licenses:check`
fails if a shipped package is missing from the notices, listed with the wrong version, or
under a license that has not been approved. Packaged apps contain `LICENSE.txt`,
`THIRD_PARTY_NOTICES.md` and the full license texts in `licenses/`. OpenPGP.js (LGPL) is kept
outside the app archive so it can be replaced.

## Renaming the product

The display name (`YT-DLP++`) is `productName` in `package.json`. It is used for the
window title, the per-user data folder, the sidebar, the Windows executable and the macOS
app. To rename the product, change it there and in the `<title>` of `index.html`, plus:

| Name | Where | Used for |
| --- | --- | --- |
| `yt-dlp-plus-plus` | `name` in `package.json`; `linux.executableName` in `electron-builder.yml` | Download file names, Linux command and `.deb`/`.rpm` package |
| `com.ytdlpplusplus.desktop` | `appId` in `electron-builder.yml` | Windows installer identity, macOS bundle id |
| `ytdlpp` | `shared/constants/app.ts`, `electron/app-protocol.ts` | Internal: database file, `app://ytdlpp/` UI address, `YTDLPP_*` environment variables |

Changing `productName` or `appId` after a release moves users to a new data folder and a
separate installation, so do it only before publishing.

## Where data is stored

| Data | Location |
| --- | --- |
| Settings and database | `<userData>/ytdlpp.db` |
| Logs | `<userData>/logs` (Windows, Linux), `~/Library/Logs/YT-DLP++` (macOS) |
| Managed engines | `<userData>/engines/<platform>-<arch>` (with `manifest.json` install records) |
| Previous engine versions (for rolling back) | `<userData>/engines/<platform>-<arch>/.rollback` |
| Partial downloads | `<userData>/downloads-tmp` (kept for paused and failed downloads so they can be resumed) |

`<userData>` is `%APPDATA%\YT-DLP++` on Windows,
`~/Library/Application Support/YT-DLP++` on macOS and `~/.config/YT-DLP++` on
Linux. Settings → Diagnostics opens the logs folder.

## Security

The interface runs sandboxed with context isolation and no Node.js access, under a strict
Content Security Policy, and is served from the app's own `app://ytdlpp/` scheme rather
than `file://`. Every IPC message is validated. Packaged builds cannot be run as plain
Node.js, ignore `NODE_OPTIONS` and the inspector flags, and only load their
integrity-checked app archive. Media engines are verified (checksums, and signatures where
the project publishes them) before use. See [SECURITY.md](SECURITY.md) for how to report a
vulnerability and for the known limitations.

## Troubleshooting

**Electron starts as plain Node (`bad option: --remote-debugging-port` or
`Cannot read properties of undefined (reading 'setAppLogsPath')`).** The
`ELECTRON_RUN_AS_NODE` environment variable is set in your shell, usually
inherited from a tool that is itself built on Electron. Unset it before
running `npm run dev`. The end-to-end tests remove it automatically.

## Credits

YT-DLP++ would not exist without these projects. They are separate programs, downloaded
from their official sources when you install them in the app (they are not bundled), and
each keeps its own license.

| Project | What YT-DLP++ uses it for | License | Links |
| --- | --- | --- | --- |
| **yt-dlp** | Analysing links and downloading video, audio, playlists and subtitles | Unlicense (source); the standalone executables are GPL-3.0-or-later | [github.com/yt-dlp/yt-dlp](https://github.com/yt-dlp/yt-dlp) |
| **FFmpeg** and **FFprobe** | Merging streams, extracting and converting audio, embedding metadata, checking files | LGPL/GPL, depending on the build | [ffmpeg.org](https://ffmpeg.org) |
| FFmpeg builds by **BtbN** | FFmpeg for Windows and Linux (LGPL builds) | LGPL-3.0-or-later | [github.com/BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds) |
| FFmpeg builds by **Martin Riedl** | FFmpeg for macOS | GPL | [ffmpeg.martin-riedl.de](https://ffmpeg.martin-riedl.de) |
| **Deno** | The JavaScript runtime yt-dlp needs for full YouTube support | MIT | [deno.com](https://deno.com), [github.com/denoland/deno](https://github.com/denoland/deno) |

The name YT-DLP++ refers to yt-dlp, the engine it is built around; it does not imply any
endorsement by the yt-dlp maintainers. yt-dlp is itself a fork of
[youtube-dl](https://github.com/ytdl-org/youtube-dl) and
[youtube-dlc](https://github.com/blackjack4494/yt-dlc), and thanks go to their authors too.
FFmpeg is a trademark of Fabrice Bellard, originator of the FFmpeg project.

The app itself is built with [Electron](https://www.electronjs.org), [Vue](https://vuejs.org),
[Pinia](https://pinia.vuejs.org), [Tailwind CSS](https://tailwindcss.com),
[Lucide](https://lucide.dev) icons, [Zod](https://zod.dev),
[better-sqlite3](https://github.com/WiseLibs/better-sqlite3) / [SQLite](https://sqlite.org),
[OpenPGP.js](https://openpgpjs.org), [electron-updater](https://www.electron.build) and
[electron-log](https://github.com/megahertz/electron-log). Every component, with its version
and license, is listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md); the full license
texts ship with the app.

## License

YT-DLP++ is MIT-licensed (see [LICENSE](LICENSE)). This covers YT-DLP++'s own code only;
yt-dlp, FFmpeg, Deno and the other components keep their own licenses.
