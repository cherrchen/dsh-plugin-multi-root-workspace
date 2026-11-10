import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { installRemoteProfileGuard } from '../src/remote/profile-guard.ts'
import { hasConfinedProfile } from '../src/compat/process-profile.ts'

const BWRAP = '/usr/bin/bwrap'
const confineArgv = (argv: readonly string[]) => [BWRAP, '--ro-bind', '/', '/', '--', ...argv]

function stubCtx() {
  const calls: string[] = []
  const sessions = new Map<string, { sandbox?: string }>()
  const provided: Record<string, unknown> = {}
  const pending: Array<{ services: string[]; cb: (scoped: unknown) => void }> = []
  let confineImpl: (argv: readonly string[]) => Promise<{ argv: string[]; enforcement: 'full' | 'partial' }>
    = async argv => ({ argv: confineArgv(argv), enforcement: 'full' })

  const sandboxPolicy = {
    resolve(input: { session?: { sandbox?: string } }) {
      calls.push('resolve')
      return { mode: input.session?.sandbox ?? 'workspace-write', workspaceRoot: '/w' }
    },
  }
  const sandbox = {
    confine(argv: readonly string[]) { calls.push('confine'); return confineImpl(argv) },
  }
  const spawnCalls: { argv: readonly string[]; env?: object }[] = []
  const terminalCalls: { argv?: readonly string[]; env?: object }[] = []
  const subprocess = {
    spawn(spec: { argv: readonly string[]; env?: object }) {
      calls.push('spawn'); spawnCalls.push(spec); return { done: Promise.resolve({ exitCode: 0 }) }
    },
    async spawnTerminal(spec: { argv?: readonly string[]; env?: object }) {
      calls.push('spawnTerminal'); terminalCalls.push(spec); return { done: Promise.resolve({ exitCode: 0 }) }
    },
  }
  const scopedFor = (services: string[]) => ({
    approval: provided.approval,
    get: (name: string) => provided[name],
    effect: (fn: () => unknown) => { fn() },
    services,
  })
  const ctx = {
    get(name: string) { return provided[name] },
    inject(services: string[], cb: (scoped: unknown) => void) {
      if (services.every(name => provided[name] !== undefined)) cb(scopedFor(services))
      else pending.push({ services, cb })
      return { dispose: async () => { calls.push('inject-dispose') } }
    },
    sandboxPolicy, sandbox, subprocess,
  } as unknown as Context & { sandboxPolicy: typeof sandboxPolicy; sandbox: typeof sandbox; subprocess: typeof subprocess }

  const provide = (name: string, service: unknown) => {
    provided[name] = service
    for (const item of pending.splice(0)) {
      if (item.services.every(serviceName => provided[serviceName] !== undefined)) item.cb(scopedFor(item.services))
      else pending.push(item)
    }
  }
  const unprovide = (name: string) => { delete provided[name] }

  provide('sandboxPolicy', sandboxPolicy)
  provide('sandbox', sandbox)
  provide('subprocess', subprocess)
  provide('sessions', { get: (id: string) => sessions.get(id) })

  return {
    ctx, calls, sessions, spawnCalls, terminalCalls, provide, unprovide,
    confine(argv: readonly string[]) { return sandbox.confine(argv) as Promise<{ argv: string[]; enforcement: string }> },
    setConfine(impl: typeof confineImpl) { confineImpl = impl },
  }
}

afterEach(() => { vi.useRealTimers() })

describe('the remote profile guard', () => {
  it('refuses to install when a required seam is missing and rolls back partial setup', () => {
    const { ctx, unprovide } = stubCtx()
    unprovide('sandbox')
    expect(() => installRemoteProfileGuard(ctx)).toThrowError(/remote-profile-unavailable/)
    const { ctx: second, unprovide: unprovideSecond } = stubCtx()
    unprovideSecond('sessions')
    expect(() => installRemoteProfileGuard(second)).toThrowError(/remote-profile-unavailable/)
    const { ctx: third, unprovide: unprovideThird, provide: provideThird } = stubCtx()
    unprovideThird('subprocess')
    provideThird('subprocess', { spawn() { return {} } })
    expect(() => installRemoteProfileGuard(third)).toThrowError(/remote-profile-unavailable/)
  })

  it('denies every spawn that was not minted by confine, including LSP/job-like raw spawns', async () => {
    const { ctx, calls } = stubCtx()
    installRemoteProfileGuard(ctx)
    for (const argv of [['/bin/sh'], confineArgv(['x']), ['node', 'lsp.js'], ['worker', '--job'], [] as string[]]) {
      expect(() => ctx.subprocess.spawn({ argv })).toThrowError(/remote-profile-unconfined-spawn/)
    }
    expect(calls.filter(call => call === 'spawn')).toHaveLength(0)
  })

  it('mints a full confined argv once, then refuses the replay', async () => {
    const { ctx, confine, calls } = stubCtx()
    installRemoteProfileGuard(ctx)
    const confined = await confine(['run', 'cmd'])
    expect(hasConfinedProfile(confined.argv)).toBe(true)
    ctx.subprocess.spawn({ argv: confined.argv })
    expect(calls.filter(call => call === 'spawn')).toHaveLength(1)
    expect(() => ctx.subprocess.spawn({ argv: confined.argv })).toThrowError(/remote-profile-unconfined-spawn/)
  })

  it('refuses mutated argv, a syntax-forged profile, and partial confinement', async () => {
    const { ctx, confine, setConfine } = stubCtx()
    installRemoteProfileGuard(ctx)
    const confined = await confine(['run', 'cmd'])
    expect(() => ctx.subprocess.spawn({ argv: [...confined.argv, '--evil'] })).toThrowError(/remote-profile-unconfined-spawn/)
    expect(() => ctx.subprocess.spawn({ argv: ['--ro-bind', 'x'] })).toThrowError(/remote-profile-unconfined-spawn/)
    setConfine(async argv => ({ argv: confineArgv(argv), enforcement: 'partial' }))
    const partial = await confine(['run', 'other'])
    expect(partial.enforcement).toBe('partial')
    expect(() => ctx.subprocess.spawn({ argv: partial.argv })).toThrowError(/remote-profile-unconfined-spawn/)
  })

  it('lets identical concurrent mints each spawn once', async () => {
    const { ctx, confine, calls } = stubCtx()
    installRemoteProfileGuard(ctx)
    const one = await confine(['run', 'cmd'])
    const two = await confine(['run', 'cmd'])
    expect(one.argv).toEqual(two.argv)
    ctx.subprocess.spawn({ argv: one.argv })
    ctx.subprocess.spawn({ argv: two.argv })
    expect(calls.filter(call => call === 'spawn')).toHaveLength(2)
    expect(() => ctx.subprocess.spawn({ argv: one.argv })).toThrowError(/remote-profile-unconfined-spawn/)
  })

  it('fails closed past the 256-ticket ledger cap', async () => {
    const { ctx, confine } = stubCtx()
    installRemoteProfileGuard(ctx)
    for (let i = 0; i < 256; i++) await confine(['run', `cmd-${i}`])
    await expect(confine(['run', 'overflow'])).rejects.toThrowError(/remote-profile-ledger-full/)
  })

  it('expires tickets after thirty seconds of monotonic time', async () => {
    const { ctx, confine } = stubCtx()
    installRemoteProfileGuard(ctx)
    vi.useFakeTimers()
    try {
      const confined = await confine(['run', 'cmd'])
      vi.advanceTimersByTime(31_000)
      expect(() => ctx.subprocess.spawn({ argv: confined.argv })).toThrowError(/remote-profile-ticket-expired/)
    } finally { vi.useRealTimers() }
  })

  it('denies full-access resolutions, confine policies, and approval escalations', async () => {
    const { ctx, calls, provide } = stubCtx()
    const approval = { request(_input: { reason?: string }) { calls.push('approval'); return Promise.resolve('approved') } }
    provide('approval', approval)
    installRemoteProfileGuard(ctx)
    expect(() => ctx.sandboxPolicy.resolve({ session: { sandbox: 'danger-full-access' } })).toThrowError(/remote-profile-full-access/)
    expect(ctx.sandboxPolicy.resolve({ session: { sandbox: 'workspace-write' } })).toMatchObject({ mode: 'workspace-write' })
    expect(() => ctx.sandbox.confine(['x'], { mode: 'danger-full-access' })).toThrowError(/remote-profile-full-access/)
    expect(await approval.request({ reason: 'escalate sandbox to danger-full-access: pls' })).toBe('rejected')
    expect(calls.filter(call => call === 'approval')).toHaveLength(0)
    expect(await approval.request({ reason: 'rename a file' })).toBe('approved')
  })

  it('wraps an approval service that activates after the guard', async () => {
    const { ctx, calls, provide, unprovide } = stubCtx()
    unprovide('approval')
    installRemoteProfileGuard(ctx)
    const approval = { request(_input: { reason?: string }) { calls.push('approval'); return Promise.resolve('approved') } }
    provide('approval', approval)
    expect(await approval.request({ reason: 'escalate sandbox to danger-full-access: pls' })).toBe('rejected')
    expect(calls.filter(call => call === 'approval')).toHaveLength(0)
  })

  it('refuses loader-environment injection at the native spawn boundary', async () => {
    const { ctx, confine, calls } = stubCtx()
    installRemoteProfileGuard(ctx)
    const confined = await confine(['run', 'cmd'])
    for (const env of [{ LD_PRELOAD: '/x.so' }, { DYLD_INSERT_LIBRARIES: '/x.dylib' }, { NODE_OPTIONS: '--require x' }, { NODE_PATH: '/x' }]) {
      expect(() => ctx.subprocess.spawn({ argv: confined.argv, env })).toThrowError(/remote-profile-env-injection/)
    }
    await confine(['run', 'cmd'])
    for (const env of [{ LD_PRELOAD: '' }, { PATH: '/usr/bin' }]) {
      ctx.subprocess.spawn({ argv: confineArgv(['run', 'cmd']), env })
    }
    expect(calls.filter(call => call === 'spawn')).toHaveLength(2)
  })

  it('re-confines a marked Agent terminal, refuses bare/dangerous/foreign ones, and passes user terminals through', async () => {
    const { ctx, sessions, terminalCalls, calls } = stubCtx()
    installRemoteProfileGuard(ctx)
    sessions.set('sess-1', {})
    await ctx.subprocess.spawnTerminal({ argv: ['/bin/bash'], env: { DSH_PTY_SESSION_ID: 'pty-1', DSH_SESSION_ID: 'sess-1' } })
    const confined = terminalCalls[0]!.argv!
    expect(hasConfinedProfile(confined)).toBe(true)
    expect(confined[confined.length - 1]).toBe('/bin/bash')
    await expect(ctx.subprocess.spawnTerminal({ argv: ['/bin/bash'], env: { DSH_PTY_SESSION_ID: 'pty-2' } }))
      .rejects.toThrowError(/remote-profile-terminal-session/)
    await expect(ctx.subprocess.spawnTerminal({ argv: ['/bin/bash'], env: { DSH_PTY_SESSION_ID: 'pty-3', DSH_SESSION_ID: 'absent' } }))
      .rejects.toThrowError(/remote-profile-terminal-session/)
    await expect(ctx.subprocess.spawnTerminal({ argv: [], env: { DSH_PTY_SESSION_ID: 'pty-4', DSH_SESSION_ID: 'sess-1' } }))
      .rejects.toThrowError(/remote-profile-terminal-argv/)
    sessions.set('sess-root', { sandbox: 'danger-full-access' })
    await expect(ctx.subprocess.spawnTerminal({ argv: ['/bin/bash'], env: { DSH_PTY_SESSION_ID: 'pty-5', DSH_SESSION_ID: 'sess-root' } }))
      .rejects.toThrowError(/remote-profile-full-access/)
    await expect(ctx.subprocess.spawnTerminal({ argv: ['/bin/bash'], env: { DSH_PTY_SESSION_ID: 'pty-6', DSH_SESSION_ID: 'sess-1', LD_PRELOAD: '/x.so' } }))
      .rejects.toThrowError(/remote-profile-env-injection/)
    await ctx.subprocess.spawnTerminal({ argv: ['/bin/bash'] })
    expect(terminalCalls[terminalCalls.length - 1]!.argv).toEqual(['/bin/bash'])
    expect(calls.filter(call => call === 'spawnTerminal')).toHaveLength(2)
  })

  it('mints nothing for a confine that resolves after the guard is disposed', async () => {
    const { ctx, setConfine, spawnCalls } = stubCtx()
    let release!: (result: { argv: string[]; enforcement: 'full' }) => void
    setConfine(() => new Promise(resolve => { release = resolve }))
    const restore = installRemoteProfileGuard(ctx)
    const pending = ctx.sandbox.confine(['run', 'cmd'], { mode: 'workspace-write' }) as Promise<unknown>
    restore()
    release({ argv: confineArgv(['run', 'cmd']), enforcement: 'full' })
    await expect(pending).rejects.toThrowError(/remote-profile-disposed/)
    expect(spawnCalls).toHaveLength(0)
  })

  it('restores every wrapper once, idempotently, returning local-only behavior', async () => {
    const { ctx, calls } = stubCtx()
    const restore = installRemoteProfileGuard(ctx)
    expect(() => ctx.subprocess.spawn({ argv: ['/bin/sh'] })).toThrowError(/remote-profile-unconfined-spawn/)
    restore()
    restore()
    ctx.subprocess.spawn({ argv: ['/bin/sh'] })
    expect(calls).toContain('spawn')
    expect(ctx.sandboxPolicy.resolve({})).toMatchObject({ mode: 'workspace-write' })
    expect(calls).toContain('inject-dispose')
  })
})
