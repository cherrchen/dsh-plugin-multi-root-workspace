/**
 * `sshBindingSave` idempotent re-save regression: a create-shaped draft (no
 * `rootId`) for an environment+path that is already bound edits the existing
 * binding — the same rootId is kept, no second binding is allocated, and an
 * unchanged re-save stays a no-op (the revision does not move).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { handlePersonalEndpoint } from '../src/remote/personal-endpoints.ts'
import type { SshStateView } from '../src/remote/personal-contract.ts'
import { loadPersonalConfig, savePersonalConfig, type PersonalConfig, type PersonalEnvironment } from '../src/remote/personal/config.ts'
import type { MultiRootRegistry } from '../src/registry.ts'
import type { Context } from '@deepseek-ai/cordis'

const dirs: string[] = []
const tmp = (): string => { const dir = mkdtempSync(join(tmpdir(), 'r4b-')); dirs.push(dir); return dir }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const MANAGED: PersonalEnvironment = {
  environmentId: 'dev-box', platform: 'linux',
  endpoint: { hostname: 'build.internal', port: 22, user: 'builder' },
  credential: { kind: 'managed', credentialId: 'aabbccddeeff' },
  hostKey: 'SHA256:' + 'A'.repeat(43),
  helper: { nodePath: '/usr/bin/node', helperPath: '/h/lib/helper.js', sha256: 'a'.repeat(64), protocol: 3 },
}
const CONFIG: PersonalConfig = { schemaVersion: 2, revision: 0, environments: [MANAGED], bindings: [] }

const world = () => {
  const dir = tmp()
  const personalPath = join(dir, 'remote-personal.json')
  const credentialRoot = join(dir, 'cred')
  const registry = {
    remoteEnabled: true,
    remoteMode: 'personal',
    remotePersonalPath: personalPath,
    remoteCredentialRoot: credentialRoot,
    refreshRemotePersonal: async () => {},
  } as unknown as MultiRootRegistry
  return { registry, personalPath }
}

describe.skipIf(process.platform === 'win32')('sshBindingSave twice without a rootId edits the same binding', () => {
  it('an unchanged re-save keeps the rootId, one binding, and the revision', async () => {
    const { registry, personalPath } = world()
    await savePersonalConfig(personalPath, CONFIG, 0)
    const call = async (revision: number, actions: readonly ('read' | 'write' | 'exec')[] = ['read']) =>
      await handlePersonalEndpoint(undefined as never as Context, registry, '/w', {
        endpoint: 'sshBindingSave', sessionId: 's', revision,
        binding: { environmentId: 'dev-box', path: '/srv/app', actions: [...actions] },
      }) as SshStateView

    const first = await call(0)
    expect(first.bindings).toMatchObject([{ environmentId: 'dev-box', rootId: 'app', path: '/srv/app' }])

    // The wizard's Back→Next draft has no rootId: it now edits the binding
    // that already covers this environment+path. Identical content stays a
    // no-op — the revision does not move and exactly one binding remains.
    const second = await call(1)
    expect(second.bindings).toHaveLength(1)
    expect(second.bindings).toMatchObject([{ environmentId: 'dev-box', rootId: 'app', path: '/srv/app' }])
    expect(loadPersonalConfig(personalPath).bindings).toHaveLength(1)
    expect(loadPersonalConfig(personalPath).revision).toBe(1)
  })

  it('a changed re-save updates the same binding in place', async () => {
    const { registry, personalPath } = world()
    await savePersonalConfig(personalPath, CONFIG, 0)
    const call = async (revision: number, actions: readonly ('read' | 'write' | 'exec')[]) =>
      await handlePersonalEndpoint(undefined as never as Context, registry, '/w', {
        endpoint: 'sshBindingSave', sessionId: 's', revision,
        binding: { environmentId: 'dev-box', path: '/srv/app', actions: [...actions] },
      }) as SshStateView

    await call(0, ['read'])
    const second = await call(1, ['read', 'write'])
    expect(second.bindings).toHaveLength(1)
    expect(second.bindings).toMatchObject([{ environmentId: 'dev-box', rootId: 'app', path: '/srv/app', actions: ['read', 'write'] }])
  })
})
