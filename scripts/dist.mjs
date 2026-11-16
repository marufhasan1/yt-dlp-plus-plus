// Runs electron-builder with electron-builder.yml, adding the application update
// feed (GitHub Releases) when the repository is known:
//
//   MEDIAFLOW_GITHUB_OWNER=<owner> MEDIAFLOW_GITHUB_REPO=<repo> npm run dist
//
// electron-builder then writes app-update.yml into the package, which
// electron-updater reads at runtime. Without these variables the build has no
// update feed, and the Software Updates page says so instead of checking.
// Builds are never published from here (`--publish never` unless overridden).
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const cli = join(dirname(require.resolve('electron-builder/package.json')), 'cli.js')

const owner = process.env.MEDIAFLOW_GITHUB_OWNER ?? ''
const repo = process.env.MEDIAFLOW_GITHUB_REPO ?? ''
const args = process.argv.slice(2)

if (owner || repo) {
  // GitHub's own rules for user/organisation and repository names.
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner) || !/^[A-Za-z0-9._-]{1,100}$/.test(repo)) {
    console.error('MEDIAFLOW_GITHUB_OWNER / MEDIAFLOW_GITHUB_REPO are not valid GitHub names.')
    process.exit(1)
  }
  args.push('-c.publish.provider=github', `-c.publish.owner=${owner}`, `-c.publish.repo=${repo}`, '-c.publish.releaseType=release')
  process.stdout.write(`Update feed: https://github.com/${owner}/${repo}/releases\n`)
} else {
  console.warn('No update feed configured (MEDIAFLOW_GITHUB_OWNER / MEDIAFLOW_GITHUB_REPO not set): this build cannot update itself.')
}
if (!args.some((arg) => arg === '--publish' || arg.startsWith('--publish=') || arg === '-p')) args.push('--publish', 'never')

// Full license texts of everything that ships (and a check that THIRD_PARTY_NOTICES.md is current).
const licenses = spawnSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'licenses.mjs')], { stdio: 'inherit', shell: false })
if (licenses.status !== 0) process.exit(licenses.status ?? 1)

const result = spawnSync(process.execPath, [cli, ...args], { stdio: 'inherit', shell: false })
process.exit(result.status ?? 1)
