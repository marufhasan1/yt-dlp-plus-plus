// Checks a packaged build without running it:
//
//   node scripts/verify-package.cjs <unpacked app folder> <platform> <arch>
//   node scripts/verify-package.cjs release/1.0.0/win-unpacked win32 x64
//
// Verifies the Electron fuses written into the binary, that the archive holds only the
// files the app needs (one native SQLite binary for the target, no sources or maps),
// that OpenPGP.js sits outside the integrity-checked archive (LGPL), and that the
// license files and icon are present. Used by the release workflow after packaging.
const { existsSync, readdirSync, readFileSync, statSync } = require('node:fs')
const { join } = require('node:path')
const { FuseV1Options, getCurrentFuseWire } = require('@electron/fuses')
const asar = require('@electron/asar')

const [dir, platform, arch] = process.argv.slice(2)
if (!dir || !platform || !arch) {
  console.error('usage: node scripts/verify-package.cjs <unpacked app folder> <platform> <arch>')
  process.exit(2)
}
const problems = []
const ok = (condition, message) => {
  if (!condition) problems.push(message)
}

const { productName } = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'))
const resources = platform === 'darwin' ? join(dir, `${productName}.app`, 'Contents', 'Resources') : join(dir, 'resources')
const executable =
  platform === 'win32' ? join(dir, `${productName}.exe`) : platform === 'darwin' ? join(dir, `${productName}.app`) : join(dir, readdirSync(dir).find((f) => f.toLowerCase() === productName.toLowerCase()) ?? productName)

;(async () => {
  // ── Fuses ──
  const wire = await getCurrentFuseWire(executable)
  const expected = {
    RunAsNode: false,
    EnableCookieEncryption: true,
    EnableNodeOptionsEnvironmentVariable: false,
    EnableNodeCliInspectArguments: false,
    EnableEmbeddedAsarIntegrityValidation: true,
    OnlyLoadAppFromAsar: true,
    LoadBrowserProcessSpecificV8Snapshot: false,
    GrantFileProtocolExtraPrivileges: false
  }
  for (const [name, enabled] of Object.entries(expected)) {
    const state = wire[FuseV1Options[name]]
    // 0x31 ('1') = enabled, 0x30 ('0') = disabled; other values mean the fuse was removed.
    ok(state === (enabled ? 0x31 : 0x30), `fuse ${name} should be ${enabled ? 'on' : 'off'} (is ${state === 0x31 ? 'on' : state === 0x30 ? 'off' : 'missing'})`)
  }

  // ── Archive contents ──
  const archive = join(resources, 'app.asar')
  const files = asar.listPackage(archive, { isPack: false }).map((f) => f.replace(/\\/g, '/'))
  const has = (path) => files.includes(path)
  ok(has('/out/main/index.js') && has('/out/preload/index.js') && has('/out/renderer/index.html'), 'app code missing from app.asar')
  ok(!files.some((f) => f.endsWith('.map')), 'source maps were packaged')
  ok(!files.some((f) => f.startsWith('/out/bundled-packages')), 'build bookkeeping files were packaged')
  ok(!files.some((f) => /\/better-sqlite3\/(deps|src)\//.test(f)), 'SQLite C sources were packaged')
  const prebuilds = files.filter((f) => /\/better-sqlite3\/prebuilds\/[^/]+\.node$/.test(f)).map((f) => f.split('/').pop())
  ok(prebuilds.length === 1 && prebuilds[0] === `${platform}-${arch}.node`, `expected only ${platform}-${arch}.node, found: ${prebuilds.join(', ') || 'none'}`)
  const unpacked = join(resources, 'app.asar.unpacked')
  ok(existsSync(join(unpacked, 'node_modules', 'better-sqlite3', 'prebuilds', `${platform}-${arch}.node`)), 'native SQLite binary not unpacked')
  ok(existsSync(join(unpacked, 'node_modules', 'openpgp', 'dist', 'node', 'openpgp.min.cjs')), 'OpenPGP.js is not outside the archive (LGPL replaceability)')
  ok(!files.some((f) => /\/openpgp\/dist\/(lightweight|types)\//.test(f)), 'unused OpenPGP.js builds were packaged')

  // ── Licenses, notices, icon, update feed ──
  for (const name of ['LICENSE.txt', 'THIRD_PARTY_NOTICES.md', join('licenses', 'THIRD_PARTY_LICENSES.txt')]) {
    ok(existsSync(join(resources, name)), `${name} missing from resources`)
  }
  const licenses = existsSync(join(resources, 'licenses', 'THIRD_PARTY_LICENSES.txt')) ? readFileSync(join(resources, 'licenses', 'THIRD_PARTY_LICENSES.txt'), 'utf8') : ''
  for (const name of ['vue 3.', 'pinia ', 'better-sqlite3 ', 'openpgp ', 'electron-updater ']) ok(licenses.includes(name), `license text for ${name.trim()} missing`)
  if (platform === 'linux') ok(existsSync(join(resources, 'icon.png')), 'Linux window icon missing')
  const feed = existsSync(join(resources, 'app-update.yml')) ? readFileSync(join(resources, 'app-update.yml'), 'utf8').trim().replace(/\n/g, ', ') : 'none'

  const size = (path) => (statSync(path).size / 1048576).toFixed(1)
  console.log(`${executable}`)
  console.log(`  fuses: ${Object.keys(expected).length} checked; archive: ${files.length} entries, ${size(archive)} MB; native: ${prebuilds.join(', ')}; update feed: ${feed}`)
  if (problems.length > 0) {
    console.error(`Package check failed:\n  - ${problems.join('\n  - ')}`)
    process.exit(1)
  }
  console.log('Package OK')
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
