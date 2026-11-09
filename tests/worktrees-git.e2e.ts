/**
 * Phase P10: a REAL restricted-shell Git journey for the A authorization.
 *
 * The fixture's primary root is an external linked worktree. With the primary
 * alone, a confined `workspace-write` shell cannot write the shared common git
 * dir, so `git add` / `git commit` fail. After the operator registers the
 * canonical common (the A root), the SAME confined mode can commit — and the
 * main checkout's source tree and an unrelated directory remain refused.
 *
 * The kernel runner is required per dialect exactly like the existing sandbox
 * matrix: a host whose outer sandbox refuses nesting skips with the runner's
 * message, while a probe-verified dialect fails the run if it cannot execute.
 *
 * @module tests/worktrees-git.e2e
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { mountRegistryStack, type RegistryStack } from './support/registry-stack.ts'
import { createFixtureWorkspace, type FixtureWorkspace } from './support/temp-workspace.ts'
import { confineForTest } from './support/confine.ts'
import { runConfined } from './support/dialect-grants.ts'
import { requireKernelRunner } from './support/kernel-runner.ts'

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error('git ' + args.join(' ') + ' failed: ' + result.stderr)
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

const fixtures: FixtureWorkspace[] = []
const stacks: RegistryStack[] = []
afterEach(async () => {
  while (stacks.length > 0) await stacks.pop()!.dispose()
  while (fixtures.length > 0) fixtures.pop()!.dispose()
})

describe('restricted Git journey with the A root', () => {
  it('fails Git metadata writes before confirmation and commits after it, while the source tree stays refused', async (context) => {
    const area = createFixtureWorkspace('worktrees-git')
    fixtures.push(area)
    const main = join(area.base, 'main')
    const linked = join(area.base, 'linked')
    const unrelated = join(area.base, 'unrelated')
    initRepo(main)
    mkdirSync(unrelated)
    git(main, ['worktree', 'add', '-q', linked, '-b', 'feature'])
    writeFileSync(join(linked, 'feature.txt'), 'feature\n')
    const common = join(main, '.git')

    let provider: { confine: (argv: readonly string[], policy: SandboxPolicy) => unknown } | undefined
    const stack = await mountRegistryStack(join(area.base, 'store'), {}, {
      beforeGate: async ctx => {
        ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'workspace-write', workspaceRoot: linked }) } as never)
        const { MultiRootSandboxProvider } = await import('../src/sandbox.ts')
        await ctx.plugin(MultiRootSandboxProvider)
        provider = ctx.sandbox as unknown as typeof provider
      },
    })
    stacks.push(stack)
    if (provider === undefined) throw new Error('the sandbox provider was not mounted')

    const policy = { mode: 'workspace-write', workspaceRoot: linked } as SandboxPolicy
    const confined = await confineForTest(provider, ['/bin/sh', '-c', 'true'], policy)
    if ('kind' in confined) return context.skip(requireKernelRunner(dialect(), confined.detail))
    // The provider built an argv; executing it is the runner probe. A host whose
    // outer sandbox refuses nesting reports runner-failed here and skips.
    const probe = runConfined(confined, linked)
    if (probe.kind !== 'ok') return context.skip(requireKernelRunner(dialect(), 'detail' in probe ? probe.detail : 'no confined execution'))

    const gitPath = gitBinary()

    // 1. Before A: Git cannot write the admin index / shared objects.
    const before = await confineForTest(provider, [gitPath, '-C', linked, 'add', 'feature.txt'], policy)
    const beforeRun = runConfined(before, linked)
    expect(beforeRun.kind).not.toBe('ok')

    // 2. Grant the canonical common through the ordinary Registry.
    await stack.registry.add(linked, { path: common })

    // 3. The same workspace-write session can now stage and commit.
    const add = runConfined(await confineForTest(provider, [gitPath, '-C', linked, 'add', 'feature.txt'], policy), linked)
    expect(add.kind, 'detail' in add ? add.detail : '').toBe('ok')
    const commit = runConfined(await confineForTest(provider, [gitPath, '-C', linked, 'commit', '-q', '-m', 'feature'], policy), linked)
    expect(commit.kind, 'detail' in commit ? commit.detail : '').toBe('ok')
    // The commit object lives in the shared object database.
    expect(git(linked, ['rev-parse', 'HEAD']).trim().length).toBeGreaterThan(0)

    // 4. The main checkout's SOURCE tree is still outside the grant.
    const sourceWrite = runConfined(await confineForTest(provider, ['/bin/sh', '-c', 'echo nope > "' + join(main, 'outside.txt') + '"'], policy), linked)
    expect(sourceWrite.kind).not.toBe('ok')
    expect(() => readFileSync(join(main, 'outside.txt'))).toThrow()

    // 5. An unrelated directory stays refused.
    const unrelatedWrite = runConfined(await confineForTest(provider, ['/bin/sh', '-c', 'echo nope > "' + join(unrelated, 'x.txt') + '"'], policy), linked)
    expect(unrelatedWrite.kind).not.toBe('ok')
  })
})
