/** G1 differences are measured against the existing, unmodified local provider. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import Policy from '@deepseek-ai/dsh-sandbox-policy'
import Projections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { MultiRootFileSystem } from '../src/fs.ts'
import { MultiRootScopeService } from '../src/scope.ts'
import { isMultiRootProvider } from '../src/providers.ts'
import { mountCompat } from './support/compat.ts'
import { mountRegistryStack } from './support/registry-stack.ts'
import { createFixtureWorkspace } from './support/temp-workspace.ts'
import { executeTool, installToolExecutor } from './support/tool-executor.ts'
import { LocalOnlyFileSystem, localFilesystemFacade } from './support/local-fs-facade.ts'
import { loadRuntimeModule } from '../scripts/lib/dsh-runtime.mjs'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { vi.restoreAllMocks(); while (cleanup.length) await cleanup.pop()!() })

async function world(facade: boolean, mode: SandboxMode = 'workspace-write', capped = false) {
  const fixture = createFixtureWorkspace('g1-local')
  const ctx = new Context()
  cleanup.push(async () => { try { await ctx.fiber.dispose() } finally { fixture.dispose() } })
  await ctx.plugin(Projections)
  await ctx.plugin(Policy, { mode, workspaceRoot: fixture.workspace })
  await ctx.plugin(MultiRootScopeService, capped ? { toolAccess: { edit: 'read-only' } } : {})
  await mountCompat(ctx)
  await ctx.plugin(facade ? LocalOnlyFileSystem : MultiRootFileSystem, { cwd: fixture.workspace })
  return { ctx, fs: ctx.fs, fixture }
}

it('preserves synchronous targets, metadata, streams, bytes and optional method presence', async () => {
  const record = async (facade: boolean) => {
    const { ctx, fs, fixture } = await world(facade)
    const path = join(fixture.workspace, 'file space.txt')
    writeFileSync(path, 'hello\nworld\n')
    const target = await fs.resolve('file space.txt')
    const parent = await fs.resolve(fixture.workspace)
    expect(typeof fs.processPath(target)).toBe('string')
    expect(fs.fileUrl(target)).toBe(pathToFileURL(fs.processPath(target)).href)
    expect(fs.contains(parent, target)).toBe(true)
    expect(isMultiRootProvider(ctx.get('fs'), 'fs')).toBe(true)
    const chunks: string[] = []
    for await (const chunk of await fs.streamText(target)) chunks.push(chunk)
    const info = await fs.stat(target)
    const optional = ['patchText', 'deleteFile', 'moveFile', 'watch', 'processPathFromHostPath']
      .map(name => [name, typeof Reflect.get(fs, name)])
    return { text: await fs.readText(target), stream: chunks.join(''), type: info?.type, size: info?.size,
      lstat: (await fs.lstat(path))?.type,
      bytes: Buffer.from(await fs.readBytes(target, undefined, 100)).toString('hex'),
      range: Buffer.from(await fs.readByteRange(target, { offset: 6, length: 5 })).toString('hex'),
      children: (await fs.listDir(parent)).map(child => [child.name, child.type, fs.contains(parent, child.target)]), optional }
  }
  expect(await record(true)).toEqual(await record(false))
})

it.each(['read-only', 'workspace-write', 'danger-full-access'] as const)('preserves local-root policy and scope projections in %s', async mode => {
  const record = async (facade: boolean) => {
    const { ctx, fs, fixture } = await world(facade, mode)
    const roots = ['inherit', 'read-only', 'read-write'] as const
    const paths = roots.map(access => join(fixture.outside, access))
    for (const path of paths) mkdirSync(path)
    ctx.multiRootScope.setAdditionalRoots(fixture.workspace, roots.map((access, i) => ({
      id: access, path: paths[i]!, recordedPath: canonicalPath(paths[i]!), access,
    })))
    const results = []
    for (const [i, access] of roots.entries()) {
      const path = join(paths[i]!, 'cell.txt'); writeFileSync(path, 'before')
      let denied = false
      try { await fs.writeText(await fs.resolve(path), 'after') } catch (error) {
        expect(error).toMatchObject({ code: 'FS_SANDBOX_DENIED' }); denied = true
      }
      const writable = access === 'read-write' || (access === 'inherit' && mode !== 'read-only')
      expect(denied).toBe(!writable)
      results.push([access, denied, readFileSync(path, 'utf8')])
    }
    const scope = ctx.multiRootScope.resolve({ mode, workspaceRoot: fixture.workspace })
    return { results, members: scope.additionalRoots.map(path => path.replace(fixture.base, '<fixture>')),
      writable: scope.writableRoots.map(path => path.replace(fixture.base, '<fixture>')) }
  }
  expect(await record(true)).toEqual(await record(false))
})

it('preserves stale-version rejection and create-if-absent without overwriting a sentinel', async () => {
  for (const facade of [false, true]) {
    const { fs, fixture } = await world(facade)
    const path = join(fixture.workspace, 'version.txt')
    writeFileSync(path, 'before')
    const target = await fs.resolve(path); const before = await fs.stat(target)
    writeFileSync(path, 'a longer replacement')
    await expect(fs.writeText(target, 'bad', { kind: 'replaceIfVersion', version: before!.version })).rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
    await expect(fs.writeText(target, 'bad', { kind: 'createIfAbsent' })).rejects.toMatchObject({ code: 'FS_NOT_OBSERVED' })
    expect(readFileSync(path, 'utf8')).toBe('a longer replacement')
  }
})

it('keeps a caller-derived service context instead of binding every call to the backend owner', async () => {
  const backend = { ctx: { marker: 'owner' }, resolve() { return Promise.resolve(this.ctx.marker) } }
  const facade = localFilesystemFacade(backend)
  const caller = Object.create(facade) as typeof backend
  Object.defineProperty(caller, 'ctx', { value: { marker: 'caller' } })
  expect(await facade.resolve()).toBe('owner')
  expect(await caller.resolve()).toBe('caller')
})

it('retains real tool observations, intent callbacks and actor identity', async () => {
  const record = async (facade: boolean) => {
    const { ctx, fixture } = await world(facade)
    await ctx.plugin(SystemPrompt); await ctx.plugin(Tools); await installToolExecutor(ctx)
    ctx.provide('workingDirectory', { ensure: async () => fixture.workspace } as never)
    const toolFs = await loadRuntimeModule('@deepseek-ai/dsh-tool-fs')
    await ctx.plugin(toolFs as never)
    const events: unknown[] = []
    ctx.on('fs/observed', (target, observation, actor) => {
      events.push(['observed', target.displayPath.replace(fixture.base, '<fixture>'), observation.kind, (actor as { callId: string }).callId])
    })
    ctx.on('fs/write-intent', async (_target, actor, next) => { events.push(['write-intent', (actor as { callId: string }).callId]); return await next() })
    ctx.on('fs/edit-intent', async (_target, actor, next) => { events.push(['edit-intent', (actor as { callId: string }).callId]); return await next() })
    const file = join(fixture.workspace, 'observed.txt')
    for (const [name, args] of [
      ['write', { file_path: file, content: 'before' }], ['read', { file_path: file }],
      ['edit', { file_path: file, old_string: 'before', new_string: 'after' }],
    ] as const) {
      const result = await executeTool(ctx, { callId: `g1-${name}`, name, args, signal: new AbortController().signal }) as { isError: boolean }
      expect(result.isError).toBe(false)
    }
    expect(readFileSync(file, 'utf8')).toBe('after')
    expect(events).toContainEqual(['write-intent', 'g1-write'])
    expect(events).toContainEqual(['edit-intent', 'g1-edit'])
    expect(events.some(event => Array.isArray(event) && event[0] === 'observed')).toBe(true)
    return events
  }
  expect(await record(true)).toEqual(await record(false))
})

it('preserves one Registry admission, revocation and disposal through the public service', async () => {
  const fixture = createFixtureWorkspace('g1-registry')
  const stack = await mountRegistryStack(join(fixture.base, 'store'), {}, { beforeGate: async ctx => {
    await ctx.plugin(Projections)
    await ctx.plugin(Policy, { mode: 'workspace-write', workspaceRoot: fixture.workspace })
    await ctx.plugin(LocalOnlyFileSystem, { cwd: fixture.workspace })
  } })
  cleanup.push(async () => { try { await stack.dispose() } finally { fixture.dispose() } })
  await stack.registry.add(fixture.workspace, { path: fixture.outside })
  const admission = vi.spyOn(stack.registry, 'withOperation')
  const path = join(fixture.outside, 'admitted.txt')
  await stack.ctx.fs.writeText(await stack.ctx.fs.resolve(path), 'allowed')
  expect(admission).toHaveBeenCalledTimes(1)
  await stack.registry.setAccess(fixture.workspace, { kind: 'path', path: fixture.outside }, 'read-only')
  await expect(stack.ctx.fs.writeText(await stack.ctx.fs.resolve(path), 'bad')).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
  expect(readFileSync(path, 'utf8')).toBe('allowed')
  await stack.dispose()
  expect(stack.ctx.get('fs')).toBeUndefined()
})

it('keeps dispatch tool caps on additional roots while the primary stays writable', async () => {
  const { ctx, fs, fixture } = await world(true, 'workspace-write', true)
  ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [{ id: 'extra', path: fixture.outside,
    recordedPath: canonicalPath(fixture.outside), access: 'read-write' }])
  const first = join(fixture.outside, 'first.txt'); writeFileSync(first, 'before')
  const dispatch = ctx.waterfall.bind(ctx) as (event: string, exec: object, next: () => Promise<unknown>) => Promise<unknown>
  await dispatch('tools/execute', { name: 'edit', callId: 'g1-cap' }, async () => {
    await expect(fs.editText(await fs.resolve(first), { oldString: 'before', newString: 'bad', replaceAll: false })).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    await fs.writeText(await fs.resolve(join(fixture.workspace, 'primary.txt')), 'allowed')
  })
  expect(readFileSync(first, 'utf8')).toBe('before')
  expect(readFileSync(join(fixture.workspace, 'primary.txt'), 'utf8')).toBe('allowed')
})

it('rejects unknown/stale remote strings, targets and either move endpoint before any local delegation', async () => {
  const io = vi.fn((..._args: unknown[]) => Promise.resolve('local IO must not run'))
  const sync = vi.fn((..._args: unknown[]) => '/local')
  const facade = localFilesystemFacade({ resolve: io, lstat: io, readText: io, stat: io, listDir: io,
    writeText: io, editText: io, patchText: io, deleteFile: io, moveFile: io, readBytes: io, readByteRange: io,
    streamText: io, watch: io, processPath: sync, fileUrl: sync, contains: sync, processPathFromHostPath: sync })
  const stale = { targetKey: 'remote://retired/root/file', displayPath: '/same/local/name' }
  const local = { targetKey: '/local/file', displayPath: '/local/file' }
  await expect(facade.resolve('remote://unknown/root/file')).rejects.toMatchObject({ code: 'G1_REMOTE_REFERENCE_UNAVAILABLE' })
  await expect(facade.resolve('relative', { cwd: 'ssh://unknown/root' })).rejects.toMatchObject({ code: 'G1_REMOTE_REFERENCE_UNAVAILABLE' })
  for (const method of ['lstat', 'readText', 'stat', 'listDir', 'writeText', 'editText', 'patchText', 'deleteFile', 'readBytes', 'readByteRange', 'streamText', 'watch'] as const) {
    await expect(facade[method](stale)).rejects.toMatchObject({ code: 'G1_REMOTE_REFERENCE_UNAVAILABLE' })
  }
  await expect(facade.moveFile(local, stale)).rejects.toMatchObject({ code: 'G1_REMOTE_REFERENCE_UNAVAILABLE' })
  await expect(facade.moveFile(stale, local)).rejects.toMatchObject({ code: 'G1_REMOTE_REFERENCE_UNAVAILABLE' })
  expect(() => facade.processPath(stale)).toThrow('local-only G1')
  expect(() => facade.fileUrl(stale)).toThrow('local-only G1')
  expect(() => facade.contains(local, stale)).toThrow('local-only G1')
  expect(() => facade.processPathFromHostPath('sftp://unknown/root')).toThrow('local-only G1')
  expect(io).not.toHaveBeenCalled(); expect(sync).not.toHaveBeenCalled()
})

it('rejects remote references even through traced ctx.fs with a same-name local sentinel', async () => {
  const resolve = vi.spyOn(MultiRootFileSystem.prototype, 'resolve')
  const read = vi.spyOn(MultiRootFileSystem.prototype, 'readText')
  const { ctx, fixture } = await world(true)
  const sentinel = join(fixture.workspace, 'same-name.txt')
  writeFileSync(sentinel, 'local sentinel')
  const remote = 'remote://retired/root/same-name.txt'
  const error = { code: 'G1_REMOTE_REFERENCE_UNAVAILABLE' }
  await expect(ctx.fs.resolve(remote)).rejects.toMatchObject(error)
  await expect(ctx.fs.readText({ targetKey: remote, displayPath: sentinel } as FsTarget)).rejects.toMatchObject(error)
  expect(resolve).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled()
  expect(readFileSync(sentinel, 'utf8')).toBe('local sentinel')
})
