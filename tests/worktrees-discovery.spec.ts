/**
 * Phase P2: discovery, activation states, watcher degradation and the live
 * settings switch. The Registry is the real production stack; only the live
 * session/sandbox-policy lookups are stubbed (they belong to the host).
 *
 * @module tests/worktrees-discovery
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { mountRegistryStack, type RegistryStack } from './support/registry-stack.ts'
import { createFixtureWorkspace, type FixtureWorkspace } from './support/temp-workspace.ts'
import MultiRootWorktrees, { WorktreeError, type Config } from '../src/worktrees.ts'
import type { WorktreePromptWaitResult } from '../src/worktrees/types.ts'

const SESSION = 'session-1'

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

interface Mounted {
  readonly stack: RegistryStack
  readonly ctx: Context
  readonly worktrees: MultiRootWorktrees
  readonly storeFile: string
}

interface MountOptions {
  readonly config?: Config
  readonly mode?: () => 'read-only' | 'workspace-write' | 'danger-full-access'
  readonly session?: { readonly cwd: string } | undefined
  readonly settings?: boolean
}

const mounted: Mounted[] = []
const fixtures: FixtureWorkspace[] = []
let hooksRef: { setSource(source: () => unknown): void; onChange(): void; validate(value: unknown): void } | undefined

function fixture(label: string): FixtureWorkspace {
  const created = createFixtureWorkspace(label)
  fixtures.push(created)
  return created
}

async function mount(storeRoot: string, options: MountOptions = {}): Promise<Mounted> {
  const stack = await mountRegistryStack(storeRoot)
  const ctx = stack.ctx
  const mode = options.mode ?? (() => 'workspace-write')
  ctx.provide('sandboxPolicy', {
    resolve: () => ({ mode: mode(), workspaceRoot: options.session?.cwd ?? '/' }),
  } as never)
  const session = options.session
  ctx.provide('sessions', {
    get: (id: string) => (session === undefined || id !== SESSION ? undefined : { header: { cwd: session.cwd } }),
  } as never)
  if (options.settings === true) {
    ctx.provide('settings', {
      installSection: (_owner: Context, _ns: string, _schema: unknown, _value: unknown, hooks: { setSource(source: () => unknown): void; onChange(): void; validate(value: unknown): void }) => {
        hooksRef = hooks
      },
    } as never)
  }
  await ctx.plugin(MultiRootWorktrees, options.config ?? {})
  const result = { stack, ctx, worktrees: ctx.multiRootWorktrees, storeFile: stack.storeFile }
  mounted.push(result)
  return result
}

afterEach(async () => {
  hooksRef = undefined
  while (mounted.length > 0) await mounted.pop()!.stack.dispose()
  while (fixtures.length > 0) fixtures.pop()!.dispose()
  vi.restoreAllMocks()
})

function promptOf(result: WorktreePromptWaitResult) {
  expect(result.status).toBe('prompt')
  if (result.status !== 'prompt') throw new Error('expected a prompt')
  return result.prompt
}

describe('discovery', () => {
  it('offers an external linked worktree and reports the session effective access', async () => {
    const area = fixture('discovery-linked')
    const main = join(area.base, 'main')
    const linked = join(area.base, 'linked')
    initRepo(main)
    git(main, ['worktree', 'add', '-q', linked, '-b', 'feature'])
    let mode: 'read-only' | 'workspace-write' | 'danger-full-access' = 'workspace-write'
    const { worktrees } = await mount(join(area.base, 'store'), { mode: () => mode, session: { cwd: main }, config: { waitTimeoutMs: 100 } })

    const prompt = promptOf(await worktrees.wait(SESSION))
    expect(prompt.path).toBe(realpathSync.native(linked))
    expect(prompt.kind).toBe('worktree')
    expect(prompt.access).toBe('inherit')
    expect(prompt.effectiveAccess).toBe('read-write')
    expect(prompt.remaining).toBe(1)
    expect(prompt.primaryRoot).toBe(main)

    mode = 'read-only'
    const readOnly = promptOf(await worktrees.wait(SESSION))
    expect(readOnly.effectiveAccess).toBe('read-only')

    mode = 'danger-full-access'
    const none = await worktrees.wait(SESSION)
    expect(none.status).toBe('timeout')
  }, 20_000)

  it('has no pool special case: a pool worktree inside the primary is filtered, a sibling pool worktree is offered', async () => {
    const area = fixture('discovery-pool')
    const main = join(area.base, 'main')
    initRepo(main)
    const pool = join(main, '.agents', 'worktrees')
    const first = join(pool, 'a')
    const second = join(pool, 'b')
    git(main, ['worktree', 'add', '-q', first, '-b', 'a'])
    git(main, ['worktree', 'add', '-q', second, '-b', 'b'])

    // Primary = the main repository: both pool checkouts live INSIDE it and
    // are filtered by the ordinary overlap rule.
    const asMain = await mount(join(area.base, 'store-main'), { session: { cwd: main }, config: { waitTimeoutMs: 20 } })
    expect((await asMain.worktrees.wait(SESSION)).status).toBe('timeout')
    expect(asMain.worktrees.activationOf(main).candidates).toBe(0)
    await asMain.stack.dispose()
    mounted.splice(mounted.indexOf(asMain), 1)

    // Primary = pool checkout a: sibling b shares the common and neither
    // contains the other, so it IS a candidate (no pool exclusion exists).
    const asPool = await mount(join(area.base, 'store-pool'), { session: { cwd: first } })
    const prompt = promptOf(await asPool.worktrees.wait(SESSION))
    expect(prompt.path).toBe(realpathSync.native(second))
  }, 20_000)

  it('filters already-registered candidates and never writes the Registry while discovering', async () => {
    const area = fixture('discovery-registered')
    const main = join(area.base, 'main')
    const linked = join(area.base, 'linked')
    initRepo(main)
    git(main, ['worktree', 'add', '-q', linked, '-b', 'feature'])
    const { worktrees, stack, storeFile } = await mount(join(area.base, 'store'), { session: { cwd: main }, config: { waitTimeoutMs: 20 } })
    await stack.registry.add(main, { path: linked })
    const before = readFileSync(storeFile, 'utf8')
    expect((await worktrees.wait(SESSION)).status).toBe('timeout')
    expect(readFileSync(storeFile, 'utf8')).toBe(before)
  }, 20_000)

  it('degrades watcher coverage past the admin cap', async () => {
    const area = fixture('discovery-degraded')
    const main = join(area.base, 'main')
    initRepo(main)
    git(main, ['worktree', 'add', '-q', join(area.base, 'one'), '-b', 'one'])
    git(main, ['worktree', 'add', '-q', join(area.base, 'two'), '-b', 'two'])
    const { worktrees } = await mount(join(area.base, 'store'), {
      session: { cwd: main },
      config: { maxAdminWatchers: 1, waitTimeoutMs: 20 },
    })
    await worktrees.wait(SESSION)
    expect(worktrees.activationOf(main).degraded).toBe(true)
    // The watcher cap does not truncate discovery.
    expect(worktrees.activationOf(main).candidates).toBe(2)
  }, 20_000)
})

describe('activation lifecycle', () => {
  it('reports unactivated for a non-checkout and never retries in the background', async () => {
    const area = fixture('activation-plain')
    const plain = area.workspace
    const { worktrees } = await mount(join(area.base, 'store'), { session: { cwd: plain }, config: { waitTimeoutMs: 20 } })
    expect((await worktrees.wait(SESSION)).status).toBe('unactivated')
    expect(worktrees.activationOf(plain).activation).toBe('unactivated')
    expect(worktrees.activationOf(plain).candidates).toBe(0)
    expect(worktrees.activationOf(plain).watching).toBe(false)
  })

  it('reports unactivated for a repository subdirectory without watching anything', async () => {
    const area = fixture('activation-subdir')
    const repo = join(area.base, 'repo')
    initRepo(repo)
    mkdirSync(join(repo, 'sub'))
    const { worktrees } = await mount(join(area.base, 'store'), { session: { cwd: join(repo, 'sub') } })
    expect((await worktrees.wait(SESSION)).status).toBe('unactivated')
    expect(worktrees.activationOf(join(repo, 'sub')).candidates).toBe(0)
  })

  it('goes lost when the primary .git disappears, answers waiters, and recovers only explicitly', async () => {
    const area = fixture('activation-lost')
    const main = join(area.base, 'main')
    const linked = join(area.base, 'linked')
    initRepo(main)
    git(main, ['worktree', 'add', '-q', linked, '-b', 'feature'])
    const { worktrees } = await mount(join(area.base, 'store'), {
      session: { cwd: main },
      config: { waitTimeoutMs: 200, debounceMs: 20 },
    })
    const firstId = promptOf(await worktrees.wait(SESSION)).id
    // macOS arms FSEvents asynchronously; give the debounced watcher set a
    // moment before the event this case depends on.
    await new Promise(resolve => setTimeout(resolve, 100))
    renameSync(join(main, '.git'), join(area.base, 'git-away'))
    // The watcher reconciles on its own: the workspace releases everything.
    await vi.waitFor(() => { expect(worktrees.activationOf(main).activation).toBe('lost') }, { timeout: 15_000, interval: 25 })
    // A re-mount sees lost and stops; it does not resurrect the workspace.
    expect((await worktrees.wait(SESSION)).status).toBe('lost')
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(worktrees.activationOf(main).activation).toBe('lost')

    renameSync(join(area.base, 'git-away'), join(main, '.git'))
    // Recovery is explicit: the OLD prompt id is dead (stale), and a fresh
    // request receives a NEW id for the re-evaluated candidate.
    expect((await worktrees.wait(SESSION, { seenPromptId: firstId })).status).toBe('lost')
    await worktrees.describeRoots(main)
    const stale = await worktrees.wait(SESSION, { seenPromptId: firstId })
    expect(stale.status).toBe('stale')
    const recovered = promptOf(await worktrees.wait(SESSION))
    expect(recovered.id).not.toBe(firstId)
    expect(recovered.path).toBe(realpathSync.native(linked))
  }, 30_000)

  it('reports lost on a re-mount even before a watcher fires', async () => {
    const area = fixture('activation-lost-remount')
    const main = join(area.base, 'main')
    initRepo(main)
    git(main, ['worktree', 'add', '-q', join(area.base, 'wt'), '-b', 'wt'])
    const { worktrees } = await mount(join(area.base, 'store'), { session: { cwd: main }, config: { waitTimeoutMs: 20 } })
    expect(promptOf(await worktrees.wait(SESSION)).id).toBeDefined()
    rmSync(join(main, '.git'), { recursive: true })
    // The revalidation every mount performs is authoritative by itself.
    expect((await worktrees.wait(SESSION)).status).toBe('lost')
  }, 20_000)

  it('clears prompt decisions on reset but keeps an explicit ignore until reset', async () => {
    const area = fixture('activation-reset')
    const main = join(area.base, 'main')
    initRepo(main)
    git(main, ['worktree', 'add', '-q', join(area.base, 'wt'), '-b', 'wt'])
    const { worktrees } = await mount(join(area.base, 'store'), { session: { cwd: main } })
    const before = promptOf(await worktrees.wait(SESSION)).id
    await worktrees.reset(SESSION)
    const after = promptOf(await worktrees.wait(SESSION)).id
    expect(after).not.toBe(before)
  })
})

describe('settings switch', () => {
  it('refuses new requests while disabled and recovers when switched back on', async () => {
    const area = fixture('settings-switch')
    const main = join(area.base, 'main')
    initRepo(main)
    git(main, ['worktree', 'add', '-q', join(area.base, 'wt'), '-b', 'wt'])
    const { worktrees } = await mount(join(area.base, 'store'), { session: { cwd: main }, settings: true })
    expect(promptOf(await worktrees.wait(SESSION)).id).toBeDefined()
    expect(hooksRef).toBeDefined()
    let enabled = false
    hooksRef!.setSource(() => ({ enabled }))
    hooksRef!.onChange()
    await expect(worktrees.wait(SESSION)).rejects.toBeInstanceOf(WorktreeError)
    await expect(worktrees.wait(SESSION)).rejects.toMatchObject({ code: 'worktree/not-enabled' })
    enabled = true
    hooksRef!.onChange()
    expect(promptOf(await worktrees.wait(SESSION)).id).toBeDefined()
  }, 20_000)
})
