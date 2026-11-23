/** SSH manager shutdown: ordered, independent, idempotent, close-aware. */
import { EventEmitter } from 'node:events'
import type { Context } from '@deepseek-ai/cordis'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SshEnvironmentManager } from '../src/remote/ssh-environment.ts'
import type { DeploymentManifest } from '../src/remote/manifest.ts'

const probe = vi.hoisted(() => ({
  events: [] as string[],
  ready: undefined as Promise<void> | undefined,
  failTeardown: false,
  failMount: undefined as string | undefined,
}))

vi.mock('@deepseek-ai/dsh-session-projection', () => ({
  default: (ctx: Context) => { ctx.effect(() => () => { probe.events.push('projections') }) },
}))
vi.mock('@deepseek-ai/dsh-sandbox-policy', () => ({
  SandboxPolicyService: (ctx: Context) => { ctx.effect(() => () => { probe.events.push('policy') }) },
}))

vi.mock('../src/compat/ssh-packages.ts', async () => {
  const { Service } = await import('@deepseek-ai/cordis')
  class SshConnection extends Service {
    readonly ready: Promise<Record<string, unknown>>
    constructor(ctx: Context, config: Record<string, unknown>) {
      super(ctx, 'ssh')
      this.ready = (probe.ready ?? Promise.resolve()).then(() => ({
        platform: 'linux', workspace: config.workspace, executable: '/usr/bin/node', protocol: 3,
      }))
      ctx.effect(() => () => { probe.events.push('ssh') })
    }
    assertOpen(): void {}
    connectStream(): Promise<EventEmitter> { return Promise.resolve(new EventEmitter()) }
    override async dispose(): Promise<void> {
      if (probe.failTeardown) throw new Error('ssh teardown failed')
    }
  }
  const named = (name: string) => (ctx: Context) => {
    ctx.effect(() => () => { probe.events.push(name) })
    if (probe.failMount === name) throw new Error(`${name} mount failed`)
  }
  return {
    loadHostSshPackages: async () => ({
      '@deepseek-ai/dsh-ssh': { SshConnection },
      '@deepseek-ai/dsh-fs-ssh': { SshFileSystem: named('fs') },
      '@deepseek-ai/dsh-subprocess-ssh': { SshSubprocessRuntime: named('subprocess') },
      '@deepseek-ai/dsh-sandbox-ssh': { SshSandboxProvider: named('sandbox') },
    }),
  }
})

const SSH_G = [
  'user dshbuild', 'hostname 203.0.113.95', 'userknownhostsfile /home/t/.dsh-ssh-test/known_hosts',
  'stricthostkeychecking yes', 'forwardagent no', 'batchmode yes',
].join('\n')
const KEY_LINE = '203.0.113.95 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestFakeKeyDataForUnitTestOnly123456'
const FP = 'SHA256:ZVJcb8gU2m2/IDlL0Zq4y2dzsJxbaMKHqm12KbIQ8D0'
const environment = {
  environmentId: 'vps-app', platform: 'linux', account: 'dshbuild', hostKey: FP,
  namespace: 'ns', transport: 'helper' as const, helper: { sha256: 'a'.repeat(64), protocol: 3 },
  connection: {
    host: 'dsh-vps-build', nodePath: '/opt/node-v24/bin/node',
    helperPath: '/opt/dsh-helper/node_modules/@deepseek-ai/dsh-ssh/lib/helper.js', workspace: '/srv/dsh/work/app',
  },
  credentialIsolation: 'unattested' as const,
}
const manifest: DeploymentManifest = { schemaVersion: 1, configVersion: 'c', environments: [environment] as never, bindings: [] }
const exec = async (file: string, args: readonly string[]) => {
  if (file === 'ssh' && args[0] === '-G') return { stdout: SSH_G, stderr: '' }
  if (file === 'ssh-keygen' && args[0] === '-F') return { stdout: `${KEY_LINE}\n`, stderr: '' }
  if (file === 'ssh-keygen' && args[0] === '-lf') return { stdout: `256 ${FP} comment (ED25519)\n`, stderr: '' }
  return { stdout: '', stderr: '' }
}
const warnings: string[] = []
const logger = { debug: () => {}, warn: (message: string) => { warnings.push(message) } }
const eligible = { status: 'eligible' as const, release: '0.2.2-rc.5' }

beforeEach(() => {
  probe.events = []
  probe.ready = undefined
  probe.failTeardown = false
  probe.failMount = undefined
  warnings.length = 0
})

function manager(): SshEnvironmentManager {
  return new SshEnvironmentManager({
    manifest, logger, gate: eligible, allowUnattestedForTesting: true, exec, readFile: () => KEY_LINE,
  })
}

describe('SSH environment manager shutdown', () => {
  it('disposes fibers in reverse mount order and shares one concurrent disposal', async () => {
    const instance = manager()
    await instance.open('vps-app')
    const first = instance.disposeAll()
    const second = instance.disposeAll()
    expect(second).toBe(first)
    await first
    expect(probe.events).toEqual(['sandbox', 'subprocess', 'fs', 'ssh', 'policy', 'projections'])
    // Repeated close is a no-op.
    await instance.disposeAll()
    expect(probe.events).toEqual(['sandbox', 'subprocess', 'fs', 'ssh', 'policy', 'projections'])
  })

  it('records one fiber failure and keeps cleaning the remaining fibers', async () => {
    const instance = manager()
    const order: string[] = []
    const internal = instance as unknown as {
      disposeFibers(environmentId: string, fibers: readonly { dispose(): Promise<void> }[]): Promise<void>
    }
    await internal.disposeFibers('vps-app', [
      { dispose: async () => { order.push('first') } },
      { dispose: async () => { throw new Error('broken fiber') } },
      { dispose: async () => { order.push('last') } },
    ])
    expect(order).toEqual(['last', 'first'])
    expect(warnings.some(message => message.includes('environment vps-app teardown failed: broken fiber'))).toBe(true)
  })

  it('disposes the fibers mounted before a partial initialization fails', async () => {
    const instance = manager()
    probe.failMount = 'sandbox'
    await expect(instance.open('vps-app')).rejects.toThrow('sandbox mount failed')
    expect(probe.events).toContain('sandbox')
    await instance.disposeAll()
  })

  it('rejects new work after close starts', async () => {
    const instance = manager()
    await instance.disposeAll()
    await expect(instance.open('vps-app')).rejects.toMatchObject({ code: 'remote-unavailable' })
    await expect(instance.openSftp('vps-app')).rejects.toMatchObject({ code: 'remote-unavailable' })
  })

  it('reclaims a connection that resolves after close started', async () => {
    const ready = Promise.withResolvers<void>()
    probe.ready = ready.promise
    const instance = manager()
    const opening = instance.open('vps-app')
    const disposal = instance.disposeAll()
    ready.resolve()
    await expect(opening).rejects.toMatchObject({ code: 'remote-unavailable' })
    await disposal
    expect(probe.events).toEqual(['sandbox', 'subprocess', 'fs', 'ssh', 'policy', 'projections'])
  })
})
