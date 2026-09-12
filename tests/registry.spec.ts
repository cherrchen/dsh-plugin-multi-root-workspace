/**
 * The registry service over a REAL storage stack: the JSON backend, the domain
 * form, the scope service, and the registry, assembled the way a profile
 * assembles them.
 *
 * A restart is a second context over the same store root, which is the only
 * way to prove the durability claim the M3 journey rests on: roots survive a
 * process, and a registration whose directory vanished is withheld rather than
 * handed to the kernel dialects.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DOMAIN_NAME, MAX_ALIAS_LENGTH } from '../src/registry.ts'
import { RootValidationError } from '../src/roots.ts'
import { mountRegistryStack, type RegistryStack } from './support/registry-stack.ts'
import { createFixtureWorkspace, type FixtureWorkspace } from './support/temp-workspace.ts'

let fixture: FixtureWorkspace
let storeRoot: string
let storeFile: string
let primary: string
let stacks: RegistryStack[] = []

/** Create a sibling directory usable as an additional root. */
function makeRoot(name: string): string {
  const path = join(fixture.base, name)
  mkdirSync(path, { recursive: true })
  return canonicalPath(path)
}

/** Mount the shared stack over this test's private store root. */
async function mount(): Promise<RegistryStack> {
  const stack = await mountRegistryStack(storeRoot)
  stacks.push(stack)
  return stack
}

/** Dispose every stack this test created, newest first. */
async function disposeAll(): Promise<void> {
  const pending = stacks
  stacks = []
  for (const stack of pending.reverse()) await stack.dispose()
}

beforeEach(() => {
  fixture = createFixtureWorkspace('registry')
  storeRoot = join(fixture.base, 'storages')
  storeFile = join(storeRoot, `${DOMAIN_NAME}.json`)
  mkdirSync(storeRoot)
  primary = canonicalPath(fixture.workspace)
})

afterEach(async () => {
  await disposeAll()
  fixture.dispose()
})

describe('registration lifecycle', () => {
  it('grants a newly registered root, persists it, and reports it available', async () => {
    const { registry, scope } = await mount()
    const extra = makeRoot('extra')

    const statuses = await registry.add(primary, { path: extra })

    expect(statuses).toHaveLength(1)
    expect(statuses[0]?.state).toBe('available')
    expect(statuses[0]?.path).toBe(extra)
    expect(scope.scopeOf(primary)).toEqual([extra])
    expect(registry.granted(primary)).toEqual([extra])
    expect(readFileSync(storeFile, 'utf8')).toContain(extra)
  })

  it('keeps registry order and reorders on move', async () => {
    const { registry } = await mount()
    const first = makeRoot('first')
    const second = makeRoot('second')
    const third = makeRoot('third')

    await registry.add(primary, { path: first })
    await registry.add(primary, { path: second })
    await registry.add(primary, { path: third })
    expect(registry.granted(primary)).toEqual([first, second, third])

    // Move the last one in front of the first (what the panel's ↑ action does).
    await registry.move(primary, { kind: 'ordinal', ordinal: 3 }, { kind: 'ordinal', ordinal: 1 })
    expect(registry.granted(primary)).toEqual([third, first, second])

    // No anchor moves it to the end.
    await registry.move(primary, { kind: 'ordinal', ordinal: 1 })
    expect(registry.granted(primary)).toEqual([first, second, third])
  })

  it('sets and clears a display alias without touching the path', async () => {
    const { registry } = await mount()
    const extra = makeRoot('extra')
    await registry.add(primary, { path: extra })

    const aliased = await registry.setAlias(primary, { kind: 'path', path: extra }, '  payments  ')
    expect(aliased[0]?.alias).toBe('payments')
    expect(aliased[0]?.path).toBe(extra)

    const cleared = await registry.setAlias(primary, { kind: 'id', id: aliased[0]!.id }, '   ')
    expect(cleared[0]?.alias).toBeUndefined()
    expect(cleared[0]?.path).toBe(extra)
  })

  it('rejects an alias the panel could not render safely', async () => {
    const { registry } = await mount()
    const extra = makeRoot('extra')
    await registry.add(primary, { path: extra })

    await expect(registry.setAlias(primary, { kind: 'path', path: extra }, 'a\nb')).rejects.toThrow(RootValidationError)
    await expect(registry.setAlias(primary, { kind: 'path', path: extra }, 'x'.repeat(MAX_ALIAS_LENGTH + 1)))
      .rejects.toThrow(RootValidationError)
  })

  it('revokes the grant when a root is removed, and empties the store with the last one', async () => {
    const { registry, scope } = await mount()
    const first = makeRoot('first')
    const second = makeRoot('second')
    await registry.add(primary, { path: first })
    await registry.add(primary, { path: second })

    const afterFirst = await registry.remove(primary, { kind: 'path', path: first })
    expect(afterFirst.map(status => status.path)).toEqual([second])
    expect(scope.scopeOf(primary)).toEqual([second])

    const empty = await registry.remove(primary, { kind: 'id', id: afterFirst[0]!.id })
    expect(empty).toEqual([])
    expect(scope.scopeOf(primary)).toEqual([])
    expect(readFileSync(storeFile, 'utf8')).not.toContain(second)
  })

  it('refuses a duplicate, the primary root itself, a nested root, and a relative path', async () => {
    const { registry } = await mount()
    const extra = makeRoot('extra')
    makeRoot('extra/inner')
    const notADirectory = join(fixture.base, 'a-file')
    writeFileSync(notADirectory, 'not a directory')
    await registry.add(primary, { path: extra })

    const codeOf = async (path: string): Promise<string> => {
      try {
        await registry.add(primary, { path })
      } catch (error: unknown) {
        return error instanceof RootValidationError ? error.code : 'other'
      }
      return 'accepted'
    }

    expect(await codeOf(extra)).toBe('duplicate')
    expect(await codeOf(primary)).toBe('equals-primary')
    expect(await codeOf(join(extra, 'inner'))).toBe('nested')
    expect(await codeOf(fixture.base)).toBe('nested')
    expect(await codeOf('relative/path')).toBe('not-absolute')
    expect(await codeOf(join(fixture.base, 'missing'))).toBe('missing')
    expect(await codeOf(notADirectory)).toBe('not-a-directory')
  })

  it('notifies observers after each durable change', async () => {
    const { registry } = await mount()
    const seen: string[] = []
    const dispose = registry.onChange(root => { seen.push(root) })
    const extra = makeRoot('extra')

    await registry.add(primary, { path: extra })
    await registry.remove(primary, { kind: 'path', path: extra })
    dispose()
    await registry.add(primary, { path: extra })

    expect(seen).toEqual([primary, primary])
  })
})

describe('durability across a restart', () => {
  it('restores the registered roots, their order, and their aliases', async () => {
    const first = await mount()
    const extra = makeRoot('extra')
    const other = makeRoot('other')
    await first.registry.add(primary, { path: extra, alias: 'payments' })
    await first.registry.add(primary, { path: other })
    await disposeAll()

    const second = await mount()
    const statuses = second.registry.list(primary)
    expect(statuses.map(status => status.path)).toEqual([extra, other])
    expect(statuses.map(status => status.state)).toEqual(['available', 'available'])
    expect(statuses[0]?.alias).toBe('payments')
    expect(statuses[0]?.id).toBe(first.registry.list(primary)[0]?.id)
    expect(second.scope.scopeOf(primary)).toEqual([extra, other])
  })

  it('withholds a registration whose directory is gone, and restores it on recheck', async () => {
    const first = await mount()
    const extra = makeRoot('extra')
    await first.registry.add(primary, { path: extra })
    await disposeAll()
    rmSync(extra, { recursive: true, force: true })

    const second = await mount()
    const [status] = second.registry.list(primary)
    expect(status?.state).toBe('missing')
    expect(status?.detail).toBeDefined()
    expect(second.registry.granted(primary)).toEqual([])
    expect(second.scope.scopeOf(primary)).toEqual([])

    mkdirSync(extra)
    const rechecked = await second.registry.recheck(primary)
    expect(rechecked[0]?.state).toBe('available')
    expect(second.scope.scopeOf(primary)).toEqual([canonicalPath(extra)])
  })

  it('re-registering a withheld root revives it instead of reporting a duplicate', async () => {
    const first = await mount()
    const extra = makeRoot('extra')
    await first.registry.add(primary, { path: extra })
    await disposeAll()
    rmSync(extra, { recursive: true, force: true })

    const second = await mount()
    expect(second.registry.list(primary)[0]?.state).toBe('missing')

    mkdirSync(extra)
    const revived = await second.registry.add(primary, { path: extra, alias: 'back' })
    expect(revived).toHaveLength(1)
    expect(revived[0]?.state).toBe('available')
    expect(revived[0]?.alias).toBe('back')
    expect(second.registry.granted(primary)).toEqual([canonicalPath(extra)])
  })
})

describe('store that this build cannot read', () => {
  it('reports an unusable record as invalid and never grants it', async () => {
    const first = await mount()
    const outer = makeRoot('outer')
    const inner = makeRoot('outer/inner')
    await first.registry.add(primary, { path: outer })
    await disposeAll()

    // Rewrite the stored record so the second entry is nested inside the first.
    const document = JSON.parse(readFileSync(storeFile, 'utf8')) as {
      tables: { roots: Record<string, { roots: { id: string; path: string; addedAt: string }[] }> }
    }
    const record = document.tables.roots[primary]!
    record.roots.push({ id: 'hand-written', path: inner, addedAt: '2026-09-12T00:00:00.000Z' })
    writeFileSync(storeFile, JSON.stringify(document))

    const second = await mount()
    const statuses = second.registry.list(primary)
    expect(statuses.map(status => status.state)).toEqual(['available', 'invalid'])
    expect(statuses[1]?.path).toBe(inner)
    expect(second.registry.granted(primary)).toEqual([outer])
    expect(second.scope.scopeOf(primary)).toEqual([outer])
  })

  it('degrades to an empty root set instead of failing activation when the store is corrupt', async () => {
    const first = await mount()
    const extra = makeRoot('extra')
    await first.registry.add(primary, { path: extra })
    await disposeAll()
    writeFileSync(storeFile, '{ this is not the document this build writes')

    const second = await mount()
    expect(second.registry.list(primary)).toEqual([])
    expect(second.scope.scopeOf(primary)).toEqual([])
    expect(second.registry.unavailable).toContain('multi_root_workspace')
    await expect(second.registry.add(primary, { path: extra })).rejects.toMatchObject({
      code: 'storage-unavailable',
    })
  })
})
