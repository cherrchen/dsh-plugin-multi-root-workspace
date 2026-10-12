import { mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { Lsp, LspProviderId } from '@deepseek-ai/dsh-lsp'
import { WorkspaceFiles } from '@deepseek-ai/dsh-api-workspace-files'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as LspRouting from '../src/lsp.ts'
import * as FilesRouting from '../src/workspace-files.ts'
import { MultiRootScopeService } from '../src/scope.ts'
import { mountCompat } from './support/compat.ts'
import { mountProviderGate } from './support/providers.ts'
import { createFixtureWorkspace, symlinkUnsupportedReason, type FixtureWorkspace } from './support/temp-workspace.ts'
import { adaptPathWatch } from '../src/compat/workspace-files.ts'

let ctx: Context
let fixture: FixtureWorkspace
beforeEach(async () => {
  fixture = createFixtureWorkspace('routing')
  ctx = new Context()
  await ctx.plugin(LocalFileSystem, { cwd: fixture.workspace })
  await ctx.plugin(MultiRootScopeService)
  await mountCompat(ctx)
  // The routing rows inject the provider-conflict gate; the LocalFileSystem
  // above plays this bundle's provider, so the gate brands it.
  await mountProviderGate(ctx)
  writeFileSync(join(fixture.workspace, 'same.ts'), 'primary')
  writeFileSync(join(fixture.outside, 'same.ts'), 'additional')
  ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [{ id: 'extra', path: fixture.outside, recordedPath: canonicalPath(fixture.outside), access: 'read-write' }])
})
afterEach(async () => { await ctx.fiber.dispose(); fixture.dispose() })

async function lsp() {
  await ctx.plugin(Lsp)
  ctx.lsp.registerProvider({ id: LspProviderId('test'), extensionToLanguage: { '.ts': 'typescript' }, query: async request => ({ kind: 'hover', hover: { contents: JSON.stringify(request) } }) })
  const fiber = await ctx.plugin(LspRouting)
  const query = (filePath: string, workspaceRoot = fixture.workspace, signal?: AbortSignal) => ctx.lsp.query({ filePath, workspaceRoot, operation: 'hover', position: { line: 0, character: 0 } }, signal)
  return { fiber, query }
}

describe('public LSP routing', () => {
  it('routes absolute and ../ paths to the additional workspace, leaving relative names primary', async () => {
    const { query } = await lsp()
    for (const path of [join(fixture.outside, 'same.ts'), '../out/same.ts']) {
      const result = await query(path)
      expect(result).toMatchObject({ hover: { contents: expect.stringContaining(`"workspaceRoot":${JSON.stringify(canonicalPath(fixture.outside))}`) } })
      expect(result).toMatchObject({ hover: { contents: expect.stringContaining(`"filePath":${JSON.stringify(join(fixture.outside, 'same.ts'))}`) } })
    }
    expect(await query('same.ts')).toMatchObject({ hover: { contents: expect.stringContaining('"filePath":"same.ts"') } })
  })
  it('does not reuse another primary workspace registration, and withdraws on removal', async () => {
    const { query } = await lsp()
    const foreign = join(fixture.base, 'foreign'); mkdirSync(foreign)
    const path = join(fixture.outside, 'same.ts')
    expect(await query(path, foreign)).toMatchObject({ hover: { contents: expect.stringContaining(`"workspaceRoot":${JSON.stringify(foreign)}`) } })
    ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [])
    expect(await query(path)).toMatchObject({ hover: { contents: expect.stringContaining(`"workspaceRoot":${JSON.stringify(fixture.workspace)}`) } })
  })
  it('restores the actual service method when the row unloads', async () => {
    const { fiber, query } = await lsp()
    await fiber.dispose()
    expect(Object.getOwnPropertyDescriptor(ctx.lsp, 'query')).toBeUndefined()
    expect(await query('../out/same.ts')).toMatchObject({ hover: { contents: expect.stringContaining('"filePath":"../out/same.ts"') } })
  })
  it('forwards cancellation before a routed query starts', async () => {
    const { query } = await lsp()
    const controller = new AbortController(); controller.abort(new Error('canceled'))
    await expect(query('../out/same.ts', fixture.workspace, controller.signal)).rejects.toThrow('canceled')
  })
  it.skipIf(symlinkUnsupportedReason() !== undefined)('withholds a redirected root and follows an internal file alias canonically', async () => {
    const { query } = await lsp()
    symlinkSync(join(fixture.outside, 'same.ts'), join(fixture.workspace, 'link.ts'))
    expect(await query('link.ts')).toMatchObject({ hover: { contents: expect.stringContaining(`"workspaceRoot":${JSON.stringify(canonicalPath(fixture.outside))}`) } })
    renameSync(fixture.outside, join(fixture.base, 'saved'))
    const other = join(fixture.base, 'other'); mkdirSync(other); writeFileSync(join(other, 'same.ts'), '')
    symlinkSync(other, fixture.outside, 'dir')
    expect(await query('../out/same.ts')).toMatchObject({ hover: { contents: expect.stringContaining(`"workspaceRoot":${JSON.stringify(fixture.workspace)}`) } })
  })
})

async function files() {
  const service = new WorkspaceFiles(ctx, { maxBytes: 1024, maxFileBytes: 1024, maxLines: 5000, maxEntries: 1 })
  const fiber = await ctx.plugin(FilesRouting)
  const scope = { sessionId: 's' as never, workspaceRoot: fixture.workspace }
  return { service: ctx.workspaceFiles, fiber, scope, raw: service }
}

/**
 * Decode a `readBytes` payload on whichever shape this matrix version
 * returns: native bytes on current releases, a base64 string on pre-0.2.
 */
function decodeBytes(data: Uint8Array | string): string {
  return typeof data === 'string' ? Buffer.from(data, 'base64').toString() : new TextDecoder().decode(data)
}

/** Whether this version's `changes` is the path-watch signature (3-arity). */
function hasPathWatch(service: WorkspaceFiles): boolean {
  return service.changes.length >= 3
}

describe('workspace-files isolation', () => {
  it('lists each root through the original caps and rejects unrelated directories', async () => {
    const { service, scope } = await files()
    writeFileSync(join(fixture.outside, 'other.txt'), 'another')
    const listing = await service.list(scope, fixture.outside, new AbortController().signal)
    expect(listing.entries).toHaveLength(1); expect(listing.truncated).toBe(true); expect(listing.path).toBe('')
    await expect(service.list(scope, fixture.base, new AbortController().signal)).rejects.toMatchObject({ code: 'workspace-file/outside-workspace' })
    const foreign = join(fixture.base, 'foreign'); mkdirSync(foreign)
    await expect(service.list({ ...scope, workspaceRoot: foreign }, fixture.outside, new AbortController().signal)).rejects.toMatchObject({ code: 'workspace-file/outside-workspace' })
  })
  it('rejects removed roots and restores upstream confinement on unload', async () => {
    const { service, scope, fiber } = await files()
    await service.list(scope, fixture.outside, new AbortController().signal)
    await fiber.dispose()
    expect(Object.getOwnPropertyDescriptor(service, 'list')).toBeUndefined()
    await expect(service.list(scope, fixture.outside, new AbortController().signal)).rejects.toMatchObject({ code: 'workspace-file/outside-workspace' })
  })
  it.skipIf(symlinkUnsupportedReason() !== undefined)('rejects escaping symlinks and redirected roots', async () => {
    const { service, scope } = await files()
    symlinkSync(fixture.base, join(fixture.outside, 'escape'), 'dir')
    await expect(service.list(scope, join(fixture.outside, 'escape'), new AbortController().signal)).rejects.toMatchObject({ code: expect.stringMatching(/^workspace-file\/(outside-workspace|not-directory)$/) })
    renameSync(fixture.outside, join(fixture.base, 'saved')); symlinkSync(fixture.base, fixture.outside, 'dir')
    await expect(service.list(scope, fixture.outside, new AbortController().signal)).rejects.toMatchObject({ code: expect.stringMatching(/^workspace-file\/(outside-workspace|not-directory)$/) })
  })
  it('keeps a legacy session-wide watch unchanged', () => {
    const original = function(_scope: unknown, _signal: AbortSignal) { return [] }
    const service = { changes: original } as unknown as WorkspaceFiles
    const dispose = adaptPathWatch(service, () => { throw new Error('must not adapt session-wide watch') })
    expect(service.changes).toBe(original); dispose(); expect(service.changes).toBe(original)
  })
  it('routes a path watch and interrupts an idle stream when its root is removed', async () => {
    const raw = new WorkspaceFiles(ctx, { maxBytes: 1024, maxFileBytes: 1024, maxLines: 5000, maxEntries: 1 })
    let watchedRoot: string | undefined
    Object.defineProperty(raw, 'changes', { configurable: true, writable: true, value: async function*(request: { workspaceRoot: string }, _path: string, signal: AbortSignal) {
      watchedRoot = request.workspaceRoot
      yield { kind: 'ready' }
      await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    } })
    await ctx.plugin(FilesRouting)
    const stream = ctx.workspaceFiles.changes({ sessionId: 's' as never, workspaceRoot: fixture.workspace }, fixture.outside, new AbortController().signal)[Symbol.asyncIterator]()
    expect(await stream.next()).toMatchObject({ value: { kind: 'ready' } })
    expect(watchedRoot).toBe(canonicalPath(fixture.outside))
    const pending = stream.next()
    await new Promise(resolve => setImmediate(resolve))
    ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [])
    await expect(pending).rejects.toThrow('revoked')
  })

  it('serves reads under a live additional root and refuses them once the grant is withheld', async () => {
    const { service, scope } = await files()
    const file = join(fixture.outside, 'same.ts')
    const signal = () => new AbortController().signal
    // Upstream gives reads no workspace confinement; the routing row lends
    // the live grant so stat/read/readBytes answer like an ordinary file.
    expect((await service.stat(scope, file, signal())).absolutePath).toBe(canonicalPath(file))
    expect((await service.read(scope, file, {}, signal())).text).toBe('additional')
    expect(decodeBytes((await service.readBytes(scope, file, {} as never, signal())).data)).toBe('additional')

    // The record stays registered but the grant is withheld (redirected):
    // the registry still lists the path, the scope no longer grants it, and
    // every read/watch surface must refuse instead of resolving whatever the
    // directory was replaced with.
    let registered: readonly { path: string }[] = [{ path: canonicalPath(fixture.outside) }]
    ctx.provide('multiRootRegistry', { list: () => registered } as never)
    ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [])
    await expect(service.stat(scope, file, signal())).rejects.toMatchObject({ code: 'workspace-file/outside-workspace' })
    await expect(service.read(scope, file, {}, signal())).rejects.toMatchObject({ code: 'workspace-file/outside-workspace' })
    await expect(service.readBytes(scope, file, {} as never, signal())).rejects.toMatchObject({ code: 'workspace-file/outside-workspace' })
    // Only a path-watch signature can refuse a withheld file watch; the
    // legacy session-wide `changes(scope, signal)` has no path to bound.
    if (hasPathWatch(service)) {
      const stream = service.changes(scope, file, signal())[Symbol.asyncIterator]()
      await expect(stream.next()).rejects.toMatchObject({ code: 'workspace-file/outside-workspace' })
    }

    // Once the record is gone entirely the path is an ordinary filesystem
    // path again — upstream's own default read access applies.
    registered = []
    expect((await service.stat(scope, file, signal())).absolutePath).toBe(canonicalPath(file))

    // A path that never registered is untouched by all of this.
    const plain = join(fixture.base, 'plain.txt'); writeFileSync(plain, 'plain')
    ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [{ id: 'extra', path: fixture.outside, recordedPath: canonicalPath(fixture.outside), access: 'read-write' }])
    expect((await service.stat(scope, plain, signal())).absolutePath).toBe(canonicalPath(plain))
  })

  it('bounds the legacy read surface and base-relative targets to the grant', async () => {
    // `readAll`/`readRelated` only exist on pre-0.2 releases — simulate that
    // surface on this version's service so the probe wraps it.
    const raw = new WorkspaceFiles(ctx, { maxBytes: 1024, maxFileBytes: 1024, maxLines: 5000, maxEntries: 1 })
    Object.defineProperty(raw, 'readAll', { configurable: true, writable: true, value: async (_r: unknown, path: string) => ({ data: readFileSync(path) }) })
    Object.defineProperty(raw, 'readRelated', { configurable: true, writable: true, value: async (_r: unknown, path: string, tail: string) => ({ data: readFileSync(join(dirname(path), tail)) }) })
    await ctx.plugin(FilesRouting)
    type LegacySurface = WorkspaceFiles & {
      readAll: (r: unknown, p: string, s: AbortSignal) => Promise<{ data: Buffer }>
      readRelated: (r: unknown, p: string, t: string, s: AbortSignal) => Promise<{ data: Buffer }>
    }
    const service = ctx.workspaceFiles as LegacySurface
    const scope = { sessionId: 's' as never, workspaceRoot: fixture.workspace }
    const file = join(fixture.outside, 'same.ts')
    const primary = join(fixture.workspace, 'same.ts')
    const signal = () => new AbortController().signal

    // Live root: every surface reads like an ordinary file, including a
    // base-relative tail that stays inside the granted root.
    writeFileSync(join(fixture.outside, 'other.txt'), 'another')
    expect((await service.readAll(scope, file, signal())).data.toString()).toBe('additional')
    expect((await service.readRelated(scope, file, 'other.txt', signal())).data.toString()).toBe('another')
    expect(decodeBytes((await service.readBytes(scope, 'same.ts', { baseFile: file } as never, signal())).data)).toBe('additional')

    // Withheld: the direct reads refuse, and so does a base-relative tail
    // that escapes a *granted* base into the dead grant.
    ctx.provide('multiRootRegistry', { list: () => [{ path: canonicalPath(fixture.outside) }] } as never)
    ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [])
    await expect(service.readAll(scope, file, signal())).rejects.toMatchObject({ code: 'workspace-file/outside-workspace' })
    await expect(service.readRelated(scope, file, 'other.txt', signal())).rejects.toMatchObject({ code: 'workspace-file/outside-workspace' })
    await expect(service.readRelated(scope, primary, join('..', 'out', 'same.ts'), signal())).rejects.toMatchObject({ code: 'workspace-file/outside-workspace' })
    await expect(service.readBytes(scope, 'same.ts', { baseFile: file } as never, signal())).rejects.toMatchObject({ code: 'workspace-file/outside-workspace' })
    await expect(service.readBytes(scope, join('..', 'out', 'same.ts'), { baseFile: primary } as never, signal())).rejects.toMatchObject({ code: 'workspace-file/outside-workspace' })
  })

  it('restores the upstream read methods when the row unloads', async () => {
    const { service, scope, fiber } = await files()
    await fiber.dispose()
    expect(Object.getOwnPropertyDescriptor(service, 'stat')).toBeUndefined()
    expect(Object.getOwnPropertyDescriptor(service, 'read')).toBeUndefined()
    expect(Object.getOwnPropertyDescriptor(service, 'readBytes')).toBeUndefined()
    const file = join(fixture.outside, 'same.ts')
    expect((await service.stat(scope, file, new AbortController().signal)).absolutePath).toBe(canonicalPath(file))
  })
})

it('routes concurrent effective cwd queries using each calling session origin, never the cwd as a registry key', async () => {
  const { query } = await lsp()
  const nested = join(fixture.outside, 'nested'); mkdirSync(nested)
  const other = join(fixture.base, 'other'); mkdirSync(other)
  const waterfall = ctx.waterfall.bind(ctx) as any
  const request = (origin: string, file: string) => waterfall('tools/execute', { agent: { session: { header: { cwd: origin } } } }, async () => {
    await new Promise(resolve => setTimeout(resolve, 5))
    return query(file, nested)
  })
  const [first, second] = await Promise.all([request(fixture.workspace, '../same.ts'), request(other, '../same.ts')])
  expect(first).toMatchObject({ hover: { contents: expect.stringContaining(`"workspaceRoot":${JSON.stringify(canonicalPath(fixture.outside))}`) } })
  expect(second).toMatchObject({ hover: { contents: expect.stringContaining(`"workspaceRoot":${JSON.stringify(other)}`) } })
  expect(second).toMatchObject({ hover: { contents: expect.stringContaining(`"filePath":${JSON.stringify(join(fixture.outside, 'same.ts'))}`) } })
})

it('uses the policy fallback for a session without origin metadata instead of authorizing its effective cwd', async () => {
  const { query } = await lsp()
  ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'workspace-write', workspaceRoot: fixture.workspace }) } as never)
  const waterfall = ctx.waterfall.bind(ctx) as any
  const result = await waterfall('tools/execute', { agent: { session: { header: {} } } }, async () => query('same.ts', fixture.outside))
  expect(result).toMatchObject({ hover: { contents: expect.stringContaining(`"workspaceRoot":${JSON.stringify(canonicalPath(fixture.outside))}`) } })
  ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [])
  const removed = await waterfall('tools/execute', { agent: { session: { header: {} } } }, async () => query('same.ts', fixture.outside))
  expect(removed).toMatchObject({ hover: { contents: expect.stringContaining(`"workspaceRoot":${JSON.stringify(fixture.workspace)}`) } })
})
