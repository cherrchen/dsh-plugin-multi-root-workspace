/**
 * pack:check — is the tarball `pnpm pack` produces actually installable?
 *
 * The release publishes exactly this archive, and every smoke asserts the
 * CHECKOUT works; a build that drops a shared chunk, a `cordis.patch.yml` row
 * whose module was never emitted, or an `exports` entry pointing at a missing
 * `types` file all ship broken while every test stays green. This check packs
 * the repository into a temporary directory, reads the tarball PORTABLY (a
 * gzip+tar reader in this file — no GNU `tar` dependency, so the same check
 * runs on Windows CI), and asserts:
 *
 * - the metadata and entry files the bundle contract names are present;
 * - every `default`/`types` file `package.json` `exports` advertises exists;
 * - every module a `cordis.patch.yml` row resolves inside THIS package exists;
 * - every relative `import`/`from` specifier in every packed `lib/*.js`
 *   resolves to a packed file (a missing shared chunk fails loudly);
 * - the complete member list is printed for the log.
 *
 * @module scripts/check-pack
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { parse } from 'yaml'

/** Repository root (this file lives in `scripts/`). */
const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const PACKAGE_NAME = '@dsh-electron/dsh-plugin-multi-root-workspace'

/** Members every bundle must ship — the contract a smoke asserts indirectly. */
const REQUIRED = [
  'package/package.json',
  'package/cordis.patch.yml',
  'package/README.md',
  'package/README.en.md',
  'package/CHANGELOG.md',
  'package/CHANGELOG.en.md',
  'package/LICENSE',
  'package/lib/index.js',
  'package/lib/client.js',
  'package/lib/windows-runner.js',
]

/**
 * Run `pnpm pack` into `dir` and return the generated tarball's path.
 * The tarball name comes from the directory listing, not stdout parsing.
 */
export function packTarball(dir = mkdtempSync(join(tmpdir(), 'dsh-pack-'))) {
  // Node refuses to spawn Windows `.cmd` shims without a shell, so prefer the
  // package manager entry pnpm itself exported to this script run.
  const execPath = process.env.npm_execpath ?? ''
  const args = ['pack', '--pack-destination', dir]
  const options = { cwd: REPO_ROOT, encoding: 'utf8' }
  const packed = /\.[cm]?js$/u.test(execPath) ? spawnSync(process.execPath, [execPath, ...args], options)
    : execPath !== '' ? spawnSync(execPath, args, options)
      : spawnSync('pnpm', args, { ...options, shell: process.platform === 'win32' })
  if (packed.status !== 0) {
    throw new Error(`pnpm pack failed (exit ${String(packed.status)}${packed.error ? `, ${packed.error.message}` : ''}):\n${packed.stdout ?? ''}${packed.stderr ?? ''}`)
  }
  const tarball = readdirSync(dir).find(name => name.endsWith('.tgz'))
  if (tarball === undefined) throw new Error(`pnpm pack produced no .tgz in ${dir}:\n${packed.stdout}${packed.stderr}`)
  return { dir, tarball: join(dir, tarball) }
}

/** Parse one pax extended-header body for its `path=` record. */
function paxPathOf(body) {
  const text = body.toString('utf8')
  let cursor = 0
  while (cursor < text.length) {
    const space = text.indexOf(' ', cursor)
    if (space < 0) break
    const length = Number.parseInt(text.slice(cursor, space), 10)
    if (!Number.isFinite(length) || length <= 0) break
    const record = text.slice(space + 1, cursor + length - 1)
    cursor += length
    if (record.startsWith('path=')) return record.slice(5)
  }
  return undefined
}

/**
 * A minimal gzip+tar reader covering ustar, GNU longnames and pax paths —
 * everything a `pnpm pack` archive can contain. Returns `Map<name, Buffer>`.
 */
export function readTarGz(file) {
  const data = gunzipSync(readFileSync(file))
  const entries = new Map()
  let offset = 0
  let pendingName
  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) break
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '')
    const size = Number.parseInt(header.subarray(124, 136).toString('utf8').replace(/\0.*$/s, '').trim() || '0', 8)
    const type = String.fromCharCode(header[156])
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/s, '')
    const body = data.subarray(offset + 512, offset + 512 + size)
    offset += 512 + Math.ceil(size / 512) * 512
    if (type === 'x') { pendingName = paxPathOf(body); continue }
    if (type === 'L') { pendingName = body.toString('utf8').replace(/\0.*$/s, ''); continue }
    const full = pendingName ?? (prefix === '' ? name : `${prefix}/${name}`)
    pendingName = undefined
    entries.set(full, body)
  }
  return entries
}

/** Every `default`/`types` target `exports` advertises, recursively. */
function exportTargets(exportsField) {
  const targets = []
  const walk = value => {
    if (typeof value === 'string') { targets.push(value); return }
    if (value !== null && typeof value === 'object') {
      for (const [key, nested] of Object.entries(value)) {
        if (key === 'default' || key === 'types' || typeof nested === 'object') walk(nested)
      }
    }
  }
  walk(exportsField)
  return targets
}

/**
 * Resolve a patch row's `name` to the file it loads inside THIS package —
 * the bare name reads `exports['.']`, a subpath reads `exports['./sub']`.
 * Other packages' rows are not this tarball's business.
 */
function moduleTarget(name, pkg) {
  if (name !== PACKAGE_NAME && !name.startsWith(`${PACKAGE_NAME}/`)) return undefined
  const subpath = name === PACKAGE_NAME ? '.' : `.${name.slice(PACKAGE_NAME.length)}`
  const entry = pkg.exports?.[subpath] ?? (subpath === '.' ? pkg.main : undefined)
  const file = typeof entry === 'string' ? entry : entry?.default
  return file === undefined ? undefined : `package/${file.replace(/^\.\//, '')}`
}

/** Every specifier a packed ESM file references. */
function importSpecifiers(source) {
  const found = []
  for (const match of source.matchAll(/(?:import|export)[^'"]*?\bfrom\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    const specifier = match[1] ?? match[2] ?? match[3]
    if (specifier !== undefined) found.push(specifier)
  }
  return found
}

/** `a.js`, `a.json`, or `a/index.js`-style resolution inside the member set. */
function resolveMember(from, specifier, members) {
  const base = posix.join(posix.dirname(from), specifier)
  for (const candidate of [base, `${base}.js`, `${base}.json`, `${base}/index.js`]) {
    if (members.has(candidate)) return candidate
  }
  return undefined
}

function main() {
  const failures = []
  const assert = (ok, message) => { if (!ok) failures.push(message) }

  const { dir, tarball } = packTarball()
  try {
    const members = readTarGz(tarball)
    const names = [...members.keys()].sort()
    console.log(`[pack:check] ${tarball}`)
    console.log(`[pack:check] ${names.length} members:`)
    for (const name of names) console.log(`  ${name}`)

    for (const required of REQUIRED) assert(members.has(required), `missing required member ${required}`)

    const manifestEntry = members.get('package/package.json')
    if (manifestEntry === undefined) {
      console.error('[pack:check] no package/package.json — cannot continue')
      process.exit(1)
    }
    const pkg = JSON.parse(manifestEntry.toString('utf8'))

    for (const target of exportTargets(pkg.exports)) {
      if (!target.startsWith('./')) continue
      assert(members.has(`package/${target.slice(2)}`), `exports target ${target} is not in the tarball`)
    }

    const patchEntry = members.get('package/cordis.patch.yml')
    if (patchEntry !== undefined) {
      const patch = parse(patchEntry.toString('utf8'))
      const rows = [...(patch.insert ?? []), ...(patch.append ?? []), ...(patch.prepend ?? [])]
      for (const row of rows) {
        if (typeof row?.name !== 'string') continue
        const target = moduleTarget(row.name, pkg)
        if (target === undefined) {
          if (row.name === PACKAGE_NAME || row.name.startsWith(`${PACKAGE_NAME}/`)) {
            failures.push(`cordis.patch.yml row ${row.id ?? row.name} names ${row.name}, which has no resolvable exports entry`)
          }
          continue
        }
        assert(members.has(target), `cordis.patch.yml row ${row.id ?? row.name} resolves to missing ${target}`)
      }
    }

    // Follow the import graph from EVERY packed lib/*.js entry: a chunk the
    // bundler emitted but `files` dropped must fail here, not at the user's
    // first `dsh plugin add`.
    const queue = names.filter(name => /^package\/lib\/[^/]+\.js$/.test(name))
    const visited = new Set()
    while (queue.length > 0) {
      const name = queue.pop()
      if (visited.has(name)) continue
      visited.add(name)
      for (const specifier of importSpecifiers(members.get(name).toString('utf8'))) {
        if (!specifier.startsWith('.')) continue
        const resolved = resolveMember(name, specifier, members)
        assert(resolved !== undefined, `${name} imports ${specifier}, which is not in the tarball`)
        if (resolved !== undefined && resolved.endsWith('.js') && !visited.has(resolved)) queue.push(resolved)
      }
    }

    // lib/windows-runner.js executes as a SEPARATE Node process: the host's
    // in-process plugin package resolution does not apply, so its whole static
    // module graph may import `node:` builtins only. It reaches the upstream
    // ACL package dynamically through `--upstream-runner`, never through a
    // static bare specifier (CI run 38131613042: ERR_MODULE_NOT_FOUND from the
    // installed tarball before main() could fail closed).
    {
      const runnerQueue = ['package/lib/windows-runner.js']
      const runnerVisited = new Set()
      while (runnerQueue.length > 0) {
        const name = runnerQueue.pop()
        if (runnerVisited.has(name) || !members.has(name)) continue
        runnerVisited.add(name)
        for (const specifier of importSpecifiers(members.get(name).toString('utf8'))) {
          if (specifier.startsWith('.')) {
            const resolved = resolveMember(name, specifier, members)
            assert(resolved !== undefined, `${name} imports ${specifier}, which is not in the tarball`)
            if (resolved !== undefined && resolved.endsWith('.js')) runnerQueue.push(resolved)
          } else {
            assert(specifier.startsWith('node:'), `${name} imports ${specifier}: the standalone Windows runner may import node builtins only`)
          }
        }
      }
    }

    if (failures.length > 0) {
      for (const failure of failures) console.error(`[pack:check] FAIL ${failure}`)
      console.error(`[pack:check] ${failures.length} missing member(s)`)
      process.exit(1)
    }
    console.log('[pack:check] the packed artifact is complete')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// `smoke:packed` imports packTarball; only check when invoked directly.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
