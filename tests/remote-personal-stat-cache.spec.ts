/**
 * `refreshRemotePersonal` polls the personal stores on every remote
 * operation; the readSnapshot stat-identity cache (dev+ino+size+mtimeMs on
 * the env file and its bindings sidecar) skips the read + parse while
 * nothing changed. A changed or missing file still reloads immediately.
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const readCount = vi.hoisted(() => ({ value: 0, paths: new Set<string>() }))
vi.mock('node:fs', async importOriginal => {
  const real = await importOriginal<typeof import('node:fs')>()
  return {
    ...real,
    readFileSync: (path: Parameters<typeof real.readFileSync>[0], options?: Parameters<typeof real.readFileSync>[1]) => {
      const name = String(path)
      if (readCount.paths.size === 0 || readCount.paths.has(name)) readCount.value += 1
      return real.readFileSync(path, options)
    },
  }
})

import { loadPersonalManifest, savePersonalConfig, type PersonalConfig, type PersonalEnvironment } from '../src/remote/personal/config.ts'

const dirs: string[] = []
const tmp = (): string => { const dir = mkdtempSync(join(tmpdir(), 'statcache-')); dirs.push(dir); return dir }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const MANAGED: PersonalEnvironment = {
  environmentId: 'dev-box', platform: 'linux',
  endpoint: { hostname: 'build.internal', port: 22, user: 'builder' },
  credential: { kind: 'managed', credentialId: 'aabbccddeeff' },
  hostKey: 'SHA256:' + 'A'.repeat(43),
  helper: null,
}
const CONFIG: PersonalConfig = { schemaVersion: 2, revision: 0, environments: [MANAGED], bindings: [] }

const watch = (personalPath: string): (() => number) => {
  readCount.paths.add(personalPath)
  readCount.paths.add(`${personalPath}.bindings.json`)
  const before = readCount.value
  return () => readCount.value - before
}

describe.skipIf(process.platform === 'win32')('personal store stat-identity cache', () => {
  it('an unchanged store is not re-read; a touched file reloads immediately', async () => {
    const dir = tmp()
    const personalPath = join(dir, 'remote-personal.json')
    await savePersonalConfig(personalPath, CONFIG, 0)
    const first = loadPersonalManifest(personalPath)

    const count = watch(personalPath)
    const again = loadPersonalManifest(personalPath, first)
    expect(again).toBe(first)
    expect(count()).toBe(0)

    // Rewrite the bindings sidecar: the stat identity changes and the next
    // load reads the files again.
    const { readFileSync } = await import('node:fs')
    const bindingsPath = `${personalPath}.bindings.json`
    writeFileSync(bindingsPath, `${readFileSync(bindingsPath, 'utf8')}\n`, { mode: 0o600 })
    const third = loadPersonalManifest(personalPath, first)
    expect(count()).toBeGreaterThan(0)
    expect(third.manifest.environments).toEqual(first.manifest.environments)
  })

  it('a missing store reloads instead of serving the cache', async () => {
    const dir = tmp()
    const personalPath = join(dir, 'remote-personal.json')
    await savePersonalConfig(personalPath, CONFIG, 0)
    const first = loadPersonalManifest(personalPath)
    const count = watch(personalPath)
    expect(loadPersonalManifest(personalPath, first)).toBe(first)
    expect(count()).toBe(0)

    rmSync(personalPath)
    const missing = loadPersonalManifest(personalPath, first)
    expect(missing).not.toBe(first)
    expect(missing.manifest.environments).toEqual([])
    expect(missing.revision).toBe(0)
  })
})

it('keys even an empty manifest by path and effective initiator', () => {
  const missing = join(tmp(), 'remote-personal.json')
  const posix = loadPersonalManifest(missing)
  expect(JSON.stringify(posix.manifest)).toBe('{"schemaVersion":1,"configVersion":"personal-0","environments":[],"bindings":[]}')
  expect(posix.digest).toBe(createHash('sha256').update('{"bindings":[],"configVersion":"personal-0","environments":[],"schemaVersion":1}').digest('hex'))
  const native = loadPersonalManifest(missing, posix, { kind: 'windows-openssh' })
  const ubuntu = loadPersonalManifest(missing, native, { kind: 'wsl', distribution: 'Ubuntu 24.04', user: 'ci' })
  const debian = loadPersonalManifest(missing, ubuntu, { kind: 'wsl', distribution: 'Debian', user: 'ci' })
  const other = loadPersonalManifest(missing, debian, { kind: 'wsl', distribution: 'Debian', user: 'other' })
  const projections = [posix, native, ubuntu, debian, other]
  // The protected store never changed (still absent): every distinct
  // effective initiator projects a distinct digest off identical bytes.
  expect(new Set(projections.map(row => row.digest)).size).toBe(projections.length)
  for (const row of projections) {
    expect(row.path).toBe(missing)
    expect(row.identity).toBe(posix.identity)
    expect(row.manifest.environments).toEqual([])
  }
  expect(posix.initiator).toBeUndefined()
  expect(native.initiator).toEqual({ kind: 'windows-openssh' })
  expect(ubuntu.initiator).toEqual({ kind: 'wsl', distribution: 'Ubuntu 24.04', user: 'ci' })
  // A semantically equal identity — a new object with reordered keys —
  // reuses the projection.
  expect(loadPersonalManifest(missing, other, { user: 'other', distribution: 'Debian', kind: 'wsl' })).toBe(other)
  // Reverting to the POSIX view recovers the exact legacy manifest and digest.
  const recovered = loadPersonalManifest(missing, other)
  expect(recovered).not.toBe(other)
  expect(recovered.manifest).toEqual(posix.manifest)
  expect(recovered.digest).toBe(posix.digest)
  // A different missing path can never return the previous projection.
  const elsewhere = join(tmp(), 'remote-personal.json')
  const moved = loadPersonalManifest(elsewhere, other)
  expect(moved).not.toBe(other)
  expect(moved.path).toBe(elsewhere)
})
