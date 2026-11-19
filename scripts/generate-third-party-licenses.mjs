#!/usr/bin/env node
/**
 * Generate `THIRD_PARTY_LICENSE` from the packages this tarball actually ships.
 *
 * Three inputs decide the inventory, so the file cannot drift from the build:
 *
 * - `package.json` `dependencies` — runtime packages installed with the plugin;
 * - the built `lib/*.js.map` sources (and `// node_modules/...` comments as a
 *   fallback) — third-party code inlined into a shipped artifact, including
 *   packages that are only devDependencies at the repository level;
 * - `scripts/third-party-sources.json` — upstream code kept as a source-level
 *   fork or port, which no module path can reveal.
 *
 * `peerDependencies` are deliberately absent: the DSH host installs them and
 * the package does not redistribute their code.
 *
 * Usage:
 *   node scripts/generate-third-party-licenses.mjs            print to stdout
 *   node scripts/generate-third-party-licenses.mjs --write    update the file
 *   node scripts/generate-third-party-licenses.mjs --check    fail when stale
 *
 * `--check` needs a completed `pnpm build`; CI runs it after the build step.
 *
 * @module scripts/generate-third-party-licenses
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUTPUT = join(REPO_ROOT, 'THIRD_PARTY_LICENSE')
const MANIFEST = join(REPO_ROOT, 'scripts', 'third-party-sources.json')
const LIB = join(REPO_ROOT, 'lib')
const PACKAGE_NAME = '@dsh-electron/dsh-plugin-multi-root-workspace'

/** Read and parse a JSON file. */
function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/** Normalize a license body so the generated file is byte-stable. */
function normalizeText(text) {
  return text.replaceAll('\r\n', '\n').replaceAll('\r', '\n').trimEnd() + '\n'
}

/** Normalize a repository field into one URL, or return the homepage. */
function repositoryOf(manifest) {
  const repository = manifest.repository
  const raw = typeof repository === 'string'
    ? repository
    : typeof repository?.url === 'string' ? repository.url : manifest.homepage
  if (typeof raw !== 'string' || raw === '') return undefined
  let url = raw
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/^git@github\.com:/, 'https://github.com/')
    .replace(/^github:/, 'https://github.com/')
    .replace(/\.git$/, '')
  if (!/^[a-z][a-z0-9+.-]*:/i.test(url) && /^[\w.-]+\/[\w.-]+$/.test(url)) {
    url = `https://github.com/${url}`
  }
  return url
}

/** Read the SPDX license expression from a package manifest. */
function licenseOf(manifest) {
  const license = manifest.license
  if (typeof license === 'string' && license !== '') return license
  if (typeof license?.type === 'string' && license.type !== '') return license.type
  throw new Error(`missing license field for ${manifest.name ?? '(unknown package)'}`)
}

/**
 * Locate the license file beside a package manifest.
 * @param packageDirectory - the package root.
 * @returns the license text.
 */
function licenseTextOf(packageDirectory) {
  const candidates = readdirSync(packageDirectory)
    .filter((name) => /^(?:licen[cs]e|copying|notice)(?:\..*)?$/i.test(name))
    .sort((left, right) => {
      const rank = (name) => name.toLowerCase() === 'license' ? 0 : 1
      return rank(left) - rank(right) || (left < right ? -1 : left > right ? 1 : 0)
    })
  const file = candidates[0]
  if (file === undefined) throw new Error(`no license file in ${packageDirectory}`)
  return normalizeText(readFileSync(join(packageDirectory, file), 'utf8'))
}

/**
 * Split a module path at its LAST `node_modules/` segment.
 *
 * The last segment is what matters: a pnpm store path contains the store's
 * `node_modules` first and the package's own `node_modules` last, and a nested
 * dependency resolves under the package's copy.
 * @param modulePath - an absolute or repository-relative module path.
 * @param base - directory the relative path resolves against.
 * @returns the package name and root directory, or `undefined`.
 */
function packageFromModulePath(modulePath, base) {
  const normalized = modulePath.replaceAll('\\', '/')
  const marker = '/node_modules/'
  const markerIndex = normalized.lastIndexOf(marker)
  if (markerIndex < 0) return undefined
  const tail = normalized.slice(markerIndex + marker.length)
  const segments = tail.split('/')
  const firstName = segments[0]
  if (firstName === undefined || firstName === '') return undefined
  const name = firstName.startsWith('@') ? `${firstName}/${segments[1] ?? ''}` : firstName
  if (name.endsWith('/')) return undefined
  return { name, directory: resolve(base, normalized.slice(0, markerIndex + marker.length) + name) }
}

/**
 * Collect packages whose code appears in a shipped `lib/` artifact.
 * @returns a map keyed by `name@version`.
 */
function bundledPackages() {
  const packages = new Map()
  const maps = existsSync(LIB)
    ? readdirSync(LIB).filter((name) => name.endsWith('.js.map')).sort()
    : []
  if (maps.length === 0) {
    const artifacts = existsSync(LIB)
      ? readdirSync(LIB).filter((name) => name.endsWith('.js')).sort()
      : []
    for (const artifact of artifacts) {
      const source = readFileSync(join(LIB, artifact), 'utf8')
      for (const match of source.matchAll(/\/\/\s*((?:\.\.\/)?node_modules\/[^\s]+)/g)) {
        const found = packageFromModulePath(resolve(REPO_ROOT, match[1]), REPO_ROOT)
        if (found !== undefined) addPackage(packages, found.directory, artifact)
      }
    }
    if (packages.size === 0) {
      throw new Error('no bundled third-party modules found; run `pnpm build` before generating the license inventory')
    }
    return packages
  }
  for (const mapName of maps) {
    const mapPath = join(LIB, mapName)
    const artifact = mapName.slice(0, -'.map'.length)
    const map = readJson(mapPath)
    const sources = Array.isArray(map.sources) ? map.sources : []
    for (const source of sources) {
      if (typeof source !== 'string' || !source.includes('node_modules/')) continue
      const found = packageFromModulePath(source, LIB)
      if (found === undefined) continue
      addPackage(packages, found.directory, artifact)
    }
  }
  if (packages.size === 0) {
    throw new Error('no bundled third-party modules found; run `pnpm build` before generating the license inventory')
  }
  return packages
}

/**
 * Record one package under `name@version`, merging its artifact list.
 * @param packages - the accumulating map.
 * @param directory - the package root.
 * @param artifact - the shipped artifact that contains the code.
 * @returns the recorded or merged entry.
 */
function addPackage(packages, directory, artifact) {
  const manifest = readJson(join(directory, 'package.json'))
  const name = manifest.name
  const version = manifest.version
  if (typeof name !== 'string' || typeof version !== 'string') {
    throw new Error(`invalid package manifest: ${join(directory, 'package.json')}`)
  }
  const key = `${name}@${version}`
  const entry = packages.get(key) ?? {
    name,
    version,
    directory,
    manifest,
    artifacts: new Set(),
    declared: false,
  }
  if (artifact !== undefined) entry.artifacts.add(artifact)
  packages.set(key, entry)
  return entry
}

/** Collect the declared runtime dependencies, bundled or not. */
function declaredPackages(packages) {
  const manifest = readJson(join(REPO_ROOT, 'package.json'))
  for (const name of Object.keys(manifest.dependencies ?? {}).sort()) {
    const entry = addPackage(packages, join(REPO_ROOT, 'node_modules', name), undefined)
    entry.declared = true
  }
}

/** Collect the source-level forks declared by `scripts/third-party-sources.json`. */
function vendoredPackages() {
  const manifest = readJson(MANIFEST)
  if (!Array.isArray(manifest.vendored)) throw new Error('scripts/third-party-sources.json has no vendored array')
  return manifest.vendored.map((entry) => {
    for (const field of ['name', 'repository', 'license', 'licenseFile', 'releases']) {
      if (typeof entry[field] !== 'string' || entry[field] === '') {
        throw new Error(`vendored entry is missing ${field}`)
      }
    }
    for (const field of ['paths', 'provenance']) {
      if (!Array.isArray(entry[field]) || entry[field].length === 0) {
        throw new Error(`vendored entry is missing ${field}`)
      }
    }
    if (entry.packages !== undefined && !Array.isArray(entry.packages)) {
      throw new Error('vendored entry has a non-array packages field')
    }
    const licensePath = join(REPO_ROOT, entry.licenseFile)
    if (!existsSync(licensePath)) throw new Error(`vendored license file is missing: ${entry.licenseFile}`)
    return { ...entry, licenseText: normalizeText(readFileSync(licensePath, 'utf8')) }
  })
}

/** Format one redistributed package section. */
function renderPackage(entry) {
  const distribution = []
  if (entry.artifacts.size > 0) {
    distribution.push(`bundled in ${[...entry.artifacts].sort().map((name) => `\`lib/${name}\``).join(', ')}`)
  }
  if (entry.declared) distribution.push('declared in `dependencies`')
  return [
    `### ${entry.name} ${entry.version}`,
    '',
    `- License: ${licenseOf(entry.manifest)}`,
    `- Source: ${repositoryOf(entry.manifest) ?? 'not declared'}`,
    `- Distribution: ${distribution.join('; ')}`,
    '',
    '```text',
    licenseTextOf(entry.directory).trimEnd(),
    '```',
    '',
  ].join('\n')
}

/** Format one source-level fork section. */
function renderVendored(entry) {
  return [
    `### ${entry.name} (source-level fork or port)`,
    '',
    `- License: ${entry.license}`,
    `- Source: ${entry.repository}`,
    ...(Array.isArray(entry.packages) && entry.packages.length > 0
      ? [`- Upstream packages: ${entry.packages.map((name) => `\`${name}\``).join(', ')}`]
      : []),
    `- Based on: ${entry.releases}`,
    `- Paths: ${entry.paths.map((path) => `\`${path}\``).join(', ')}`,
    `- Provenance: ${entry.provenance.map((path) => `\`${path}\``).join(', ')}`,
    '',
    '```text',
    entry.licenseText.trimEnd(),
    '```',
    '',
  ].join('\n')
}

/** Build the complete generated file. */
function generate() {
  const packages = new Map()
  declaredPackages(packages)
  for (const [key, entry] of bundledPackages()) {
    const existing = packages.get(key)
    if (existing === undefined) packages.set(key, entry)
    else for (const artifact of entry.artifacts) existing.artifacts.add(artifact)
  }
  const sorted = [...packages.values()].sort((left, right) => {
    const leftKey = `${left.name}@${left.version}`
    const rightKey = `${right.name}@${right.version}`
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
  })
  const vendored = vendoredPackages()
  return [
    '# Third-Party Licenses',
    '',
    '<!-- Generated by scripts/generate-third-party-licenses.mjs. Do not edit by hand. -->',
    '',
    `\`${PACKAGE_NAME}\` is licensed under MIT; see \`LICENSE\`. This file lists third-party software redistributed with the published package. It is generated from \`package.json\`, the built \`lib/\` source maps, and \`scripts/third-party-sources.json\`.`,
    '',
    'Regenerate with:',
    '',
    '```sh',
    'pnpm build',
    'pnpm licenses:update',
    '```',
    '',
    '## Redistributed dependencies and bundled code',
    '',
    ...sorted.map(renderPackage),
    '## Source-level forks and ports',
    '',
    ...vendored.map(renderVendored),
    '## Host-provided components',
    '',
    'The package declares `@deepseek-ai/*` and `koffi` as peer dependencies. The DSH host installs them; they are not redistributed in this package and remain under their own licenses.',
    '',
  ].join('\n')
}

const argument = process.argv[2]
const generated = generate()

if (argument === '--write') {
  writeFileSync(OUTPUT, generated)
  console.log(`[licenses] wrote ${OUTPUT}`)
} else if (argument === '--check') {
  if (!existsSync(OUTPUT)) {
    console.error('[licenses] THIRD_PARTY_LICENSE is missing; run `pnpm build && pnpm licenses:update`')
    process.exitCode = 1
  } else if (readFileSync(OUTPUT, 'utf8') !== generated) {
    console.error('[licenses] THIRD_PARTY_LICENSE is stale; run `pnpm build && pnpm licenses:update`')
    process.exitCode = 1
  } else {
    console.log('[licenses] THIRD_PARTY_LICENSE is current')
  }
} else if (argument === '--help' || argument === '-h') {
  console.log('Usage: node scripts/generate-third-party-licenses.mjs [--write|--check]')
} else if (argument !== undefined) {
  console.error(`[licenses] unknown argument: ${argument}`)
  process.exitCode = 1
} else {
  process.stdout.write(generated)
}
