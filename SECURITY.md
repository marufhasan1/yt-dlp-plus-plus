# Security policy

## Supported versions

Security fixes are made for the latest release only. YT-DLP++ updates itself from GitHub
Releases (installer and AppImage builds); portable, DEB and RPM users update by installing the
new version.

## Reporting a vulnerability

Please report vulnerabilities privately through the repository's **Security → Report a
vulnerability** page (GitHub private vulnerability reporting), not in public issues. Include
the YT-DLP++ version, operating system, steps to reproduce and the impact you expect.

Please allow a reasonable time for a fix before disclosing details. Problems in yt-dlp,
FFmpeg or Deno themselves belong with those projects; YT-DLP++ will update the version it
installs once they are fixed.

## How YT-DLP++ is protected

- **Interface**: sandboxed renderer with context isolation and no Node.js access, a strict
  Content Security Policy (`script-src 'self'`, images only from the app and `data:`), served
  from the app's own `app://ytdlpp/` scheme. Navigation away from the app, new windows,
  `<webview>` and all permission requests are refused.
- **IPC**: every message is checked for its sender and validated with Zod schemas. The
  interface never passes file paths, command-line arguments or URLs to fetch to the main
  process; files are chosen in native dialogs and referred to by tokens.
- **Packaged binary** (Electron fuses): running as Node.js (`ELECTRON_RUN_AS_NODE`),
  `NODE_OPTIONS` and `--inspect` are disabled; the app loads only from its `app.asar`, whose
  integrity is checked at start-up; cookies are encrypted.
- **Engines**: yt-dlp, FFmpeg/FFprobe and Deno come from fixed official sources over HTTPS,
  with SHA-256 checksums, and for yt-dlp the maintainers' GPG signature checked against a key
  built into YT-DLP++. New versions are run and checked before replacing the old ones, and
  are always started by absolute path, without a shell.
- **Engine output**: files yt-dlp reports outside the chosen download folder are ignored;
  yt-dlp plugins are not loaded (`--no-plugin-dirs`); FFmpeg may open local files only
  (`-protocol_whitelist file`); file name templates are fixed presets.
- **Untrusted data**: media metadata is validated before use; thumbnails are fetched by the
  main process (no redirects, private network addresses refused) and only JPEG, PNG and WebP
  data under 512 KB, recognised by signature, is passed on without being decoded; the
  clipboard is read only when it holds a link.
- **App updates**: electron-updater checks the SHA-512 of each download against the release
  manifest; on signed Windows builds it also checks the publisher's signature.

## Known limitations

- **Unsigned builds.** Releases are signed only if the maintainers configure certificates in
  the release workflow. Unsigned Windows builds show SmartScreen warnings and their updates
  are verified by SHA-512 only; unsigned macOS builds show Gatekeeper warnings and cannot
  install updates in place. Check downloads against `SHA256SUMS.txt`.
- **Engine checksums share a source with the binaries** for FFmpeg (BtbN, Martin Riedl) and
  Deno: they protect against corrupted and truncated downloads, not against a compromised
  provider. yt-dlp is additionally protected by its signature.
- **Thumbnail addresses** are checked for private and local addresses by their host name
  only; a public name that resolves to a private address is not detected. Thumbnails are
  fetched over HTTPS without redirects, so such a request would also need a valid
  certificate for that name, and only image data is ever used.
- **Proxy credentials** are stored unencrypted in the local settings database and are passed
  to yt-dlp on its command line, where other processes of the same user can read them.
- **Development tools** (ESLint, electron-builder) currently depend on a `minimatch` version
  with a known regular-expression denial-of-service issue. It runs only at build time on
  trusted input and is not part of the app; `npm audit --omit=dev` reports no
  vulnerabilities in what YT-DLP++ ships.
