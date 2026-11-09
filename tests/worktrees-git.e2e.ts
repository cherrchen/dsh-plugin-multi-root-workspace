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
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import type { Context } from '@deepseek-ai/cordis'
import { mountRegistryStack, type RegistryStack } from './support/registry-stack.ts'
import { createFixtureWorkspace, type FixtureWorkspace } from './support/temp-workspace.ts'
import { confineForTest } from './support/confine.ts'
import { runConfined, type ConfinedOutcome } from './support/dialect-grants.ts'
import { requireKernelRunner } from './support/kernel-runner.ts'
import MultiRootWorktrees from '../src/worktrees.ts'
import type { WorktreePromptWaitResult } from '../src/worktrees/types.ts'
import { resolveRepo } from '../src/worktrees/repository.ts'

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
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

function gitBinary(): string {
  const found = spawnSync('which', ['git'], { encoding: 'utf8' })
  const path = found.stdout?.trim()
  return path === undefined || path === '' ? '/usr/bin/git' : path
}

function dialect(): string {
  return process.platform === 'darwin' ? 'seatbelt' : process.platform === 'win32' ? 'windows-acl' : 'landlock'
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
const cases = [
  { label: 'external linked checkout', pool: false },
  { label: 'default pool checkout', pool: true },
]

describe.each(cases)('restricted Git journey with the A root: $label', ({ label, pool }) => {
  it('fails before the A confirmation and commits after it, while the source tree stays refused', async (context) => {
    const { area, main, linked, unrelated } = journey(label.replaceAll(' ', '-'), pool)
    const common = join(main, '.git')
    let provider: { confine: (argv: readonly string[], policy: SandboxPolicy) => unknown } | undefined
    const stack = await mountRegistryStack(join(area.base, 'store'), {}, {
      beforeGate: async (ctx: Context) => {
        // The live session shape the panel and the worktree row read.
        ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'workspace-write', workspaceRoot: linked }) } as never)
        ctx.provide('sessions', { get: (id: string) => id === SESSION ? { header: { cwd: linked } } : undefined } as never)
        const { MultiRootSandboxProvider } = await import('../src/sandbox.ts')
        await ctx.plugin(MultiRootSandboxProvider)
        provider = ctx.sandbox as unknown as typeof provider
      },
    })
    stacks.push(stack)
    // The production discovery row, mounted over the same host services the
    // e2e already proved.
    await stack.ctx.plugin(MultiRootWorktrees, { waitTimeoutMs: 200 })
    const worktrees = stack.ctx.multiRootWorktrees
    if (provider === undefined) throw new Error('the sandbox provider was not mounted')

    const policy = { mode: 'workspace-write', workspaceRoot: linked } as SandboxPolicy
    const admitted = async (argv: readonly string[]): Promise<ConfinedOutcome> =>
      await stack.registry.withOperation(policy, 'process', async () => {
        const confined = await confineForTest(provider!, argv, policy)
        if ('kind' in confined) return confined
        return runConfined(confined, linked)
      })

    const probe = await admitted(['/bin/sh', '-c', 'true'])
    if (probe.kind !== 'ok') return context.skip(requireKernelRunner(dialect(), 'detail' in probe ? probe.detail : 'no confined execution'))

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

    // 2. The live session gets the real A prompt for the canonical common.
    const prompt = promptOf(await worktrees.wait(SESSION))
    expect(prompt.kind).toBe('git-common')
    expect(prompt.path).toBe(realpathSync.native(common))
    expect(prompt.effectiveAccess).toBe('read-write')
    // No B candidate may be confirmed in its place; the operator confirms the
    // common the host actually offered.
    const resolved = await worktrees.resolve(SESSION, prompt.id, 'add')
    expect(resolved.viewRevision).toEqual(expect.any(String))
    const rows = stack.registry.list(linked)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ path: realpathSync.native(common), access: 'inherit', state: 'available' })

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

    // 5. The main checkout's SOURCE tree is still outside the grant.
    const sourceWrite = await admitted(['/bin/sh', '-c', 'echo nope > "' + join(main, 'outside.txt') + '"'])
    expect(sourceWrite.kind).not.toBe('ok')
    expect(() => readFileSync(join(main, 'outside.txt'))).toThrow()

    // 6. An unrelated directory stays refused.
    const unrelatedWrite = await admitted(['/bin/sh', '-c', 'echo nope > "' + join(unrelated, 'x.txt') + '"'])
    expect(unrelatedWrite.kind).not.toBe('ok')

    // 7. After the ordinary Remove, a NEW confined attempt cannot write the
    // common again: the grant really is the registration, not a cache.
    await stack.registry.removeAt(linked, { kind: 'id', id: rows[0]!.id })
    writeFileSync(join(linked, 'again.txt'), 'again\n')
    const afterRemoval = await admitted([gitPath, '-C', linked, 'add', 'again.txt'])
    expect(afterRemoval.kind).not.toBe('ok')
    expect(stack.registry.list(linked)).toHaveLength(0)
  })
})
