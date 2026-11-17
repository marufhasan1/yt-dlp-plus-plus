# YT-DLP++ — Project Plan

Living document: architecture, decisions, milestones and progress. Update it
whenever the implementation changes.

| | |
| --- | --- |
| Current version | 1.0.0 |
| Current phase | Phase 8 complete — v1.0.0 ready to tag (see the Phase 8 report for what remains before publishing) |
| Last updated | 2026-11-16 |

The project was called **MediaFlow** until 2026-11-16 and is now **YT-DLP++** (display name),
`yt-dlp-plus-plus` (package, file and Linux command name) and `ytdlpp` (internal identifiers).
Earlier reports below use the new name, except where they quote paths or files of that time.

---

## 1. Architecture

### Process model

```
┌───────────────────────────── Electron main process (Node.js) ─────────────────────────────┐
│ main.ts ── lifecycle, single-instance lock, service wiring, shutdown                       │
│ security.ts ── permission denial, navigation/window-open/webview blocking, sender checks   │
│ ipc/ ── createIpcRegistrar(): sender check → Zod validation → handler → IpcResult envelope │
│ services/ ── settings, storage (SQLite + migrations); engines, downloads… in later phases   │
└──────────────────────────────────────────▲─────────────────────────────────────────────────┘
                                           │ ipcRenderer.invoke / webContents.send
┌──────────────────────── preload.ts (sandboxed, contextIsolation) ─────────────────────────┐
│ Exposes window.ytdlpp: a fixed, typed set of functions. No raw ipcRenderer access.     │
└──────────────────────────────────────────▲─────────────────────────────────────────────────┘
                                           │
┌──────────────────────────── Renderer (Vue 3, no Node.js) ─────────────────────────────────┐
│ src/api/client.ts unwraps envelopes → Pinia stores → pages/components                     │
└────────────────────────────────────────────────────────────────────────────────────────────┘
```

### IPC design

- **One contract** in `shared/types/ipc.ts` (`IpcInvokeContract`,
  `IpcEventContract`) types both ends. Channel names live in
  `shared/constants/ipc-channels.ts`.
- **Every handler is registered through `createIpcRegistrar`**, which:
  1. accepts calls only from the top-level frame of our own renderer
     (`file://…/out/renderer/index.html`, or the dev-server origin in
     development);
  2. validates the single argument with a Zod schema and rejects extra
     arguments;
  3. returns `{ ok: true, data }` or `{ ok: false, error: { code, message } }`.
     Electron flattens rejected errors into strings, so envelopes keep error
     codes intact. Unexpected errors are logged and replaced by a generic
     message (no stack traces or paths reach the UI).
- **Preload** exposes named functions only (`app.getInfo()`,
  `settings.update(patch)`, `settings.onChanged(cb)`, …). Event listeners never
  receive the `IpcRendererEvent` (it exposes `sender`).
- Adding a capability = add channel → add contract entry → register handler
  with a schema → add a preload function. Nothing is reachable otherwise.

### Security baseline (implemented)

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`,
  `webSecurity: true`; DevTools disabled in packaged builds.
- Strict CSP injected at build time: production allows only `'self'` for
  scripts, styles, fonts and connections, plus `data:` images. The dev variant
  adds `ws:` and inline styles for Vite HMR.
- All permission requests and checks are denied.
- `window.open` is always denied (and logged); the only external pages the app opens are
  release notes, from links the update check recorded itself (HTTPS, known hosts only). `will-navigate`/`will-redirect` away from the
  renderer and `<webview>` are blocked.
- Production UI served from `app://ytdlpp/` (Phase 8), not `file://`.
- Electron fuses lock down the packaged binary (Phase 8, see below).
- `YTDLPP_USER_DATA_DIR` (test isolation) is ignored in packaged builds.

### Storage

- SQLite via better-sqlite3, file `<userData>/ytdlpp.db`, WAL mode,
  `foreign_keys = ON`, `busy_timeout = 5000`.
- Migrations are TypeScript modules in `electron/database/migrations/`, each
  applied in its own transaction and recorded in `schema_migrations`. A
  database written by a newer app version is refused instead of corrupted.
- Migration 001 creates every table from the spec — `downloads`, `playlists`,
  `playlist_items`, `engine_versions`, `update_history`, `settings` — with
  CHECK constraints, foreign keys (cascade from playlists to items; downloads
  → items set NULL) and indexes on status, dates, URLs and lookup columns.
- Settings are stored one row per key as JSON and validated per key on load.
  A corrupt or invalid value falls back to its default without resetting the
  others.

### Media engines (Phase 2)

Code: `electron/services/engines/`.

**Resolution.** Each engine is looked up in order:
1. **managed** — `<userData>/engines/<platform>-<arch>/`, installed by the app;
2. **bundled** — `resources/engines/<platform>/<arch>/` inside the package (none shipped yet);
3. **system** — absolute `PATH` entries plus Homebrew/MacPorts/`/usr/local/bin`/snap
   folders that GUI apps do not inherit. Relative `PATH` entries are ignored.

FFmpeg and FFprobe are resolved **as a pair**: the first location containing both wins, so
the two are never mixed from different builds.

**Health checks** (startup, "Check again", and after every install), per engine:
executable header (PE/ELF/Mach-O, including universal binaries) must match the OS and a
CPU the OS can run (natively or via its emulation layer: x64 on Windows-on-ARM, Rosetta on macOS) →
execute permission on Unix (restored automatically for managed copies) →
for managed copies, size against the install record (and a full SHA-256 re-hash on
"Check again") → run `--version` / `-version` and parse it → for FFmpeg, verify the
encoders (`libmp3lame`, `aac`, `pcm_s16le`, `flac`, `libopus`) and muxers (`mp4`,
`webm`, `matroska`, `ipod`, `mp3`, `wav`, `flac`, `opus`) later phases need → FFmpeg and
FFprobe must report the same build.
Result per engine: `ok`, `degraded` (works, with warnings), `broken`, or `missing`.

**Installation (opt-in, user-confirmed).** Providers are fixed in code; only an allowlist of
HTTPS hosts can be contacted, including redirect targets (`TrustedHttpClient`, using
Electron's `net.fetch` so the system proxy and certificate store apply).

| Engine | Source | Integrity |
| --- | --- | --- |
| yt-dlp | Latest stable GitHub release; standalone executable per platform (`yt-dlp.exe`, `yt-dlp_arm64.exe`, `yt-dlp_macos` universal, `yt-dlp_linux[_aarch64]`, musl variants) | `SHA2-256SUMS` verified with OpenPGP against yt-dlp's **pinned** release key; asset hash must match it and GitHub's digest |
| FFmpeg + FFprobe (Windows, Linux glibc) | BtbN/FFmpeg-Builds — newest release-branch **LGPL** static build from the immutable `autobuild-*` release (not the rolling `latest` tag) | `checksums.sha256` + GitHub digest |
| FFmpeg + FFprobe (macOS) | Martin Riedl's build server; the "latest" link resolves to an immutable versioned URL | sidecar `.sha256` per file |
| Linux musl FFmpeg | No trusted provider — UI explains to use the system package manager; system copies are detected | — |

Pipeline: resolve → free-space check → stream download into
`<userData>/engines/.staging/install-*` with SHA-256 computed on the fly and size limits →
compare checksum (archives are never extracted before this) → extract with the OS `tar`
(bsdtar on Windows/macOS, GNU tar on Linux) → select regular files only (symlinks ignored) →
`chmod 755` → header/arch check → **run** the staged binaries → atomic swap: existing files
renamed to `*.previous`, new ones moved in, all restored on any failure → write
`manifest.json` (version, SHA-256, size, source URL) → record `update_history` and
`engine_versions` → re-detect. A crash mid-swap is repaired at next start.

**Concurrency.** Detection and installation run through one queue, so a binary is never
replaced while being probed. One install at a time; cancellable (aborts the download and
discards staging). `EngineManager.acquire([...])` leases engines to running jobs; installs
refuse to replace leased engines (`BUSY`). Downloads/conversions (Phases 3–6) must take a lease.

**UI.** Software Updates shows a yt-dlp card and an FFmpeg toolchain card (FFmpeg and
FFprobe rows with separate status/version/source/path/problems), Install/Repair/Reinstall
with a confirmation dialog naming the provider and license, live progress with Cancel,
"Check again" (deep check) and "Open folder". A banner and a sidebar dot appear while any
engine is missing or broken.

### Media analysis and downloads (Phase 3)

Code: `electron/services/media/`, `electron/services/download/`.

```
Home ──analyze(url)──▶ MediaInfoService ──yt-dlp --dump-single-json──▶ normalizeFormats
                         │  caches formats (3 h, 50 entries) under analysisId
                         ◀── MediaAnalysis (summary + thumbnail data URL; no format ids)
Home ──start({analysisId, selection, options})──▶ DownloadManager
                         │  buildDownloadPlan → exact format ids + fallback selector
                         │  queue (settings.maxConcurrentDownloads) → DownloadWorker
                         │  yt-dlp with progress templates ──▶ ProgressAggregator
                         ◀── downloads:changed events (throttled 4/s; transitions always sent)
```

- **Every yt-dlp call** (`ytdlp-command.ts`): `--ignore-config` (a user's global config
  cannot change behaviour), `--encoding utf-8` + `PYTHONIOENCODING`/`PYTHONUTF8`,
  `--no-playlist`, `--js-runtimes deno:<path>` when Deno is usable, `--ffmpeg-location`
  with the paired toolchain folder, and the URL last after `--`. No shell, no user-supplied
  arguments; file names come only from four fixed templates.
- **Format selection** (`format-selection.ts`, pure): drops storyboards, DRM, unknown codecs;
  classifies codecs; labels by the short side (vertical video = "1080p"). A container is
  offered only if video *and* audio fit without re-encoding (MP4: H.264/H.265/AV1 + AAC/MP3;
  WebM: VP9/VP8/AV1 + Opus/Vorbis; MKV: all) — so MP4 at 4K appears only when AV1 exists, and
  a container never produces a silent file. Audio prefers non-DRC, stereo, original-language
  streams and copies instead of re-encoding when the codec already matches. The plan uses the
  exact analysed format ids with a yt-dlp fallback selector in case a format vanished.
- **Progress**: `[MF-PROGRESS] status|downloaded|total|estimate|speed|eta|format_id` on stdout,
  `[MF-PP] status|postprocessor` on stderr, final path via `--print after_move:%(filepath)j`.
  `--progress` is required because `--print` implies `--quiet`. Separate video/audio streams
  are weighted by size into one percentage; ETA uses remaining bytes across all streams.
- **Per-job temp folder** `<userData>/downloads-tmp/<jobId>` (`--paths temp:`): partial files
  never land in the user's folder; cancel/failure deletes it. Phase 6 keeps it for resume.
- **Cancellation** kills the whole process tree (`taskkill /T /F` on Windows; process group on
  Unix), because yt-dlp's standalone builds re-launch themselves and start FFmpeg and Deno.
- **Errors** are classified from stderr into stable codes (unavailable, private, age-restricted,
  geo-blocked, bot check, rate-limited, network, disk full, permission, FFmpeg missing, …) with
  plain-language messages.
- **Security**: the renderer passes an `analysisId` and a validated selection, never format
  ids, selectors, paths or arguments. Thumbnails are fetched by main (HTTPS, public hosts only,
  image types, 5 MB cap) and re-encoded by Chromium's image decoder. The download folder is set
  only through the native folder dialog; "Show in folder" takes a job id, not a path.
- **Persistence**: jobs in `downloads` (migration 003 adds `plan_json`, `error_code`,
  `dismissed_at`, `source_id`, `updated_at`). Removing a job from the list sets `dismissed_at`
  (history is kept, files are never touched). Jobs active when the app closed are marked
  `INTERRUPTED` at startup and can be retried. Quitting stops running downloads first.

### Playlists (Phase 4)

Code: `electron/services/playlist/`, `electron/services/media/link-analyzer.ts`.

- **Routing**: `media:analyze` goes through `LinkAnalyzer`. YouTube playlist/channel links
  go straight to `PlaylistService`; other links go to `MediaInfoService`, which throws
  `PlaylistDetected` if yt-dlp reports a playlist, and are then re-routed. The result is
  `{ kind: 'media' }` or `{ kind: 'playlist' }`; Home navigates to the Playlists page for the latter.
- **Listing**: `yt-dlp --yes-playlist --flat-playlist --playlist-end 1000 --dump-single-json`
  (5 min timeout, 128 MB cap). Bare channel URLs are rewritten to their `/videos` tab.
  Entries are validated one by one; entries without an http(s) link and nested playlists
  are dropped; `[Private video]`/`[Deleted video]` titles, non-public `availability` and
  live/upcoming entries are kept but marked unavailable. Position = order in the list.
- **Storage** (migration 004): `playlists` gains `source_id` (unique, so re-analysing
  refreshes in place), `truncated`, `updated_at`; `playlist_items` gains `video_id`,
  `duration_seconds`, `uploader`, `thumbnail_url`, `unavailable_reason`; `downloads` gains
  `playlist_id` (ON DELETE SET NULL), `playlist_position`, `playlist_title`. A refresh
  rebuilds items in one transaction and carries each video's download link and status
  over by video id.
- **Downloading**: `buildProfilePlan` (container-safe `-f` filters + verified `-S` order)
  → `DownloadManager.enqueue` with one `PreparedDownload` per entry (engines and folders
  checked once, so a batch queues completely or not at all). Destination
  `<download folder>/<sanitised playlist title>` when "Create subfolders for playlists" is
  on (`sanitizeFolderName` + `childPath` containment check); optional `NNN - ` prefix,
  accepted only as digits + " - ". Unavailable and already-active entries are skipped and
  counted. Job status changes are mirrored onto `playlist_items.status`; Downloads-list
  thumbnails are fetched in the background, four at a time.
- **UI**: link form, saved-playlist library, header with counts, truncation note and overall
  progress, profile options (video: MP4/WebM/MKV, maximum resolution, codec preference;
  audio: format/quality; numbering, embed options; destination preview), entry list with
  checkboxes, Shift+click ranges, select all/none, title filter, live per-entry status, lazy
  thumbnails (`IntersectionObserver`) and `content-visibility: auto` for long lists.

### Audio converter (Phase 5)

Code: `electron/services/media/conversion.service.ts`, `conversion-plan.ts` (pure),
`electron/ipc/converter.ipc.ts`, `src/pages/Converter.vue`, `src/stores/converter.store.ts`.

- **Selection by token**: `converter:pick-files` checks FFmpeg/FFprobe first (bounded wait
  for startup detection), then opens the native file dialog (≤ 200 files) and inspects each
  file: `stat` (regular, non-empty) + `ffprobe -print_format json -show_format -show_streams`,
  three at a time. The renderer receives `ConverterInput`s keyed by a random token (path for
  display only); `converter:start` accepts only tokens, and a custom output folder is
  likewise a token from `converter:choose-folder`. Destinations: download folder, next to
  each original, or the chosen folder.
- **FFmpeg invocation** (`buildConversionArgs`), no shell:
  `-hide_banner -nostdin -loglevel error -progress pipe:1 -stats_period 0.5 -i file:<in>
  -map 0:a:0 [cover] -map_metadata 0 <codec> <container> -n file:<temp>`. The `file:`
  prefix stops names being read as protocols (`concat:`, `http:` …) and works with Unicode
  paths; `-n` never overwrites.
  - MP3 `libmp3lame` (`-q:a 0` for Best, else CBR) + ID3v2.3; M4A `aac` + faststart;
    OPUS `libopus` (resamples to 48 kHz); FLAC (16-bit for lossy sources, source depth
    otherwise); WAV `pcm_s16le`, or `pcm_s24le` only for >16-bit lossless sources.
  - Same codec + Best (or FLAC → FLAC) → `-c:a copy`, no generation loss.
  - Surround is downmixed to stereo for MP3/OPUS. Embedded cover art (mjpeg/png
    `attached_pic`) is copied into MP3/M4A/FLAC; real video tracks are never copied.
- **Run**: one conversion at a time (FFmpeg is multi-threaded). Output goes to
  `<dest>/<name>.ytdlpp-<id>.<ext>`, is re-probed and verified (audio present, expected
  codec, ≥ 90 % of the source duration), then renamed to the first free
  `<name>.<ext>` / `<name> (n).<ext>` (never the input itself). Failure or cancel removes the
  temporary file; cancel kills the process tree. Progress = `out_time_us` / source duration,
  plus speed (×) and ETA. FFmpeg errors are mapped to plain messages; the stderr tail goes to the log.
- **Jobs** live in memory for the session (`converter:list|cancel|remove|show-in-folder`,
  `converter:changed|removed` events, 250 ms throttle except status changes); quitting stops
  a running conversion.
- **UI**: file list with codec, sample rate, channels, bitrate, bit depth, duration, size,
  tags, Video/Cover-art badges and per-file errors; format/quality/destination options with
  notes (lossy → lossless, copy without re-encoding, cover art not kept in OPUS/WAV);
  conversion list with progress, speed, ETA, output path and size; sidebar badge.

### Download management (Phase 6)

Code: `electron/services/download/download-manager.ts`, `orphan-guard.ts`,
`electron/services/network/` (`session-proxy.ts`, `proxy-fetch.ts`), migration 005,
`src/pages/Downloads.vue`, `src/pages/History.vue`, `src/components/settings/AdvancedSettings.vue`.

- **Pause / resume.** yt-dlp cannot be suspended safely, so pausing stops its process tree and
  keeps the job's scratch folder (`<userData>/downloads-tmp/<jobId>`). Resuming re-runs the
  same command: yt-dlp continues `.part` files and skips streams already complete (verified
  with the real binary, killed mid-video and mid-audio). Queued jobs just leave the queue.
  Post-processing (merging/converting) is not interruptible; Pause is refused with an
  explanation while a job is being finished. Pause all / Resume all act on the whole list.
- **Automatic retries.** A run that fails with a network error (classifier code `NETWORK`)
  is queued again after 5 s, 15 s, 45 s … (max 2 min), up to Settings → Advanced →
  Automatic retries (default 3); the partial files are continued. Other failures keep their
  partial files for a manual Retry; cancelled, completed and removed jobs delete them.
- **Restart recovery.** A graceful quit saves queued/running jobs as `paused` +
  `interrupted` (one transaction) before stopping them. At startup, rows still `queued`/
  `downloading`/`processing` (a crash) are recovered the same way; rows without a stored plan
  become failed (`INTERRUPTED`). The Downloads page shows a recovery notice with
  "Resume all" / "Not now". Scratch folders not owned by a paused or failed job are removed.
- **Orphan guard.** yt-dlp is not ended by the OS when YT-DLP++ dies (Windows has no
  parent-death signal; on Unix it leads its own process group). Each run writes
  `.ytdlpp-owner.json` (pid, executable, start time) into its scratch folder; at
  startup, before anything can resume, a still-running owner is stopped (tree kill) if
  the OS reports the same executable and, on Windows, a matching start time, so a reused
  PID is never touched. Observed: after a hard kill during extraction yt-dlp lived on for a
  few seconds; during a download it exited within a second.
- **Duplicates.** Starting a video that already has an active or paused job in the same
  output format is refused (`DUPLICATE`). Analysis results carry `previousDownloads`
  (newest five, with "file still there"), shown on Home with a Show button. Playlist
  downloads can skip videos already downloaded in the same format whose file still exists
  ("Skip videos already downloaded", on by default).
- **History.** `history:list` returns finished jobs (completed/failed/cancelled, including
  ones removed from Downloads), filtered by search (title/link, `LIKE` with escaped
  wildcards), format, result and date range (local days converted to instants by the
  renderer, normalised by Zod), 50 per page, with `fileExists` for completed items.
  `history:delete` removes the record (and the Downloads entry); the file is only touched
  when `deleteFile: true` is sent explicitly, and is moved to the Recycle Bin / Trash
  (`shell.trashItem`), never deleted outright. Retry and Show in folder work for
  history-only jobs (Retry puts the job back on the Downloads page).
- **Advanced settings.** Automatic retries (0–10), network timeout (`--socket-timeout`,
  5–300 s), speed limit per download (`--limit-rate`, 256 KB/s–50 MB/s), proxy, log level
  (info/debug, applied to the log file at once). Network options travel with the engine
  runtime, so analysis, playlist listing and downloads all use them.
- **Proxy.** Validated and normalised in shared code (`http`, `https`, `socks4(a)`,
  `socks5(h)`; host, optional port and credentials; no path, query, whitespace or control
  characters). yt-dlp gets `--proxy`. YT-DLP++'s own requests (thumbnails, engine
  downloads) use the same proxy through the session (`setProxy`, applied at startup and on
  change). Electron's `net.fetch` never answers a proxy's 407 challenge (verified), so when
  the proxy has credentials those requests use a small fetch built on `net.request`, which
  answers only challenges from the configured proxy host and reports the final URL after
  redirects for the existing allow-list checks. Credentials are stored in the settings
  table unencrypted (stated in the UI) and redacted wherever the address is shown.

### Software updates (Phase 7)

Code: `electron/services/updates/` (`update.service.ts`, `engine-update-check.ts`,
`versions.ts`, `app-updater.ts`, `release-notes.ts`), `electron/services/engines/engine-installer.ts`
(verification in place, rollback store), migration 006, `electron/ipc/update.ipc.ts`,
`src/pages/Updates.vue`, `src/components/updates/`, `src/components/settings/UpdateSettings.vue`,
`scripts/dist.mjs`.

- **Components**: YT-DLP++, yt-dlp, FFmpeg (FFmpeg + FFprobe as one toolchain) and Deno, each
  with installed version, latest version, release date, last check, state (`unknown`,
  `checking`, `up-to-date`, `available`, `waiting`, `downloading`, `installing`, `ready`,
  `updated`, `failed`, `unavailable`) and a message. Results are stored in `update_checks`
  (and `engine_versions.latest_version/checked_at`), so they survive restarts.
- **Checks** read release metadata only (nothing is downloaded or run):
  yt-dlp — GitHub `releases/latest` of `yt-dlp/yt-dlp` (stable) or `yt-dlp/yt-dlp-nightly-builds`
  (nightly), the platform asset must exist; FFmpeg — the newest BtbN `autobuild-*` build id
  (e.g. `n9.0.2-48-gd4070a14ce`) or Martin Riedl's latest build (`<build time>_<version>`);
  Deno — GitHub `releases/latest`.
- **Comparison** is numeric per part (`2026.10.26` > `2026.9.1`, `9.0.10` > `9.0.2`), never
  lexicographic. FFmpeg compares the release-branch build (version, then commits after the
  tag) parsed from `ffmpeg -version` (`n9.0.2-48-gd4070a14ce-20261109`), or the Riedl build
  time; vendor strings fall back to the version. yt-dlp knows the installed channel (manifest
  provider `yt-dlp-github` / `yt-dlp-nightly`, or a 4-part version for system copies): a
  channel change in Settings offers the other channel's latest build, even if older
  ("Switch to stable"). Older versions are never offered otherwise.
- **Engine updates** reuse the verified install pipeline (Phase 2: pinned-key signature or
  provider checksum, platform/architecture check, staged run) and add: the new binaries are
  **run again once in place**; if that fails the previous files are put back
  (`UpdateRolledBack`, history status `rolled_back`). On success the replaced version and its
  install record move to `<engines>/.rollback/<target>/` (one generation). **Rollback** checks
  the kept files (size, SHA-256 against the record, run) and swaps them back; the version it
  replaces becomes the new rollback copy, so a rollback can be undone. Rollbacks are offered
  only for copies YT-DLP++ manages. System copies are never replaced: "Install YT-DLP++'s
  copy" installs a managed one, which takes precedence.
- **Deferral**: engines leased by downloads/conversions are never replaced. An update
  requested while they are in use waits (`waiting`, cancellable) and runs as soon as the
  leases are released (`EngineManager.onLeasesChanged`).
- **Schedule** (Settings → Updates): automatic checks on/off (default on), every 6/12/24/72/168 h
  (default 24 h; first check 20 s after engine detection; due-ness evaluated every 15 min),
  yt-dlp channel (default stable), automatic yt-dlp updates (opt-in; managed copy only, never a
  channel switch, deferred while busy), FFmpeg/Deno included in automatic checks (default on),
  app update notifications (default on, in-app notice). Nothing else is ever installed
  without a click.
- **Application updates** use electron-updater with GitHub Releases: check → release notes
  (HTML converted to plain text in main) → download with progress (cancellable), verified
  against the SHA-512 in `latest.yml` (and the publisher signature when the build is signed)
  → "Restart to update" (`quitAndInstall`; running downloads are saved as paused/interrupted
  by the normal shutdown and offered for resuming). The outcome is recorded at the next start
  by comparing the running version with the one installed. Builds without an update feed,
  the portable Windows build and development runs report why updates are unavailable.
  Development runs can be pointed at a test feed with `YTDLPP_DEV_UPDATE_CONFIG` /
  `dev-app-update.yml` (ignored when packaged).
- **Update feed at build time**: `scripts/dist.mjs` adds `publish: github` with
  `YTDLPP_GITHUB_OWNER` / `YTDLPP_GITHUB_REPO` (validated) and `--publish never`;
  electron-builder then writes `app-update.yml` into the package and `latest.yml` +
  `.blockmap` next to the installer. On Windows the feed file is only written for NSIS
  targets (not `--dir`), as electron-builder's PublishManager shows.
- **IPC**: `updates:get-status|check|update-engine|cancel-waiting|rollback|download-app|cancel-app-download|install-app|history|open-release-notes`,
  events `updates:changed|notice`. Release notes open in the browser only for the URL the
  main process recorded, over HTTPS, on github.com or ffmpeg.martin-riedl.de.

### Production release (Phase 8)

- **`app://` scheme** (`electron/app-protocol.ts`): registered as standard, secure, fetch-capable
  before `ready` and served with `protocol.handle` from `out/renderer`. Requests must use the
  host `ytdlpp`; the decoded path must stay inside the renderer folder (null bytes refused)
  and have an allowed extension; responses carry the right content type and `nosniff`.
  `isRendererUrl` accepts only `app://ytdlpp/index.html` (or the dev server in development).
- **Fuses** (`electronFuses` in `electron-builder.yml`): `RunAsNode`, `NODE_OPTIONS` and
  `--inspect` off; cookie encryption, embedded asar integrity and `OnlyLoadAppFromAsar` on;
  `GrantFileProtocolExtraPrivileges` off; the ad-hoc macOS signature is re-applied.
- **Package contents**: source maps, build metadata, SQLite sources and unused OpenPGP builds
  are excluded; only the target's `better-sqlite3` prebuild (`<platform>-<arch>.node`) is
  shipped, via a root extglob pattern. OpenPGP.js is unpacked from the asar (LGPL
  replaceability). The asar is ~8 MB.
- **License pipeline**: an electron-vite plugin records the npm packages in each bundle
  (`out/bundled-packages.*.json`); `scripts/licenses.mjs` combines them with production
  dependencies, checks THIRD_PARTY_NOTICES.md (listed, correct version, approved license —
  LGPL only for openpgp) and writes the full texts to `resources/licenses/`. Packaged apps
  contain `LICENSE.txt`, `THIRD_PARTY_NOTICES.md` and `licenses/THIRD_PARTY_LICENSES.txt`.
- **Package verification** (`scripts/verify-package.cjs`): reads the fuse wire, lists the
  asar, checks required files, exactly one native prebuild for the target, unpacked OpenPGP,
  license files and the Linux icon, and prints the update feed. Run by CI and Release.
- **Icon**: original SVG (`resources/icons/icon.svg`), rendered by Electron itself into the
  PNG and a multi-size ICO (`scripts/render-icon.cjs`).
- **Workflows**: `ci.yml` (push to main, pull requests; Windows, macOS, Linux: type-check →
  lint → tests → build → license check → Playwright → unpacked package + verify) and
  `release.yml` (tags `vX.Y.Z`: verify tag/version/changelog, tests, `npm audit` for
  production → per-OS build, optional signing/notarization from secrets, verify → draft
  release with installers, `latest*.yml`, blockmaps and `SHA256SUMS.txt`, notes from
  CHANGELOG.md). Actions are pinned to commit SHAs; checkouts do not keep credentials.

### Directory separation

| Purpose | Location |
| --- | --- |
| Installation (read-only) | Electron install directory / `app.asar` |
| User configuration, database | `app.getPath('userData')` |
| Managed engines | `<userData>/engines` |
| Engine rollback copies | `<userData>/engines/<platform>-<arch>/.rollback/<target>/` (one previous version per engine, with its install record) |
| Partial downloads | `<userData>/downloads-tmp/<jobId>`: kept while a job is paused or failed (for resuming), removed when it completes, is cancelled or removed |
| Conversion in progress | `<dest>/<name>.ytdlpp-<id>.<ext>`, renamed when verified (same volume, so the rename is atomic) |
| Logs | `app.getPath('logs')` (`<userData>/logs`; `~/Library/Logs/<name>` on macOS) |
| Download destination | OS Downloads folder by default; changeable in Settings → Downloads |

### Logging

electron-log writes `[ISO time] [level] (scope) message` to
`<logs>/main.log`, rotated at 5 MB. Scoped loggers per service. Uncaught
exceptions and unhandled rejections are captured. The renderer reports errors
to the user as toasts; details stay in the log.

---

## 2. Engineering decisions

| Decision | Reason |
| --- | --- |
| **electron-vite 6** for dev/build | One config for main, preload and renderer; HMR for the renderer and auto-restart for main. Electron Builder remains the only packager. |
| **TypeScript pinned to ~6.0** | TypeScript 7 is the native (Go) compiler; `vue-tsc` and `typescript-eslint` (`<6.1`) do not support it yet. Revisit when they do. |
| **better-sqlite3 13 with `npmRebuild: false`** | v13 is an N-API module with prebuilt binaries for win32/darwin/linux × x64/arm64, selected at runtime. No compilation against Electron headers is needed; this also allows cross-arch packaging. Verified in a packaged Windows build. |
| **@lucide/vue** instead of `lucide-vue-next` | `lucide-vue-next` is deprecated in favour of `@lucide/vue`. |
| **Settings defaults separate from field schemas** | Zod 4 applies `.default()` inside `.partial()`, so a one-key patch would silently reset every other setting. |
| **Hash router** | The production renderer is served from static files (now `app://`); there is no server to rewrite history paths. |
| **IpcResult envelopes** | Preserve error codes across the IPC boundary; avoid leaking raw messages. |
| **Preload bundles shared code** (`externalizeDeps: false`) | Sandboxed preloads can only `require('electron')`. |
| **Product name from `package.json` `productName`** | Single source used by Electron (`app.getName()`, userData folder) and Electron Builder. |
| **Native window frame** | Consistent, accessible window controls on all three platforms without custom title-bar code. |
| **System font stack** | No network fonts (CSP, offline use); renders natively per platform. |
| **License: MIT** | `LICENSE` added in Phase 8 and shipped as `LICENSE.txt`. |
| **Engines downloaded on request, not bundled** | Keeps installers small and avoids redistributing GPL executables (yt-dlp standalone builds are GPLv3+). The `bundled` resolution path exists if Phase 8 decides otherwise. |
| **yt-dlp signature pinned to one key** | Upgrades trust from "GitHub over HTTPS" to "yt-dlp maintainers' signing key". If yt-dlp rotates its key, installs fail closed until the app ships the new key. |
| **BtbN LGPL release-branch builds** for Windows/Linux | yt-dlp's own FFmpeg fork now publishes only GPL master builds. BtbN's LGPL builds contain every encoder needed (verified on the real binary) and are LGPL-3.0-or-later (confirmed with `ffmpeg -L`). |
| **Immutable release tags** | BtbN's `latest` and Riedl's `latest` change daily; resolving to `autobuild-*` / versioned URLs prevents a checksum/asset race. |
| **System `tar` for `.tar.xz`** | Present on every supported OS (Windows 10 1803+ ships bsdtar with xz); called by absolute path, never via `PATH`. Since Phase 3, `.zip` archives use yauzl instead (see below). |
| **openpgp kept external** | LGPL-3.0-or-later; loaded from `node_modules` (not bundled into main) so it stays a separately replaceable library. |
| **Install records in `manifest.json`** next to the binaries, versions/history in SQLite | The manifest travels with the files it describes (deleting the folder deletes both); SQLite holds the spec's `engine_versions` and `update_history`. |
| **Deno as a managed, optional engine** (user decision, Phase 3) | yt-dlp now needs a JavaScript runtime for full YouTube support: without one it warns the mode is deprecated and returned 53 instead of 61 formats on a test video. Deno is yt-dlp's documented default and runs sandboxed. Using Electron's own Node instead would require keeping the `RunAsNode` fuse enabled. Missing Deno shows a notice, not a block. |
| **In-process zip extraction (yauzl)** | Deno ships only `.zip`, which Linux's GNU tar cannot read. yauzl rejects traversal paths; YT-DLP++ adds a containment check and size limits. `.tar.xz` still uses the OS tar. |
| **Analyses cached in main, referenced by id** | The renderer never handles format ids or selectors, and the 175 KB+ info JSON never crosses IPC. |
| **Thumbnails proxied through main** | Keeps the renderer CSP at `img-src 'self' data:`, avoids leaking the user's IP/referrer from the UI, and blocks private-network URLs from untrusted metadata. |
| **Exact format ids + fallback selector** | Downloads what the user saw, with yt-dlp's own choice as a safety net if a format disappears between analysis and download. |
| **Fixed file name templates** | Four presets instead of free-form yt-dlp templates, which could reference arbitrary fields or paths. |
| **Playlist entries use a format *profile*, not per-video analysis** | Analysing every entry (≈10 s each) before a 100-video download would take a quarter of an hour. Instead yt-dlp picks per video from container-safe filters and a sort order. The order was verified on real data: resolution and fps first (otherwise a muxed 360p stream wins), then codec (yt-dlp would pick AV1 for MP4), then `channels:2` (yt-dlp would pick 5.1 surround). Picks match the single-video planner. |
| **One job per video** | Gives each entry its own status, retry and cancel, and reuses the queue, concurrency and persistence built in Phase 3. |
| **Entry thumbnails fetched on demand, by position** | A 1000-entry list would otherwise mean 1000 image downloads up front. Rows request their image when they near the viewport; the renderer names an entry, never a URL. |
| **Thumbnails passed through, never decoded in main** (Phase 8) | YouTube serves `.jpg` URLs as WebP, which Electron's encoder cannot read; and decoding untrusted images in the privileged process is avoidable risk. JPEG, PNG and WebP up to 512 KB, recognised by signature, go to the sandboxed renderer as data URLs. |
| **Operations wait for engine detection** | A link pasted right after launch waits (bounded) for the first engine check instead of failing with "still being checked". |
| **Converter files and folders referenced by tokens** | Only the native dialogs choose paths; the renderer cannot ask FFmpeg to read or write anything else. |
| **`file:` URLs for FFmpeg inputs/outputs** | A local name such as `concat:a|b` or `http:x` would otherwise be opened as a protocol. Verified with Unicode paths on Windows. |
| **Temporary file + FFprobe verification + rename** | A cancelled, crashed or truncated conversion never leaves a plausible-looking file under the final name. |
| **One conversion at a time** | Spec §9; FFmpeg already uses several cores, and sequential runs keep progress meaningful. |
| **Copy instead of re-encode for same-codec "Best"** | Re-encoding MP3 → MP3 or AAC → M4A only loses quality. An explicit bitrate is still honoured. |
| **Lossy → FLAC written as 16-bit** | FFmpeg would store decoded float audio as 24-bit: 3–4× larger in the smoke test with nothing more in it. |
| **Conversion list kept for the session only** | Conversions are quick and local; nothing in the spec needs them persisted. History (Phase 6) can add them. |
| **Pause = controlled stop, resume = same command again** (Phase 6) | yt-dlp has no pause; suspending a process is unavailable on Windows and lets connections time out. Re-running continues partial files (verified; full decodes of resumed files show no errors). |
| **Interrupted jobs come back paused, not failed or auto-started** | The user decides when bandwidth is used again; nothing is lost either way. |
| **Owner records instead of OS job objects for orphan yt-dlp** | Node cannot place children in a Windows job object. Recording pid + executable + start time and checking them before killing keeps the guard from touching unrelated processes. |
| **Automatic retries only for network errors** | Unavailable, private or geo-blocked videos do not become available by retrying. |
| **History deletes move files to the Recycle Bin / Trash** | Spec: never delete the downloaded file unless the user chooses to; a recoverable delete is the safer reading of "delete". |
| **Duplicates: block only active ones in the same format, inform about the rest** | Downloading a video again (another format, or a replaced file) is legitimate; two jobs writing the same output is not. |
| **net.request fetch only when the proxy has credentials** | net.fetch is the well-tested path; it cannot answer proxy authentication, so the fallback is used only where it is needed. |
| **Engine updates reuse the install pipeline, plus a check in place** (Phase 7) | One verified path for installs, repairs and updates; running the binary where it will be used catches what a staged run cannot (e.g. security software quarantining the new file). |
| **One kept version per engine, swap-based rollback** | Covers "the new yt-dlp broke a site" without unbounded disk use (FFmpeg is ~260 MB); swapping keeps rollback reversible. |
| **Update checks never download binaries** | Checking is cheap and safe to automate; downloads happen only on an explicit update (or opt-in yt-dlp auto-update). |
| **Deferred, not refused, while engines are in use** | Spec: "defer the update or ask the user to finish them". Replacing a running executable is impossible on Windows and unsafe elsewhere. |
| **yt-dlp's own updater (`-U`) is not used** | It cannot be relied on for every packaging type and would bypass YT-DLP++'s signature check, rollback and history. |
| **App update feed configured at build time, opt-in per build** | The repository is not known to the code; builds made without it say so instead of checking a wrong feed. |
| **App update outcome recorded after the restart** | Only the next start can tell whether the installer really replaced the app. |
| **`app://` scheme instead of `file://`** (Phase 8) | Lets the `GrantFileProtocolExtraPrivileges` fuse be turned off and confines what the UI origin can load to the renderer folder. |
| **Fuses set by electron-builder** | One declarative place; `verify-package.cjs` reads the wire back from each built binary. |
| **Exclusions by root extglob, no per-platform `files`** | A platform `files` list made only of exclusions makes electron-builder include the whole project (1.4 GB archive); a root exclusion overrides any platform re-inclusion. |
| **Renamed to YT-DLP++, with `yt-dlp-plus-plus` for files and `ytdlpp` internally** (user decision, after Phase 8) | `+` is unsafe in update download URLs and is not allowed in Debian package names; the Linux command must not clash with the distributions' own `yt-dlp` package. The README states that the project is independent of yt-dlp and FFmpeg and credits them. |
| **Release as draft** | A human reviews artifacts and notes before users' updaters see them. |
| **Universal Windows installer** | electron-builder combines x64 and arm64 NSIS into one installer (~241 MB) that the updater also uses; a per-arch feed would need separate configurations. |
| **License check in CI from the built bundles** | Notices drift silently when dependencies change; checking what is actually bundled catches it. |
| **Channel links → Videos tab, 1000-entry cap** | The bare channel page lists tabs as nested playlists and took 30 s to expand; the Videos tab lists 300 videos in 8 s. The cap bounds memory and time; the UI says when a list was truncated. |

---

## 3. Milestones

Status legend: ✅ done · 🔜 next · ⏳ planned

### ✅ Phase 1 — Foundation

- [x] Inspect directory, initialize project
- [x] Install dependencies (compatible, current versions)
- [x] Configure Electron (secure `BrowserWindow`, single instance, lifecycle)
- [x] Configure Vue 3 + Vite (electron-vite)
- [x] Configure TypeScript (strict; separate node/web projects)
- [x] Configure Tailwind CSS v4 (semantic colour tokens, dark/light)
- [x] Configure Pinia (settings, app, toast stores) and Vue Router
- [x] Secure IPC (typed contract, sender check, Zod validation, envelopes)
- [x] Main layout (sidebar with 7 sections and version, header, page transitions)
- [x] Theme switching (dark default, light, system) persisted in SQLite and applied to native UI
- [x] SQLite foundation (migrations, full initial schema, settings repository/service)
- [x] Structured logging and "Open logs folder"
- [x] Toast notifications, empty states, loading skeletons
- [x] ESLint, Vitest, Playwright Electron tests
- [x] Electron Builder configuration (NSIS + portable, DMG + ZIP, AppImage + DEB + RPM)

Deliverable: running desktop application — **met** (dev mode, production
build and packaged Windows build verified).

### ✅ Phase 2 — Engine Management

- [x] Platform detection (OS, CPU, glibc/musl) and per-target engine folders
- [x] Engine resolution: managed → bundled → system, FFmpeg/FFprobe as a pair
- [x] yt-dlp, FFmpeg, FFprobe version detection
- [x] Health checks: binary format/arch, permissions, integrity, runnable, capabilities, toolchain match
- [x] Opt-in installation/repair from trusted providers with signature/checksum verification, rollback and crash recovery
- [x] Cancellation, single-install lock, engine leases for future jobs
- [x] `engine_versions` and `update_history` repositories
- [x] Software Updates engine UI, setup banner, sidebar indicator, confirmation dialog, progress bar
- [x] Availability and licensing of each provider's binaries verified and recorded in THIRD_PARTY_NOTICES.md

Deliverable: working media engines — **met** (real yt-dlp 2026.10.26 and FFmpeg/FFprobe
9.0.2 installed, verified and detected through the UI on Windows x64).

### ✅ Phase 3 — Video Downloader

- [x] URL input with paste (main-process clipboard), analyze, clear, cancel; validation and YouTube link recognition
- [x] Metadata extraction (`--dump-single-json`), validated and normalised in the main process
- [x] Thumbnail preview (fetched by main, re-encoded to a small JPEG data URL; CSP unchanged)
- [x] Dynamic format discovery: containers, resolutions, codecs, audio, subtitles — nothing hard-coded
- [x] Resolution and codec selection; audio-only (MP3/M4A/WAV/FLAC/OPUS) with quality and honest notes
- [x] Embed metadata/thumbnail, subtitles (SRT/VTT, alongside or on their own)
- [x] Video and audio downloads with merge/extraction through FFmpeg
- [x] Progress tracking: per-stream weighted %, speed, ETA, size, post-processing steps
- [x] Basic queue (configurable concurrency), cancel (whole process tree), retry, remove, show in folder, interrupted-job detection
- [x] Downloads page (filters, summary, actions) and Settings → Downloads
- [x] Deno added as a managed engine (yt-dlp's JavaScript runtime for YouTube)

Deliverable: working individual video downloader — **met** (real MP4 and MP3 downloads
of a CC-BY video through the UI, verified with FFprobe).

### ✅ Phase 4 — Playlist Downloader

- [x] Playlist extraction with yt-dlp's flat mode (one request per page, not per video), up to 1000 entries
- [x] Channel links → the channel's Videos tab; links pasted on Home are routed automatically
- [x] Playlist listing: title, thumbnail, uploader, count, every entry with thumbnail, duration and status
- [x] Unavailable entries (private, deleted, members-only, live/upcoming) shown and skipped gracefully
- [x] Selection: per entry, Shift+click ranges, select all / deselect all, filter by title
- [x] Download selected / download entire playlist with one format profile (video or audio)
- [x] One job per video (individual tracking), statuses mirrored onto entries and persisted
- [x] Overall playlist progress; playlist subfolders (setting) and numbered file names
- [x] Saved playlist library: refresh (keeps download links), remove (keeps files and jobs)

Deliverable: working playlist downloader — **met** (real downloads of selected entries from
Blender's CC-BY "Official Blender Open Movies" playlist through the UI, verified with FFprobe).

### ✅ Phase 5 — Audio Converter

- [x] Local media selection in the native file dialog (audio, or video to extract the audio from), up to 200 files
- [x] FFprobe inspection: codec, sample rate, channels, bitrate, bit depth, duration, tags, cover art; damaged files explained
- [x] MP3 / M4A / OPUS / FLAC / WAV output; quality 128–320 kbps or Best; lossless options without bitrate
- [x] Same-codec copy, cover art and metadata preserved, 24-bit kept where real, surround downmix where needed
- [x] Destination: download folder, next to the originals, or a chosen folder; never overwrites
- [x] Progress with speed and time left; cancel (process tree); one conversion at a time
- [x] Output verified with FFprobe before it appears under its final name; show in folder; remove from list

Deliverable: working audio converter — **met** (20 real conversions of five different source
files to all five formats through the UI, each verified with FFprobe; cancel left no process or file).

### ✅ Phase 6 — Download Manager

- [x] Queue with configurable concurrency (now applied live when the limit is raised)
- [x] Pause / resume per job and for all jobs, keeping partial files (controlled stop; no fake pause)
- [x] Cancellation (running, queued, waiting to retry, paused; partial files deleted)
- [x] Retry: manual (continues partial files) and automatic after network errors, with backoff
- [x] Restart recovery: interrupted jobs come back paused with their partial files; recovery notice; orphaned yt-dlp stopped
- [x] History page: search, format/result/date filters, paging, open location, delete entry (file only on request, to the Recycle Bin / Trash), retry
- [x] Duplicate detection: active duplicates refused, earlier downloads shown on Home, playlist option to skip downloaded videos
- [x] Settings → Advanced: retries, network timeout, speed limit, proxy (with authentication), log detail

Deliverable: complete download management — **met** (real downloads of CC-BY content paused,
resumed, quit, crashed, recovered, cut off and retried through the UI, verified with FFprobe
and full decodes).

### ✅ Phase 7 — Update Management

- [x] yt-dlp release checking (stable and nightly channels, release date, platform asset, numeric comparison)
- [x] Managed binary updates: verified download, staged run, swap, run again in place, automatic restore on failure
- [x] FFmpeg/FFprobe update checks per trusted provider (build-level comparison), updated together; Deno
- [x] Deferral while downloads or conversions use an engine; cancellable
- [x] Rollback to the kept previous version (reversible), for managed copies
- [x] Application updater: electron-updater + GitHub Releases, release notes, download progress, SHA-512 verification, install and restart, clear errors
- [x] Update history (installs, updates, rollbacks, failures, app updates) on the Updates page
- [x] Updates page: per-component cards, Check all, last/next check; Settings → Updates (frequency, channel, opt-in yt-dlp auto-update, notifications)

Deliverable: complete software update system — **met** (real nightly/stable yt-dlp updates,
deferral and two rollbacks through the UI against the real providers; app updater checked,
downloaded and verified against an update feed, and the packaged build's GitHub feed wiring
confirmed).

### ✅ Phase 8 — Production Release

- [x] Application icon (original artwork), Windows ICO, Linux window icon
- [x] Packaging: per-target native prebuild only, no source maps or build sources; Windows NSIS (x64 + ARM64) and portable built and verified locally; macOS and Linux configured
- [x] Electron fuses locked down and verified in the packaged binary
- [x] `app://` scheme replaces `file://` for the UI
- [x] Security audit (independent review) and fixes; residual risks documented in SECURITY.md
- [x] Automated tests extended (protocol, containment, thumbnails, FFmpeg protocols, yt-dlp plugins)
- [x] License notices: LICENSE, generated full license texts, coverage/version/approval check
- [x] Documentation: README (installing, verifying, releasing), CHANGELOG, SECURITY
- [x] GitHub Actions: CI on three OSes and a tag-driven release with checksums and update manifests
- [x] Release preparation: version 1.0.0, changelog section, signing/notarization wiring via secrets
- [ ] Not done: macOS/Linux packages (their CI test runs fail — 1 test on macOS, 2 on Ubuntu, 2026-11-17), code-signing certificates

Deliverable: publicly distributable v1.0 — **Windows only** (user decision, 2026-11-17): the
release workflow verifies on Windows and builds only Windows packages; macOS and Linux stay
in the matrix as comments until their CI failures are fixed.

---

## 4. Phase 1 report

### Implemented

- Electron main process with single-instance lock, graceful shutdown (IPC
  handlers removed, database closed on quit) and a fatal-startup dialog that
  points to the log file.
- Secure preload bridge `window.ytdlpp` with `app.getInfo`,
  `app.openLogsFolder`, `settings.get`, `settings.update`, `settings.onChanged`.
- SQLite database with migration runner and the full initial schema.
- Settings service: in-memory cache, per-key validation, change events
  broadcast to all windows, `nativeTheme.themeSource` kept in sync.
- UI shell: sidebar (Home, Downloads, Playlists, Audio Converter, History,
  Settings, Software Updates; version indicator), header with page title and
  theme toggle, fade transitions, toasts, skeletons.
- Settings page: Appearance (theme: Dark / Light / System), Diagnostics (open
  logs folder), About (versions, platform, data and log folders).
- Feature pages not yet built show an honest "In development" empty state
  instead of non-functional controls.

### Tests performed

| Check | Result |
| --- | --- |
| `npm run typecheck` (tsc + vue-tsc, strict) | Pass |
| `npm run lint` | Pass, 0 warnings |
| `npm test` — 38 unit tests (migrations, constraints, rollback, settings service, IPC registrar, URL policies) | 38/38 pass |
| `npm run test:e2e` — 4 Playwright tests on the built app (hardened webPreferences, exposed API surface, no Node globals, navigation of all 7 sections, IPC validation rejection, theme switching + persistence across restart, zero console errors) | 4/4 pass |
| Dev mode (`electron-vite dev`) driven through Playwright | Renders, HMR connected, no CSP errors |
| Packaged build (`electron-builder --dir --win --x64`) launched | Starts, SQLite native module loads from `app.asar.unpacked`, settings persist, no console errors |
| `npm audit --omit=dev` | 0 vulnerabilities |

### Known issues and follow-ups

1. **No application icon yet** — Electron Builder uses the default Electron
   icon. Phase 8.
2. **GitHub `publish` configuration is not set** — needs the repository
   owner/name. Phase 7.
3. **All eight better-sqlite3 prebuilds (~16 MB) ship in every package.**
   Prune to the target platform in Phase 8 (`files` filters per platform).
4. **macOS and Linux packages have not been built yet** (no host available in
   this environment); configuration is in place, CI will cover them in Phase 8.
5. **Dev-only `npm audit` findings** (27 moderate, all from a `minimatch` ReDoS
   advisory inside ESLint/Electron Builder tooling). Not shipped; re-check when
   upstream releases fixes.
6. If `ELECTRON_RUN_AS_NODE` is set in the shell (some Electron-based editors
   set it), `npm run dev` launches Electron as plain Node. Documented in the
   README; e2e tests strip it.

---

## 5. Phase 2 report

### Implemented

- **Engine services** (`electron/services/engines/`): platform detection, binary
  format/arch inspection, three-tier resolution, version probes with FFmpeg capability
  checks, install manifest, yt-dlp release resolution with OpenPGP signature
  verification, FFmpeg providers (BtbN, Martin Riedl), installer with staging, rollback
  and crash recovery, and `EngineManager` (serialised detection/installs, events,
  cancellation, leases).
- **Supporting utilities**: allowlisted HTTPS client with streaming SHA-256, size limits
  and stall detection; shell-free process runner with timeouts and output caps; system-tar
  extraction; disk-space check; checksum helpers.
- **Storage**: `EngineVersionsRepository`, `UpdateHistoryRepository`.
- **IPC** (validated like Phase 1): `engines:get-status`, `engines:refresh {deep}`,
  `engines:install {target}`, `engines:cancel-install`, `engines:open-folder`; event
  `engines:changed`. New error codes: `NETWORK`, `INTEGRITY`, `INSUFFICIENT_SPACE`,
  `BUSY`, `CANCELLED`, `UNSUPPORTED`.
- **UI**: Software Updates engine cards, confirmation dialog (names provider and license),
  progress with cancel, setup banner, sidebar attention dot. Detection starts after the
  window is shown and never blocks startup.

### Tests performed

| Check | Result |
| --- | --- |
| `npm run typecheck`, `npm run lint` | Pass, 0 problems |
| Unit + integration tests (Vitest), 13 files | **148/148 pass** (38 from Phase 1 + 110 new) |
| — binary headers incl. the real Node executable; version/capability parsing against **real captured** `ffmpeg`/`ffprobe`/`yt-dlp` output | pass |
| — yt-dlp resolution against the **real signed** `SHA2-256SUMS` + `.sig` of 2026.10.26 (valid, tampered list, digest mismatch, pre-release, unsigned) | pass |
| — BtbN asset selection against the real asset list of `autobuild-2026-11-01-12-49`; macOS redirect/sidecar resolution | pass |
| — HTTP allowlist (incl. redirects and look-alike hosts), size limits, rate limit, offline, cancel, stall | pass |
| — installer: success, checksum mismatch keeps old binary, foreign-arch rejection, non-running binary, replace, cancel, toolchain mismatch, no extraction before checksum, crash recovery | pass |
| — manager: missing/managed/system precedence, toolchain pairing, mismatch, wrong-arch, quick vs deep integrity, events, history, cancel, BUSY on concurrent install and on leased engines | pass |
| — real processes: argument passing with shell metacharacters and Unicode, timeout kill, output cap, ENOENT, abort; real `tar` extraction with Unicode/space names and corrupt archive | pass |
| Electron app tests (Playwright), 7 | **7/7 pass** — setup banner and sidebar dot, all-missing state, opt-in dialog (cancel starts nothing), broken system engine (a real non-yt-dlp executable on PATH) shows "Needs repair"/"Repair", malformed engine IPC rejected, exact bridge surface |
| **Manual real-world run** (Windows 11 x64, isolated profile) | Detected the machine's WinGet FFmpeg 8.0 as a system engine; installed yt-dlp **2026.10.26** (~8 s) and FFmpeg/FFprobe **9.0.2** LGPL (~40 s, 161 MB) through the UI; deep check OK |
| Manual: tampered managed yt-dlp | Flagged `INTEGRITY_MISMATCH`, button "Repair", repair restored it |
| Manual: cancel FFmpeg reinstall mid-download | Stage `cancelled`; installed `ffmpeg.exe` untouched; staging emptied; no history entry |
| Packaged build (`electron-builder --dir`) | Built; `openpgp` loaded from inside `app.asar` and verified the real yt-dlp signature (checked without launching the app, to avoid touching an existing user profile) |
| `npm audit --omit=dev` | 0 vulnerabilities |

### Known issues and follow-ups

1. **macOS and Linux installs not exercised on real hardware.** Provider endpoints,
   asset names and checksum formats were verified live and are covered by tests; the
   Riedl builds' exact GPL version is not verified.
2. **No yt-dlp update check yet** — installs always take the latest stable release.
   Outdated detection, nightly channel and automatic updates are Phase 7.
3. **Linux musl**: no trusted FFmpeg provider; users install FFmpeg from their package
   manager (detected automatically).
4. **Gatekeeper on macOS**: binaries downloaded by the app are not quarantined, and
   yt-dlp_macos / Riedl builds are provider-signed, but this needs confirmation on a Mac.
5. **Repair history** records `previous_version = null` when the old binary was broken
   (its version could not be read). Accurate, but the manifest version could be used instead.
6. **Electron fuses** to be locked down in Phase 8 (see Phase 8 above).
7. Install progress for multi-archive providers (macOS) shows bytes without a total,
   since the provider does not publish sizes up front.

---

## 6. Phase 3 report

### Implemented

- **Media analysis** (`MediaInfoService`): validated URL → yt-dlp metadata (120 s timeout, 64 MB
  cap, process-tree kill on cancel) → Zod-validated info → normalised formats cached by
  `analysisId` → compact `MediaAnalysis` (title, uploader, duration, date, views, thumbnail,
  containers/resolutions/codecs, audio summary, subtitles, notices). Playlist/channel links and
  live streams are refused with explanations.
- **Format selection** (`format-selection.ts`): see §1 "Media analysis and downloads".
- **Downloads**: `DownloadManager` (queue, concurrency from settings, persistence, cancel, retry,
  remove, interrupted detection, graceful quit), `DownloadWorker` (spawn, line parsing, error
  classification, tree kill), `ProgressAggregator`, `DownloadRepository`, migration 003.
- **Deno** as a fourth managed engine (migration 002 widens the engine tables), with in-process
  zip extraction; the installer was refactored so FFmpeg and Deno share one verified archive pipeline.
- **IPC**: `media:analyze|cancel-analyze`, `downloads:list|start|cancel|retry|remove|show-in-folder`,
  events `downloads:changed|removed`, `app:read-clipboard`,
  `settings:choose-download-directory|reset-download-directory`.
- **UI**: Home (link input with paste/clear/cancel, preview card, options: format, resolution
  with codecs and size estimate, advanced codec, audio format/quality with honest notes, embed
  metadata/thumbnail, subtitles, destination, size estimate); Downloads (summary, total speed,
  filters with counts, per-job progress/speed/ETA/size/stage, cancel/retry/show/remove, empty
  states); Settings → Downloads; sidebar active-download badge; JS-runtime card on Updates.

### Tests performed

| Check | Result |
| --- | --- |
| `npm run typecheck`, `npm run lint` | Pass, 0 problems |
| Unit + integration tests (Vitest), 18 files | **253/253 pass** (150 before Phase 3 + 103 new) |
| — format selection against the **real** Big Buck Bunny format list (61 formats): exclusions, codec classes, MP4 4K only via AV1, sizes, plans for MP4/WebM/MKV/MP3/M4A/WAV/FLAC, codec preference, extras, subtitles; edge cases (no silent containers, codec-less sites, vertical video) | pass |
| — progress parsing and aggregation against **real captured** yt-dlp stdout/stderr (merge and MP3 runs); error classification including captured real errors | pass |
| — URL validation/classification, command lines (URL after `--`, config ignored, engines wired), thumbnail selection and private-network blocking, media service with real info JSON | pass |
| — download manager through the real worker with recorded output: full lifecycle, failure + retry, concurrency limit, cancel running/queued, remove rules, missing FFmpeg, interrupted jobs | pass |
| — migrations 002/003 upgrade a v1 database without losing rows; main-only download folder rules | pass |
| — Deno: real `.sha256sum` sidecars (both formats), real version output, resolver, installer with real zip extraction; zip traversal/absolute/drive paths, bombs, damaged archives | pass |
| Electron app tests (Playwright), 11 | **11/11 pass** — bridge surface, link validation, playlist hint, missing-engine error, IPC guards (file:/javascript: URLs, injected selector fields, unknown analysis, renderer-set download folder), settings persistence, interrupted job shown as retryable and removable with history kept |
| **Manual real-world run** (Windows 11 x64, isolated profile, CC-BY content) | yt-dlp, FFmpeg/FFprobe and Deno installed through the UI (11 s / 25 s / 18 s). Invalid and unavailable links gave plain messages. Analysis took 11 s; 3 containers, 8 resolutions, thumbnail shown. **MP4 360p** and **MP3 192 kbps** completed; FFprobe confirmed H.264 640×360 + AAC and stereo MP3, full 634.6 s, embedded cover art and tags. Cancelling a 1080p WebM mid-download left **0** yt-dlp/FFmpeg/Deno processes and removed its temp folder. |
| Packaged build (`electron-builder --dir`, separate output folder) | yauzl, pend, openpgp present in `app.asar` and load from it |
| `npm audit --omit=dev` | 0 vulnerabilities |

### Bugs found and fixed during the phase

- The Deno version regex lost its backslashes when inserted through a shell heredoc (caught by a unit test).
- A container could have produced a **silent** file when no compatible separate audio stream
  existed; now only muxed streams are offered in that case.
- Byte-progress throttling could drop the `processing` transition; phase/step changes are now always sent.
- The URL field's native browser validation blocked the app's own error messages (`novalidate`).
- A stale link error stayed visible while typing a new link.
- The geo-block wording "has not made this video available in your country" was not recognised.

### Known issues and follow-ups

1. **No pause/resume** yet; cancel deletes partial files. Phase 6 keeps per-job temp folders for resume.
2. **Interrupted downloads restart from zero** on Retry (Phase 6 adds real recovery).
3. **Playlists and channels** are refused with an explanation until Phase 4.
4. **Live streams** are refused while live.
5. **Subtitles**: one language per download in the UI (the IPC accepts up to 20).
6. **No duplicate detection** yet (`source_id` is stored for Phase 6).
7. Retrying long after analysis reuses the stored format ids; if a format has gone, the
   fallback selector picks yt-dlp's best match instead of the exact original choice.
8. Moving finished files from `<userData>/downloads-tmp` to a download folder on another drive
   is a copy, not a rename (slower for very large files).
9. Sign-in/cookies are not supported; age-restricted and members-only content fails with a clear message.

---

## 7. Phase 4 report

### Implemented

- `PlaylistService` (flat listing, entry normalisation, persistence, refresh, removal,
  on-demand entry thumbnails, batch download), `PlaylistRepository`, migration 004,
  `LinkAnalyzer`, `buildProfilePlan`, `DownloadManager.enqueue` (shared by single and batch
  downloads), filename sanitising helpers, playlist IPC (`playlists:list|get|refresh|remove|download|thumbnail`).
- Playlists page, Home routing (+ "Open the whole playlist" for videos opened from a
  playlist link), "Create subfolders for playlists" setting, playlist labels on Downloads.
- `EngineManager.waitForRuntime()` so work started during startup detection waits instead of failing.
- WebP thumbnail pass-through.

### Tests performed

| Check | Result |
| --- | --- |
| `npm run typecheck`, `npm run lint` | Pass, 0 problems |
| Unit + integration tests (Vitest), 19 files | **294/294 pass** (253 before + 41 new) |
| — flat parsing against the **real** "Official Blender Open Movies" playlist (17 entries) and a real channel Videos tab; unavailable entries; bad links; nested playlists | pass |
| — profile plans: the exact `-f` / `-S` expressions verified against real yt-dlp picks | pass |
| — folder-name sanitising (separators, traversal, reserved Windows names, control characters, Unicode, length) and containment; prefix validation | pass |
| — repository: save, refresh keeping links by video id across re-ordering, status mirroring, removal keeping jobs | pass |
| — service: listing, missing playlist (real error text), batch queueing with numbering/subfolders, skipping unavailable/active entries, status sync, request validation; link routing | pass |
| — engine readiness wait; WebP signature check | pass |
| Electron app tests (Playwright), 14 | **14/14 pass** (11 before + 3 new): saved playlist, unavailable entry disabled, select all/none, Shift+click range, filter, batch refused without engines with nothing queued, playlist IPC guards (positions, injected destination, unknown playlist, malformed thumbnail request), removal, Home/Playlists link validation and routing hints |
| **Manual real-world run** (Windows 11 x64, isolated profile, CC-BY content) | Engines installed through the UI. Pasting the playlist link on Home opened Playlists with 17 entries (listed in ~5 s). Two films downloaded as MP4 ≤360p and one as MP3, into `Official Blender Open Movies/` as `008 - …`, `010 - …`, `013 - …`; FFprobe confirmed H.264 640×360 + stereo AAC, stereo MP3 192 kbps, full durations, tags. Cancelling a 1080p film left 0 engine processes. After a restart the playlist and entry statuses (Downloaded / Cancelled / pending) were intact. A channel link right after restart waited for engine detection and listed 1000 videos in 26 s with the truncation note; scrolling the 1000-row list ran at 16–17 ms per frame with thumbnails loading as rows appeared. |
| Packaged build | not rebuilt this phase: no new dependencies |
| `npm audit --omit=dev` | 0 vulnerabilities |

### Bugs found and fixed during the phase

- Entry thumbnails were blank: YouTube serves signed `.jpg` thumbnail URLs as WebP, which
  Electron's encoder cannot decode (found in the real run; fixed with signature-checked pass-through).
- A link pasted within seconds of launch failed with "engines are still being checked"
  (found in the real run; operations now wait for the first detection).
- Without resolution first in the sort order, yt-dlp chose a muxed 360p stream for "best";
  and its defaults pick AV1 for MP4 and 5.1 surround audio (found while verifying expressions,
  before any code shipped).
- A missing playlist was reported as "This video is unavailable" (classifier rule added).
- Folder names from titles like `../../x` kept a leading `..` (harmless, but now stripped).

### Known issues and follow-ups

1. Playlists over 1000 entries are truncated (shown in the UI); channels list only the Videos tab (not Shorts or Live).
2. Batch items use yt-dlp's choice within the profile; per-video sizes are unknown until each starts.
3. Unavailable entries are rarely visible: YouTube now hides most of them from playlist listings.
4. "Download all" queues jobs at once; a very large batch shows many queued rows (grouping is a possible later improvement).
5. Refresh replaces positions with the playlist's current order; numbered files already
   downloaded keep their old numbers.
6. In one automated run the visible test window received a few manual clicks (an extra
   refresh and a 2-video download appear in its log); results above are from the scripted steps.

---

## 8. Phase 5 report

### Implemented

- `ConversionService` (token registry for picked files and folders, FFprobe inspection,
  single-slot queue, FFmpeg runner with `-progress` parsing, verification, atomic rename,
  cancel/shutdown, session job list) and the pure `conversion-plan` module (probe parsing,
  argument building, progress parser, unique naming, error classification, output checks).
- `EngineManager.waitForToolchain()` (FFmpeg + FFprobe, bounded wait for startup detection).
- Converter IPC (`converter:pick-files|choose-folder|start|list|cancel|remove|show-in-folder`,
  `converter:changed|removed`), all Zod-validated; quit stops a running conversion.
- Audio Converter page (replacing the placeholder), converter store, sidebar badge.

### Tests performed

| Check | Result |
| --- | --- |
| `npm run typecheck`, `npm run lint` | Pass, 0 problems |
| Unit + integration tests (Vitest), 22 files | **332/332 pass** (294 before + 38 new) |
| — probe parsing against **real** FFprobe 8.0 output (Unicode-tagged 16-bit WAV, MP3 with PNG cover, MP4 with H.264 + AAC, 96 kHz 24-bit FLAC); progress parsing against real `-progress` output; real "Invalid data" error text | pass |
| — arguments per format and quality, same-codec copy, 24-bit WAV, 16-bit FLAC for lossy sources, cover mapping, downmix, `file:` URLs, unique names that never hit the input, verification rules | pass |
| — service with a scripted FFmpeg: one at a time, progress/ETA, verification failure and FFmpeg failure remove the temp file, cancel (running and queued), destinations by token, unknown tokens, empty/missing files, FFmpeg checked before the dialog, shutdown | pass |
| — **real FFmpeg** integration (runs when FFmpeg is on `PATH`): generated media → all five formats with Unicode names and tags, verified by FFprobe; audio from video; cover kept; `(1)` naming; cancel of a 10-minute file leaves nothing | pass |
| Electron app tests (Playwright), 16 | **16/16 pass** (14 before + 2 new): converter IPC guards (paths instead of tokens, unknown tokens/jobs, bad format, extra fields, bad ids); missing FFmpeg explained without opening the dialog; **real conversion through the UI** with stubbed native dialogs (Unicode WAV → FLAC in a chosen folder, broken file reported, second run named `(1)`, clear finished) |
| **Manual real-world run** (Windows 11 x64, isolated profile, FFmpeg 8.0, dialogs stubbed) | Five sources (Unicode-named 16-bit WAV with tags, MP4 video, MP3 with cover art, 96 kHz 24-bit FLAC, damaged MP3) shown with correct details; the damaged file explained and skipped. 20 conversions (each source × MP3 192 / M4A Best / OPUS 128 / FLAC / WAV) all completed; FFprobe confirmed codecs, full durations, titles (incl. Unicode), cover art in MP3/M4A/FLAC, no video track from the MP4, 24-bit WAV only for the 24-bit source, M4A from AAC copied. A 30-minute file converted at ~150× with live %/speed/ETA and the sidebar badge; Cancel stopped it with 0 FFmpeg processes and no partial file left. 0 console errors. |
| Packaged build | not rebuilt this phase: no new dependencies |
| `npm audit --omit=dev` | 0 vulnerabilities |

### Bugs found and fixed during the phase

- Lossy sources converted to FLAC were stored as 24-bit (FFmpeg default for decoded float
  audio), 3–4× larger for nothing (found in the real run; now 16-bit).
- A batch appeared in reverse order in the conversion list (found in the real run; one
  timestamp per batch and ordered insertion).
- Picking files before FFmpeg was known to be missing let the user choose files only to see
  an error (FFmpeg is now checked before the dialog opens).
- "Files not added" toast blamed the 200-file limit when the files were duplicates (now
  duplicates are skipped silently and only the limit is reported).

### Known issues and follow-ups

1. The conversion list is not persisted; it is cleared when the app closes (files stay).
2. Only the first audio track of a file is converted; files with several languages cannot pick one yet.
3. Files cannot be dropped onto the window yet (drag and drop would need a vetted path
   hand-off from the renderer; the dialog keeps paths out of the renderer).
4. Without a duration (rare streams), progress is indeterminate and verification cannot check length.
5. "Best" for M4A/OPUS means 256 kbps; there is no VBR quality scale for those encoders.

---

## 9. Phase 6 report

### Implemented

- `DownloadManager`: pause/resume (single and all), automatic network retries with backoff,
  cancel in every state, retry from History, shutdown that saves interrupted jobs as paused,
  startup recovery, scratch-folder retention and clean-up, duplicate checks, previous
  downloads, downloaded-source lookup for playlists, history queries and deletion (file to
  the Recycle Bin / Trash on request), live concurrency changes.
- Orphan guard (`orphan-guard.ts`): owner records, OS process inspection (Windows CIM,
  Linux `/proc`, macOS `ps`), identity check, tree/group kill.
- Migration 005 (`downloads.interrupted`, format index); `DownloadRepository` recovery,
  history, delete/undismiss, duplicate queries.
- IPC: `downloads:pause|resume|pause-all|resume-all`, `history:list|delete|retry|show-in-folder`,
  new `DUPLICATE` error code; Zod schemas for history queries and deletion.
- Settings: `maxRetries`, `networkTimeoutSeconds`, `proxy`, `speedLimitKib`, `logLevel`;
  proxy validation (`shared/validation/network.ts`); yt-dlp `--socket-timeout`, `--proxy`,
  `--limit-rate`; session proxy for YT-DLP++'s own requests; proxy-authenticating fetch.
- UI: Downloads (Pause/Resume, Paused filter, Pause all/Resume all, recovery notice, retry
  countdown), History page, Settings → Advanced, Home "downloaded before" notice, playlist
  "Skip videos already downloaded" option and Paused status.
- yt-dlp error classifier: messages printed after an empty `ERROR:` line are now read
  (found in the real network-cut test).

### Tests performed

| Check | Result |
| --- | --- |
| `npm run typecheck`, `npm run lint` | Pass, 0 problems |
| Unit + integration tests (Vitest), 25 files | **387/387 pass** (332 before + 55 new); timing-sensitive files repeated 4 times without failures |
| — manager: pause keeps partial files and re-runs the identical command; pause all/resume all order; no pause during post-processing; cancel of paused jobs; automatic retry with real "getaddrinfo failed" text, retry limit, pause/cancel while waiting; shutdown → paused/interrupted; crash recovery; plan-less rows → failed; owner records written/cleared and orphans stopped at startup; duplicates; previous downloads; downloaded-source lookup honouring missing files; history search (literal `%`/`_`), result, format, dates, paging, listed flag; delete with/without file; retry from history | pass |
| — orphan guard against **real processes**: identifies a running process (path and start time), stops it and its child, leaves an unrelated process alone | pass |
| — proxy parsing/normalising/redaction, Chromium rules, settings ranges, yt-dlp network arguments, history query validation (injection-shaped input rejected) | pass |
| — proxy-authenticating fetch: answers only the configured proxy (never a website), final URL after redirects, redirect refusal, abort before/after the response, errors, empty bodies | pass |
| — classifier: real network-drop output (`ERROR: ` then `[download] Got error: …`) → `NETWORK` | pass |
| Electron app tests (Playwright), 20 | **20/20 pass** (16 before; the old "interrupted → failed" test replaced; 5 new): recovery notice, paused/interrupted rows, orphan scratch folder removed, partial files kept, resume/cancel; Resume all; History paging, search, filters (format, result, custom dates, today), file missing, delete with/without file (trash stubbed), retry from history; IPC guards; Advanced settings persisted, proxy validation and redaction, proxy applied to the session on change and at startup |
| **Manual real-world run A** (Windows 11, isolated profile, Big Buck Bunny CC-BY, 1080p60 MP4) | Speed limit: 2.96 MB/s at a 3 MB/s limit. Pause at 16.6 MB: no engine process left, `.part` kept; resume continued at 16.6 MB (never lower). Quit at 23.4 MB: no process left, partial kept; restart showed "1 download was interrupted…", Resume all continued at 23.4 MB. Hard kill of Electron's main process while downloading: yt-dlp exited within 1 s; restart recovered the job as paused/interrupted from its partial file. Completed file: H.264 1920×1080 + AAC stereo, 634.6 s; **full FFmpeg decode without errors**; scratch folder emptied. Re-analysing showed "You have downloaded this video before … Show". 0 console errors. |
| **Manual real-world run B** (local proxy requiring Basic authentication) | Proxy entered on Settings → Advanced (shown as `http://***@127.0.0.1:…`). yt-dlp's analysis and downloads went through it (www.youtube.com, googlevideo); YT-DLP++'s thumbnail request got a 407 and was answered by the proxy-authenticating fetch. M4A download completed. Tunnels cut at 10.0 MB of a 1080p download: "Connection problem — retrying in 5 s (attempt 1 of 3)", resumed at 10.3 MB, completed (257 MB, verified with FFprobe). History listed both. The password never appeared in the log. |
| Packaged build | not rebuilt this phase: no new dependencies |
| `npm audit --omit=dev` | 0 vulnerabilities |

### Bugs found and fixed during the phase

- yt-dlp kept running after the app was killed (observed); added the orphan guard.
- Electron's `net.fetch` does not answer proxy authentication (verified: HTTP 407, no
  `login` event); added the `net.request`-based fetch for authenticated proxies.
- A dropped connection was classified as "stopped unexpectedly" because yt-dlp printed the
  message after an empty `ERROR:` line, so automatic retry never started (real network-cut
  test); the classifier now reads those lines.
- IPv6 proxy hosts got doubled brackets in Chromium's proxy rules (unit test).
- `resume()` returned the job after the queue had already started it (unit test).
- Two "Resume all" buttons while the recovery notice was shown (screenshot review).

### Known issues and follow-ups

1. Speed limit and proxy changes apply when a download starts or resumes; a running download
   keeps the settings it started with.
2. Partial files of failed downloads stay in the app's data folder until the job is retried,
   removed or deleted from history.
3. Post-processing (merging, converting) cannot be paused; the Pause button is hidden while a download is being finished.
4. Proxy credentials are stored unencrypted in the local settings database (stated in the UI).
5. The proxy-authenticating fetch streams without back-pressure; fine for thumbnails and
   engine archives, not meant for large transfers.
6. Conversions (Phase 5) are not part of History yet.
7. Seen only under Playwright on Windows: after a hard kill of the app, Chromium helper
   processes outlived it for a while; normal quitting was not affected.

---

## 10. Phase 7 report

### Implemented

- Update checks (`engine-update-check.ts`, `versions.ts`): per-provider latest-version lookups
  without downloads; yt-dlp nightly channel (`yt-dlp/yt-dlp-nightly-builds`, same pinned signing
  key); BtbN/Riedl build comparison; update decisions incl. channel switches.
- Installer: verification of the installed binaries after the swap with automatic restore
  (`UpdateRolledBack`), one-generation rollback store with install records, `rollback()`.
- EngineManager: channel-aware installs, `rollbackTarget`, rollback versions and in-use targets
  in the snapshot, lease events, "rolled back" history entries.
- `UpdateService`: checks (single and all), persisted results (migration 006: `update_checks`,
  `app_state`; `engine_versions.latest_version/checked_at`), deferred updates, scheduler,
  opt-in yt-dlp auto-update, app update download/install with outcome recorded after restart,
  notices.
- App updater (`app-updater.ts`): electron-updater wrapper, plain-text release notes, error
  messages; `scripts/dist.mjs` for the build-time update feed.
- IPC (`updates:*`), Software Updates page (app card, engine update rows, Check all,
  history table), Settings → Updates, sidebar marker, update notices.

### Tests performed

| Check | Result |
| --- | --- |
| `npm run typecheck`, `npm run lint` | Pass, 0 problems |
| Unit + integration tests (Vitest), 26 files | **413/413 pass** (387 before + 26 new); update-related files repeated 3 times |
| — versions: numeric comparison (dates, nightly, `v` prefixes, missing parts); FFmpeg build ids from real `ffmpeg -version` and BtbN asset names; Riedl URLs | pass |
| — decisions: stable/nightly in both directions, system copies, BtbN commit counts, older branches, vendor builds, Riedl build times, Deno | pass |
| — installer: keep-for-rollback with install record, rollback and undo, tampered/wrong-size kept copy refused, new binary failing in place → previous restored, channel recorded | pass |
| — EngineManager: channel passed to installs, rolled-back history, rollback refused while in use, lease events, no rollback for system copies | pass |
| — UpdateService: check all + persistence across restarts, channel switch, deferral until leases are released, failed updates, cancel waiting, schedule (startup delay, interval, off), opt-in auto-update (never for system copies), app notices, app download/ready/install and history after restart, checksum failure, unavailable updater | pass |
| — release notes HTML → text (scripts/markup removed); updater errors incl. the real GitHub 404 text | pass |
| Electron app tests (Playwright), 26 | **26/26 pass** (20 before + 6 new): components and "unavailable" reasons, history table, Settings → Updates persisted and linked, IPC guards, **real electron-updater check → download → SHA-512 verification → ready** against a local update feed, and a corrupted download rejected ("Update verification failed") and recorded |
| **Manual real-world run** (Windows 11, isolated development profile, live providers) | Check all: yt-dlp 2026.10.26, FFmpeg n9.0.2-48, Deno 2.9.8 all up to date. Nightly selected → "Switch to nightly (2026.11.04.232659)" → installed through the UI (signature verified with the pinned key, run in place), manifest `yt-dlp-nightly`, 2026.10.26 kept; a video analysed with it. Stable selected while a download used yt-dlp → "Waiting", binary unchanged; download paused → update ran automatically → 2026.10.26. Two rollbacks (to nightly and back) through the UI. History listed all four; no console errors. |
| Packaged build (NSIS, x64, scratch output, feed = a non-existent test repository) | `app-update.yml` (provider github, owner/repo) embedded; `latest.yml` and `.blockmap` produced next to the installer. The packaged app's check reached GitHub and got HTTP 404 (message now recognised — see below). |
| `npm audit --omit=dev` | 0 vulnerabilities |

### Bugs found and fixed during the phase

- Release notes rendered list items double-spaced (unit test).
- The real GitHub "404 … releases.atom" error was shown as a generic failure (packaged run);
  now "No published release was found on the update server."
- After a failed app download the history table did not refresh (e2e).
- "Latestnightly:" — a missing space in the update row (screenshot review).
- Finding (not a defect): on Windows electron-builder writes `app-update.yml` only for NSIS
  builds, not `--dir` ones; documented, and the packaged feed check used an NSIS build.

### Incident: a packaged test run used the real user profile

The packaged build was launched for the feed check with the usual `YTDLPP_USER_DATA_DIR`,
which packaged builds deliberately ignore. It therefore opened the user's own
`%APPDATA%\MediaFlow` profile and applied migrations 5 and 6 to its database (schema 4 → 6),
appended to its log and created `.updaterId`. The older installed YT-DLP++ build would now
refuse to start ("schema version 6 is newer than this application supports"). No user data
was lost: the changes are only in `ytdlpp.db-wal`/`-shm` (the main file is untouched since
2026-11-03; verified on copies that it is schema 4 without the WAL), and backups of every
touched file are in the session scratchpad. Removing the WAL/SHM, `.updaterId` and the
appended log lines restores the profile; that step awaits the user's approval. Packaged
builds are no longer launched for testing (recorded for future sessions).

### Known issues and follow-ups

1. App updates were verified against a local feed in development and the packaged GitHub
   wiring against a non-existent repository; an end-to-end install from a real GitHub release
   needs the repository and a published release (Phase 8).
2. Windows builds are unsigned, so electron-updater verifies the SHA-512 only; with signing,
   `publisherName` adds signature verification. macOS updates require a signed app (Phase 8).
3. The portable Windows build cannot update itself (stated in the UI).
4. One rollback generation per engine; keeping FFmpeg's previous version uses ~260 MB.
5. Automatic checks run while the app is open; there is no background service.
6. App update notifications are in-app notices, not OS notifications.

---

## 11. Phase 8 report

### Implemented

- **Icon**: original artwork (`resources/icons/icon.svg`); `scripts/render-icon.cjs` renders it
  with Electron into `resources/build/icon.png` (1024 px) and a 16–256 px `icon.ico`. Linux
  windows get `icon.png` from the resources folder.
- **Packaging** (`electron-builder.yml`): only the target's `better-sqlite3` prebuild, no
  SQLite sources, source maps, build metadata or unused OpenPGP builds; OpenPGP.js unpacked
  (LGPL); `LICENSE.txt`, notices and full license texts in the resources; NSIS installer name
  without architecture (one installer for x64 and ARM64); macOS hardened runtime, entitlements
  and notarization through environment variables; Linux synopsis/category/maintainer.
- **Fuses**: see Architecture → Production release. Verified on the built binaries.
- **`app://ytdlpp/`** custom scheme with containment checks replaces `file://`.
- **Security fixes** from the audit (below).
- **Licenses**: `LICENSE` (MIT); `scripts/licenses.mjs` (generate and `--check`); notices
  table names the exact bundled packages and versions; `scripts/dist.mjs` generates the texts
  before every package build.
- **Package verification**: `scripts/verify-package.cjs` (single app or `--all`).
- **GitHub Actions**: `.github/workflows/ci.yml` and `.github/workflows/release.yml`.
- **Release preparation**: version 1.0.0 (`package.json` and lockfile), Electron 45.3.3
  (latest 45.x patch), `CHANGELOG.md` with the 1.0.0 section, `SECURITY.md`, README sections
  on installing, verifying downloads, unsigned builds, CI and publishing, new npm scripts
  (`licenses`, `licenses:check`, `verify:package`, `icons`).

### Security audit

An independent review covered the main process, IPC, preload, engine handling, packaging and
updates.

| Finding | Severity | Status |
| --- | --- | --- |
| Packaged binary honoured `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS`, `--inspect`; no asar integrity | Medium | **Fixed** (fuses); checked on the packaged app: the variables and `--inspect` had no effect |
| yt-dlp's reported output file trusted for "Show in folder" and history, even outside the destination (and from stderr) | Low | **Fixed**: only stdout `[MF-FILE]` lines; paths outside the destination (after `realpath`) are ignored and logged |
| Windows builds unsigned → updates verified by SHA-512 only, SmartScreen warnings | Medium | **Documented**; signing wired through Actions secrets (electron-builder sets `publisherName` when signing) |
| UI loaded from `file://` | Info | **Fixed**: `app://` scheme, `GrantFileProtocolExtraPrivileges` off |
| `window.open` handed any HTTPS link to the system browser | Low | **Fixed**: always denied |
| Clipboard text returned to the renderer whatever it contained (with L2, an exfiltration path) | Low | **Fixed**: returned only when it is a valid media link |
| Converter restricted FFmpeg protocols only partly | Low | **Fixed**: `-protocol_whitelist file` on probe and conversion inputs (FFmpeg 8 already limits nested protocols; defence in depth) |
| Thumbnail private-address filter checked only the URL's host; redirects were followed | Low | **Partly fixed**: redirects refused (`redirect: 'error'`). Names that resolve to private addresses are not checked; HTTPS is required, so a private service would also need a valid certificate for that name. Documented |
| Thumbnails decoded by `nativeImage` in the unsandboxed main process | Low | **Fixed**: signature-checked pass-through to the sandboxed renderer |
| yt-dlp loads plugins from user directories | Low | **Fixed**: `--no-plugin-dirs` (yt-dlp ≥ 2024.10.22) |
| CI/Release workflow hardening (pinned actions, no persisted credentials, least permissions) | Info | **Done** |
| FFmpeg/Deno checksums come from the same source as the binaries | Info | **Documented** (SECURITY.md) |
| Proxy credentials in plain text in the database and on yt-dlp's command line | Info | **Documented** (SECURITY.md) |

`npm audit --omit=dev`: 0 vulnerabilities. Full `npm audit`: 14 moderate, all a `minimatch`
ReDoS inside ESLint and electron-builder (build-time only, not shipped; the only offered fix is
a breaking `--force` downgrade).

### Tests performed

| Check | Result |
| --- | --- |
| `npm run typecheck`, `npm run lint` | Pass, 0 problems |
| Unit + integration tests (Vitest), 27 files | **427/427 pass** (413 before + 14 new): `app://` resolution (host, traversal, encoded separators, null bytes, extensions), renderer URL checks for `app://`, output containment, thumbnail pass-through and redirect refusal, FFmpeg protocol whitelist, `--no-plugin-dirs` version gating |
| Electron app tests (Playwright) | **26/26 pass** on the production build served from `app://`, in consecutive runs |
| `npm run licenses:check` | 32 packages checked (9 bundled into the UI), all listed with matching versions and approved licenses |
| Windows packaging (x64 NSIS + ARM64 NSIS → one universal installer, x64 portable) | `MediaFlow-Setup-1.0.0.exe` (241 MB), `.blockmap`, `latest.yml`, `MediaFlow-Portable-1.0.0-x64.exe` (112 MB) produced with a test feed (before the rename) |
| `verify-package.cjs --all` on `win-unpacked` and `win-arm64-unpacked` | Pass: fuses as configured, exactly one `win32-x64` / `win32-arm64` SQLite prebuild, OpenPGP unpacked, no maps or sources, license files present |
| Packaged runtime check (isolated "MediaFlow QA" build, own profile; product name read from the asar before launch) | Starts and loads the UI from `app://` (screenshot), 6 migrations applied in its own profile, no errors; `ELECTRON_RUN_AS_NODE=1` and `NODE_OPTIONS` ignored, `--inspect` opened no port. The user's real profile was checked before and after: unchanged. The QA profile was deleted. |
| Real smoke run (development build, isolated profile) | yt-dlp 2026.10.26 with `--no-plugin-dirs` analysed a CC-BY video; thumbnail passed through (JPEG, 42 KB); M4A download (10.7 MB) completed inside the chosen folder |
| Workflows | Reviewed by hand (syntax, secrets only in `env`, pinned SHAs). A local `actionlint` run was not possible in this session. **Not yet run on GitHub.** |

### Bugs found and fixed during the phase

- Excluding all prebuilds at the root and re-including one per platform shipped **no** SQLite
  binary (the app would not start); a platform `files` list of only exclusions then shipped the
  whole project (1.4 GB). Caught by `verify-package.cjs`; fixed with one root extglob.
- WHATWG URL parsing already normalises `..` in `app://` URLs; tests corrected to assert
  containment of the result rather than rejection.
- The updater e2e feed offered 0.2.0, which is older than 1.0.0; it now offers the next major
  version.
- A download-manager test raced the release of the engine lease (intermittent); now waits.
- ESLint scanned generated QA files and flagged `require` in the CommonJS build scripts;
  configuration adjusted.

### Final acceptance criteria

| Criterion | Status |
| --- | --- |
| Runs on Windows, macOS and Linux | Windows: verified (development, production build, packaged). macOS, Linux: code is platform-aware and CI runs the app tests on both, but **not yet run** |
| Analyse and download individual videos | ✅ (real downloads, Phases 3 and 8) |
| Complete or selected playlist items | ✅ (Phase 4) |
| MP4, WebM, MKV where supported | ✅ |
| MP3, M4A, WAV, FLAC, OPUS | ✅ |
| Available video resolutions | ✅ (discovered per video) |
| Audio quality | ✅ |
| Convert local media files | ✅ (Phase 5) |
| Manage download queues | ✅ (Phase 6) |
| Download history | ✅ (Phase 6) |
| yt-dlp checked and updated independently | ✅ (Phase 7) |
| FFmpeg and FFprobe managed | ✅ (Phases 2 and 7) |
| Application updates independently | ✅ against a test feed; against a real GitHub release once one is published |
| Safe recovery from interrupted downloads | ✅ (Phase 6) |
| No separate Python or yt-dlp installation | ✅ (managed engines) |
| Proper license notices | ✅ (checked automatically) |
| Passes its automated tests | ✅ locally on Windows; on macOS/Linux once CI runs |
| Installers and release artifacts for all platforms | Windows ✅ locally; macOS and Linux **configured, produced by the Release workflow — not yet run** |

### Known issues and follow-ups

1. **v1.0.0 is Windows-only.** First CI run on GitHub (2026-11-17): Windows passed; macOS
   had 1 failing unit test and Ubuntu 2. Fix those, then re-enable macOS and Linux in
   `release.yml`. Adding signing secrets is recommended before publishing.
2. Builds are unsigned until certificates are configured: SmartScreen/Gatekeeper warnings,
   and macOS cannot install updates in place.
3. The Windows installer contains both architectures (241 MB download for every user).
4. Residual risks in SECURITY.md (shared-source checksums for FFmpeg/Deno, proxy credentials
   in plain text, thumbnail host names not resolved before the private-address check,
   dev-only `minimatch` advisory).
5. The Phase 7 real-profile incident still awaits the user's approval to restore the profile.
6. From earlier phases: portable Windows build does not update itself; one rollback
   generation per engine; checks run only while the app is open; notices are in-app only.
