/**
 * Kernel lease for the registry store: POSIX flock (and the Windows named
 * semaphore on that host) elects one holder; contention fails closed; release
 * — including process death — lets a successor take over.
 */

import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DOMAIN_NAME, REGISTRY_CONTENDED_MESSAGE } from '../src/registry.ts'
import { RegistryAuthorityLease, RegistryLeaseContendedError } from '../src/registry-lease.ts'
import { RootValidationError } from '../src/roots.ts'
import { mountRegistryStack, type RegistryStack } from './support/registry-stack.ts'
import { createFixtureWorkspace, type FixtureWorkspace } from './support/temp-workspace.ts'

let fixture: FixtureWorkspace
let storeRoot: string
let leasePath: string
let primary: string
let stacks: RegistryStack[] = []

async function mount(): Promise<RegistryStack> {
  const stack = await mountRegistryStack(storeRoot)
  stacks.push(stack)
  return stack
}

async function disposeAll(): Promise<void> {
  const pending = stacks
  stacks = []
  for (const stack of pending.reverse()) await stack.dispose()
}

function makeRoot(name: string): string {
  const path = join(fixture.base, name)
  mkdirSync(path, { recursive: true })
  return path
}

beforeEach(() => {
  fixture = createFixtureWorkspace('registry-lease')
  storeRoot = join(fixture.base, 'storages')
  leasePath = join(storeRoot, `${DOMAIN_NAME}.lock`)
  mkdirSync(storeRoot)
  primary = fixture.workspace
})

afterEach(async () => {
  await disposeAll()
  fixture.dispose()
})

describe('RegistryAuthorityLease', () => {
  it('lets one holder acquire and a second fail closed, then a successor take over after release', async () => {
    const first = await RegistryAuthorityLease.acquire(leasePath)
    await expect(RegistryAuthorityLease.acquire(leasePath)).rejects.toBeInstanceOf(RegistryLeaseContendedError)
    await first.release()
    const second = await RegistryAuthorityLease.acquire(leasePath)
    await second.release()
  })

  it('is idempotent on release', async () => {
    const lease = await RegistryAuthorityLease.acquire(leasePath)
    await lease.release()
    await lease.release()
    const again = await RegistryAuthorityLease.acquire(leasePath)
    await again.release()
  })
})

describe('registry authority at the service boundary', () => {
  it('elects the first stack as authority and grants its durable roots', async () => {
    const { registry, scope } = await mount()
    const extra = makeRoot('extra')
    await registry.add(primary, { path: extra })
    expect(registry.authority).toEqual({ kind: 'active' })
    expect(registry.unavailable).toBeUndefined()
    expect(scope.scopeOf(primary)).toHaveLength(1)
  })

  it('does not open a stale domain in a second stack sharing the store: empty grants, mutations reject', async () => {
    const first = await mount()
    const extra = makeRoot('extra')
    await first.registry.add(primary, { path: extra })
    expect(first.scope.scopeOf(primary)).toHaveLength(1)

    const second = await mount()
    expect(second.registry.authority).toEqual({ kind: 'contended' })
    expect(second.registry.unavailable).toBe(REGISTRY_CONTENDED_MESSAGE)
    expect(second.registry.list(primary)).toEqual([])
    expect(second.scope.scopeOf(primary)).toEqual([])
    expect(await second.registry.refresh(primary)).toEqual([])
    await expect(second.registry.add(primary, { path: makeRoot('other') })).rejects.toMatchObject({
      code: 'registry-contended',
    } satisfies Partial<RootValidationError>)
    // The first process still owns the grant; contention must not steal it.
    expect(first.scope.scopeOf(primary)).toHaveLength(1)
    expect(first.registry.authority).toEqual({ kind: 'active' })
  })

  it('lets the waiting process become authority after the holder disposes, and reads the last durable mutation', async () => {
    const first = await mount()
    const extra = makeRoot('extra')
    await first.registry.add(primary, { path: extra })
    const second = await mount()
    expect(second.registry.authority.kind).toBe('contended')
    expect(second.scope.scopeOf(primary)).toEqual([])

    await first.dispose()
    stacks = stacks.filter(stack => stack !== first)

    const statuses = await second.registry.refresh(primary)
    expect(second.registry.authority).toEqual({ kind: 'active' })
    expect(second.registry.unavailable).toBeUndefined()
    expect(statuses).toHaveLength(1)
    expect(second.scope.scopeOf(primary)).toHaveLength(1)
  })

  it('still degrades to storage-failed (not a stale grant) when the holder cannot parse the store', async () => {
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(storeRoot, `${DOMAIN_NAME}.json`), '{ this is not the document this build writes')
    const { registry, scope } = await mount()
    expect(registry.authority.kind).toBe('storage-failed')
    expect(registry.unavailable).toContain(DOMAIN_NAME)
    expect(registry.list(primary)).toEqual([])
    expect(scope.scopeOf(primary)).toEqual([])
    await expect(registry.add(primary, { path: makeRoot('extra') })).rejects.toMatchObject({
      code: 'storage-unavailable',
    })
  })
})

afterEach(() => {
  rmSync(leasePath, { force: true })
})
