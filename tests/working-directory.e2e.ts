import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import Policy from '@deepseek-ai/dsh-sandbox-policy'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import { MultiRootFileSystem } from '../src/fs.ts'
import { effectiveDirectory } from '../src/compat/session-directory.ts'
import { mountRegistryStack } from './support/registry-stack.ts'
import { createFixtureWorkspace, REPO_ROOT } from './support/temp-workspace.ts'
import { runConfined, parseConfined } from './support/dialect-grants.ts'
import { requireKernelRunner } from './support/kernel-runner.ts'
import { loadRuntimeModule, runtimeRequire } from '../scripts/lib/dsh-runtime.mjs'

// Older releases have no workingDirectory. Absence is an explicit skip, while
// an installed service that fails evaluation must fail this file.
async function optionalRuntime(name: string) {
  try { runtimeRequire().resolve(name) } catch (error: any) {
    if (error.code === 'MODULE_NOT_FOUND') return undefined
    throw error
  }
  return await loadRuntimeModule(name)
}
const directoryModule = await optionalRuntime('@deepseek-ai/dsh-working-directory')
const worktreeModule = await optionalRuntime('@deepseek-ai/dsh-experimental-worktree')

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { while (cleanup.length) await cleanup.pop()!() })

async function world() {
  const fixture = createFixtureWorkspace('directory')
  const third = join(fixture.base, 'third'); mkdirSync(third)
  const stack = await mountRegistryStack(join(fixture.base, 'store'))
  cleanup.push(async () => { await stack.dispose(); fixture.dispose() })
  const ctx = stack.ctx
  await ctx.plugin(Sessions)
  await ctx.plugin(Projections)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Policy, { mode: 'workspace-write', workspaceRoot: fixture.workspace })
  await ctx.plugin(MultiRootFileSystem, { cwd: fixture.workspace })
  await ctx.plugin(directoryModule.default)
  const session = ctx.sessions.create(SessionId('directory-owner'), { meta: { cwd: fixture.workspace } })
  const notices: unknown[] = []
  const agent = { ctx, session, inject: (message: unknown) => notices.push(message) } as unknown as Agent
  await stack.registry.add(fixture.workspace, { path: fixture.outside })
  return { fixture, third, stack, ctx, session, agent, notices, wd: ctx.get('workingDirectory' as never) as any }
}

it.runIf(directoryModule !== undefined)('keeps origin grants and registry identity through authorized and unauthorized cwd changes', async () => {
  const { ctx, wd, agent, session, stack, fixture, third } = await world()
  const nested = join(fixture.outside, 'nested'); mkdirSync(nested)
  const other = ctx.sessions.create(SessionId('independent'), { meta: { cwd: fixture.workspace } })
  const policy = () => ctx.sandboxPolicy.resolve({ session })
  for (const cwd of [nested, third, fixture.workspace]) {
    await wd.set(agent, cwd)
    expect(effectiveDirectory(ctx, session)).toBe(canonicalPath(cwd))
    expect(wd.get(other)).toBe(fixture.workspace)
    expect(policy().workspaceRoot).toBe(fixture.workspace)
    expect(ctx.multiRootScope.resolve(policy()).additionalRoots).toEqual([canonicalPath(fixture.outside)])
    const target = await ctx.fs.resolve('relative.txt', { cwd: wd.get(session) })
    if (cwd === third) await expect(ctx.fs.writeText(target, 'bad', undefined, undefined, policy())).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    else await ctx.fs.writeText(target, 'allowed', undefined, undefined, policy())
    expect(stack.registry.list(third)).toEqual([])
  }
  expect(existsSync(join(third, 'relative.txt'))).toBe(false)
  expect(session.header.cwd).toBe(fixture.workspace)
  expect((await stack.registry.refresh(fixture.workspace))).toHaveLength(1)
})

it.runIf(directoryModule !== undefined)('replays effective cwd and recovers a missing directory without moving the grants', async () => {
  const { ctx, wd, agent, fixture, session } = await world()
  const nested = join(fixture.outside, 'nested'); mkdirSync(nested)
  await wd.set(agent, nested)
  const resumed = ctx.sessions.create(SessionId('resumed'), { meta: { cwd: fixture.workspace }, seed: session.snapshotEvents() })
  expect(wd.get(resumed)).toBe(canonicalPath(nested))
  rmSync(nested, { recursive: true })
  await wd.ensure({ ...agent, session: resumed })
  expect(wd.get(resumed)).toBe(fixture.workspace)
  expect(resumed.header.cwd).toBe(fixture.workspace)
  expect(ctx.multiRootScope.resolve(ctx.sandboxPolicy.resolve({ session: resumed })).additionalRoots).toEqual([canonicalPath(fixture.outside)])
})

async function kernel(w: Awaited<ReturnType<typeof world>>, context: any) {
  const { MultiRootSandboxProvider } = await import(pathToFileURL(join(REPO_ROOT, 'lib/sandbox.js')).href)
  await w.ctx.plugin(MultiRootSandboxProvider)
  await w.ctx.plugin(LocalSubprocess)
  const command = [process.execPath, '-e', 'console.log("confined")']
  const wrapped = await w.ctx.sandbox.confine(command, w.ctx.sandboxPolicy.resolve({ session: w.session }) as never)
  const result = runConfined(wrapped, w.fixture.workspace)
  if (result.kind !== 'ok') {
    if (process.platform === 'win32') throw new Error(`Windows ACL runner must execute: ${result.detail}`)
    context.skip(requireKernelRunner(parseConfined(wrapped.argv, command).dialect, result.detail))
    return false
  }
  return true
}

it.runIf(directoryModule !== undefined && worktreeModule !== undefined)('uses the upstream Worktree service in both roots, preserves grants, and rejects an unauthorized repository', async context => {
  const w = await world()
  if (!await kernel(w, context)) return
  await w.ctx.plugin(worktreeModule.default, { gitCommand: process.env.DSH_TEST_GIT_COMMAND ?? 'git' })
  const worktrees = w.ctx.get('worktrees' as never) as any
  for (const root of [w.fixture.workspace, w.fixture.outside, w.third]) {
    execFileSync('git', ['init', '-q', root])
    writeFileSync(join(root, 'tracked.txt'), 'seed')
    execFileSync('git', ['-C', root, 'add', 'tracked.txt'])
    execFileSync('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'seed'])
  }
  for (const [index, root] of [w.fixture.workspace, w.fixture.outside].entries()) {
    await w.wd.set(w.agent, root)
    const created = await worktrees.create(w.agent, { name: `branch-${index}` })
    expect(created.path).toBe(canonicalPath(join(root, '.agents/worktrees', `branch-${index}`)))
    expect(readFileSync(join(created.path, 'tracked.txt'), 'utf8')).toBe('seed')
    expect(readFileSync(join(created.path, '.git'), 'utf8').replaceAll('\\', '/')).toContain(join(root, '.git/worktrees').replaceAll('\\', '/'))
    const policy = w.ctx.sandboxPolicy.resolve({ session: w.session })
    await w.ctx.fs.writeText(await w.ctx.fs.resolve('new.txt', { cwd: w.wd.get(w.session) }), 'ok', undefined, undefined, policy)
    expect(w.ctx.multiRootScope.resolve(policy).additionalRoots).toEqual([canonicalPath(w.fixture.outside)])
    await expect(worktrees.create(w.agent, { name: `branch-${index}` })).rejects.toThrow('already exists')
    expect((await w.stack.registry.refresh(w.fixture.workspace))).toHaveLength(1)
    const control = new AbortController(); control.abort(new Error('canceled'))
    await expect(worktrees.create(w.agent, { name: 'canceled' }, control.signal)).rejects.toThrow('canceled')
    execFileSync('git', ['-C', root, 'worktree', 'remove', '--force', created.path])
    await w.wd.ensure(w.agent)
    expect(w.wd.get(w.session)).toBe(w.fixture.workspace)
  }
  await w.wd.set(w.agent, w.third)
  await expect(worktrees.create(w.agent, { name: 'denied' })).rejects.toThrow('Could not finish worktree')
  expect(existsSync(join(w.third, '.agents/worktrees/denied'))).toBe(false)
  expect((await w.stack.registry.refresh(w.fixture.workspace))).toHaveLength(1)
}, 120000)

it.runIf(directoryModule !== undefined)('pins running process cwd and grants while a later spawn observes removal', async context => {
  const w = await world()
  if (!await kernel(w, context)) return
  const policy = w.ctx.sandboxPolicy.resolve({ session: w.session })
  const code = `const fs=require('fs');console.log(process.cwd());setTimeout(()=>{fs.writeFileSync(${JSON.stringify(join(w.fixture.outside, 'snapshot.txt'))},'old grant');},500)`
  const wrapped = await w.ctx.sandbox.confine([process.execPath, '-e', code], policy as never)
  const child = w.ctx.subprocess.spawn({ argv: wrapped.argv, cwd: w.fixture.workspace, graceMs: 500, stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } } })
  await w.wd.set(w.agent, w.fixture.outside)
  await w.stack.registry.remove(w.fixture.workspace, { kind: 'ordinal', ordinal: 1 })
  expect((await child.done).exitCode).toBe(0)
  expect(child.collected!.stdout!.readFrom(0).text.trim()).toBe(w.fixture.workspace)
  expect(readFileSync(join(w.fixture.outside, 'snapshot.txt'), 'utf8')).toBe('old grant')
  const next = await w.ctx.sandbox.confine([process.execPath, '-e', "try {require('fs').writeFileSync('new-process.txt','bad');process.exit(3)} catch {console.log('denied')}"], policy as never)
  expect(runConfined(next, w.wd.get(w.session))).toEqual({ kind: 'ok', stdout: 'denied\n' })
  expect(existsSync(join(w.fixture.outside, 'new-process.txt'))).toBe(false)
  const target = await w.ctx.fs.resolve('native.txt', { cwd: w.wd.get(w.session) })
  await expect(w.ctx.fs.writeText(target, 'bad', undefined, undefined, policy)).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
}, 30000)

it.runIf(directoryModule !== undefined && process.platform !== 'win32')('leaves a running PTY cwd and grant snapshot intact after a directory change', async context => {
  const w = await world()
  if (!await kernel(w, context)) return
  const policy = w.ctx.sandboxPolicy.resolve({ session: w.session })
  const output = join(w.fixture.outside, 'pty-snapshot.txt')
  const argv = await w.ctx.sandbox.confine(['bash', '-c', `sleep 0.5; printf '%s' "$PWD" > ${JSON.stringify(output)}; exit 23`], policy as never)
  const terminal = await w.ctx.subprocess.spawnTerminal({ argv: argv.argv, cwd: w.fixture.workspace, rows: 24, cols: 80, terminalType: 'xterm-256color', graceMs: 500 })
  terminal.output.resume()
  try {
    await w.wd.set(w.agent, w.fixture.outside)
    await w.stack.registry.remove(w.fixture.workspace, { kind: 'ordinal', ordinal: 1 })
    expect((await terminal.done).exitCode).toBe(23)
    expect(readFileSync(output, 'utf8')).toBe(w.fixture.workspace)
    expect(w.wd.get(w.session)).toBe(canonicalPath(w.fixture.outside))
  } finally { await terminal.terminate() }
}, 30000)

it.runIf(directoryModule !== undefined && worktreeModule !== undefined)('fails when shared Git metadata is outside the existing writable roots', async context => {
  const w = await world()
  if (!await kernel(w, context)) return
  await w.ctx.plugin(worktreeModule.default, { gitCommand: process.env.DSH_TEST_GIT_COMMAND ?? 'git' })
  const metadata = join(w.third, 'gitdir')
  execFileSync('git', ['init', '-q', '--separate-git-dir', metadata, w.fixture.workspace])
  writeFileSync(join(w.fixture.workspace, 'tracked.txt'), 'seed')
  execFileSync('git', ['-C', w.fixture.workspace, 'add', 'tracked.txt'])
  execFileSync('git', ['-C', w.fixture.workspace, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'seed'])
  const before = await w.stack.registry.refresh(w.fixture.workspace)
  await expect((w.ctx.get('worktrees' as never) as any).create(w.agent, { name: 'external-metadata' })).rejects.toThrow('Could not finish worktree')
  expect(await w.stack.registry.refresh(w.fixture.workspace)).toEqual(before)
  expect(w.wd.get(w.session)).toBe(w.fixture.workspace)
  expect(execFileSync('git', ['-C', w.fixture.workspace, 'branch', '--list', 'external-metadata'], { encoding: 'utf8' }).trim()).toBe('')
}, 120000)
