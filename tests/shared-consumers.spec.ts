/** Public process, Files, LSP and native Skills seams on a shared Registry. */
import { join } from 'node:path'
import { writeFileSync, renameSync, symlinkSync } from 'node:fs'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { WorkspaceFiles } from '@deepseek-ai/dsh-api-workspace-files'
import { Lsp, LspProviderId } from '@deepseek-ai/dsh-lsp'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { nativeHostAvailability } from '../src/authority/native.ts'
import MultiRootFileSystem from '../src/fs.ts'
import MultiRootSandboxProvider from '../src/sandbox.ts'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import * as ProcessFence from '../src/process-fence.ts'
import * as FilesRouting from '../src/workspace-files.ts'
import * as LspRouting from '../src/lsp.ts'
import { mountRegistryStack, type RegistryStack } from './support/registry-stack.ts'
import { skillsStack, writeSkill } from './support/skills-stack.ts'
import { internalSkillName } from '../src/skills/catalog.ts'
import { createFixtureWorkspace, symlinkUnsupportedReason, type FixtureWorkspace } from './support/temp-workspace.ts'

const availability = await nativeHostAvailability()
if (!availability.available) console.info(`shared Registry native tests unavailable: ${availability.reason}`)
const nativeTest = it.skipIf(!availability.available)
let fixture: FixtureWorkspace, cleanups: Array<() => Promise<unknown>>
beforeEach(() => { fixture = createFixtureWorkspace('shared-consumers'); cleanups = [] })
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.reverse()) await cleanup(); fixture.dispose() })
const policy = () => ({ workspaceRoot: fixture.workspace, mode: 'workspace-write' as const })
async function mount() {
  const root = join(fixture.base, 'store')
  const stack = await mountRegistryStack(root, { sharedStorageRoot: root }, { beforeGate: async ctx => {
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SandboxPolicyService, policy())
    await ctx.plugin(MultiRootFileSystem, { cwd: fixture.workspace })
    await ctx.plugin(MultiRootSandboxProvider, {})
    ;(ctx.sandbox as MultiRootSandboxProvider).internals = { chain: ['seatbelt'] }
  } })
  cleanups.push(stack.dispose); await stack.registry.refresh(fixture.workspace); return stack
}
function dropNotifications(owner: RegistryStack) {
  vi.spyOn((owner.registry as unknown as { server: { changed(): void } }).server, 'changed').mockImplementation(() => {})
}

nativeTest('reauthorizes direct async shell/PTC and PTYs while preserving a synchronous primary-only entry', async () => {
  const owner = await mount(), follower = await mount(), ctx = follower.ctx
  await owner.registry.add(fixture.workspace, { path: fixture.outside })
  const id = SessionId('shared-process-session')
  const session = Session.create(id, [], { id, cwd: fixture.workspace, version: SESSION_FORMAT_VERSION, createdAt: 0, isSeeded: false })
  const specs: unknown[] = []
  const execute = async () => {
    const facts = await ctx.sandbox.confine(['bash', '-c', 'true'], policy())
    const result = ctx.subprocess.spawn({ argv: facts.argv, cwd: fixture.workspace })
    return { result, roots: ctx.multiRootScope.resolve(policy()).writableRoots }
  }
  ctx.provide('subprocess', { spawn: (spec: unknown) => { specs.push(spec); return { pid: 1 } }, spawnTerminal: async (spec: unknown) => { specs.push(spec); return { pid: 2 } } } as never)
  ctx.provide('shell', { execute, start: () => ({ roots: ctx.multiRootScope.resolve(policy()).writableRoots }) } as never)
  ctx.provide('ptcRuntime', { run: execute } as never)
  ctx.provide('sessions', { get: (key: string) => key === id ? session : undefined } as never)
  await ctx.plugin(ProcessFence)
  expect(await ctx.shell.execute({ command: 'true' } as never)).toMatchObject({ roots: [fixture.outside] })
  expect(await ctx.ptcRuntime.run({} as never)).toMatchObject({ roots: [fixture.outside] })
  const sync = (ctx.get('shell') as unknown as { start(): unknown }).start()
  expect(sync).toEqual({ roots: [] }); expect(sync).not.toBeInstanceOf(Promise)
  let old: readonly string[] = []
  await follower.registry.withOperation(policy(), 'process', async () => { old = (await ctx.sandbox.confine(['bash', '-c', 'true'], policy())).argv })
  dropNotifications(owner)
  await owner.registry.setAccess(fixture.workspace, { kind: 'path', path: fixture.outside }, 'read-only')
  expect(await ctx.shell.execute({ command: 'true' } as never)).toMatchObject({ roots: [] })
  expect(await ctx.ptcRuntime.run({} as never)).toMatchObject({ roots: [] })
  expect(() => ctx.subprocess.spawn({ argv: [...old], cwd: fixture.workspace })).toThrow('live admission')
  await expect(follower.registry.withOperation(policy(), 'process', () => ctx.subprocess.spawn({ argv: [...old], cwd: fixture.workspace }))).rejects.toThrow('live admission')
  await ctx.subprocess.spawnTerminal({ argv: [...old], cwd: fixture.workspace, env: { DSH_PTY_SESSION_ID: id, DSH_SESSION_ID: id } } as never)
  const newPty = specs.at(-1) as { argv: string[] }
  expect(newPty.argv).not.toEqual(old)
  const controller = { argv: ['bash'], cwd: fixture.workspace, env: { DSH_SESSION_ID: id } }
  await ctx.subprocess.spawnTerminal(controller as never)
  expect(specs.at(-1)).toBe(controller)
})

nativeTest('launches an unadmitted confine→spawn while its publication is current and refuses stale or foreign argv', async () => {
  const owner = await mount(), ctx = owner.ctx
  await owner.registry.add(fixture.workspace, { path: fixture.outside })
  const specs: unknown[] = []
  ctx.provide('subprocess', { spawn: (spec: unknown) => { specs.push(spec); return { pid: 1 } }, spawnTerminal: async () => ({ pid: 2 }) } as never)
  await ctx.plugin(ProcessFence)
  const mint = async () => (await ctx.sandbox.confine(['bash', '-c', 'true'], policy())).argv
  // A foreign consumer composes confine→spawn outside every wrapped entry, as
  // the forge panel's Git inspection does.
  const launched = await mint()
  expect(ctx.subprocess.spawn({ argv: [...launched], cwd: fixture.workspace })).toMatchObject({ pid: 1 })
  expect(specs.at(-1)).toMatchObject({ argv: launched })
  // A ledger profile is not owned by an operation frame either way: launching
  // it inside an unrelated live admission is the same publication-keyed act.
  await owner.registry.withOperation(policy(), 'process', () => ctx.subprocess.spawn({ argv: [...launched], cwd: fixture.workspace }))
  // A republish supersedes the mint's authorization basis.
  const stale = await mint()
  await owner.registry.setAccess(fixture.workspace, { kind: 'path', path: fixture.outside }, 'read-only')
  expect(() => ctx.subprocess.spawn({ argv: [...stale], cwd: fixture.workspace })).toThrow('live admission')
  // Re-minting under the current publication launches again.
  const fresh = await mint()
  expect(ctx.subprocess.spawn({ argv: [...fresh], cwd: fixture.workspace })).toMatchObject({ pid: 1 })
  // An argv this host never minted is still refused outright.
  expect(() => ctx.subprocess.spawn({ argv: ['sandbox-exec', '-p', '(version 1)', '--', 'true'], cwd: fixture.workspace })).toThrow('live admission')
})

nativeTest('stamps a mint at dispatch, so a publication landing mid-probe keeps it refused', async () => {
  const owner = await mount(), ctx = owner.ctx
  await owner.registry.add(fixture.workspace, { path: fixture.outside })
  ctx.provide('subprocess', { spawn: () => ({ pid: 1 }), spawnTerminal: async () => ({ pid: 2 }) } as never)
  await ctx.plugin(ProcessFence)
  // Hold the upstream probe: the mint resolves its authorization snapshot at
  // dispatch, then a real publication lands before the probe completes.
  const originalConfine = LocalSandboxProvider.prototype.confine
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  vi.spyOn(LocalSandboxProvider.prototype, 'confine')
    .mockImplementation(function (this: LocalSandboxProvider, ...args) {
      return held.then(() => originalConfine.apply(this, args))
    })
  try {
    const pending = ctx.sandbox.confine(['bash', '-c', 'true'], policy())
    await owner.registry.setAccess(fixture.workspace, { kind: 'path', path: fixture.outside }, 'read-only')
    release()
    const minted = (await pending).argv
    expect(() => ctx.subprocess.spawn({ argv: [...minted], cwd: fixture.workspace })).toThrow('live admission')
    // A mint issued under the current publication launches again.
    const fresh = (await ctx.sandbox.confine(['bash', '-c', 'true'], policy())).argv
    expect(ctx.subprocess.spawn({ argv: [...fresh], cwd: fixture.workspace })).toMatchObject({ pid: 1 })
  } finally { release() }
})

nativeTest('drops a mint that outlived its admission instead of demoting it into the ledger', async () => {
  const owner = await mount(), ctx = owner.ctx
  await owner.registry.add(fixture.workspace, { path: fixture.outside })
  ctx.provide('subprocess', { spawn: () => ({ pid: 1 }), spawnTerminal: async () => ({ pid: 2 }) } as never)
  await ctx.plugin(ProcessFence)
  const originalConfine = LocalSandboxProvider.prototype.confine
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  vi.spyOn(LocalSandboxProvider.prototype, 'confine')
    .mockImplementation(function (this: LocalSandboxProvider, ...args) {
      return held.then(() => originalConfine.apply(this, args))
    })
  let pending!: ReturnType<typeof ctx.sandbox.confine>
  try {
    await owner.registry.withOperation(policy(), 'process', () => {
      // A fire-and-forget mint inside the admission: its probe settles only
      // after the operation's await body has already returned.
      pending = ctx.sandbox.confine(['bash', '-c', 'true'], policy())
    })
    release()
    const minted = (await pending).argv
    // The profile really did graft the operation's writable root — and must
    // still not launch: an expired admission never bequeaths a profile.
    expect(minted.join(' ')).toContain(fixture.outside)
    expect(() => ctx.subprocess.spawn({ argv: [...minted], cwd: fixture.workspace })).toThrow('live admission')
  } finally { release() }
})

nativeTest.skipIf(symlinkUnsupportedReason() !== undefined)('mints an unadmitted profile without member grants, so a member redirect cannot invalidate it', async () => {
  const owner = await mount(), ctx = owner.ctx
  await owner.registry.add(fixture.workspace, { path: fixture.outside })
  ctx.provide('subprocess', { spawn: () => ({ pid: 1 }), spawnTerminal: async () => ({ pid: 2 }) } as never)
  await ctx.plugin(ProcessFence)
  // Unadmitted `resolve` already reports 'unavailable': the mint that follows
  // is the clamped primary-root form and grants `fixture.outside` nothing.
  expect(ctx.multiRootScope.resolve(policy())).toMatchObject({ authority: 'unavailable', additionalRoots: [] })
  const minted = (await ctx.sandbox.confine(['bash', '-c', 'true'], policy())).argv
  // The Seatbelt profile spells its grants literally: the member path never
  // entered it — nothing grafted for the launch to honor after the redirect.
  expect(minted.join(' ')).not.toContain(fixture.outside)
  renameSync(fixture.outside, join(fixture.base, 'saved')); symlinkSync(fixture.workspace, fixture.outside, 'dir')
  expect(ctx.subprocess.spawn({ argv: [...minted], cwd: fixture.workspace })).toMatchObject({ pid: 1 })
})

nativeTest('admits the forge service entries it can reach while leaving generators and unknown entries unadmitted', async () => {
  const owner = await mount(), ctx = owner.ctx
  await owner.registry.add(fixture.workspace, { path: fixture.outside })
  ctx.provide('subprocess', { spawn: () => ({ pid: 1 }), spawnTerminal: async () => ({ pid: 2 }) } as never)
  const id = SessionId('forge-panel-session')
  const session = Session.create(id, [], { id, cwd: fixture.workspace, version: SESSION_FORMAT_VERSION, createdAt: 0, isSeeded: false })
  const mintAndSpawn = async () => ctx.subprocess.spawn({ argv: (await ctx.sandbox.confine(['git', 'status'], policy())).argv, cwd: fixture.workspace })
  ctx.provide('forgePanel', {
    branches: async () => ({ admitted: ctx.multiRootScope.hasAdmission(), spawned: (await mintAndSpawn()) !== undefined }),
    follow: async function* () { yield ctx.multiRootScope.hasAdmission() },
    otherEntry: async () => ctx.multiRootScope.hasAdmission(),
  } as never)
  ctx.provide('worktrees', { create: async () => ({ admitted: ctx.multiRootScope.hasAdmission() }) } as never)
  await ctx.plugin(ProcessFence)
  const panel = ctx.get('forgePanel') as { branches(s: unknown): Promise<{ admitted: boolean; spawned: boolean }>; follow(): AsyncGenerator<boolean>; otherEntry(s: unknown): Promise<boolean> }
  await expect(panel.branches(session)).resolves.toMatchObject({ admitted: true, spawned: true })
  const tree = ctx.get('worktrees') as { create(agent: unknown): Promise<{ admitted: boolean }> }
  await expect(tree.create({ session })).resolves.toMatchObject({ admitted: true })
  // Async generators are not function entries: `follow` is untouched, and the
  // detached inspections it drives rely on the ledger like any background path.
  await expect(panel.follow()[Symbol.asyncIterator]().next()).resolves.toMatchObject({ value: false })
  await expect(panel.otherEntry(session)).resolves.toBe(false)
})

nativeTest('does not reuse a native Skills cache after unnotified revocation, and remains quiet on repeated queries', async () => {
  const owner = await skillsStack(fixture.base, true), follower = await skillsStack(fixture.base, true)
  cleanups.push(owner.dispose, follower.dispose)
  writeSkill(fixture.outside, 'review', 'SHARED SKILL')
  const [row] = await owner.registry.add(fixture.workspace, { path: fixture.outside })
  const agent = follower.agent(fixture.workspace), name = internalSkillName(fixture.workspace, row!.id, 'review')
  expect((await follower.snapshot(agent)).skills.map(skill => skill.name)).toContain(name)
  expect((await follower.ctx.skills.get(name, { cwd: fixture.workspace, scope: agent }))?.content).toContain('SHARED SKILL')
  dropNotifications(owner)
  await owner.registry.setSkillsEnabled(fixture.workspace, { kind: 'path', path: fixture.outside }, false)
  expect(await follower.ctx.skills.get(name, { cwd: fixture.workspace, scope: agent })).toBeUndefined()
  let changes = 0
  const stop = follower.ctx.on('skills/change', () => { changes++ })
  try {
    for (let i = 0; i < 5; i++) expect((await follower.snapshot(agent)).skills).toEqual([])
    expect(changes).toBe(0)
  } finally { stop() }
})

nativeTest.skipIf(symlinkUnsupportedReason() !== undefined)('revalidates LSP/Files after a root is redirected without relying on broadcasts', async () => {
  const owner = await mount(), follower = await mount(), ctx = follower.ctx
  await owner.registry.add(fixture.workspace, { path: fixture.outside })
  const file = join(fixture.outside, 'same.ts'); writeFileSync(file, 'original')
  new WorkspaceFiles(ctx, { maxBytes: 1024, maxFileBytes: 1024, maxLines: 100, maxEntries: 10 })
  await ctx.plugin(FilesRouting)
  await ctx.plugin(Lsp)
  ctx.lsp.registerProvider({ id: LspProviderId('shared-test'), extensionToLanguage: { '.ts': 'typescript' }, query: async request => ({ kind: 'hover', hover: { contents: request.workspaceRoot } }) })
  await ctx.plugin(LspRouting)
  const request = { sessionId: 'test' as never, workspaceRoot: fixture.workspace }, signal = new AbortController().signal
  const query = () => ctx.lsp.query({ filePath: file, workspaceRoot: fixture.workspace, operation: 'hover', position: { line: 0, character: 0 } })
  expect(await query()).toMatchObject({ hover: { contents: fixture.outside } })
  expect((await ctx.workspaceFiles.read(request, file, {}, signal)).text).toBe('original')
  dropNotifications(owner)
  renameSync(fixture.outside, join(fixture.base, 'saved')); symlinkSync(fixture.workspace, fixture.outside, 'dir')
  await expect(ctx.workspaceFiles.read(request, file, {}, signal)).rejects.toMatchObject({ code: 'workspace-file/outside-workspace' })
  expect(await query()).toMatchObject({ hover: { contents: fixture.workspace } })
})

nativeTest('quarantines unknown write results, keeps the lease and known denials, and never grants from the old table', async () => {
  const owner = await mount(), follower = await mount()
  await owner.registry.add(fixture.workspace, { path: fixture.outside, access: 'read-only' })
  await follower.registry.refresh(fixture.workspace)
  const internal = owner.registry as unknown as { table: { put(): Promise<void> } }
  vi.spyOn(internal.table, 'put').mockRejectedValue(Object.assign(new Error('uncertain commit'), { code: 'unknown-state' }))
  await expect(owner.registry.setAlias(fixture.workspace, { kind: 'path', path: fixture.outside }, 'uncertain')).rejects.toThrow('uncertain')
  expect(owner.registry.authority).toMatchObject({ kind: 'storage-failed', recovery: 'quarantine' })
  expect(owner.registry.diagnostics).toMatchObject({ recoveryClass: 'quarantine', recovery: { phase: 'requires-restart' } })
  expect(owner.scope.snapshot({ ...policy(), mode: 'danger-full-access' }).deniedRoots).toContain(fixture.outside)
  await owner.registry.refresh(fixture.workspace)
  expect(owner.registry.authority).toMatchObject({ kind: 'storage-failed', recovery: 'quarantine' })
  expect(owner.registry.diagnostics).toMatchObject({ recoveryClass: 'quarantine', recovery: { phase: 'requires-restart' } })
  await follower.registry.refresh(fixture.workspace)
  expect(follower.registry.authority.kind).toBe('contended')
  expect(follower.registry.granted(fixture.workspace)).toEqual([])
  new WorkspaceFiles(follower.ctx, { maxBytes: 1024, maxFileBytes: 1024, maxLines: 100, maxEntries: 10 })
  await follower.ctx.plugin(FilesRouting)
  // Even paths unknown to the cached registry cannot turn unavailable into ambient read authority.
  await expect(follower.ctx.workspaceFiles.stat({ sessionId: 's' as never, workspaceRoot: fixture.workspace }, join(fixture.base, 'unknown'), new AbortController().signal)).rejects.toMatchObject({ code: 'workspace-file/outside-workspace' })
})

nativeTest('withdraws delivered instructions on the next pre-step after unnotified removal', async () => {
  const Instructions = await import('../src/instructions.ts')
  const owner = await skillsStack(fixture.base, true), follower = await skillsStack(fixture.base, true)
  cleanups.push(owner.dispose, follower.dispose)
  await follower.ctx.plugin(SandboxPolicyService, policy())
  await follower.ctx.plugin(Instructions)
  writeFileSync(join(fixture.outside, 'AGENTS.md'), 'SHARED INSTRUCTION BODY')
  await owner.registry.add(fixture.workspace, { path: fixture.outside })
  const agent = follower.agent(fixture.workspace)
  const first = await follower.preStep(agent)
  expect(JSON.stringify(first)).toContain('SHARED INSTRUCTION BODY')
  dropNotifications(owner)
  await owner.registry.removeAt(fixture.workspace, { kind: 'path', path: fixture.outside })
  const revoked = JSON.stringify(await follower.preStep(agent))
  expect(revoked).toContain('no longer an additional root')
  expect(revoked).not.toContain('SHARED INSTRUCTION BODY')
})

nativeTest('cancels an idle additional-root Files stream when its authority connection is lost', async () => {
  const owner = await mount(), follower = await mount(), ctx = follower.ctx
  await owner.registry.add(fixture.workspace, { path: fixture.outside })
  const raw = new WorkspaceFiles(ctx, { maxBytes: 1024, maxFileBytes: 1024, maxLines: 100, maxEntries: 10 })
  // Only releases with path-watch support expose this consumer seam.
  if (raw.changes.length < 3) return
  Object.defineProperty(raw, 'changes', { configurable: true, writable: true, value: async function*(_request: unknown, _path: string, signal: AbortSignal) {
    yield { kind: 'ready' }
    signal.throwIfAborted()
    await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  } })
  await ctx.plugin(FilesRouting)
  const iterator = ctx.workspaceFiles.changes({ sessionId: 'stream' as never, workspaceRoot: fixture.workspace }, fixture.outside, new AbortController().signal)[Symbol.asyncIterator]()
  expect(await iterator.next()).toMatchObject({ value: { kind: 'ready' } })
  const pending = iterator.next()
  await owner.dispose()
  await expect(pending).rejects.toThrow('revoked')
})

nativeTest.each([true, false])('bounds native Skills requery feedback with a shared-mode waiter (holder supports IPC: %s)', async sharedOwner => {
  const owner = await skillsStack(fixture.base, sharedOwner), follower = await skillsStack(fixture.base, true)
  cleanups.push(owner.dispose, follower.dispose)
  writeSkill(fixture.outside, 'review', 'RECOVERED SKILL')
  await owner.registry.add(fixture.workspace, { path: fixture.outside })
  const agent = follower.agent(fixture.workspace)
  let queries = 0, changes = 0
  const pending = new Set<Promise<unknown>>(), errors: unknown[] = []
  const query = () => {
    if (++queries > 20) return
    const task = follower.snapshot(agent).catch(error => { errors.push(error) })
    pending.add(task); void task.finally(() => pending.delete(task))
  }
  const settle = async () => { while (pending.size) await Promise.all([...pending]); expect(errors).toEqual([]); expect(queries).toBeLessThan(20) }
  const stop = follower.ctx.on('skills/change', () => { changes++; query() })
  try {
    query(); await settle()
    const stable = changes
    for (let i = 0; i < 3; i++) { query(); await settle() }
    expect(changes).toBe(stable)
    // skillsStack(shared=false) is shared too since the legacy mode was
    // removed — either way the second mount is a follower.
    expect(follower.registry.authority.kind).toBe('follower')
    await owner.dispose()
    await follower.registry.refresh(fixture.workspace); await settle()
    expect(follower.registry.authority.kind).toBe('active')
    expect((await follower.snapshot(agent)).skills).toHaveLength(1)
    const recovered = changes
    query(); await settle(); expect(changes).toBe(recovered)
  } finally { stop() }
})
