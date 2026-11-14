/**
 * Phase P2: discovery, activation states, watcher degradation and the live
 * settings switch. The Registry is the real production stack; only the live
 * session/sandbox-policy lookups are stubbed (they belong to the host).
 *
 * @module tests/worktrees-discovery
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { mountRegistryStack, type RegistryStack } from './support/registry-stack.ts'
import { createFixtureWorkspace, type FixtureWorkspace } from './support/temp-workspace.ts'
import { readSidecarFile } from './support/worktrees-stack.ts'
import { primaryKey } from '../src/roots.ts'
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
  /** Mount the real default (off) instead of the specs' enabled baseline. */
  readonly defaultConfig?: boolean
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
  await ctx.plugin(MultiRootWorktrees, options.defaultConfig === true ? (options.config ?? {}) : { enabled: true, ...(options.config ?? {}) })
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

  // Windows holds a watched directory handle and refuses the rename this setup
  // needs; the lost/recovery behavior itself is covered by the re-mount case.
  it.skipIf(process.platform === 'win32')('goes lost when the primary .git disappears, answers waiters, and recovers only explicitly', async () => {
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
    expect((await worktrees.wait(SESSION)).status).toBe('lost')
    await worktrees.describeRoots(main)
    // The old prompt id died with the activation; a fresh request receives a
    // new id for the re-evaluated candidate.
    const dead = await worktrees.resolve(SESSION, firstId, 'add')
    expect(dead.skipped).toMatchObject([{ code: 'worktree/prompt-stale' }])
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

describe('fresh check and operator memory', () => {
  it('answers the same fresh view twice without claiming or writing anything', async () => {
    const area = fixture('fresh-pure')
    const main = join(area.base, 'main')
    const linked = join(area.base, 'linked')
    initRepo(main)
    git(main, ['worktree', 'add', '-q', linked, '-b', 'feature'])
    const { worktrees, stack, storeFile } = await mount(join(area.base, 'store'), { session: { cwd: main } })
    const before = existsSync(storeFile) ? readFileSync(storeFile, 'utf8') : ''
    const full = await worktrees.prompt(SESSION)
    expect(full.prompts).toHaveLength(1)
    const first = await worktrees.prompt(SESSION, { fresh: true })
    const second = await worktrees.prompt(SESSION, { fresh: true })
    expect(first.prompts.map(prompt => prompt.id)).toEqual(second.prompts.map(prompt => prompt.id))
    expect(first.prompts[0]?.path).toBe(realpathSync.native(linked))
    // A pure query claims nothing: the full Dialog list and the Registry are
    // untouched, and no sidecar file was created.
    expect((await worktrees.prompt(SESSION)).prompts).toHaveLength(1)
    expect(existsSync(storeFile) ? readFileSync(storeFile, 'utf8') : '').toBe(before)
    expect(readSidecarFile(join(area.base, 'store', 'worktree-prompts'), primaryKey(main))).toBeUndefined()
    expect(stack.registry.list(main)).toHaveLength(0)
  }, 20_000)

  it('claims the shown ids so the next fresh check stays quiet, until reset', async () => {
    const area = fixture('fresh-seen')
    const main = join(area.base, 'main')
    const linked = join(area.base, 'linked')
    initRepo(main)
    git(main, ['worktree', 'add', '-q', linked, '-b', 'feature'])
    const { worktrees } = await mount(join(area.base, 'store'), { session: { cwd: main } })
    const shown = (await worktrees.prompt(SESSION, { fresh: true })).prompts[0]!
    expect(await worktrees.seen(SESSION, [shown.id])).toEqual({ seen: 1 })
    expect((await worktrees.prompt(SESSION, { fresh: true })).prompts).toEqual([])
    // An unknown or repeated id changes nothing.
    expect(await worktrees.seen(SESSION, [shown.id])).toEqual({ seen: 1 })
    expect(await worktrees.seen(SESSION, ['not-a-prompt'])).toEqual({ seen: 0 })
    // The Dialog list still shows it: `offered` only filters the automatic check.
    expect((await worktrees.prompt(SESSION)).prompts).toHaveLength(1)
    await worktrees.reset(SESSION)
    expect((await worktrees.prompt(SESSION, { fresh: true })).prompts).toHaveLength(1)
  }, 20_000)

  it('snoozes the recorded keys, keeps the candidate confirmable, and lets a new worktree through', async () => {
    const area = fixture('snooze-until-new')
    const main = join(area.base, 'main')
    const linked = join(area.base, 'linked')
    initRepo(main)
    git(main, ['worktree', 'add', '-q', linked, '-b', 'feature'])
    const { worktrees, stack } = await mount(join(area.base, 'store'), { session: { cwd: main } })
    const shown = (await worktrees.prompt(SESSION, { fresh: true })).prompts[0]!
    const answer = await worktrees.resolve(SESSION, shown.id, 'snooze', { snooze: { mode: 'until-new-worktree' } })
    expect(answer.resolved).toHaveLength(1)
    // Still queued and visible in the Dialog: a snooze is not a confirmation.
    expect(answer.prompts.map(prompt => prompt.path)).toEqual([realpathSync.native(linked)])
    expect(worktrees.activationOf(main).candidates).toBe(1)
    expect(stack.registry.list(main)).toHaveLength(0)
    expect((await worktrees.prompt(SESSION, { fresh: true })).prompts).toEqual([])
    // A NEW worktree is a new discovery key, so it is not covered.
    const later = join(area.base, 'later')
    git(main, ['worktree', 'add', '-q', later, '-b', 'later'])
    const fresh = await worktrees.prompt(SESSION, { fresh: true })
    expect(fresh.prompts.map(prompt => prompt.path)).toEqual([realpathSync.native(later)])
    // The old key stays suppressed.
    expect(fresh.prompts.some(prompt => prompt.path === shown.path)).toBe(false)
  }, 20_000)

  it('suppresses until its instant expires, measured by the host clock', async () => {
    const area = fixture('snooze-until')
    const main = join(area.base, 'main')
    const linked = join(area.base, 'linked')
    initRepo(main)
    git(main, ['worktree', 'add', '-q', linked, '-b', 'feature'])
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    try {
      const { worktrees } = await mount(join(area.base, 'store'), { session: { cwd: main } })
      const shown = (await worktrees.prompt(SESSION, { fresh: true })).prompts[0]!
      await worktrees.resolve(SESSION, shown.id, 'snooze', { snooze: { mode: '7d' } })
      expect((await worktrees.prompt(SESSION, { fresh: true })).prompts).toEqual([])
      clock.mockReturnValue(now + 7 * 86_400_000 - 1_000)
      expect((await worktrees.prompt(SESSION, { fresh: true })).prompts).toEqual([])
      clock.mockReturnValue(now + 7 * 86_400_000 + 1_000)
      expect((await worktrees.prompt(SESSION, { fresh: true })).prompts).toHaveLength(1)
    } finally {
      clock.mockRestore()
    }
  }, 20_000)

  it('forgets offered ids on a Host restart but keeps the persisted snooze', async () => {
    const area = fixture('snooze-restart')
    const main = join(area.base, 'main')
    const linked = join(area.base, 'linked')
    initRepo(main)
    git(main, ['worktree', 'add', '-q', linked, '-b', 'feature'])
    const storeRoot = join(area.base, 'store')
    const first = await mount(storeRoot, { session: { cwd: main } })
    const shown = (await first.worktrees.prompt(SESSION, { fresh: true })).prompts[0]!
    await first.worktrees.seen(SESSION, [shown.id])
    expect((await first.worktrees.prompt(SESSION, { fresh: true })).prompts).toEqual([])
    await first.stack.dispose()
    mounted.splice(mounted.indexOf(first), 1)
    // `offered` is Host memory: a new Host may announce it once more.
    const second = await mount(storeRoot, { session: { cwd: main } })
    const again = (await second.worktrees.prompt(SESSION, { fresh: true })).prompts[0]
    expect(again?.id).toBeDefined()
    await second.worktrees.resolve(SESSION, again!.id, 'snooze', { snooze: { mode: 'until-new-worktree' } })
    await second.stack.dispose()
    mounted.splice(mounted.indexOf(second), 1)
    // The delay is sidecar state, so the new Host honors it.
    const third = await mount(storeRoot, { session: { cwd: main } })
    expect((await third.worktrees.prompt(SESSION, { fresh: true })).prompts).toEqual([])
  }, 30_000)

  it('does not revive a lost workspace from the automatic fresh check', async () => {
    const area = fixture('fresh-lost')
    const main = join(area.base, 'main')
    initRepo(main)
    git(main, ['worktree', 'add', '-q', join(area.base, 'wt'), '-b', 'wt'])
    const { worktrees } = await mount(join(area.base, 'store'), { session: { cwd: main } })
    expect((await worktrees.prompt(SESSION, { fresh: true })).prompts).toHaveLength(1)
    // Removing the primary .git is allowed while the watcher holds the
    // directory; renaming it is not (Windows refuses the rename). Producing
    // the lost state this way keeps the case runnable on every platform.
    rmSync(join(main, '.git'), { recursive: true })
    expect((await worktrees.prompt(SESSION, { fresh: true })).prompts).toEqual([])
    expect(worktrees.activationOf(main).activation).toBe('lost')
    // A re-mount re-validates and keeps reporting lost; only the explicit
    // panel/command list may re-detect the workspace (covered by the
    // lost/recovery case above).
    expect((await worktrees.wait(SESSION)).status).toBe('lost')
  }, 20_000)
  it('forgets a persisted reminder delay when reset clears it', async () => {
    const area = fixture('snooze-reset-restart')
    const main = join(area.base, 'main')
    const linked = join(area.base, 'linked')
    initRepo(main)
    git(main, ['worktree', 'add', '-q', linked, '-b', 'feature'])
    const storeRoot = join(area.base, 'store')
    const first = await mount(storeRoot, { session: { cwd: main } })
    const shown = (await first.worktrees.prompt(SESSION, { fresh: true })).prompts[0]!
    await first.worktrees.seen(SESSION, [shown.id])
    await first.worktrees.resolve(SESSION, shown.id, 'snooze', { snooze: { mode: '30d' } })
    expect((await first.worktrees.prompt(SESSION, { fresh: true })).prompts).toEqual([])
    await first.worktrees.reset(SESSION)
    expect((await first.worktrees.prompt(SESSION, { fresh: true })).prompts).toHaveLength(1)
    await first.stack.dispose()
    mounted.splice(mounted.indexOf(first), 1)
    // The cleared delay is durable: the next Host must not restore it.
    const second = await mount(storeRoot, { session: { cwd: main } })
    expect((await second.worktrees.prompt(SESSION, { fresh: true })).prompts).toHaveLength(1)
  }, 30_000)

  it('runs the automatic fresh check without persistent discovery or sidecar reconciliation', async () => {
    const area = fixture('fresh-passive')
    const main = join(area.base, 'main')
    const registered = join(area.base, 'registered')
    initRepo(main)
    git(main, ['worktree', 'add', '-q', registered, '-b', 'registered'])
    const storeRoot = join(area.base, 'store')
    const sidecarRoot = join(storeRoot, 'worktree-prompts')
    // The first Host registers one checkout, so the sidecar carries a B
    // mapping bound to an owner epoch the next Host would reconcile.
    const one = await mount(storeRoot, { session: { cwd: main } })
    const first = promptOf(await one.worktrees.wait(SESSION))
    expect(first.path).toBe(realpathSync.native(registered))
    await one.worktrees.resolve(SESSION, first.id, 'add')
    await one.stack.dispose()
    mounted.splice(mounted.indexOf(one), 1)
    // A second Host starts cold on the same store; its first request is the
    // automatic fresh check the overlay performs on session activation.
    const candidate = join(area.base, 'candidate')
    git(main, ['worktree', 'add', '-q', candidate, '-b', 'candidate'])
    const two = await mount(storeRoot, { session: { cwd: main } })
    const spy = vi.spyOn(two.stack.registry, 'worktreeSidecar')
    try {
      const sidecarBefore = readSidecarFile(sidecarRoot, primaryKey(main))
      const fresh = await two.worktrees.prompt(SESSION, { fresh: true })
      expect(fresh.prompts.map(prompt => prompt.path)).toEqual([realpathSync.native(candidate)])
      // The fresh check is a read: no watcher set, no owner-side reconcile,
      // no sidecar revision.
      expect(two.worktrees.activationOf(main).watching).toBe(false)
      expect(spy.mock.calls.map(call => (call[1] as { op: string }).op)).toEqual(['read'])
      expect(readSidecarFile(sidecarRoot, primaryKey(main))).toEqual(sidecarBefore)
      // Without a watcher a later worktree is not discovered in the
      // background: only the next explicit check sees it.
      git(main, ['worktree', 'add', '-q', join(area.base, 'later'), '-b', 'later'])
      await new Promise(resolve => setTimeout(resolve, 400))
      expect(two.worktrees.activationOf(main).candidates).toBe(1)
      expect(spy.mock.calls.some(call => (call[1] as { op: string }).op === 'reconcile')).toBe(false)
      // Opening the Dialog is the explicit lifecycle that promotes the
      // workspace to persistent discovery.
      await two.worktrees.prompt(SESSION)
      expect(two.worktrees.activationOf(main).watching).toBe(true)
      await vi.waitFor(() => {
        expect(spy.mock.calls.some(call => (call[1] as { op: string }).op === 'reconcile')).toBe(true)
      })
    } finally {
      spy.mockRestore()
    }
  }, 30_000)

  it('resumes a timed reminder after expiry even though the notice claimed its ids', async () => {
    const area = fixture('snooze-seen-expiry')
    const main = join(area.base, 'main')
    const linked = join(area.base, 'linked')
    initRepo(main)
    git(main, ['worktree', 'add', '-q', linked, '-b', 'feature'])
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    try {
      const { worktrees } = await mount(join(area.base, 'store'), { session: { cwd: main } })
      const shown = (await worktrees.prompt(SESSION, { fresh: true })).prompts[0]!
      // The browser sequence: the notice claims its ids first, then the
      // operator picks the seven-day delay from the notice dropdown.
      expect(await worktrees.seen(SESSION, [shown.id])).toEqual({ seen: 1 })
      expect((await worktrees.prompt(SESSION, { fresh: true })).prompts).toEqual([])
      await worktrees.resolve(SESSION, shown.id, 'snooze', { snooze: { mode: '7d' } })
      expect((await worktrees.prompt(SESSION, { fresh: true })).prompts).toEqual([])
      clock.mockReturnValue(now + 7 * 86_400_000 + 1_000)
      const resumed = await worktrees.prompt(SESSION, { fresh: true })
      expect(resumed.prompts.map(prompt => prompt.path)).toEqual([realpathSync.native(linked)])
    } finally {
      clock.mockRestore()
    }
  }, 20_000)

  it('keeps a reminder recoverable when a sidecar reload observes the expiry first', async () => {
    const area = fixture('snooze-reload-expiry')
    const main = join(area.base, 'main')
    const linked = join(area.base, 'linked')
    initRepo(main)
    git(main, ['worktree', 'add', '-q', linked, '-b', 'feature'])
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    try {
      const { worktrees } = await mount(join(area.base, 'store'), { session: { cwd: main } })
      const shown = (await worktrees.prompt(SESSION, { fresh: true })).prompts[0]!
      expect(await worktrees.seen(SESSION, [shown.id])).toEqual({ seen: 1 })
      await worktrees.resolve(SESSION, shown.id, 'snooze', { snooze: { mode: '7d' } })
      clock.mockReturnValue(now + 7 * 86_400_000 + 1_000)
      // An explicit panel/command read reloads the sidecar BEFORE the next
      // automatic check observes the expiry. Dropping the expired record here
      // must release the claim it covered, not just forget the delay: the
      // next fresh check has no record left to expire.
      await worktrees.describeRoots(main)
      const resumed = await worktrees.prompt(SESSION, { fresh: true })
      expect(resumed.prompts.map(prompt => prompt.path)).toEqual([realpathSync.native(linked)])
    } finally {
      clock.mockRestore()
    }
  }, 20_000)

})

describe('experimental default', () => {
  it('defaults the live switch to off and performs no discovery or write', async () => {
    const area = fixture('settings-default-off')
    const main = join(area.base, 'main')
    initRepo(main)
    git(main, ['worktree', 'add', '-q', join(area.base, 'wt'), '-b', 'wt'])
    const { worktrees, stack } = await mount(join(area.base, 'store'), { session: { cwd: main }, defaultConfig: true })
    expect(worktrees.enabled).toBe(false)
    await expect(worktrees.wait(SESSION)).rejects.toMatchObject({ code: 'worktree/not-enabled' })
    // The switch is off, so no activation, watcher, prompt or sidecar write.
    expect(worktrees.activationOf(main).activation).toBe('unactivated')
    expect(stack.registry.list(main)).toHaveLength(0)
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
