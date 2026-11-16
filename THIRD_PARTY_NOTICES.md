# Third-Party Notices

MediaFlow includes or depends on the third-party software listed below. Each
component is distributed under its own license. The full license texts of
everything that ships are collected in `licenses/THIRD_PARTY_LICENSES.txt` in
the installation directory (generated at build time by `scripts/licenses.mjs`);
Electron's and Chromium's are in `LICENSE.electron.txt` and `LICENSES.chromium.html`.

This file must be kept in sync with the shipped dependency tree:
`node scripts/licenses.mjs --check` (run in CI and before every release build)
fails when a shipped package is missing here, listed with another version, or
uses a license that is not approved. Last checked for MediaFlow 1.0.0.

## Application runtime

| Component | Version | License | Project |
| --- | --- | --- | --- |
| Electron | 45.2.1 | MIT | https://github.com/electron/electron |
| Chromium (bundled with Electron) | 156 | BSD-3-Clause and others — see `LICENSES.chromium.html` in the installation directory | https://www.chromium.org |
| Node.js (bundled with Electron) | 24 | MIT and others | https://github.com/nodejs/node |

## Bundled into the user interface

| Component | Version | License | Project |
| --- | --- | --- | --- |
| Vue (`vue`, `@vue/runtime-dom`, `@vue/runtime-core`, `@vue/reactivity`, `@vue/shared`) | 3.5.44 | MIT | https://github.com/vuejs/core |
| Vue Router (`vue-router`) | 5.4.0 | MIT | https://github.com/vuejs/router |
| Pinia (`pinia`) | 4.1.0 | MIT | https://github.com/vuejs/pinia |
| Lucide icons (`@lucide/vue`) | 1.66.0 | ISC | https://github.com/lucide-icons/lucide |
| Tailwind CSS (`tailwindcss`, generated styles) | 4.3.3 | MIT | https://github.com/tailwindlabs/tailwindcss |
| Zod (`zod`) | 4.6.7 | MIT | https://github.com/colinhacks/zod |

## Main process dependencies

| Component | Version | License | Project |
| --- | --- | --- | --- |
| better-sqlite3 | 13.0.3 | MIT | https://github.com/WiseLibs/better-sqlite3 |
| SQLite (compiled into better-sqlite3) | 3.53.4 | Public domain | https://sqlite.org |
| node-addon-api | 8.9.2 | MIT | https://github.com/nodejs/node-addon-api |
| OpenPGP.js (openpgp) — kept as a separate, replaceable module, not bundled | 6.3.2 | LGPL-3.0-or-later | https://github.com/openpgpjs/openpgpjs |
| yauzl | 3.4.0 | MIT | https://github.com/thejoshwolfe/yauzl |
| pend | 1.2.0 | MIT | https://github.com/andrewrk/node-pend |
| electron-log | 5.4.4 | MIT | https://github.com/megahertz/electron-log |
| electron-updater | 6.8.11 | MIT | https://github.com/electron-userland/electron-builder |
| builder-util-runtime | 9.7.0 | MIT | https://github.com/electron-userland/electron-builder |
| Zod | 4.6.7 | MIT | https://github.com/colinhacks/zod |
| argparse | 2.0.1 | Python-2.0 | https://github.com/nodeca/argparse |
| debug | 4.4.3 | MIT | https://github.com/debug-js/debug |
| fs-extra | 10.1.0 | MIT | https://github.com/jprichardson/node-fs-extra |
| graceful-fs | 4.2.11 | ISC | https://github.com/isaacs/node-graceful-fs |
| js-yaml | 4.3.2 | MIT | https://github.com/nodeca/js-yaml |
| jsonfile | 6.2.1 | MIT | https://github.com/jprichardson/node-jsonfile |
| lazy-val | 1.0.5 | MIT | https://github.com/develar/lazy-val |
| lodash.escaperegexp | 4.1.2 | MIT | https://github.com/lodash/lodash |
| lodash.isequal | 4.5.0 | MIT | https://github.com/lodash/lodash |
| ms | 2.1.3 | MIT | https://github.com/vercel/ms |
| sax | 1.6.1 | BlueOak-1.0.0 | https://github.com/isaacs/sax-js |
| semver | 7.7.4 | ISC | https://github.com/npm/node-semver |
| tiny-typed-emitter | 2.1.0 | MIT | https://github.com/binier/tiny-typed-emitter |
| universalify | 2.0.1 | MIT | https://github.com/RyanZim/universalify |

## Media engines (downloaded on request, not bundled)

MediaFlow does not ship these programs. When the user chooses **Install** on
the Software Updates page, the app downloads them directly from the provider
listed below, verifies them, and stores them in its own engines folder
(`<userData>/engines/<platform>-<arch>`). They run as separate programs; MediaFlow
does not link against them. Their licenses apply to those copies.

| Engine | Source | License of the downloaded build | Verification |
| --- | --- | --- | --- |
| yt-dlp (standalone executable) | Official releases, https://github.com/yt-dlp/yt-dlp | yt-dlp source is Unlicense; the PyInstaller-built executables include GPLv3+ code, so the combined executable is GPL-3.0-or-later (per yt-dlp's README) | `SHA2-256SUMS` OpenPGP signature checked against yt-dlp's pinned release key (fingerprint `AC0C BBE6 848D 6A87 3464 AF4E 57CF 6593 3B5A 7581`), then SHA-256 of the file |
| FFmpeg + FFprobe — Windows (x64, arm64), Linux glibc (x64, arm64) | BtbN FFmpeg-Builds, https://github.com/BtbN/FFmpeg-Builds (release-branch `lgpl` static builds from immutable `autobuild-*` releases) | LGPL-3.0-or-later (built with `--enable-version3`; confirmed with `ffmpeg -L`) | SHA-256 from the release's `checksums.sha256`, cross-checked with GitHub's asset digest |
| Deno (JavaScript runtime used by yt-dlp for YouTube) — Windows, macOS, Linux glibc | Official releases, https://github.com/denoland/deno | MIT | SHA-256 from the release's `.sha256sum` sidecar, cross-checked with GitHub's asset digest |
| FFmpeg + FFprobe — macOS (Apple Silicon, Intel) | Martin Riedl's build server, https://ffmpeg.martin-riedl.de (release builds; binaries are code-signed by the provider) | GPL (the provider lists x264 and x265 among the included libraries; exact GPL version not verified) | SHA-256 from the provider's `.sha256` file for the exact versioned download |

FFmpeg is a trademark of Fabrice Bellard, originator of the FFmpeg project.
Source code for FFmpeg is available at https://ffmpeg.org; each provider above
publishes its build scripts.

If engines are ever bundled inside the installer (`resources/engines`), their
full license texts must be added to `resources/licenses` first.
