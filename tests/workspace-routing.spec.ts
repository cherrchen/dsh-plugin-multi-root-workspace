import { mkdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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
  writeFileSync(join(fixture.workspace, 'same.ts'), 'primary')
  writeFileSync(join(fixture.outside, 'same.ts'), 'additional')
  ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [{ id: 'extra', path: fixture.outside, recordedPath: canonicalPath(fixture.outside) }])
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
})
