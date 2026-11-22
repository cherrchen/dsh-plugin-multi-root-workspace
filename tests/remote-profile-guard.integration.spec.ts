import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import Policy from '@deepseek-ai/dsh-sandbox-policy'
import Projections from '@deepseek-ai/dsh-session-projection'
import { installRemoteProfileGuard } from '../src/remote/profile-guard.ts'
import { mountRegistryStack, type RegistryStack } from './support/registry-stack.ts'
import { createFixtureWorkspace, type FixtureWorkspace } from './support/temp-workspace.ts'

let fixture: FixtureWorkspace
let stack: RegistryStack | undefined
let base: string

beforeEach(() => {
  fixture = createFixtureWorkspace('remote-profile-guard')
  base = mkdtempSync(join(tmpdir(), 'mrw-guard-'))
})
afterEach(async () => { await stack?.dispose(); stack = undefined; fixture.dispose(); rmSync(base, { recursive: true, force: true }) })

async function mount() {
  const spawned: unknown[] = []
  const world = await mountRegistryStack(join(base, 'store'), {}, {
    beforeGate: async ctx => {
      await ctx.plugin(Projections)
      await ctx.plugin(Sessions)
      await ctx.plugin(Policy, { mode: 'workspace-write', workspaceRoot: fixture.workspace })
    },
  })
  Object.assign(world.ctx.sandbox, { confine: async (argv: readonly string[]) => ({ argv, enforcement: 'full' }) })
  world.ctx.provide('subprocess', {
    spawn(spec: unknown) { spawned.push(spec); return { done: Promise.resolve({ exitCode: 0 }) } },
    async spawnTerminal(spec: unknown) { spawned.push(spec); return { done: Promise.resolve({ exitCode: 0 }) } },
  } as never)
  stack = world
  return { spawned }
}

describe('the profile guard over real sessions and policy', () => {
  it('denies a session whose persisted record resolves danger-full-access', async () => {
    await mount()
    installRemoteProfileGuard(stack!.ctx)
    const session = stack!.ctx.sessions.create(SessionId('restricted'), { meta: { cwd: fixture.workspace } })
    await expect(Promise.resolve(stack!.ctx.sandboxPolicy.resolve({ session }) as { mode: string })).resolves.toMatchObject({ mode: 'workspace-write' })
    session.append('sandbox/mode', { mode: 'danger-full-access' })
    expect(() => stack!.ctx.sandboxPolicy.resolve({ session })).toThrowError(/remote-profile-full-access/)
  })

  it('rejects the main one-shot escalation at a real ctx.inject-activated approval', async () => {
    const { spawned } = await mount()
    installRemoteProfileGuard(stack!.ctx)
    const requests: string[] = []
    stack!.ctx.provide('approval', {
      request(input: { reason?: string }) { requests.push(input.reason ?? ''); return Promise.resolve('allowed-once') },
    } as never)
    await new Promise<void>(resolve => { setTimeout(resolve, 20) })
    const approval = stack!.ctx.get('approval') as { request(input: { reason?: string }): Promise<string> }
    await expect(approval.request({ reason: 'escalate sandbox to danger-full-access: needed' })).resolves.toBe('rejected')
    expect(requests).toHaveLength(0)
    await expect(approval.request({ reason: 'open a file' })).resolves.toBe('allowed-once')
    expect(spawned).toHaveLength(0)
  })

  it('keeps raw native process calls at zero and restores descriptors on unload', async () => {
    const { spawned } = await mount()
    const restore = installRemoteProfileGuard(stack!.ctx)
    expect(() => stack!.ctx.subprocess.spawn({ argv: ['/bin/sh'] })).toThrowError(/remote-profile-unconfined-spawn/)
    const session = stack!.ctx.sessions.create(SessionId('again'), { meta: { cwd: fixture.workspace } })
    session.append('sandbox/mode', { mode: 'danger-full-access' })
    expect(() => stack!.ctx.sandboxPolicy.resolve({ session })).toThrowError(/remote-profile-full-access/)
    expect(spawned).toHaveLength(0)
    restore()
    await expect(Promise.resolve(stack!.ctx.sandboxPolicy.resolve({ session }) as { mode: string }))
      .resolves.toMatchObject({ mode: 'danger-full-access' })
    stack!.ctx.subprocess.spawn({ argv: ['/bin/sh'] })
    expect(spawned).toHaveLength(1)
  })
})
