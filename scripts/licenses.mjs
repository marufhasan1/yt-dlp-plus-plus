// Third-party license compliance for packaged builds.
//
//   node scripts/licenses.mjs           writes resources/licenses/THIRD_PARTY_LICENSES.txt
//   node scripts/licenses.mjs --check   only verifies (CI)
//
// Covers every package that ships: the production dependency tree (installed into
// the app archive) and the packages bundled into the main/preload/renderer code
// (recorded by the build in out/bundled-packages.*.json — run `npm run build` first).
// Fails when a package is missing from THIRD_PARTY_NOTICES.md, listed there with a
// different version, has no license text, or uses a license that is not approved.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const checkOnly = process.argv.includes('--check')
const problems = []

/** Licenses that allow distribution in a closed or open binary alongside YT-DLP++ (MIT). */
const APPROVED = new Set(['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', '0BSD', 'Python-2.0', 'BlueOak-1.0.0', 'Unlicense', 'CC0-1.0'])
/** Weak copyleft, approved for specific packages that stay separate, replaceable modules (not bundled). */
const APPROVED_FOR = { 'LGPL-3.0-or-later': new Set(['openpgp']) }
/** Deprecated SPDX identifiers some packages still use. */
const SPDX_ALIASES = { 'LGPL-3.0+': 'LGPL-3.0-or-later', 'GPL-3.0+': 'GPL-3.0-or-later', 'Apache 2.0': 'Apache-2.0' }
/** Shipped although no build step reports them: generated or re-exported code. */
const ALWAYS_BUNDLED = ['vue', 'tailwindcss']

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/** Finds a package's directory as Node would from `fromDir`. */
function packageDir(name, fromDir) {
  try {
    return dirname(createRequire(join(fromDir, 'noop.js')).resolve(`${name}/package.json`))
  } catch {
    // Packages whose "exports" hide package.json: walk up node_modules folders.
    for (let dir = fromDir; ; dir = dirname(dir)) {
      const candidate = join(dir, 'node_modules', name)
      if (existsSync(join(candidate, 'package.json'))) return candidate
      if (dirname(dir) === dir) return null
    }
  }
}

const packages = new Map() // name@version → { name, version, dir, origin }

function addTree(name, fromDir, origin) {
  const dir = packageDir(name, fromDir)
  if (!dir) {
    problems.push(`${name}: not installed (run npm ci)`)
    return
  }
  const manifest = readJson(join(dir, 'package.json'))
  const key = `${manifest.name}@${manifest.version}`
  if (packages.has(key)) return
  packages.set(key, { name: manifest.name, version: manifest.version, dir, manifest, origin })
  for (const dependency of Object.keys(manifest.dependencies ?? {})) addTree(dependency, dir, origin)
  for (const dependency of Object.keys(manifest.optionalDependencies ?? {})) {
    if (packageDir(dependency, dir)) addTree(dependency, dir, origin)
  }
}

const app = readJson(join(root, 'package.json'))
for (const name of Object.keys(app.dependencies ?? {})) addTree(name, root, 'installed in the app archive')

const bundled = new Set(ALWAYS_BUNDLED)
let sawBuild = false
for (const target of ['main', 'preload', 'renderer']) {
  const path = join(root, 'out', `bundled-packages.${target}.json`)
  if (!existsSync(path)) continue
  sawBuild = true
  for (const name of readJson(path)) bundled.add(name)
}
if (!sawBuild) problems.push('out/bundled-packages.*.json not found: run `npm run build` first')
for (const name of bundled) {
  const dir = packageDir(name, root)
  if (!dir) {
    problems.push(`${name}: bundled but not installed`)
    continue
  }
  const manifest = readJson(join(dir, 'package.json'))
  const key = `${manifest.name}@${manifest.version}`
  if (!packages.has(key)) packages.set(key, { name: manifest.name, version: manifest.version, dir, manifest, origin: 'bundled into the application code' })
}

function spdx(manifest) {
  const value = typeof manifest.license === 'string' ? manifest.license : manifest.license?.type
  const expression = value ?? (Array.isArray(manifest.licenses) ? manifest.licenses.map((l) => l.type).join(' OR ') : null)
  return expression ? (SPDX_ALIASES[expression] ?? expression) : null
}

function approved(name, expression) {
  if (!expression) return false
  // "(MIT OR CC0-1.0)": any approved alternative is enough; "A AND B": all must be approved.
  const alternatives = expression.replace(/[()]/g, '').split(/\s+OR\s+/)
  return alternatives.some((alternative) =>
    alternative.split(/\s+AND\s+/).every((id) => APPROVED.has(id.trim()) || APPROVED_FOR[id.trim()]?.has(name))
  )
}

function licenseText(dir) {
  const file = readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.(md|txt|markdown))?$/i.test(f)) ?? readdirSync(dir).find((f) => /^licen[cs]e/i.test(f))
  return file ? readFileSync(join(dir, file), 'utf8').trim() : null
}

/**
 * A few packages publish no license file. For MIT, the terms are fixed, so the text
 * is reproduced with the copyright holder named in package.json, and marked as such.
 */
function reconstructedMit(manifest) {
  const author = typeof manifest.author === 'string' ? manifest.author : manifest.author?.name
  if (spdx(manifest) !== 'MIT' || !author) return null
  return [
    '(The package publishes no license file; this is the MIT License it declares in package.json,',
    ' with the author it names as the copyright holder.)',
    '',
    'MIT License',
    '',
    `Copyright (c) ${author.replace(/\s*<[^>]*>/, '')}`,
    '',
    'Permission is hereby granted, free of charge, to any person obtaining a copy of this software and',
    'associated documentation files (the "Software"), to deal in the Software without restriction, including',
    'without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell',
    'copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the',
    'following conditions:',
    '',
    'The above copyright notice and this permission notice shall be included in all copies or substantial',
    'portions of the Software.',
    '',
    'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT',
    'LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO',
    'EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER',
    'IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE',
    'USE OR OTHER DEALINGS IN THE SOFTWARE.'
  ].join('\n')
}

const notices = readFileSync(join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8')
const rows = notices.split(/\r?\n/).filter((line) => line.startsWith('|'))
const sorted = [...packages.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))

const sections = []
for (const pkg of sorted) {
  const expression = spdx(pkg.manifest)
  if (!approved(pkg.name, expression)) problems.push(`${pkg.name}@${pkg.version}: license "${expression ?? 'none'}" is not approved`)
  // The notices table names each package (backticked or plain) in the row that also gives its version.
  const row = rows.find((line) => new RegExp(`(^|[\\s(,\`|])${pkg.name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}([\\s),\`|]|$)`).test(line))
  if (!row) problems.push(`${pkg.name}: missing from THIRD_PARTY_NOTICES.md`)
  else if (!row.includes(`| ${pkg.version} |`)) problems.push(`${pkg.name}: THIRD_PARTY_NOTICES.md lists another version (installed ${pkg.version})`)
  const text = licenseText(pkg.dir) ?? reconstructedMit(pkg.manifest)
  if (!text) problems.push(`${pkg.name}@${pkg.version}: no license file in the package`)
  const repository = typeof pkg.manifest.repository === 'string' ? pkg.manifest.repository : pkg.manifest.repository?.url
  sections.push(
    [
      '='.repeat(78),
      `${pkg.name} ${pkg.version} — ${expression ?? 'unknown license'}`,
      `${pkg.origin}${repository ? `; ${repository.replace(/^git\+/, '')}` : ''}`,
      '='.repeat(78),
      '',
      text ?? '(no license text found)',
      ''
    ].join('\n')
  )
}

if (problems.length > 0) {
  console.error(`License check failed (${problems.length}):\n  - ${problems.join('\n  - ')}`)
  process.exit(1)
}

if (!checkOnly) {
  const own = readFileSync(join(root, 'LICENSE'), 'utf8').trim()
  const output = [
    `YT-DLP++ ${app.version} — third-party licenses`,
    '',
    'Full license texts of the software that ships with YT-DLP++, as installed in the',
    'application archive or bundled into its code. Electron and Chromium licenses are in',
    'LICENSE.electron.txt and LICENSES.chromium.html in the installation directory.',
    'Media engines (yt-dlp, FFmpeg, Deno) are not shipped; see THIRD_PARTY_NOTICES.md.',
    '',
    '='.repeat(78),
    `YT-DLP++ ${app.version} — ${app.license}`,
    '='.repeat(78),
    '',
    own,
    '',
    ...sections
  ].join('\n')
  mkdirSync(join(root, 'resources', 'licenses'), { recursive: true })
  writeFileSync(join(root, 'resources', 'licenses', 'THIRD_PARTY_LICENSES.txt'), output)
}
console.log(`Licenses OK: ${packages.size} packages (${[...packages.values()].filter((p) => p.origin.startsWith('bundled')).length} bundled)${checkOnly ? '' : ' → resources/licenses/THIRD_PARTY_LICENSES.txt'}`)
