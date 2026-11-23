/** G3: the remote_bash two-admission contract against a controllable backend. */
import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import Policy from '@deepseek-ai/dsh-sandbox-policy'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { lazySshExecBackend, sshExecBackend, type SshExecManager } from '../src/remote/ssh-exec-backend.ts'
import { fakeManifest } from './support/fake-remote.ts'
import { RemoteAdmissionError } from '../src/remote/contract.ts'
import { handlePersonalEndpoint } from '../src/remote/personal-endpoints.ts'
import { loadPersonalConfig, savePersonalConfig, type PersonalConfig } from '../src/remote/personal/config.ts'
import { remoteBashTool } from '../src/remote/exec-tool.ts'
import {
  RemoteConnectionLost,
  runRemoteCommand,
  type OutputChunkMeta,
  type RemoteExecutionBackend,
  type RemoteExecDeployment,
  type RemoteProcessHandle,
  type RemoteProcessOutputSink,
} from '../src/remote/exec.ts'
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
    bindings: [
      { primary: fixture.workspace, environmentId: 'build-01', rootId: 'app', path: '/work/app', actions: ['read', 'write', 'exec'] },
      { primary: fixture.workspace, environmentId: 'build-01', rootId: 'data', path: '/work/data', actions: ['read'] },
      { primary: fixture.outside, environmentId: 'build-01', rootId: 'data', path: '/work/data', actions: ['read'] },
    ],
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
  constructor(private readonly sink: RemoteProcessOutputSink, private readonly onTerminate?: (h: FakeHandle) => void) {}
  emit(chunk: string, err = false, meta?: OutputChunkMeta) { this.sink[err ? 'stderr' : 'stdout'](new TextEncoder().encode(chunk), meta) }
  finish(exitCode = 0, signal: string | null = null) { this.exit.resolve({ exitCode, signal }) }
  lose() { this.exit.reject(new RemoteConnectionLost('connection lost')) }
  terminate() { this.terminateCalls++; this.onTerminate?.(this) }
  async waitForExit() { return this.waitResult }
}

function fakeBackend(over: { enforcement?: 'full' | 'partial'; deployment?: RemoteExecDeployment } = {}) {
  const deployment = over.deployment ?? DEPLOYMENT
  const state = {
    generation: 'gen-1',
    confineCalls: [] as { argv: readonly string[]; policy: { sessionId: string } }[],
    spawnCalls: [] as { argv: readonly string[]; options: { cwd: string; generation: string } }[],
    confineGate: undefined as PromiseWithResolvers<void> | undefined,
    handles: [] as FakeHandle[],
  }
  const backend: RemoteExecutionBackend = {
    deployment,
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
    allowUserOwnedRemoteManifestForTesting: true,
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

  it.each(['same workspace', 'another workspace'])('keeps a running command when a grant is added in %s', async scope => {
    const stack = await mount()
    const { backend, state } = fakeBackend()
    const pending = run(stack, backend)
    await waitHandles(state)
    const primary = scope === 'same workspace' ? fixture.workspace : fixture.outside
    await stack.registry.addRemote(primary, { ...REF, rootId: 'data' })
    await new Promise(resolve => setTimeout(resolve, 325)) // at least one polling re-admission
    const handle = state.handles[0]!
    expect(handle.terminateCalls).toBe(0)
    handle.finish()
    await expect(pending).resolves.toMatchObject({ status: 'scope-exited', exitCode: 0 })
  })

  it('does not resume the old command after remove and re-add under a blocked recheck', async () => {
    const stack = await mount()
    const { backend, state } = fakeBackend()
    const pending = run(stack, backend)
    await waitHandles(state)
    const entered = Promise.withResolvers<void>()
    const check = Promise.withResolvers<void>()
    const admit = stack.registry.withRemoteOperation.bind(stack.registry)
    const spy = vi.spyOn(stack.registry, 'withRemoteOperation').mockImplementation(async (...args) => {
      entered.resolve()
      await check.promise
      return await admit(...args)
    })
    try {
      await entered.promise
      await stack.registry.removeRemote(fixture.workspace, REF)
      await stack.registry.addRemote(fixture.workspace, REF)
      check.resolve()
      await expect(pending).resolves.toMatchObject({ termination: 'revoked' })
      expect(state.handles[0]!.terminateCalls).toBe(1)
    } finally { check.resolve(); spy.mockRestore() }
  })

  it('retries temporary IPC errors within the revocation budget', async () => {
    const stack = await mount()
    const { backend, state } = fakeBackend()
    const pending = run(stack, backend)
    await waitHandles(state)
    const admit = stack.registry.withRemoteOperation.bind(stack.registry)
    const recovered = Promise.withResolvers<void>()
    const spy = vi.spyOn(stack.registry, 'withRemoteOperation')
      .mockRejectedValueOnce(new RemoteAdmissionError('authority-disconnected', 'IPC disconnected'))
      .mockImplementation(async (...args) => {
        const result = await admit(...args)
        recovered.resolve()
        return result
      })
    try {
      await recovered.promise
      const handle = state.handles[0]!
      expect(spy).toHaveBeenCalledTimes(2)
      expect(handle.terminateCalls).toBe(0)
      handle.finish()
      await expect(pending).resolves.toMatchObject({ status: 'scope-exited', exitCode: 0 })
    } finally { spy.mockRestore() }
  })

  it.each(['binding', 'credential', 'host key'] as const)('keeps a no-op save and revokes the command when its %s changes', async changed => {
    const personalPath = join(fixture.base, 'personal.json')
    const config: PersonalConfig = {
      schemaVersion: 2, revision: 0,
      environments: [{
        environmentId: REF.environmentId, platform: 'linux', hostKey: `SHA256:${'A'.repeat(43)}`,
        endpoint: { hostname: 'build.internal', port: 22, user: 'ci' },
        credential: { kind: 'managed', credentialId: 'aabbccddeeff' },
        helper: { nodePath: '/bin/node', helperPath: '/opt/helper.js', sha256: 'a'.repeat(64), protocol: 1 },
      }],
      bindings: [{ ...REF, primary: fixture.workspace, path: '/work/app', actions: ['read', 'exec'] }],
    }
    await savePersonalConfig(personalPath, config, 0)
    const stack = await mountRegistryStack(join(fixture.base, 'store'), {
      remoteEnvironments: { mode: 'personal', enabled: true, personalPath, credentialRoot: join(fixture.base, 'cred') },
    }, {
      beforeGate: async ctx => {
        await ctx.plugin(Projections)
        await ctx.plugin(Sessions)
        await ctx.plugin(Policy, { mode: 'workspace-write', workspaceRoot: fixture.workspace })
      },
    })
    stacks.push(stack)
    stack.registry.setRemoteEndpointVerifier({ verify: async (_env, binding) => ({
      platform: 'linux', target: { kind: 'path', value: binding.path },
    }) })
    await stack.registry.addRemote(fixture.workspace, REF)
    const { backend, state } = fakeBackend()
    const pending = run(stack, backend)
    await waitHandles(state)
    const { primary: _primary, ...binding } = config.bindings[0]!
    const payload = { endpoint: 'sshBindingSave', sessionId: 's', revision: 0, binding } as const
    await expect(handlePersonalEndpoint(stack.ctx, stack.registry, fixture.workspace, {
      ...payload, binding: { ...binding, actions: ['exec', 'read'], transfers: [] },
    })).resolves.toMatchObject({ revision: 0 })
    await expect(stack.registry.remoteList(fixture.workspace)).resolves.toMatchObject({ grants: [{ state: 'registered' }] })
    expect(state.handles[0]!.terminateCalls).toBe(0)

    if (changed === 'binding') {
      await handlePersonalEndpoint(stack.ctx, stack.registry, fixture.workspace, { ...payload, binding: { ...binding, path: '/work/moved' } })
    } else {
      const loaded = loadPersonalConfig(personalPath)
      const original = loaded.environments[0]!
      const environment = changed === 'credential'
        ? { ...original, credential: { kind: 'managed' as const, credentialId: 'ffeeddccbbaa' } }
        : { ...original, hostKey: `SHA256:${'B'.repeat(43)}` }
      await savePersonalConfig(personalPath, { ...loaded, revision: 1, environments: [environment] }, 0)
    }
    await expect(pending).resolves.toMatchObject({ termination: 'revoked' })
    expect(state.handles[0]!.terminateCalls).toBe(1)
    await expect(stack.registry.remoteList(fixture.workspace)).resolves.toMatchObject({ grants: [{ state: 'withheld' }] })
  })

  it('denies a revoked grant between A and B without spawning', async () => {
    const stack = await mount()
    const { backend, state } = fakeBackend()
    state.confineGate = Promise.withResolvers()
    const pending = run(stack, backend)
    await new Promise(resolve => setTimeout(resolve, 10))
    await stack.registry.removeRemote(fixture.workspace, REF)
    state.confineGate.resolve()
    await expect(pending).resolves.toMatchObject({
      status: 'not-started',
      code: 'endpoint-not-registered',
      message: expect.stringContaining('not registered'),
      hint: expect.stringMatching(/[Rr]egistered|workspace topology/),
    })
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
    const invalidCwd = await run(stack, ro.backend, { cwdRelative: '../escape' })
    expect(invalidCwd).toMatchObject({
      status: 'not-started',
      code: 'invalid-cwd',
      message: expect.stringContaining('cwdRelative'),
      hint: expect.stringContaining('/work/app'),
    })
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
      await expect(run(stack, ro.backend, over)).resolves.toMatchObject({
        status: 'not-started', code, message: expect.any(String), hint: expect.any(String),
      })
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
    await expect(done).resolves.toMatchObject({
      status: 'scope-exited',
      scope: 'confirmed',
      exitCode: 7,
      truncated: { stdout: true, stderr: false },
      totalBytes: { stdout: null, stderr: null },
      droppedBytes: { stdout: null, stderr: null },
    })
    const unconfirmed = fakeBackend()
    const pending = run(stack, unconfirmed.backend)
    await waitHandles(unconfirmed.state)
    unconfirmed.state.handles[0]!.waitResult = false
    unconfirmed.state.handles[0]!.finish(0)
    await expect(pending).resolves.toMatchObject({
      status: 'exited',
      scope: 'unconfirmed',
      message: expect.stringContaining('scope'),
      hint: expect.stringContaining('Descendants'),
    })
    const lost = fakeBackend()
    const hanging = run(stack, lost.backend)
    await waitHandles(lost.state)
    lost.state.handles[0]!.lose()
    await expect(hanging).resolves.toMatchObject({
      status: 'unknown',
      reconcileId: expect.any(String),
      message: expect.stringContaining('unknown'),
      hint: expect.stringContaining('reconcileId'),
    })
    expect(lost.state.spawnCalls).toHaveLength(1)
  })

  it('opens Helper generations by bound Root and keeps a nested cwd on the same Helper', async () => {
    const environment = {
      ...fakeManifest({ primary: fixture.workspace }).environments[0]!,
      transport: 'helper' as const,
      exec: { ...DEPLOYMENT, shell: [...DEPLOYMENT.shell] },
    }
    const opened: [string, string | undefined][] = []
    const policies: string[] = []
    const manager: SshExecManager = {
      async open(id, root) {
        opened.push([id, root])
        return {
          generation: root,
          hello: { executable: '/bin/node', platform: 'linux' },
          sandbox: {
            confine: async (argv: readonly string[], policy: { workspaceRoot: string }) => {
              policies.push(policy.workspaceRoot)
              return { argv, enforcement: 'full' }
            },
          },
          subprocess: {
            spawn: ({ cwd }: { cwd: string }) => ({
              done: Promise.resolve({ exitCode: 0 }),
              terminate() {},
              waitForExit: async () => true,
              collected: { stdout: { readFrom: () => ({ text: JSON.stringify({ real: cwd, dev: '1', ino: '2', isDirectory: true }) }) } },
            }),
          },
        } as Awaited<ReturnType<SshExecManager['open']>>
      },
      async openSftp() { throw new Error('this operation uses the Helper') },
      generationOf: (_id, root) => root ?? 'stale',
      markStale() {},
    }
    const signal = AbortSignal.timeout(2_000)
    for (const root of ['/srv/app', '/srv/logs']) {
      const backend = lazySshExecBackend(environment, manager, root)!
      await backend.verifyCwd!(root + '/nested', root, signal, { kind: 'object', value: '1:2' })
      await expect(backend.confine(['probe'], { mode: 'workspace-write', workspaceRoot: root, sessionId: 'session' }, signal))
        .resolves.toMatchObject({ generation: root })
      expect(backend.currentGeneration()).toBe(root)
    }
    expect(opened).toEqual(['/srv/app', '/srv/logs'].flatMap(root => Array.from({ length: 3 }, () => [environment.environmentId, root])))
    expect(policies).toEqual(['/srv/app', '/srv/app', '/srv/app', '/srv/logs', '/srv/logs', '/srv/logs'])
  })

  it.each([
    ['x'.repeat(100), 'x'.repeat(64)],
    ['é'.repeat(40), 'é'.repeat(32)],
    ['x'.repeat(63) + 'é', 'x'.repeat(63)],
  ])('retains the bounded prefix of real-adapter output %j', async (text, expected) => {
    const stack = await mount()
    const environment = fakeManifest({ primary: fixture.workspace }).environments[0]!
    environment.exec = { ...DEPLOYMENT, shell: [...DEPLOYMENT.shell] }
    const ssh = { generation: 'g', sandbox: { confine: async (argv: readonly string[]) => ({ argv, enforcement: 'full' }) },
      subprocess: { spawn: () => ({ done: Promise.resolve({ exitCode: 0, signal: null }), waitForExit: async () => true, terminate() {},
        collected: { stdout: { readFrom: () => ({ text }) }, stderr: { readFrom: () => ({ text }) } } }) } }
    const backend = sshExecBackend(environment, ssh as never, { generationOf: () => 'g', markStale() {} } as never)!
    await expect(run(stack, backend)).resolves.toMatchObject({ stdout: expected, stderr: expected, truncated: { stdout: true, stderr: true } })
  })

  it('fills the remaining output budget across chunks and discards later bytes', async () => {
    const stack = await mount()
    const { backend, state } = fakeBackend()
    const pending = run(stack, backend)
    await waitHandles(state)
    state.handles[0]!.emit('a'.repeat(60))
    state.handles[0]!.emit('bcdefgh')
    state.handles[0]!.emit('later')
    state.handles[0]!.finish()
    await expect(pending).resolves.toMatchObject({ stdout: 'a'.repeat(60) + 'bcde', truncated: { stdout: true, stderr: false } })
  })

  it('reports exactly-at-limit output without truncating and keeps raw totals', async () => {
    const stack = await mount()
    const { backend, state } = fakeBackend()
    const pending = run(stack, backend)
    await waitHandles(state)
    state.handles[0]!.emit('x'.repeat(64), false, { offset: 0, totalBytes: 64, lossy: false })
    state.handles[0]!.finish()
    await expect(pending).resolves.toMatchObject({
      stdout: 'x'.repeat(64),
      truncated: { stdout: false, stderr: false },
      totalBytes: { stdout: 64, stderr: null },
      droppedBytes: { stdout: 0, stderr: null },
    })
  })

  it('reports the raw total and the dropped bytes of over-budget output', async () => {
    const stack = await mount()
    const { backend, state } = fakeBackend()
    const pending = run(stack, backend)
    await waitHandles(state)
    state.handles[0]!.emit('x'.repeat(200), false, { offset: 0, totalBytes: 200, lossy: false })
    state.handles[0]!.finish()
    await expect(pending).resolves.toMatchObject({
      stdout: 'x'.repeat(64),
      truncated: { stdout: true, stderr: false },
      totalBytes: { stdout: 200, stderr: null },
      droppedBytes: { stdout: 136, stderr: null },
    })
  })

  it('handles an upstream output window that already dropped its head', async () => {
    const stack = await mount()
    const { backend, state } = fakeBackend()
    const pending = run(stack, backend)
    await waitHandles(state)
    state.handles[0]!.emit('y'.repeat(64), false, { offset: 936, totalBytes: 1000, lossy: true })
    state.handles[0]!.finish()
    await expect(pending).resolves.toMatchObject({
      stdout: 'y'.repeat(64),
      truncated: { stdout: true, stderr: false },
      totalBytes: { stdout: 1000, stderr: null },
      droppedBytes: { stdout: 936, stderr: null },
    })
  })

  it('cuts at a UTF-8 boundary without a replacement character or an inflated count', async () => {
    const stack = await mount()
    const { backend, state } = fakeBackend()
    const pending = run(stack, backend)
    await waitHandles(state)
    const prefix = 'a'.repeat(63) + 'é'
    state.handles[0]!.emit(prefix, false, { offset: 0, totalBytes: Buffer.byteLength(prefix), lossy: false })
    state.handles[0]!.finish()
    const result = await pending
    expect(result).toMatchObject({
      stdout: 'a'.repeat(63),
      truncated: { stdout: true, stderr: false },
      totalBytes: { stdout: 65, stderr: null },
      droppedBytes: { stdout: 1, stderr: null },
    })
    expect('stdout' in result && result.stdout).not.toContain('\uFFFD')
  })

  it('reports an exact total but an unknown dropped count for an approximate window', async () => {
    const stack = await mount()
    const { backend, state } = fakeBackend()
    const pending = run(stack, backend)
    await waitHandles(state)
    state.handles[0]!.emit('abc', false, { lossy: true, totalBytes: 10, approximate: true })
    state.handles[0]!.finish()
    await expect(pending).resolves.toMatchObject({
      stdout: 'abc',
      truncated: { stdout: true, stderr: false },
      totalBytes: { stdout: 10, stderr: null },
      droppedBytes: { stdout: null, stderr: null },
    })
  })

  it('applies the bounded preview default to an existing 1 MiB deployment', async () => {
    const stack = await mount()
    const deployment = { ...DEPLOYMENT, stdoutLimit: 1_048_576, stderrLimit: 1_048_576 }
    const { backend, state } = fakeBackend({ deployment })
    const pending = run(stack, backend)
    await waitHandles(state)
    state.handles[0]!.emit('z'.repeat(100_000), false, { offset: 0, totalBytes: 100_000, lossy: false })
    state.handles[0]!.finish()
    const result = await pending
    expect(result).toMatchObject({
      truncated: { stdout: true, stderr: false },
      totalBytes: { stdout: 100_000, stderr: null },
      droppedBytes: { stdout: 100_000 - 65_536, stderr: null },
    })
    expect('stdout' in result && result.stdout).toHaveLength(65_536)
  })

  it('lets maxOutputBytes raise the preview up to the deployment limit and clamps beyond it', async () => {
    const stack = await mount()
    const raised = fakeBackend({ deployment: { ...DEPLOYMENT, stdoutLimit: 1_048_576, stderrLimit: 1_048_576 } })
    const pending = run(stack, raised.backend, { maxOutputBytes: 131_072 })
    await waitHandles(raised.state)
    raised.state.handles[0]!.emit('w'.repeat(100_000), false, { offset: 0, totalBytes: 100_000, lossy: false })
    raised.state.handles[0]!.finish()
    const raisedResult = await pending
    expect(raisedResult).toMatchObject({ truncated: { stdout: false }, totalBytes: { stdout: 100_000 }, droppedBytes: { stdout: 0 } })
    expect('stdout' in raisedResult && raisedResult.stdout).toHaveLength(100_000)

    const clamped = fakeBackend({ deployment: { ...DEPLOYMENT, stdoutLimit: 1_024, stderrLimit: 1_024 } })
    const clampedPending = run(stack, clamped.backend, { maxOutputBytes: 8_192 })
    await waitHandles(clamped.state)
    clamped.state.handles[0]!.emit('c'.repeat(2_048), false, { offset: 0, totalBytes: 2_048, lossy: false })
    clamped.state.handles[0]!.finish()
    const clampedResult = await clampedPending
    expect(clampedResult).toMatchObject({
      truncated: { stdout: true },
      totalBytes: { stdout: 2_048 },
      droppedBytes: { stdout: 1_024 },
    })
    expect('stdout' in clampedResult && clampedResult.stdout).toHaveLength(1_024)
  })

  it('reports unknown with a reconcile id when the start acknowledgement is lost, and never retries', async () => {
    const stack = await mount()
    const { backend, state } = fakeBackend()
    const base = backend.spawn
    backend.spawn = (argv, options, sink) => {
      const handle = base(argv, options, sink)
      const started = Promise.withResolvers<void>()
      Object.defineProperty(handle, 'started', { get: () => started.promise })
      started.reject(new RemoteConnectionLost('spawn reply lost'))
      return handle
    }
    const result = await run(stack, backend)
    expect(result).toMatchObject({ status: 'unknown', reconcileId: expect.any(String), operationId: expect.any(String) })
    expect(state.spawnCalls).toHaveLength(1)
    expect(state.handles[0]!.terminateCalls).toBe(0)
  })

  it('handles transport loss before a delayed start acknowledgement', async () => {
    const stack = await mount()
    const { backend, state } = fakeBackend()
    const started = Promise.withResolvers<void>()
    const spawn = backend.spawn
    backend.spawn = (...args) => {
      const handle = spawn(...args)
      Object.defineProperty(handle, 'started', { value: started.promise })
      return handle
    }
    const pending = run(stack, backend)
    await waitHandles(state)
    const lostAt = Date.now()
    state.handles[0]!.lose()
    // The start acknowledgement never arrives: loss alone must report unknown.
    await expect(pending).resolves.toMatchObject({ status: 'unknown', reconcileId: expect.any(String), operationId: expect.any(String) })
    expect(Date.now() - lostAt).toBeLessThan(1_000)
    expect(state.handles[0]!.terminateCalls).toBe(0)
  })

  it('refuses a cwd the production verifyCwd rejects before any confine or spawn', async () => {
    const stack = await mount()
    const { backend, state } = fakeBackend()
    const seen: { cwd: string; root: string }[] = []
    backend.verifyCwd = async (cwd, root) => {
      seen.push({ cwd, root })
      throw Object.assign(new Error('the remote cwd is a symlink'), { code: 'destination-symlinked' })
    }
    await expect(run(stack, backend)).resolves.toMatchObject({ status: 'not-started', code: 'destination-symlinked' })
    expect(seen).toEqual([{ cwd: '/work/app', root: '/work/app' }])
    expect(state.confineCalls).toHaveLength(0)
    expect(state.spawnCalls).toHaveLength(0)
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
    await expect(pending).resolves.toMatchObject({
      status: 'scope-exited',
      termination: 'cancelled',
      message: expect.stringContaining('cancelled'),
      hint: expect.stringContaining('remote process'),
    })
    expect(handle.terminateCalls).toBe(1)
    const timed = fakeBackend()
    const waiting = run(stack, timed.backend, { timeoutMs: 20 })
    await waitHandles(timed.state)
    for (let i = 0; i < 400 && timed.state.handles[0]!.terminateCalls === 0; i++) await new Promise(resolve => setTimeout(resolve, 5))
    timed.state.handles[0]!.waitResult = false
    timed.state.handles[0]!.finish(null, 'SIGKILL')
    await expect(waiting).resolves.toMatchObject({
      status: 'exited',
      scope: 'unconfirmed',
      termination: 'timeout',
      message: expect.stringContaining('timeoutMs'),
      hint: expect.stringContaining('timeoutMs'),
    })
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

  it('bounds cleanup when a revoked process never acknowledges start or termination', async () => {
    const stack = await mount()
    const { backend, state } = fakeBackend()
    const spawn = backend.spawn
    backend.spawn = (...args) => {
      const handle = spawn(...args)
      Object.defineProperty(handle, 'started', { value: new Promise<void>(() => {}) })
      return handle
    }
    const pending = run(stack, backend)
    await waitHandles(state)
    await stack.registry.removeRemote(fixture.workspace, REF)
    await expect(pending).resolves.toMatchObject({ status: 'unknown', termination: 'revoked', reconcileId: expect.any(String) })
    expect(state.handles[0]!.terminateCalls).toBe(1)
  })

  it('observes owner revocation while the command runs on a follower', async () => {
    const owner = await mount()
    const follower = await mount()
    const { backend, state } = fakeBackend()
    const pending = run(follower, backend)
    await waitHandles(state)
    await owner.registry.removeRemote(fixture.workspace, REF)
    await expect(pending).resolves.toMatchObject({ status: 'unknown', termination: 'revoked' })
    expect(state.handles[0]!.terminateCalls).toBe(1)
  })

  it('observes mode narrowing without a grant notification', async () => {
    const stack = await mount()
    const { backend, state } = fakeBackend()
    const session = sessionOf(stack)
    const pending = run(stack, backend, { session })
    await waitHandles(state)
    session.append('sandbox/mode', { mode: 'read-only' })
    await expect(pending).resolves.toMatchObject({ status: 'unknown', termination: 'revoked' })
    expect(state.handles[0]!.terminateCalls).toBe(1)
  })

  it('revocation after spawn terminates the in-flight command and denies the next', async () => {
    const stack = await mount()
    const { backend, state } = fakeBackend()
    const pending = run(stack, backend)
    await waitHandles(state)
    await stack.registry.removeRemote(fixture.workspace, REF)
    for (let i = 0; i < 100 && state.handles[0]!.terminateCalls === 0; i++) await new Promise(resolve => setTimeout(resolve, 1))
    expect(state.handles[0]!.terminateCalls).toBe(1)
    state.handles[0]!.finish(0)
    await expect(pending).resolves.toMatchObject({ status: 'scope-exited', exitCode: 0, termination: 'revoked' })
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
  }) as Promise<{ isError?: boolean; error?: { message?: string }; value?: Record<string, unknown> }>

  it('errors when the tool is not registered', async () => {
    const { stack, agent } = await toolWorld()
    const result = await call(stack.ctx, agent, { environmentId: 'build-01', rootId: 'app', command: 'x', timeoutMs: 10 })
    expect(result.isError).toBe(true)
  })

  it('rejects forged session and tool-name fields before any admission', async () => {
    const { stack, agent } = await toolWorld()
    const { backend, state } = fakeBackend()
    await stack.ctx.plugin({
      name: 'g3-remote-tool', inject: ['tools'],
      apply(fiber) { fiber.tools.register(remoteBashTool({ registry: stack.registry, backendFor: () => backend }) as never) },
    })
    const outcome = await call(stack.ctx, agent, {
      environmentId: 'build-01', rootId: 'app', command: 'ls', timeoutMs: 500,
      sessionId: 'forged', toolName: 'other_tool',
    })
    expect(outcome.value).toMatchObject({
      status: 'not-started',
      code: 'invalid-arguments',
      message: expect.stringContaining('"sessionId"'),
      hint: expect.stringContaining('remote_bash'),
    })
    expect(state.confineCalls).toHaveLength(0)
    expect(state.spawnCalls).toHaveLength(0)
  })

  it('applies the 64 KiB preview default and maxOutputBytes through dispatch', async () => {
    const { stack, agent } = await toolWorld()
    const deployment = { ...DEPLOYMENT, stdoutLimit: 1_048_576, stderrLimit: 1_048_576 }
    const { backend, state } = fakeBackend({ deployment })
    await stack.ctx.plugin({
      name: 'g3-remote-tool', inject: ['tools'],
      apply(fiber) { fiber.tools.register(remoteBashTool({ registry: stack.registry, backendFor: () => backend }) as never) },
    })
    const pending = call(stack.ctx, agent, { environmentId: 'build-01', rootId: 'app', command: 'ls', timeoutMs: 500 })
    await waitHandles(state)
    state.handles[0]!.emit('z'.repeat(100_000), false, { offset: 0, totalBytes: 100_000, lossy: false })
    state.handles[0]!.finish(0)
    const outcome = await pending
    expect(outcome.value).toMatchObject({
      truncated: { stdout: true, stderr: false },
      totalBytes: { stdout: 100_000, stderr: null },
      droppedBytes: { stdout: 100_000 - 65_536, stderr: null },
    })
    expect(String(outcome.value?.stdout)).toHaveLength(65_536)
  })

  it('uses the dispatch session and tool name for admission', async () => {
    const { stack, session, agent } = await toolWorld()
    const { backend, state } = fakeBackend()
    await stack.ctx.plugin({
      name: 'g3-remote-tool', inject: ['tools'],
      apply(fiber) { fiber.tools.register(remoteBashTool({ registry: stack.registry, backendFor: () => backend }) as never) },
    })
    const seen: { sessionId?: string; toolName?: string } = {}
    const original = stack.registry.withRemoteOperation.bind(stack.registry)
    vi.spyOn(stack.registry, 'withRemoteOperation').mockImplementation(async (request, body) => {
      seen.sessionId ??= request.session?.id
      seen.toolName ??= request.toolName
      return await original(request, body)
    })
    const pending = call(stack.ctx, agent, { environmentId: 'build-01', rootId: 'app', command: 'ls', timeoutMs: 500 })
    await waitHandles(state)
    state.handles[0]!.finish(0)
    await pending
    expect(seen.sessionId).toBe(session.id)
    expect(seen.toolName).toBe('remote_bash')
    for (const callInfo of state.confineCalls) expect(callInfo.policy.sessionId).toBe(session.id)
  })
})
