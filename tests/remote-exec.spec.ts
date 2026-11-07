/** G3: the remote_bash two-admission contract against a controllable backend. */
import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import Policy from '@deepseek-ai/dsh-sandbox-policy'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { remoteBashTool } from '../src/remote/exec-tool.ts'
import { RemoteConnectionLost, runRemoteCommand, type RemoteExecutionBackend, type RemoteProcessHandle } from '../src/remote/exec.ts'
import { executeTool, installToolExecutor } from './support/tool-executor.ts'
import { mountRegistryStack, type RegistryStack } from './support/registry-stack.ts'
import { createFixtureWorkspace, type FixtureWorkspace } from './support/temp-workspace.ts'

let fixture: FixtureWorkspace
let stacks: RegistryStack[]
beforeEach(() => { fixture = createFixtureWorkspace('remote-exec'); stacks = [] })
afterEach(async () => { for (const stack of stacks.reverse()) await stack.dispose(); fixture.dispose() })

const REF = { environmentId: 'build-01', rootId: 'app' }
const DEPLOYMENT = { shell: ['/bin/sh', '-c'], env: { PATH: '/bin' }, maxTimeoutMs: 60_000, stdoutLimit: 64, stderrLimit: 64, terminateGraceMs: 10 } as const

function manifestFile() {
  const path = join(fixture.base, 'deploy.json')
  writeFileSync(path, JSON.stringify({
    schemaVersion: 1, configVersion: 'cfg-1',
    environments: [{ environmentId: 'build-01', platform: 'linux', account: 'ci', hostKey: `SHA256:${'A'.repeat(43)}`, namespace: 'ns', transport: 'sftp', helper: null, connection: { host: 'vps' }, credentialIsolation: 'unattested' }],
    bindings: [{ primary: fixture.workspace, environmentId: 'build-01', rootId: 'app', path: '/work/app', actions: ['read', 'write', 'exec'] }],
  }))
  chmodSync(path, 0o600)
  return path
}

class FakeHandle implements RemoteProcessHandle {
  readonly started = Promise.resolve()
  terminateCalls = 0
  waitResult = true
  private readonly exit = Promise.withResolvers<{ exitCode: number | null; signal: string | null }>()
  readonly exited = this.exit.promise
  constructor(private readonly sink: { stdout(c: Uint8Array): void; stderr(c: Uint8Array): void }, private readonly onTerminate?: (h: FakeHandle) => void) {}
  emit(chunk: string, err = false) { this.sink[err ? 'stderr' : 'stdout'](new TextEncoder().encode(chunk)) }
  finish(exitCode = 0, signal: string | null = null) { this.exit.resolve({ exitCode, signal }) }
  lose() { this.exit.reject(new RemoteConnectionLost('connection lost')) }
  terminate() { this.terminateCalls++; this.onTerminate?.(this) }
  async waitForExit() { return this.waitResult }
}

function fakeBackend(over: { enforcement?: 'full' | 'partial' } = {}) {
  const state = {
    generation: 'gen-1',
    confineCalls: [] as { argv: readonly string[]; policy: { sessionId: string } }[],
    spawnCalls: [] as { argv: readonly string[]; options: { cwd: string; generation: string } }[],
    confineGate: undefined as PromiseWithResolvers<void> | undefined,
    handles: [] as FakeHandle[],
  }
  const backend: RemoteExecutionBackend = {
    deployment: DEPLOYMENT,
    async confine(argv, policy) {
      const generation = state.generation
      state.confineCalls.push({ argv: [...argv], policy })
      await state.confineGate?.promise
      return { argv, enforcement: over.enforcement ?? 'full', generation }
    },
    currentGeneration: () => state.generation,
    spawn(argv, options, sink) {
      state.spawnCalls.push({ argv: [...argv], options })
      const handle = new FakeHandle(sink)
      state.handles.push(handle)
      return handle
    },
  }
  return { backend, state }
}

async function mount(toolAccess?: Record<string, 'read-only'>) {
  const stack = await mountRegistryStack(join(fixture.base, 'store'), {
    remoteEnvironments: { enabled: true, manifestPath: manifestFile() },
  }, {
    scopeConfig: toolAccess === undefined ? {} : { toolAccess },
    beforeGate: async ctx => {
      await ctx.plugin(Projections)
      await ctx.plugin(Sessions)
      await ctx.plugin(Policy, { mode: 'workspace-write', workspaceRoot: fixture.workspace })
    },
  })
  stacks.push(stack)
  stack.registry.setRemoteEndpointVerifier({ verify: async (_e, b) => ({ platform: 'linux' as const, target: { kind: 'path' as const, value: b.path } }) })
  await stack.registry.addRemote(fixture.workspace, REF)
  return stack
}

let seq = 0
const sessionOf = (stack: RegistryStack, mode?: string) => {
  const session = stack.ctx.sessions.create(SessionId(`exec-${++seq}`), { meta: { cwd: fixture.workspace } })
  if (mode !== undefined) session.append('sandbox/mode', { mode })
  return session
}
async function waitHandles(state: { handles: FakeHandle[] }, count = 1) {
  for (let i = 0; i < 400 && state.handles.length < count; i++) await new Promise(resolve => setTimeout(resolve, 5))
  if (state.handles.length < count) throw new Error(`expected ${count} spawned handle(s), got ${state.handles.length}`)
}
const run = (stack: RegistryStack, backend: RemoteExecutionBackend, request: Record<string, unknown> = {}, signal = new AbortController().signal) =>
  runRemoteCommand(stack.registry, () => backend, {
    session: sessionOf(stack), environmentId: 'build-01', rootId: 'app', command: 'echo hi', timeoutMs: 5_000, ...request,
  } as never, 'remote_bash', signal)

describe.skipIf(process.platform === 'win32')('the two-admission remote command contract', () => {
  it('spawns through B only when nothing changed since A', async () => {
    const stack = await mount()
    const { backend, state } = fakeBackend()
    state.confineGate = Promise.withResolvers()
    const pending = run(stack, backend)
    for (let i = 0; i < 400 && state.confineCalls.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 5))
    state.generation = 'gen-2'
    state.confineGate.resolve()
    await expect(pending).resolves.toMatchObject({ status: 'not-started', code: 'admission-changed' })
    expect(state.spawnCalls).toHaveLength(0)
    const again = run(stack, backend)
    await waitHandles(state)
    state.handles[0]!.finish(0)
    await expect(again).resolves.toMatchObject({ status: 'scope-exited', scope: 'confirmed', exitCode: 0 })
    expect(state.spawnCalls).toHaveLength(1)
    expect(state.spawnCalls[0]!.argv).toEqual(['/bin/sh', '-c', 'echo hi'])
    expect(state.spawnCalls[0]!.options).toMatchObject({ cwd: '/work/app', generation: 'gen-2' })
    const nested = run(stack, backend, { cwdRelative: 'build/out' })
    await waitHandles(state, 2)
    state.handles[1]!.finish(0)
    await expect(nested).resolves.toMatchObject({ status: 'scope-exited' })
    expect(state.spawnCalls[1]!.options).toMatchObject({ cwd: '/work/app/build/out' })
  })

  it('denies a revoked grant between A and B without spawning', async () => {
    const stack = await mount()
    const { backend, state } = fakeBackend()
    state.confineGate = Promise.withResolvers()
    const pending = run(stack, backend)
    await new Promise(resolve => setTimeout(resolve, 10))
    await stack.registry.removeRemote(fixture.workspace, REF)
    state.confineGate.resolve()
    await expect(pending).resolves.toMatchObject({ status: 'not-started', code: 'endpoint-not-registered' })
    expect(state.spawnCalls).toHaveLength(0)
  })

  it('refuses unverified sandbox, read-only mode, capped tools, and bad inputs', async () => {
    const stack = await mount()
    const partial = fakeBackend({ enforcement: 'partial' })
    await expect(run(stack, partial.backend)).resolves.toMatchObject({ status: 'not-started', code: 'sandbox-unverified' })
    expect(partial.state.spawnCalls).toHaveLength(0)
    const ro = fakeBackend()
    const session = sessionOf(stack, 'read-only')
    await expect(runRemoteCommand(stack.registry, () => ro.backend, {
      session, environmentId: 'build-01', rootId: 'app', command: 'x', timeoutMs: 10,
    }, 'remote_bash', new AbortController().signal)).resolves.toMatchObject({ status: 'not-started', code: 'mode-denies' })
    expect(ro.state.confineCalls).toHaveLength(0)
    for (const [over, code] of [
      [{ cwdRelative: '../escape' }, 'invalid-cwd'],
      [{ cwdRelative: '/abs' }, 'invalid-cwd'],
      [{ cwdRelative: 'a/./b' }, 'invalid-cwd'],
      [{ cwdRelative: 'a\0b' }, 'invalid-cwd'],
      [{ cwdRelative: 'a\\b' }, 'invalid-cwd'],
      [{ cwdRelative: 'a//b' }, 'invalid-cwd'],
      [{ timeoutMs: 0 }, 'invalid-timeout'],
      [{ timeoutMs: DEPLOYMENT.maxTimeoutMs + 1 }, 'invalid-timeout'],
    ] as const) {
      await expect(run(stack, ro.backend, over)).resolves.toMatchObject({ status: 'not-started', code })
    }
    const capped = await mount({ remote_bash: 'read-only' })
    const cappedBackend = fakeBackend()
    await expect(run(capped, cappedBackend.backend)).resolves.toMatchObject({ status: 'not-started', code: 'tool-capped' })
    expect(cappedBackend.state.confineCalls).toHaveLength(0)
  })

  it('reports exit, truncation, timeout and connection loss', async () => {
    const stack = await mount()
    const { backend, state } = fakeBackend()
    const done = run(stack, backend)
    await waitHandles(state)
    state.handles[0]!.emit('x'.repeat(200)); state.handles[0]!.emit('err', true)
    state.handles[0]!.finish(7)
    await expect(done).resolves.toMatchObject({ status: 'scope-exited', scope: 'confirmed', exitCode: 7, truncated: { stdout: true, stderr: false } })
    const unconfirmed = fakeBackend()
    const pending = run(stack, unconfirmed.backend)
    await waitHandles(unconfirmed.state)
    unconfirmed.state.handles[0]!.waitResult = false
    unconfirmed.state.handles[0]!.finish(0)
    await expect(pending).resolves.toMatchObject({ status: 'exited', scope: 'unconfirmed' })
    const lost = fakeBackend()
    const hanging = run(stack, lost.backend)
    await waitHandles(lost.state)
    lost.state.handles[0]!.lose()
    await expect(hanging).resolves.toMatchObject({ status: 'unknown', reconcileId: expect.any(String) })
    expect(lost.state.spawnCalls).toHaveLength(1)
  })

  it('terminates once on timeout and once on repeated cancel', async () => {
    const stack = await mount()
    const slow = fakeBackend()
    const controller = new AbortController()
    const pending = run(stack, slow.backend, { timeoutMs: 30_000 }, controller.signal)
    await waitHandles(slow.state)
    const handle = slow.state.handles[0]!
    controller.abort()
    controller.abort()
    handle.finish(null, 'SIGKILL')
    await expect(pending).resolves.toMatchObject({ status: 'scope-exited', termination: 'cancelled' })
    expect(handle.terminateCalls).toBe(1)
    const timed = fakeBackend()
    const waiting = run(stack, timed.backend, { timeoutMs: 20 })
    await waitHandles(timed.state)
    for (let i = 0; i < 400 && timed.state.handles[0]!.terminateCalls === 0; i++) await new Promise(resolve => setTimeout(resolve, 5))
    timed.state.handles[0]!.waitResult = false
    timed.state.handles[0]!.finish(null, 'SIGKILL')
    await expect(waiting).resolves.toMatchObject({ status: 'exited', scope: 'unconfirmed', termination: 'timeout' })
    expect(timed.state.handles[0]!.terminateCalls).toBe(1)
  })

  it('keeps the second session running when the first is cancelled', async () => {
    const stack = await mount()
    const { backend, state } = fakeBackend()
    const c1 = new AbortController()
    const one = run(stack, backend, {}, c1.signal)
    const two = run(stack, backend)
    await waitHandles(state, 2)
    c1.abort()
    state.handles[0]!.finish(null, 'SIGTERM')
    state.handles[1]!.emit('ok'); state.handles[1]!.finish(0)
    await expect(one).resolves.toMatchObject({ status: 'scope-exited', termination: 'cancelled' })
    await expect(two).resolves.toMatchObject({ status: 'scope-exited', stdout: 'ok' })
    expect(state.handles[0]!.terminateCalls).toBe(1)
    expect(state.handles[1]!.terminateCalls).toBe(0)
  })

  it('revocation after spawn lets the in-flight command finish and denies the next', async () => {
    const stack = await mount()
    const { backend, state } = fakeBackend()
    const pending = run(stack, backend)
    await waitHandles(state)
    await stack.registry.removeRemote(fixture.workspace, REF)
    state.handles[0]!.finish(0)
    await expect(pending).resolves.toMatchObject({ status: 'scope-exited', exitCode: 0 })
    await expect(run(stack, backend)).resolves.toMatchObject({ status: 'not-started', code: 'endpoint-not-registered' })
  })
})

describe.skipIf(process.platform === 'win32')('remote_bash through the real tool pipeline', () => {
  async function toolWorld() {
    const stack = await mount()
    await stack.ctx.plugin(SystemPrompt)
    await stack.ctx.plugin(Tools)
    await installToolExecutor(stack.ctx)
    const session = sessionOf(stack)
    const agent = { id: session.id, session } as Agent
    return { stack, session, agent }
  }
  const call = (ctx: RegistryStack['ctx'], agent: Agent, args: object) => executeTool(ctx, {
    callId: 'g3-call', name: 'remote_bash', args, signal: new AbortController().signal, agent,
  }) as Promise<{ isError?: boolean; error?: { message?: string } }>

  it('errors when the tool is not registered', async () => {
    const { stack, agent } = await toolWorld()
    const result = await call(stack.ctx, agent, { environmentId: 'build-01', rootId: 'app', command: 'x', timeoutMs: 10 })
    expect(result.isError).toBe(true)
  })

  it('uses the dispatch session and tool name, ignoring forged fields', async () => {
    const { stack, session, agent } = await toolWorld()
    const { backend, state } = fakeBackend()
    await stack.ctx.plugin({
      name: 'g3-remote-tool', inject: ['tools'],
      apply(fiber) { fiber.tools.register(remoteBashTool({ registry: stack.registry, backendFor: () => backend }) as never) },
    })
    const pending = call(stack.ctx, agent, {
      environmentId: 'build-01', rootId: 'app', command: 'ls', timeoutMs: 500,
      sessionId: 'forged', toolName: 'other_tool',
    })
    await new Promise(resolve => setTimeout(resolve, 50))
    state.handles[0]?.finish(0)
    await pending
    expect(state.confineCalls.length).toBeGreaterThan(0)
    for (const callInfo of state.confineCalls) expect(callInfo.policy.sessionId).toBe(session.id)
  })
})
