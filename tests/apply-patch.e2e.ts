/** Exercise the released apply_patch tool through the real multi-root provider. */
import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import { afterEach, expect, it } from 'vitest'
import { loadRuntimeModule } from '../scripts/lib/dsh-runtime.mjs'
import { MultiRootFileSystem } from '../src/fs.ts'
import { MultiRootScopeService } from '../src/scope.ts'
import { mountCompat } from './support/compat.ts'
import { executeTool, installToolExecutor } from './support/tool-executor.ts'
import { createFixtureWorkspace } from './support/temp-workspace.ts'

const supportsPatch = typeof Reflect.get(LocalFileSystem.prototype, 'patchText') === 'function'
const toolFs = supportsPatch ? await loadRuntimeModule('@deepseek-ai/dsh-tool-fs') : undefined
const worlds: Array<{ ctx: Context; dispose(): void }> = []
afterEach(async () => { for (const world of worlds.splice(0)) { await world.ctx.fiber.dispose(); world.dispose() } })

async function mount(capped: boolean) {
  const fixture = createFixtureWorkspace('apply-patch')
  const ctx = new Context()
  worlds.push({ ctx, dispose: fixture.dispose })
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: fixture.workspace })
  await ctx.plugin(MultiRootScopeService, capped ? { toolAccess: { apply_patch: 'read-only' } } : {})
  await mountCompat(ctx)
  await ctx.plugin(MultiRootFileSystem, { cwd: fixture.workspace })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await installToolExecutor(ctx)
  ctx.provide('workingDirectory', { ensure: async () => fixture.workspace } as never)
  await ctx.plugin(toolFs as never, { applyPatch: true, read: false, readImage: false, write: false, edit: false } as never)
  ctx.multiRootScope.setAdditionalRoots(fixture.workspace, [
    { id: 'root', path: fixture.outside, recordedPath: canonicalPath(fixture.outside), access: 'read-write' },
  ])
  const call = async (input: string) => await executeTool(ctx, {
    callId: 'real-patch', name: 'apply_patch', args: { input }, signal: new AbortController().signal,
  }) as { isError?: boolean; error?: { info?: { code?: string } } }
  return { fixture, call }
}

it.runIf(supportsPatch)('executes update, delete and move in an additional root through the released tool', async () => {
  const { fixture, call } = await mount(false)
  const edited = join(fixture.outside, 'edited.txt')
  const deleted = join(fixture.outside, 'deleted.txt')
  const source = join(fixture.outside, 'source.txt')
  const moved = join(fixture.outside, 'moved.txt')
  for (const file of [edited, deleted, source]) writeFileSync(file, 'before\n')
  const patch = ['*** Begin Patch', `*** Update File: ${edited}`, '@@', '-before', '+after',
    `*** Delete File: ${deleted}`, `*** Update File: ${source}`, `*** Move to: ${moved}`, '@@', '-before', '+after', '*** End Patch'].join('\n')
  const result = await call(patch)
  expect(result.isError).toBe(false)
  expect(readFileSync(edited, 'utf8')).toBe('after\n')
  expect(existsSync(deleted)).toBe(false)
  expect(existsSync(source)).toBe(false)
  expect(readFileSync(moved, 'utf8')).toBe('after\n')
})

it.runIf(supportsPatch)('refuses the real apply_patch tool when its additional-root writes are capped', async () => {
  const { fixture, call } = await mount(true)
  const path = join(fixture.outside, 'denied.txt')
  writeFileSync(path, 'before\n')
  const result = await call(['*** Begin Patch', `*** Update File: ${path}`, '@@', '-before', '+after', '*** End Patch'].join('\n'))
  expect(result.isError).toBe(true)
  expect(result.error?.info?.code).toBe('FS_SANDBOX_DENIED')
  expect(readFileSync(path, 'utf8')).toBe('before\n')
})
