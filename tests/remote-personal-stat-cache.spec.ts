/**
 * `refreshRemotePersonal` polls the personal stores on every remote
 * operation; the readSnapshot stat-identity cache (dev+ino+size+mtimeMs on
 * the env file and its bindings sidecar) skips the read + parse while
 * nothing changed. A changed or missing file still reloads immediately.
 */
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
