import { mkdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { WorkspaceFiles } from '@deepseek-ai/dsh-api-workspace-files'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { browseRoot } from '../src/panel-files.ts'
import type { PanelCall } from '../src/contract.ts'
import { mountRegistryStack, type RegistryStack } from './support/registry-stack.ts'
import { createFixtureWorkspace, symlinkUnsupportedReason, type FixtureWorkspace } from './support/temp-workspace.ts'

let fixture: FixtureWorkspace
let stack: RegistryStack
let request: PanelCall
const signal = () => new AbortController().signal
beforeEach(async () => {
  fixture = createFixtureWorkspace('panel-files')
  stack = await mountRegistryStack(join(fixture.base, 'store'))
  await stack.ctx.plugin(LocalFileSystem, { cwd: fixture.workspace })
  new WorkspaceFiles(stack.ctx, { maxBytes: 1024, maxFileBytes: 1024, maxLines: 5000, maxEntries: 2 })
  await stack.registry.add(fixture.workspace, { path: fixture.outside })
  const root = (await stack.registry.refresh(fixture.workspace))[0]!
  request = { sessionId: 's', endpoint: 'files', entry: { ordinal: 1, id: root.id, path: root.path, addedAt: root.addedAt }, path: '.' }
  writeFileSync(join(fixture.outside, 'file.txt'), 'hello')
})
afterEach(async () => { await stack.dispose(); fixture.dispose() })

it('lists additional directories and previews text through the original workspace-files caps', async () => {
  expect(await browseRoot(stack.ctx, fixture.workspace, request, signal())).toMatchObject({ entries: [{ name: 'file.txt', type: 'file' }], truncated: false })
  expect(await browseRoot(stack.ctx, fixture.workspace, { ...request, endpoint: 'readFile', path: 'file.txt' }, signal())).toEqual({ text: 'hello', eof: true })
  writeFileSync(join(fixture.outside, 'huge.txt'), 'x'.repeat(2000))
  await expect(browseRoot(stack.ctx, fixture.workspace, { ...request, endpoint: 'readFile', path: 'huge.txt' }, signal())).rejects.toMatchObject({ code: 'workspace-file/too-large' })
})
it('rejects absolute paths, traversal, foreign primary roots, and forged entry snapshots', async () => {
  for (const path of [fixture.base, '../ws', '../', 'file://outside', 'C:\\outside', '\0']) {
    await expect(browseRoot(stack.ctx, fixture.workspace, { ...request, path }, signal())).rejects.toBeDefined()
  }
  await expect(browseRoot(stack.ctx, fixture.outside, request, signal())).rejects.toBeDefined()
  await expect(browseRoot(stack.ctx, fixture.workspace, { ...request, entry: { ...request.entry!, path: fixture.workspace } }, signal())).rejects.toBeDefined()
})
it('rejects a root after removal', async () => {
  await stack.registry.removeAt(fixture.workspace, { kind: 'entry', ...request.entry! })
  await expect(browseRoot(stack.ctx, fixture.workspace, request, signal())).rejects.toBeDefined()
})
it.skipIf(symlinkUnsupportedReason() !== undefined)('rejects symlink escapes and never follows a redirected registration', async () => {
  symlinkSync(fixture.workspace, join(fixture.outside, 'escape'), 'dir')
  await expect(browseRoot(stack.ctx, fixture.workspace, { ...request, path: 'escape' }, signal())).rejects.toBeDefined()
  renameSync(fixture.outside, join(fixture.base, 'saved'))
  const replacement = join(fixture.base, 'replacement'); mkdirSync(replacement)
  symlinkSync(replacement, fixture.outside, 'dir')
  await expect(browseRoot(stack.ctx, fixture.workspace, request, signal())).rejects.toBeDefined()
})
it('discards an answer if the root is removed during I/O', async () => {
  const original = stack.ctx.workspaceFiles.list
  stack.ctx.workspaceFiles.list = async function(scope, path, signal) {
    const answer = await original.call(this, scope, path, signal)
    await stack.registry.removeAt(fixture.workspace, { kind: 'entry', ...request.entry! })
    return answer
  }
  await expect(browseRoot(stack.ctx, fixture.workspace, request, signal())).rejects.toBeDefined()
})
