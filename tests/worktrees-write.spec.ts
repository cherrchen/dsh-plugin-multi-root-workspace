/** Phase P4: the confirmed write path, the sidecar and the explicit cleanup. */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { mountWorktreeStack, readSidecarFile, type WorktreeStack } from './support/worktrees-stack.ts'
import { createFixtureWorkspace, type FixtureWorkspace } from './support/temp-workspace.ts'
import { primaryKey } from '../src/roots.ts'
import { resolveRepo } from '../src/worktrees/repository.ts'
import type { WorktreePromptWaitResult } from '../src/worktrees/types.ts'

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
  writeFileSync(join(path, 'README.md'), 'x\n')
  git(path, ['add', 'README.md'])
  git(path, ['commit', '-q', '-m', 'initial'])
}

const fixtures: FixtureWorkspace[] = []
const stacks: WorktreeStack[] = []
afterEach(async () => {
  while (stacks.length > 0) await stacks.pop()!.stack.dispose()
  while (fixtures.length > 0) fixtures.pop()!.dispose()
})

function fixture(label: string): FixtureWorkspace {
  const area = createFixtureWorkspace(label)
  fixtures.push(area)
  return area
}

interface Workspace {
  readonly area: FixtureWorkspace
  readonly main: string
  readonly linked: string
  readonly stack: WorktreeStack
}

async function mountLinked(label: string): Promise<Workspace> {
  const area = fixture(label)
  const main = join(area.base, 'main')
  const linked = join(area.base, 'linked')
  initRepo(main)
  git(main, ['worktree', 'add', '-q', linked, '-b', 'feature'])
  const stack = await mountWorktreeStack(join(area.base, 'store'), { cwd: main, config: { waitTimeoutMs: 100 } })
  stacks.push(stack)
  return { area, main, linked, stack }
}

/** The store document, or '' before the first write created it. */
function storeText(path: string): string {
  try { return readFileSync(path, 'utf8') } catch { return '' }
}

function promptOf(result: WorktreePromptWaitResult) {
  expect(result.status).toBe('prompt')
  if (result.status !== 'prompt') throw new Error('expected a prompt')
  return result.prompt
}

describe('confirmed registration', () => {
  it('registers an inherit root, writes the B mapping, and retires the prompt', async () => {
    const { main, linked, stack } = await mountLinked('write-add')
    const prompt = promptOf(await stack.worktrees.wait(stack.sessionId))
    const before = storeText(stack.storeFile)
    const answer = await stack.worktrees.resolve(stack.sessionId, prompt.id, 'add')
    expect(answer.prompt).toBeUndefined()
    const rows = stack.stack.registry.list(main)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ path: realpathSync.native(linked), access: 'inherit', state: 'available' })
    const sidecar = readSidecarFile(stack.sidecarRoot, primaryKey(main))
    expect(sidecar).toBeDefined()
    expect(sidecar!.worktreeRoots).toMatchObject([{
      rootId: rows[0]!.id,
      path: rows[0]!.path,
      rootAddedAt: rows[0]!.addedAt,
    }])
    expect(storeText(stack.storeFile)).not.toBe(before)
    // The same prompt cannot be answered twice.
    await expect(stack.worktrees.resolve(stack.sessionId, prompt.id, 'add')).rejects
      .toMatchObject({ code: 'worktree/prompt-stale' })
  })

  it('dismisses with a workspace-wide ignore that reset clears', async () => {
    const { main, linked, stack } = await mountLinked('write-dismiss')
    const first = promptOf(await stack.worktrees.wait(stack.sessionId))
    await stack.worktrees.resolve(stack.sessionId, first.id, 'dismiss', true)
    const sidecar = readSidecarFile(stack.sidecarRoot, primaryKey(main))
    expect(sidecar!.ignored).toMatchObject([{ kind: 'worktree', path: realpathSync.native(linked) }])
    // A shared-queue re-evaluation must not resurrect the ignored candidate.
    expect((await stack.worktrees.wait(stack.sessionId)).status).toBe('timeout')
    await stack.worktrees.reset(stack.sessionId)
    expect(readSidecarFile(stack.sidecarRoot, primaryKey(main))!.ignored).toEqual([])
    expect(promptOf(await stack.worktrees.wait(stack.sessionId)).path).toBe(realpathSync.native(linked))
  })

  it('refuses to confirm when the candidate changed while the prompt was open', async () => {
    const { main, linked, stack } = await mountLinked('write-stale')
    const prompt = promptOf(await stack.worktrees.wait(stack.sessionId))
    const repo = resolveRepo(linked)
    if (!repo.ok) throw new Error('fixture is not active')
    // A rewritten admin HEAD invalidates the captured candidate snapshot.
    writeFileSync(join(repo.repo.adminGitdir!, 'HEAD'), 'definitely-not-a-head\n')
    const before = storeText(stack.storeFile)
    await expect(stack.worktrees.resolve(stack.sessionId, prompt.id, 'add')).rejects
      .toMatchObject({ code: 'worktree/prompt-stale' })
    expect(storeText(stack.storeFile)).toBe(before)
    expect(stack.stack.registry.list(main)).toHaveLength(0)
  })
})

describe('deletion lifecycle', () => {
  it('badges a deleted tracked root and cleans up only after an explicit request', async () => {
    const { main, linked, stack } = await mountLinked('write-cleanup')
    const prompt = promptOf(await stack.worktrees.wait(stack.sessionId))
    await stack.worktrees.resolve(stack.sessionId, prompt.id, 'add')
    const [row] = stack.stack.registry.list(main)
    rmSync(linked, { recursive: true, force: true })
    await stack.stack.registry.refresh(main)
    const described = await stack.worktrees.describeRoots(main)
    expect(described?.cleanupCount).toBe(1)
    expect(described?.badges.get(row!.id)).toMatchObject({ state: 'directory-missing', cleanupEligible: true })
    // Nothing was removed by the deletion event itself.
    expect(stack.stack.registry.list(main)).toHaveLength(1)
    const result = await stack.worktrees.cleanup(stack.sessionId, [row!.id])
    expect(result).toEqual({ removed: [row!.id], skipped: [] })
    expect(stack.stack.registry.list(main)).toHaveLength(0)
    expect(readSidecarFile(stack.sidecarRoot, primaryKey(main))!.worktreeRoots).toEqual([])
  })

  it('refuses cleanup while the directory still exists and reports why', async () => {
    const { main, stack } = await mountLinked('write-cleanup-present')
    const prompt = promptOf(await stack.worktrees.wait(stack.sessionId))
    await stack.worktrees.resolve(stack.sessionId, prompt.id, 'add')
    const [row] = stack.stack.registry.list(main)
    const result = await stack.worktrees.cleanup(stack.sessionId, [row!.id])
    expect(result.removed).toEqual([])
    expect(result.skipped).toEqual([{ id: row!.id, code: 'worktree/not-eligible' }])
    expect(stack.stack.registry.list(main)).toHaveLength(1)
  })

  it('keeps an unknown id out without touching any record', async () => {
    const { main, stack } = await mountLinked('write-cleanup-unknown')
    const prompt = promptOf(await stack.worktrees.wait(stack.sessionId))
    await stack.worktrees.resolve(stack.sessionId, prompt.id, 'add')
    const result = await stack.worktrees.cleanup(stack.sessionId, ['not-a-mapping'])
    expect(result.removed).toEqual([])
    expect(result.skipped).toEqual([{ id: 'not-a-mapping', code: 'worktree/not-eligible' }])
    expect(stack.stack.registry.list(main)).toHaveLength(1)
  })
})

describe('sidecar degradation', () => {
  it('keeps discovery and confirmation working with a corrupt sidecar file', async () => {
    const area = fixture('write-corrupt')
    const main = join(area.base, 'main')
    const linked = join(area.base, 'linked')
    initRepo(main)
    git(main, ['worktree', 'add', '-q', linked, '-b', 'feature'])
    const sidecarRoot = join(area.base, 'store', 'worktree-prompts')
    mkdirSync(sidecarRoot, { recursive: true })
    const { createHash } = await import('node:crypto')
    const file = join(sidecarRoot, createHash('sha256').update(primaryKey(main)).digest('hex') + '.json')
    writeFileSync(file, '{ not json')
    const stack = await mountWorktreeStack(join(area.base, 'store'), { cwd: main })
    stacks.push(stack)
    const prompt = promptOf(await stack.worktrees.wait(stack.sessionId))
    await stack.worktrees.resolve(stack.sessionId, prompt.id, 'add')
    expect(stack.stack.registry.list(main)).toHaveLength(1)
    // The corrupt file was NOT overwritten: the owner stayed memory-only.
    expect(readFileSync(file, 'utf8')).toBe('{ not json')
  })
})
