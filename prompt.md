# Project: Cross-Platform Desktop Media Downloader

## 1. Your Role

Act as a senior desktop application architect, Electron engineer, TypeScript developer, Vue.js developer, UI/UX designer, and software distribution engineer.

Your task is to design and develop a professional, production-quality, cross-platform desktop media downloader application.

The application will use:

- Electron for the desktop framework.
- TypeScript for application logic.
- Vue 3 for the frontend.
- Vite for development and bundling.
- Tailwind CSS for styling.
- Pinia for state management.
- yt-dlp as the primary media downloading engine.
- FFmpeg and FFprobe for media processing.
- SQLite for local persistence.
- GitHub Releases for application distribution and updates.

The application must support Windows, Linux, and macOS.

Build this as a maintainable, modular, extensible desktop product, not a simple GUI wrapper around command-line utilities.

Use the product name `MediaFlow` provisionally. Keep the product name configurable so it can be changed later.

## 2. Primary Objectives

The application must allow users to:

1. Download individual videos using a URL.
2. Download complete playlists.
3. Select individual videos from a playlist.
4. Select video output formats such as MP4, WebM, and MKV where supported.
5. Select available video resolutions.
6. Extract and convert audio into MP3, M4A, WAV, FLAC, and OPUS.
7. Configure audio quality.
8. Manage multiple downloads through a queue.
9. Pause, resume, cancel, and retry downloads where supported.
10. Monitor download speed, progress, downloaded size, and estimated remaining time.
11. Manage downloaded files and download history.
12. Automatically detect outdated yt-dlp versions.
13. Update yt-dlp from its official release source.
14. Manage FFmpeg and FFprobe versions.
15. Update the desktop application independently.
16. Configure application preferences and download locations.

The application should work locally without requiring an account, subscription, backend server, or cloud database.

Support downloading content that users own or are otherwise authorized to download. Respect applicable copyright requirements and platform terms.

---

# 3. Technology Stack

Use the following technologies.

### Desktop

- Electron
- Electron Builder
- electron-updater
- Secure preload bridge
- IPC communication

### Frontend

- Vue 3 Composition API
- TypeScript
- Vite
- Tailwind CSS
- Pinia
- Vue Router
- Lucide icons
- Zod for validation

### Backend / Desktop Services

- Node.js
- TypeScript
- child_process.spawn
- better-sqlite3
- Axios or native fetch
- electron-log

### Media engines

- yt-dlp
- FFmpeg
- FFprobe

### Testing

- Vitest
- Playwright
- Electron application integration tests

Use compatible, stable package versions. Do not blindly use deprecated APIs or outdated packages.

Prefer a single consistent packaging approach using Electron Builder.

---

# 4. Application Architecture

Use a modular monolithic architecture with clearly separated layers.

The application must contain the following layers:

## Renderer Process

Responsible for:

- User interface
- Navigation
- Forms
- Download visualization
- Progress indicators
- Settings
- User interactions

The renderer must not have direct Node.js or filesystem access.

## Preload Process

Responsible for:

- Exposing a restricted API through contextBridge.
- Providing typed IPC methods.
- Receiving validated application events.
- Preventing arbitrary IPC channel access.

## Electron Main Process

Responsible for:

- Application lifecycle.
- Window management.
- IPC handlers.
- Filesystem operations.
- Download process management.
- Engine initialization.
- Update management.
- Database initialization.

## Service Layer

Create independent services for:

- Download management.
- Playlist management.
- Media information extraction.
- Media conversion.
- Engine management.
- Engine updates.
- Application updates.
- Settings management.
- Download history.
- File management.

All business logic must remain outside Vue components.

---

# 5. Recommended Project Structure

Create a structure similar to:

mediaflow/
│
├── electron/
│   ├── main.ts
│   ├── preload.ts
│   │
│   ├── ipc/
│   │   ├── download.ipc.ts
│   │   ├── playlist.ipc.ts
│   │   ├── media.ipc.ts
│   │   ├── settings.ipc.ts
│   │   └── update.ipc.ts
│   │
│   ├── services/
│   │   ├── download/
│   │   │   ├── download-manager.ts
│   │   │   ├── download-queue.ts
│   │   │   ├── download-worker.ts
│   │   │   └── download-progress.ts
│   │   │
│   │   ├── playlist/
│   │   │   └── playlist.service.ts
│   │   │
│   │   ├── media/
│   │   │   ├── media-info.service.ts
│   │   │   └── conversion.service.ts
│   │   │
│   │   ├── engines/
│   │   │   ├── engine-manager.ts
│   │   │   ├── ytdlp-engine.ts
│   │   │   ├── ffmpeg-engine.ts
│   │   │   └── ffprobe-engine.ts
│   │   │
│   │   ├── updates/
│   │   │   ├── app-updater.ts
│   │   │   ├── engine-updater.ts
│   │   │   └── release-checker.ts
│   │   │
│   │   ├── storage/
│   │   │   ├── database.ts
│   │   │   ├── download.repository.ts
│   │   │   ├── playlist.repository.ts
│   │   │   └── settings.repository.ts
│   │   │
│   │   └── filesystem/
│   │       └── file-manager.ts
│   │
│   ├── database/
│   │   └── migrations/
│   │
│   └── utils/
│
├── src/
│   ├── assets/
│   ├── components/
│   │   ├── common/
│   │   ├── layout/
│   │   ├── downloads/
│   │   ├── media/
│   │   └── playlists/
│   │
│   ├── layouts/
│   │   └── MainLayout.vue
│   │
│   ├── pages/
│   │   ├── Home.vue
│   │   ├── Downloads.vue
│   │   ├── Playlists.vue
│   │   ├── Converter.vue
│   │   ├── History.vue
│   │   ├── Settings.vue
│   │   └── Updates.vue
│   │
│   ├── stores/
│   │   ├── download.store.ts
│   │   ├── playlist.store.ts
│   │   ├── settings.store.ts
│   │   └── update.store.ts
│   │
│   ├── composables/
│   ├── types/
│   └── router/
│
├── shared/
│   ├── types/
│   ├── constants/
│   └── validation/
│
├── resources/
│   ├── engines/
│   │   ├── win32/
│   │   ├── linux/
│   │   └── darwin/
│   ├── icons/
│   └── licenses/
│
├── tests/
├── forge.config.ts (only if needed; otherwise omit)
├── electron-builder.yml
├── package.json
├── tsconfig.json
├── vite.config.ts
└── README.md

You may refine the structure if necessary, but maintain clear separation of responsibilities.

Do not create unnecessary abstractions.

---

# 6. User Interface Design

Create a premium, modern desktop interface.

Design direction:

- Modern download manager aesthetic.
- Dark theme as default.
- Light theme as an alternative.
- Clean sidebar navigation.
- Rounded cards.
- Subtle shadows.
- Smooth transitions.
- Consistent spacing.
- Lucide icons.
- Clear typography.
- Responsive desktop layout.
- Professional empty states.
- Loading skeletons.
- Toast notifications.
- Confirmation dialogs for destructive operations.

Avoid overly colorful interfaces, excessive gradients, and unnecessary animations.

The application should look like a polished commercial desktop application.

## Sidebar Navigation

Include:

1. Home
2. Downloads
3. Playlists
4. Audio Converter
5. History
6. Settings
7. Software Updates

Include an application version indicator at the bottom of the sidebar.

## Home Page

Create a URL input section with:

- URL input field.
- Paste from clipboard button.
- Analyze button.
- Clear button.

When a valid URL is analyzed, display a media preview card containing:

- Thumbnail.
- Title.
- Channel/uploader.
- Duration.
- Available formats.
- Available resolutions.
- Available audio options.

Allow users to select the download format before starting.

Provide clear error messages for invalid or unsupported URLs.

## Downloads Page

Display active downloads in individual cards or rows.

Each download should show:

- Thumbnail.
- Video title.
- Output format.
- Selected resolution or audio quality.
- Progress percentage.
- Download speed.
- ETA.
- Downloaded size.
- Total size when known.
- Current status.

Available actions:

- Pause.
- Resume.
- Cancel.
- Retry.
- Open containing folder.
- Remove from list.

Support filtering by:

- All
- Downloading
- Queued
- Completed
- Failed
- Cancelled

Include a global download summary.

## Playlists Page

Display:

- Playlist title.
- Playlist thumbnail where available.
- Channel/uploader.
- Total video count.
- Individual video list.
- Individual video selection.
- Select all / deselect all.
- Download selected.
- Download entire playlist.

Each playlist video should have its own download status.

## Audio Converter Page

Provide a dedicated interface for converting local media files.

Allow users to:

- Select files using a file picker.
- Select output format.
- Select audio quality.
- Select destination directory.
- Start conversion.
- View conversion progress.
- Cancel conversion.
- Open output folder.

Support MP3, M4A, WAV, FLAC, and OPUS.

Use FFmpeg for conversion.

## History Page

Show previously downloaded items.

Features:

- Search.
- Filter by format.
- Filter by date.
- Open file location.
- Delete history entry.
- Retry failed downloads where possible.

Do not delete the actual downloaded file when removing a history record unless the user explicitly chooses to delete the file.

## Settings Page

Organize settings into sections:

### General

- Application theme.
- Startup behavior.
- Language preference (English initially).
- Clipboard URL detection.
- Notification preferences.

### Downloads

- Default download directory.
- Default video format.
- Default audio format.
- Default video quality.
- Default audio quality.
- Maximum simultaneous downloads.
- Filename template.
- Create subfolders for playlists.
- Skip existing files.

### Updates

- Automatic update checks.
- Check frequency.
- yt-dlp release channel.
- Automatic yt-dlp updates (optional).
- FFmpeg update preferences.
- Application update notifications.

### Advanced

- Custom yt-dlp arguments only through a validated, controlled configuration.
- Logging preferences.
- Maximum retries.
- Network timeout.
- Proxy settings if supported safely.

---

# 7. Format and Quality Selection

This is a core feature and must be implemented properly.

Do not hardcode available resolutions.

Use yt-dlp metadata to discover formats dynamically.

Distinguish between:

- Container formats.
- Video codecs.
- Audio codecs.
- Resolutions.
- Bitrates.
- Separate video and audio streams.

## Video Output Formats

Support:

- MP4
- WebM
- MKV

Only offer a format when it is supported by the available streams or can be produced through a valid FFmpeg remux/transcode operation.

## Video Quality

Offer available resolutions such as:

- 360p
- 480p
- 720p
- 1080p
- 1440p
- 2160p (4K)

Do not show unavailable resolutions.

Allow users to choose:

- Best available.
- Specific resolution.
- Audio-only.

## Video Codec Information

Where available, show:

- H.264 / AVC
- H.265 / HEVC
- VP9
- AV1

Allow an advanced codec preference, but do not promise a specific codec if the source does not provide it.

## Audio Output Formats

Support:

- MP3
- M4A
- WAV
- FLAC
- OPUS

Audio quality options:

- Best available.
- 128 kbps.
- 192 kbps.
- 256 kbps.
- 320 kbps.

For formats where bitrate settings are not applicable, explain this in the interface.

Do not claim that converting a lossy source into WAV or FLAC restores original audio quality.

## Additional Options

- Embed metadata.
- Embed thumbnail where supported.
- Download subtitles.
- Subtitle format: SRT and VTT.
- Download subtitles only.
- Preserve original audio where appropriate.

## Technical Implementation

For MP4 downloads, prefer compatible streams and merge them using FFmpeg.

Example:

yt-dlp -f "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b" --merge-output-format mp4 URL

For MP3:

yt-dlp -x --audio-format mp3 --audio-quality 192K URL

For WebM:

yt-dlp -f "bv*[ext=webm]+ba[ext=webm]/b" --merge-output-format webm URL

Do not blindly use these example commands for every source. Build a format-selection service that constructs validated yt-dlp arguments based on the formats discovered during analysis.

Use FFmpeg for conversion and stream merging where necessary.

Avoid unnecessary transcoding.

---

# 8. yt-dlp Integration

Use yt-dlp as a managed external executable.

Do not require users to install Python or yt-dlp separately.

The application should manage its own engine installation.

## Engine Initialization

At application startup:

1. Detect OS.
2. Detect CPU architecture.
3. Locate the appropriate engine executable.
4. Check whether it exists.
5. Check executable permissions.
6. Run version detection.
7. Verify FFmpeg and FFprobe.
8. Initialize the engine manager.

If an engine is missing, show an installation or repair interface.

Use official yt-dlp releases as the primary source.

## Metadata Extraction

Use machine-readable JSON output.

Example:

yt-dlp --dump-single-json --skip-download URL

Parse the JSON and normalize it into internal TypeScript models.

Support both individual videos and playlists.

Handle large playlists carefully.

Avoid loading unnecessary full-resolution metadata into the renderer.

## Download Execution

Use Node.js child_process.spawn.

Never use shell command concatenation with user-provided URLs or filenames.

Pass executable arguments as separate array elements.

Implement:

- stdout parsing.
- stderr parsing.
- Progress normalization.
- Process lifecycle management.
- Error classification.
- Cancellation.
- Retry.
- Process cleanup.

Use yt-dlp's supported progress output or progress templates.

Do not parse console output using fragile assumptions.

---

# 9. Download Manager and Queue

Create a centralized DownloadManager.

Each job must have a unique UUID.

Define a normalized job model:

interface DownloadJob {
  id: string;
  url: string;
  title: string;
  thumbnail?: string;
  mediaType: 'video' | 'audio' | 'playlist';
  outputFormat: string;
  quality?: string;
  outputPath: string;
  status:
    | 'queued'
    | 'analyzing'
    | 'downloading'
    | 'processing'
    | 'paused'
    | 'completed'
    | 'failed'
    | 'cancelled';
  progress: number;
  speed: number;
  eta: number;
  downloadedBytes: number;
  totalBytes?: number;
  error?: string;
}

Support:

- Multiple queued jobs.
- Configurable concurrency.
- Individual job control.
- Retry failed jobs.
- Duplicate detection.
- Resume where supported.
- Graceful shutdown.
- Recovery after application restart.

Suggested initial defaults:

- Maximum 2 concurrent video downloads.
- Maximum 1 concurrent conversion.
- Unlimited queue size subject to reasonable safeguards.

Do not implement fake pause functionality.

If a process cannot safely pause, use a controlled stop/resume strategy and preserve partial files when possible.

Persist queue information in SQLite.

On application restart, inspect interrupted jobs and offer recovery.

---

# 10. Playlist Management

Support playlist metadata extraction and individual video selection.

Use yt-dlp playlist metadata.

Requirements:

- Fetch playlist information.
- Display playlist title.
- Display uploader.
- Display total item count.
- Display individual video entries.
- Select or deselect videos.
- Download selected entries.
- Download all entries.
- Track each entry separately.
- Track overall playlist progress.

Do not unnecessarily fetch full metadata for every entry if a lightweight playlist extraction mode is sufficient.

Handle unavailable, private, deleted, and inaccessible playlist entries gracefully.

---

# 11. FFmpeg and Audio Conversion

Bundle or provision FFmpeg and FFprobe separately for each supported platform.

Implement a MediaConverter service.

Requirements:

- Local file selection.
- Input validation.
- Supported output formats.
- Quality selection.
- Progress monitoring.
- Cancellation.
- Error handling.
- Output file verification.
- Metadata handling.

Use FFprobe to inspect input media.

Avoid shell execution.

Handle filenames containing Unicode characters, spaces, and special characters.

Support common audio and video inputs.

---

# 12. Software and Engine Update Manager

This is a major feature.

Create an independent update system for:

1. Desktop application.
2. yt-dlp.
3. FFmpeg.
4. FFprobe.

Each component must have separate version detection and update status.

## yt-dlp Update

Use the official GitHub release API:

https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest

Check:

- Installed version.
- Latest stable version.
- Release date.
- Available platform assets.
- Download URL.
- Checksums or signatures where provided.

Compare versions correctly.

Do not compare version strings lexicographically.

Support a stable release channel by default, with optional nightly updates.

Do not assume yt-dlp's built-in self-updater works for every platform or packaging type.

Implement a managed-binary update mechanism:

1. Check the latest release.
2. Identify the correct platform asset.
3. Download to a temporary directory.
4. Verify integrity.
5. Verify architecture and executable compatibility.
6. Replace the old executable safely.
7. Run version verification.
8. Roll back if verification fails.
9. Record the update history.

Never replace a running executable.

If downloads or conversions are active, defer the update or ask the user to finish them.

## FFmpeg Update

Implement a configurable, trusted binary provider.

Do not download arbitrary executables from unknown websites.

FFmpeg and FFprobe must be managed together as a compatible toolchain.

Check version and integrity before installation.

Do not assume a single universal FFmpeg release endpoint exists for all operating systems.

## Application Update

Use electron-updater with GitHub Releases.

Provide:

- Check for updates.
- Download available update.
- Display download progress.
- Install and restart.
- Release notes.
- Update errors.

Support platform-specific packaging and signing requirements.

## Updates Page UI

Show cards for each component.

Each card should contain:

- Component name.
- Installed version.
- Latest version.
- Last checked time.
- Update status.
- Check for updates action.
- Update action.
- Progress indicator.

Possible statuses:

- Up to date.
- Update available.
- Checking.
- Downloading.
- Installing.
- Updated.
- Failed.

Add a global Check All Updates button.

Add an automatic check every 24 hours, configurable in Settings.

Automatic engine installation should be opt-in.

---

# 13. SQLite Database

Use SQLite for persistent local data.

Implement schema migrations.

Create these initial tables:

## downloads

- id
- url
- title
- thumbnail
- media_type
- output_format
- quality
- output_path
- status
- progress
- downloaded_bytes
- total_bytes
- created_at
- completed_at
- error_message

## playlists

- id
- playlist_url
- title
- thumbnail
- uploader
- total_items
- created_at

## playlist_items

- id
- playlist_id
- download_id
- video_url
- title
- position
- status

## engine_versions

- id
- engine_name
- installed_version
- latest_version
- checked_at
- updated_at

## update_history

- id
- component
- previous_version
- new_version
- status
- created_at
- error_message

## settings

- key
- value

Add indexes, foreign keys, transaction handling, and appropriate constraints.

Never store unnecessary user information.

Use parameterized queries.

---

# 14. Cross-Platform Support

Support:

## Windows

- Windows 10/11 x64.
- Optional ARM64 where dependencies permit.
- Installer.
- Portable package.

## macOS

- Intel.
- Apple Silicon.
- DMG.
- ZIP.
- Code signing and notarization configuration.

## Linux

- x64.
- ARM64 where supported.
- AppImage.
- DEB.
- RPM.

Implement platform-specific engine resolution.

Never hardcode Windows executable paths.

Use Electron app.getPath() for application-specific storage.

Separate:

- Application installation directory.
- User configuration directory.
- Engine storage directory.
- Download destination directory.
- Logs directory.

Use appropriate executable permissions on Unix platforms.

---

# 15. Security Requirements

Security is mandatory.

Implement:

- contextIsolation: true.
- nodeIntegration: false.
- sandboxing where compatible.
- Restricted preload API.
- Strict IPC validation.
- Zod validation for user inputs.
- Safe child_process.spawn usage.
- No arbitrary shell command execution.
- Safe filesystem path handling.
- URL validation.
- Output filename sanitization.
- Trusted engine download sources.
- Binary integrity checks.
- Controlled update replacement.
- Secure external URL handling.
- No unnecessary telemetry.

Treat downloaded metadata and filenames as untrusted input.

Prevent path traversal and unsafe output locations.

Prevent renderer access to arbitrary filesystem paths.

Use a restrictive Content Security Policy.

For YouTube URLs, validate supported URL patterns while recognizing that yt-dlp may support multiple legitimate URL forms.

Never expose arbitrary command execution through custom arguments.

---

# 16. Logging and Error Handling

Implement structured logging.

Log:

- Application startup.
- Engine initialization.
- Download start.
- Download completion.
- Download failures.
- Update checks.
- Engine updates.
- Conversion failures.
- Unexpected exceptions.

Do not log sensitive data unnecessarily.

Provide a user-accessible Open Logs Folder action.

Create meaningful user-friendly errors.

Examples:

- Unsupported URL.
- Video unavailable.
- Network connection failed.
- FFmpeg missing.
- Insufficient disk space.
- Permission denied.
- Engine outdated.
- Update verification failed.

Do not expose raw stack traces to ordinary users.

---

# 17. Testing Strategy

Create automated tests.

## Unit Tests

Test:

- Version comparison.
- URL validation.
- Format selection.
- Filename sanitization.
- Download progress parsing.
- Queue management.
- Update detection.
- Database repositories.
- Retry logic.

## Integration Tests

Test:

- yt-dlp execution.
- FFmpeg conversion.
- Metadata extraction.
- Playlist parsing.
- Engine updates.
- Database migrations.

Use mocked external process output where possible.

## Application Tests

Test:

- Application startup.
- Navigation.
- Theme switching.
- URL analysis.
- Format selection.
- Queue actions.
- Update interface.
- Settings persistence.

Do not depend on real YouTube downloads for every automated test.

Create fixtures and mock engine processes.

Run real-media smoke tests manually using content that is authorized for downloading.

---

# 18. CI/CD and GitHub Releases

Create GitHub Actions workflows.

Build separately for:

- Windows.
- macOS.
- Linux.

Generate:

- Installers.
- Portable builds where supported.
- Checksums.
- Release metadata.
- Update manifests.

Use version tags such as:

v1.0.0

Follow semantic versioning.

Create a release pipeline that:

1. Runs linting.
2. Runs unit tests.
3. Builds the application.
4. Runs packaging checks.
5. Generates artifacts.
6. Publishes a GitHub Release.

Keep signing credentials in GitHub Actions secrets.

Do not commit private certificates or tokens.

---

# 19. Development Phases

Develop the project in the following order.

## Phase 1: Foundation

- Initialize project.
- Install dependencies.
- Configure Electron.
- Configure Vue and Vite.
- Configure TypeScript.
- Configure Tailwind.
- Configure Pinia.
- Configure secure IPC.
- Create main layout.
- Implement theme switching.

Deliverable: Running desktop application.

## Phase 2: Engine Management

- Platform detection.
- yt-dlp initialization.
- FFmpeg initialization.
- FFprobe initialization.
- Version detection.
- Engine health checks.

Deliverable: Working media engines.

## Phase 3: Video Downloader

- URL input.
- Metadata extraction.
- Thumbnail preview.
- Format discovery.
- Resolution selection.
- Video downloads.
- Progress tracking.

Deliverable: Working individual video downloader.

## Phase 4: Playlist Downloader

- Playlist extraction.
- Playlist listing.
- Video selection.
- Batch downloading.
- Individual job tracking.

Deliverable: Working playlist downloader.

## Phase 5: Audio Converter

- Local media selection.
- MP3 conversion.
- M4A conversion.
- WAV conversion.
- FLAC conversion.
- OPUS conversion.
- Quality configuration.

Deliverable: Working audio converter.

## Phase 6: Download Manager

- Queue.
- Concurrency.
- Pause/resume where supported.
- Cancellation.
- Retry.
- History.
- Restart recovery.

Deliverable: Complete download management.

## Phase 7: Update Management

- yt-dlp release checking.
- Managed binary updates.
- FFmpeg update mechanism.
- Application updater.
- Update history.
- Rollback.

Deliverable: Complete software update system.

## Phase 8: Production Release

- Cross-platform packaging.
- Security audit.
- Automated tests.
- License notices.
- Documentation.
- GitHub Actions.
- Release preparation.

Deliverable: Publicly distributable v1.0.

---

# 20. Development Rules

Follow these instructions throughout development.

1. First inspect the existing project directory.
2. If the directory is empty, initialize the project.
3. If an existing project exists, inspect it before changing anything.
4. Create a `PROJECT_PLAN.md` file documenting architecture, milestones, and progress.
5. Create a `README.md`.
6. Create a `THIRD_PARTY_NOTICES` file.
7. Implement features incrementally.
8. Keep TypeScript strict mode enabled.
9. Avoid `any` unless there is a documented reason.
10. Use dependency injection where it improves testability.
11. Avoid oversized Vue components.
12. Keep all business logic inside services.
13. Keep IPC methods typed.
14. Validate all IPC inputs.
15. Do not block the Electron main thread.
16. Handle process termination and application shutdown safely.
17. Never claim a feature works without implementing and testing it.
18. Do not use fake data in production functionality.
19. Do not leave important features as placeholder buttons.
20. Do not silently ignore errors.
21. Keep documentation updated as implementation changes.
22. Use real, compatible package versions.
23. Verify the actual availability and licensing of bundled binaries.
24. Prefer maintainable solutions over shortcuts.

When encountering a technical issue, investigate the root cause rather than introducing a temporary workaround.

---

# 21. How to Execute This Project

Do not attempt to generate the entire application in one response.

Start by:

1. Inspecting the project directory.
2. Creating the initial architecture.
3. Preparing `PROJECT_PLAN.md`.
4. Initializing Electron, Vue 3, Vite and TypeScript.
5. Configuring Tailwind and Pinia.
6. Creating the secure preload bridge.
7. Creating the main application layout.
8. Running the application and verifying that it works.

After Phase 1 is complete:

- Report implemented features.
- Report changed files.
- Report tests performed.
- Report any remaining issues.
- Update PROJECT_PLAN.md.

Then continue to the next phase.

Do not proceed blindly when a previous phase has failed.

Ask for clarification only when an essential product decision cannot reasonably be made using the requirements above.

Otherwise, make sensible engineering decisions and document them.

## Final Acceptance Criteria

The project is considered ready for its first public release when:

- It runs on Windows, macOS and Linux.
- Users can analyze and download individual videos.
- Users can download complete or selected playlist items.
- Users can choose MP4, WebM and MKV where supported.
- Users can choose MP3, M4A, WAV, FLAC and OPUS.
- Users can choose available video resolutions.
- Users can configure audio quality.
- Users can convert local media files.
- Users can manage download queues.
- Users can inspect download history.
- yt-dlp can be checked and updated independently.
- FFmpeg and FFprobe can be managed.
- The application can update independently.
- The application safely recovers from interrupted downloads.
- The application does not require a separate Python or yt-dlp installation.
- The application has proper license notices.
- The application passes its automated tests.
- Installers and release artifacts are generated for all supported platforms.

Build MediaFlow as a professional, secure, maintainable desktop application that is ready for public distribution.