/**
 * `remote_bash` re-checks the pinned remote root identity at exec time
 * (ADR-0030 §3): the grant's `verifiedTarget` `{kind:'object', value:dev:ino}`
 * recorded at registration must match the live read-only stat probe inside
 * `lazySshExecBackend.verifyCwd`. A directory recreated at the granted path —
 * same realpath, different dev:ino — withholds the command before confine and
 * before any spawn.
 */
import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import Policy from '@deepseek-ai/dsh-sandbox-policy'
import { lazySshExecBackend, type SshExecManager } from '../src/remote/ssh-exec-backend.ts'
import type { SshEnvironment } from '../src/remote/ssh-environment.ts'
import { runRemoteCommand } from '../src/remote/exec.ts'
import { mountRegistryStack, type RegistryStack } from './support/registry-stack.ts'
import { createFixtureWorkspace, type FixtureWorkspace } from './support/temp-workspace.ts'

let fixture: FixtureWorkspace
let stacks: RegistryStack[]
let seq = 0
beforeEach(() => { fixture = createFixtureWorkspace('exec-root-identity'); stacks = [] })
afterEach(async () => { for (const stack of stacks.reverse()) await stack.dispose(); fixture.dispose() })

const ENVIRONMENT = {
  environmentId: 'build-01', platform: 'linux', account: 'ci',
  hostKey: `SHA256:${'A'.repeat(43)}`, namespace: 'ns', transport: 'helper',
  helper: { sha256: 'a'.repeat(64), protocol: 3 },
  connection: { host: 'vps', nodePath: '/usr/bin/node', helperPath: '/h/helper.js', workspace: '/work/app' },
  exec: { shell: ['/bin/sh', '-c'], env: { PATH: '/bin' }, maxTimeoutMs: 60_000, stdoutLimit: 65_536, stderrLimit: 65_536, terminateGraceMs: 10 },
  credentialIsolation: 'unattested',
} as const
const REF = { environmentId: 'build-01', rootId: 'app' }

function manifestFile() {
  const path = join(fixture.base, 'deploy.json')
  writeFileSync(path, JSON.stringify({
    schemaVersion: 1, configVersion: 'cfg-1',
    environments: [ENVIRONMENT],
    bindings: [{ primary: fixture.workspace, environmentId: 'build-01', rootId: 'app', path: '/work/app', actions: ['read', 'write', 'exec'] }],
  }))
  chmodSync(path, 0o600)
  return path
}

async function mount(): Promise<RegistryStack> {
  const stack = await mountRegistryStack(join(fixture.base, 'store'), {
    remoteEnvironments: { enabled: true, manifestPath: manifestFile() },
  }, {
    allowUserOwnedRemoteManifestForTesting: true,
    beforeGate: async ctx => {
      await ctx.plugin(Projections)
      await ctx.plugin(Sessions)
      await ctx.plugin(Policy, { mode: 'workspace-write', workspaceRoot: fixture.workspace })
    },
  })
  stacks.push(stack)
  // The registration verifier pins the root's durable identity to dev:ino 1:100.
  stack.registry.setRemoteEndpointVerifier({
    verify: async () => ({ platform: 'linux' as const, target: { kind: 'object' as const, value: '1:100' } }),
  })
  await stack.registry.addRemote(fixture.workspace, REF)
  return stack
}

interface SpawnSpec { argv: string[]; cwd: string }

/** The fake helper environment + manager + cached backendFor, probing `dev:ino`. */
function harness(dev: string, ino: string) {
  const probes: SpawnSpec[] = []
  const commands: SpawnSpec[] = []
  let commandExit: PromiseWithResolvers<{ exitCode: number | null; signal: string | null }> | undefined
  const env = {
    generation: 'gen-1',
    hello: { executable: '/opt/node', platform: 'linux' },
    sandbox: {
      confine: async (argv: readonly string[]) => ({ argv: [...argv], enforcement: 'full' }),
    },
    subprocess: {
      spawn: (spec: SpawnSpec) => {
        if (spec.argv[1] === '-e') {
          probes.push(spec)
          const text = JSON.stringify({ real: spec.cwd, dev, ino, isDirectory: true })
          return {
            done: Promise.resolve({ exitCode: 0 }),
            collected: { stdout: { readFrom: () => ({ text }) } },
            terminate() {},
            waitForExit: async () => true,
          }
        }
        commands.push(spec)
        commandExit = Promise.withResolvers<{ exitCode: number | null; signal: string | null }>()
        const exit = commandExit
        return {
          done: exit.promise.then(result => ({ exitCode: result.exitCode ?? 0, signal: result.signal })),
          terminate() { exit.resolve({ exitCode: null, signal: 'SIGTERM' }) },
          waitForExit: async () => true,
          started: Promise.resolve(),
        }
      },
    },
  } as unknown as SshEnvironment
  const manager = {
    open: async () => env,
    openSftp: async () => { throw new Error('unused') },
    generationOf: () => 'gen-1',
    markStale: () => {},
  } as unknown as SshExecManager
  // Production caches one lazy backend per environment/workspace — admission
  // B's `backendFor` must return the same instance admission A opened.
  const backends = new Map<string, ReturnType<typeof lazySshExecBackend>>()
  const backendFor = (_id: string, workspace: string) => {
    let backend = backends.get(workspace)
    if (backend === undefined) {
      backend = lazySshExecBackend(ENVIRONMENT as never, manager, workspace)
      backends.set(workspace, backend)
    }
    return backend
  }
  return { probes, commands, finish: () => commandExit?.resolve({ exitCode: 0, signal: null }), backendFor }
}

describe.skipIf(process.platform === 'win32')('the pinned dev:ino is re-checked at exec time', () => {
  it('launches when the live probe still reports the registered identity', async () => {
    const stack = await mount()
    const grant = (await stack.registry.remoteList(fixture.workspace)).grants[0]!
    expect(grant.verifiedTarget).toEqual({ kind: 'object', value: '1:100' })

    const h = harness('1', '100')
    const session = stack.ctx.sessions.create(SessionId(`exec-${++seq}`), { meta: { cwd: fixture.workspace } })
    const pending = runRemoteCommand(stack.registry, h.backendFor, {
      session, environmentId: 'build-01', rootId: 'app', command: 'echo hi', timeoutMs: 5_000,
    } as never, 'remote_bash', new AbortController().signal)

    for (let i = 0; i < 400 && h.commands.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 5))
    h.finish()
    const result = await pending

    expect(result).toMatchObject({ status: 'scope-exited', scope: 'confirmed', exitCode: 0 })
    expect(h.probes.length).toBeGreaterThanOrEqual(1)
    expect(h.commands).toHaveLength(1)
    expect(h.commands[0]!.argv).toEqual(['/bin/sh', '-c', 'echo hi'])
    expect(h.commands[0]!.cwd).toBe('/work/app')
  })

  it('withholds when the live probe reports a different dev:ino — no spawn', async () => {
    const stack = await mount()
    const grant = (await stack.registry.remoteList(fixture.workspace)).grants[0]!
    expect(grant.verifiedTarget).toEqual({ kind: 'object', value: '1:100' })

    // The live probe reports the SAME realpath but a different dev:ino — the
    // directory was recreated at the granted path after registration.
    const h = harness('1', '999')
    const session = stack.ctx.sessions.create(SessionId(`exec-${++seq}`), { meta: { cwd: fixture.workspace } })
    const result = await runRemoteCommand(stack.registry, h.backendFor, {
      session, environmentId: 'build-01', rootId: 'app', command: 'echo hi', timeoutMs: 5_000,
    } as never, 'remote_bash', new AbortController().signal)

    expect(result).toMatchObject({ status: 'not-started', code: 'endpoint-redirected' })
    expect(h.probes.length).toBeGreaterThanOrEqual(1)
    expect(h.commands).toHaveLength(0)
    expect((await stack.registry.remoteList(fixture.workspace)).grants[0]?.state).toBe('withheld')
    await stack.registry.addRemote(fixture.workspace, { environmentId: 'build-01', rootId: 'app' })
    expect((await stack.registry.remoteList(fixture.workspace)).grants[0]?.state).toBe('registered')
  })
})
