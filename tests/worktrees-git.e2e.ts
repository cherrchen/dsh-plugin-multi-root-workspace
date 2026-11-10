/**
 * Phase P10: a REAL restricted-shell Git journey for the A authorization.
 *
 * Each case builds a linked checkout as the live session primary — once in the
 * worktree plugin's default pool (`.agents/worktrees/<id>` inside the main
 * checkout) and once as an external checkout — then drives the REAL discovery
 * and confirmation path: the host offers the shared common git dir, the
 * operator confirms it, and only then does the same `workspace-write` session
 * stage and commit without a Full-access escalation.
 *
 * The kernel runner is required per dialect exactly like the existing sandbox
 * matrix: a host whose outer sandbox refuses nesting skips with the runner's
 * message, while a probe-verified dialect fails the run if it cannot execute.
 *
 * @module tests/worktrees-git.e2e
 */

import { afterEach, describe, expect, it } from 'vitest'
import { accessSync, constants, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { delimiter, isAbsolute, join } from 'node:path'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import type { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import type { Context } from '@deepseek-ai/cordis'
import { mountRegistryStack, type RegistryStack } from './support/registry-stack.ts'
import { createFixtureWorkspace, type FixtureWorkspace } from './support/temp-workspace.ts'
import { confineForTest } from './support/confine.ts'
import { parseConfined, runConfined, type ConfinedOutcome, type ParsedDialect } from './support/dialect-grants.ts'
import { kernelRunnerRequired, requireKernelRunner } from './support/kernel-runner.ts'
import MultiRootWorktrees from '../src/worktrees.ts'
import type { WorktreePromptWaitResult } from '../src/worktrees/types.ts'
import { resolveRepo } from '../src/worktrees/repository.ts'

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync(gitBinary(), args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error('git ' + args.join(' ') + ' failed in ' + cwd + ': ' + result.stderr)
  return result.stdout
}

function initRepo(path: string): void {
  mkdirSync(path, { recursive: true })
  git(path, ['init', '-q', '-b', 'main'])
  git(path, ['config', 'user.email', 'fixture@example.invalid'])
  git(path, ['config', 'user.name', 'Fixture'])
  writeFileSync(join(path, 'README.md'), 'fixture\n')
  git(path, ['add', 'README.md'])
  git(path, ['commit', '-q', '-m', 'initial'])
}

let gitExecutable: string | undefined
function gitBinary(): string {
  if (gitExecutable !== undefined) return gitExecutable
  const name = process.platform === 'win32' ? 'git.exe' : 'git'
  for (const entry of (process.env.PATH ?? '').split(delimiter)) {
    const directory = entry.replace(/^"(.*)"$/, '$1')
    if (!isAbsolute(directory)) continue
    const path = join(directory, name)
    try {
      accessSync(path, constants.X_OK)
      return gitExecutable = realpathSync.native(path)
    } catch { /* Try the next PATH entry. */ }
  }
  throw new Error(`${name} was not found on PATH`)
}

function unavailableRunner(dialect: ParsedDialect | undefined, detail: string): string {
  if (dialect !== undefined && dialect !== 'unknown') return requireKernelRunner(dialect, detail)
  // If confine failed before returning argv, it has not told us which
  // dialect it picked. Never skip on a host with a verified local runner.
  const local = process.platform === 'linux' ? ['bwrap', 'landlock']
    : [process.platform === 'win32' ? 'windows-acl' : 'seatbelt']
  return requireKernelRunner(local.find(kernelRunnerRequired) ?? local[0]!, detail)
}

function writeProbe(path: string): string[] {
  const code = `
    try {
      require('node:fs').writeFileSync(process.argv[1], 'probe')
      console.log('allowed')
    } catch (error) {
      if (!['EACCES', 'EPERM', 'EROFS'].includes(error.code)) throw error
      console.log('denied')
    }
  `
  return [process.execPath, '-e', code, path]
}

function promptOf(result: WorktreePromptWaitResult) {
  expect(result.status, JSON.stringify(result)).toBe('prompt')
  if (result.status !== 'prompt') throw new Error('expected a prompt')
  return result.prompt
}

const fixtures: FixtureWorkspace[] = []
const stacks: RegistryStack[] = []
afterEach(async () => {
  while (stacks.length > 0) await stacks.pop()!.dispose()
  while (fixtures.length > 0) fixtures.pop()!.dispose()
})

interface Journey {
  readonly area: FixtureWorkspace
  readonly main: string
  readonly linked: string
  readonly unrelated: string
}

function journey(label: string, pool: boolean): Journey {
  const area = createFixtureWorkspace(`worktrees-git-${label}`)
  fixtures.push(area)
  const main = join(area.base, 'main')
  const unrelated = join(area.base, 'unrelated')
  // The default-pool layout the worktree plugin creates: the checkout lives
  // inside the main checkout, so the A registration is the only way to cover
  // the shared metadata without granting the whole source tree.
  const linked = pool ? join(main, '.agents', 'worktrees', 'w1') : join(area.base, 'linked')
  initRepo(main)
  git(main, ['worktree', 'add', '-q', linked, '-b', 'feature'])
  mkdirSync(unrelated)
  writeFileSync(join(linked, 'feature.txt'), 'feature\n')
  return { area, main, linked, unrelated }
}

const SESSION = 'session-git'

interface OpenJourney extends Journey {
  readonly common: string
  readonly stack: RegistryStack
  readonly worktrees: MultiRootWorktrees
  readonly admitted: (argv: readonly string[]) => Promise<ConfinedOutcome>
  readonly selected: () => ParsedDialect | undefined
}

/** Mount the production discovery row over the real Registry + sandbox stack. */
async function openJourney(label: string, pool: boolean): Promise<OpenJourney> {
  const { area, main, linked, unrelated } = journey(label, pool)
  const common = join(main, '.git')
  let provider: Pick<LocalSandboxProvider, 'confine'> | undefined
  const stack = await mountRegistryStack(join(area.base, 'store'), {}, {
    beforeGate: async (ctx: Context) => {
      // The live session shape the panel and the worktree row read.
      ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'workspace-write', workspaceRoot: linked }) } as never)
      ctx.provide('sessions', { get: (id: string) => id === SESSION ? { header: { cwd: linked } } : undefined } as never)
      const { MultiRootSandboxProvider } = await import('../src/sandbox.ts')
      await ctx.plugin(MultiRootSandboxProvider)
      provider = ctx.sandbox
    },
  })
  stacks.push(stack)
  await stack.ctx.plugin(MultiRootWorktrees, { enabled: true, waitTimeoutMs: 200 })
  const worktrees = stack.ctx.multiRootWorktrees
  if (provider === undefined) throw new Error('the sandbox provider was not mounted')
  const policy = { mode: 'workspace-write', workspaceRoot: linked } as SandboxPolicy
  let selected: ParsedDialect | undefined
  const admitted = async (argv: readonly string[]): Promise<ConfinedOutcome> =>
    await stack.registry.withOperation(policy, 'process', async () => {
      const confined = await confineForTest(provider!, argv, policy)
      if ('kind' in confined) return confined
      selected = parseConfined(confined.argv, argv).dialect
      return runConfined(confined, linked)
    })
  return { area, main, linked, unrelated, common, stack, worktrees, admitted, selected: () => selected }
}

describe('restricted Git journey with the main-checkout A root', () => {
  it('fails before A and commits after it, and now permits the main source tree', async (context) => {
    const { main, linked, unrelated, stack, worktrees, admitted, selected } = await openJourney('external', false)
    const probe = await admitted(writeProbe(join(linked, 'probe.txt')))
    if (probe.kind !== 'ok') return context.skip(unavailableRunner(selected(), probe.detail))
    expect(selected()).not.toBe('unknown')
    expect(probe.stdout.trim()).toBe('allowed')
    expect(await admitted(writeProbe(join(unrelated, 'probe.txt')))).toMatchObject({ kind: 'ok', stdout: expect.stringMatching(/^denied\r?\n$/) })

    const gitPath = gitBinary()
    const repo = resolveRepo(linked)
    if (!repo.ok) throw new Error('the fixture is not an active checkout: ' + repo.reason)
    const admin = repo.repo.adminGitdir!
    const indexBefore = readFileSync(join(admin, 'index'))
    const headBefore = git(linked, ['rev-parse', 'HEAD']).trim()

    // 1. Before A: Git cannot write the admin index / shared objects.
    const beforeRun = await admitted([gitPath, '-C', linked, 'add', 'feature.txt'])
    expect(beforeRun.kind).not.toBe('ok')
    expect(readFileSync(join(admin, 'index'))).toEqual(indexBefore)

    // 2. The live session gets the real A prompt for the MAIN CHECKOUT.
    const prompt = promptOf(await worktrees.wait(SESSION))
    expect(prompt.kind).toBe('main-checkout')
    expect(prompt.path).toBe(realpathSync.native(main))
    expect(prompt.effectiveAccess).toBe('read-write')
    const resolved = await worktrees.resolve(SESSION, prompt.id, 'add')
    expect(resolved.viewRevision).toEqual(expect.any(String))
    const rows = stack.registry.list(linked)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ path: realpathSync.native(main), access: 'inherit', state: 'available' })

    // 3. The same workspace-write session can now stage and commit.
    const add = await admitted([gitPath, '-C', linked, 'add', 'feature.txt'])
    expect(add.kind, 'detail' in add ? add.detail : '').toBe('ok')
    const commit = await admitted([gitPath, '-C', linked, 'commit', '-q', '-m', 'feature'])
    expect(commit.kind, 'detail' in commit ? commit.detail : '').toBe('ok')

    // 4. Commit products: the index changed, HEAD moved, and the branch ref in
    // the SHARED common names the new commit.
    expect(readFileSync(join(admin, 'index'))).not.toEqual(indexBefore)
    const headAfter = git(linked, ['rev-parse', 'HEAD']).trim()
    expect(headAfter).not.toBe(headBefore)
    expect(git(main, ['rev-parse', 'feature']).trim()).toBe(headAfter)
    expect(git(linked, ['ls-files']).split('\n')).toContain('feature.txt')

    // 5. The main checkout's SOURCE tree is now INSIDE the grant: this is the
    // deliberate scope change of the main-checkout A target.
    const sourceWrite = await admitted(writeProbe(join(main, 'outside.txt')))
    expect(sourceWrite).toMatchObject({ kind: 'ok', stdout: expect.stringMatching(/^allowed\r?\n$/) })
    expect(readFileSync(join(main, 'outside.txt'), 'utf8')).toBe('probe')

    // 6. An unrelated directory stays refused.
    const unrelatedWrite = await admitted(writeProbe(join(unrelated, 'x.txt')))
    expect(unrelatedWrite).toMatchObject({ kind: 'ok', stdout: expect.stringMatching(/^denied\r?\n$/) })

    // 7. After the ordinary Remove, a NEW confined attempt cannot write the
    // common again: the grant really is the registration, not a cache.
    await stack.registry.removeAt(linked, { kind: 'id', id: rows[0]!.id })
    writeFileSync(join(linked, 'again.txt'), 'again\n')
    const afterRemoval = await admitted([gitPath, '-C', linked, 'add', 'again.txt'])
    expect(afterRemoval.kind).not.toBe('ok')
    expect(stack.registry.list(linked)).toHaveLength(0)
  })

  it('does not offer A for a default-pool checkout, so Git writes stay refused', async (context) => {
    const { linked, stack, worktrees, admitted, selected } = await openJourney('pool', true)
    const probe = await admitted(writeProbe(join(linked, 'probe.txt')))
    if (probe.kind !== 'ok') return context.skip(unavailableRunner(selected(), probe.detail))
    expect(selected()).not.toBe('unknown')

    // `<main>` contains the pool primary, so the Registry refuses it as
    // `primary-overlap` and no A prompt is produced.
    expect((await worktrees.wait(SESSION)).status).toBe('timeout')
    expect(stack.registry.list(linked)).toHaveLength(0)

    writeFileSync(join(linked, 'feature.txt'), 'feature\n')
    const add = await admitted([gitBinary(), '-C', linked, 'add', 'feature.txt'])
    expect(add.kind).not.toBe('ok')
  })
})
