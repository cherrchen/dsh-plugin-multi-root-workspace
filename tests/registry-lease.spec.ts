/**
 * Kernel lease for the registry store: POSIX flock (and the Windows named
 * semaphore on that host) elects one holder; contention fails closed; release
 * — including process death — lets a successor take over.
 */

import { mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import MultiRootRegistry, { DOMAIN_NAME, REGISTRY_CONTENDED_MESSAGE } from '../src/registry.ts'
import { RegistryAuthorityLease, RegistryLeaseContendedError } from '../src/registry-lease.ts'
import { leaseNameWin32 } from '../src/registry-lease-win32.ts'
import { RootValidationError } from '../src/roots.ts'
import MultiRootScopeService from '../src/scope.ts'
import { mountCompat } from './support/compat.ts'
import { mountProviderGate } from './support/providers.ts'
import { shortPathName } from './support/windows.ts'
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
  it('uses one Windows semaphore name for physical and aliased store directories', () => {
    const alias = join(fixture.base, 'storage-alias')
    symlinkSync(storeRoot, alias, process.platform === 'win32' ? 'junction' : 'dir')
    expect(leaseNameWin32(join(alias, `${DOMAIN_NAME}.lock`))).toBe(leaseNameWin32(leasePath))
    expect(leaseNameWin32(join(alias, 'other.lock'))).not.toBe(leaseNameWin32(leasePath))
  })

  it('contends through a directory alias at the actual kernel boundary', async () => {
    const alias = join(fixture.base, 'storage-alias')
    symlinkSync(storeRoot, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const lease = await RegistryAuthorityLease.acquire(leasePath)
    try {
      await expect(RegistryAuthorityLease.acquire(join(alias, `${DOMAIN_NAME}.lock`)))
        .rejects.toBeInstanceOf(RegistryLeaseContendedError)
    } finally {
      await lease.release()
    }
  })

  it.runIf(process.platform === 'win32')('uses one semaphore name for a case-variant spelling and the 8.3 alias of the store', (context) => {
    const variant = storeRoot.split('').map((letter, index) => index % 2 === 0 ? letter.toLowerCase() : letter.toUpperCase()).join('')
    expect(leaseNameWin32(join(variant, `${DOMAIN_NAME}.lock`))).toBe(leaseNameWin32(leasePath))
    // The 8.3 alias only exists on volumes where short-name generation is on;
    // when it spells the long name there is nothing distinct to compare.
    const short = shortPathName(storeRoot)
    if (short === storeRoot) {
      context.skip(`8.3 short names are disabled on this volume (${storeRoot} resolves to itself)`)
      return
    }
    expect(leaseNameWin32(join(short, `${DOMAIN_NAME}.lock`))).toBe(leaseNameWin32(leasePath))
  })

  it('elects exactly one authority when three OS processes contend for one store', async () => {
    // Same child program the multiprocess e2e drives: mount the stack, print one
    // JSON status line with the authority verdict, hold until stdin closes.
    const childSource = fileURLToPath(new URL('./support/registry-authority-child.ts', import.meta.url))
    const children: ChildProcess[] = []
    try {
      const ready = await Promise.all([0, 1, 2].map(async () => {
        const child = spawn(process.execPath, ['--experimental-transform-types', childSource,
          JSON.stringify({ storeRoot, primary })], { stdio: ['pipe', 'pipe', 'pipe'] })
        children.push(child)
        const stderr: Buffer[] = []
        child.stderr?.on('data', chunk => stderr.push(chunk as Buffer))
        return await new Promise<{ authority: string }>((resolve, reject) => {
          let buffer = ''
          child.once('error', reject)
          child.once('exit', (code, signal) => {
            const detail = Buffer.concat(stderr).toString('utf8')
            reject(new Error(`authority child exited before ready (code=${String(code)} signal=${String(signal)})${detail === '' ? '' : `\n${detail}`}`))
          })
          child.stdout?.on('data', chunk => {
            buffer += String(chunk)
            const line = buffer.split('\n').find(entry => entry.trim().startsWith('{'))
            if (line === undefined) return
            resolve(JSON.parse(line) as { authority: string })
          })
        })
      }))
      expect(ready.filter(entry => entry.authority === 'active')).toHaveLength(1)
      expect(ready.filter(entry => entry.authority === 'contended')).toHaveLength(2)
    } finally {
      for (const child of children) child.stdin?.end()
      for (const child of children) child.kill('SIGTERM')
      await Promise.all(children.map(async child => await new Promise<void>(resolve => {
        if (child.exitCode !== null || child.signalCode !== null) { resolve(); return }
        child.once('exit', () => resolve())
      })))
    }
  })

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

  it('marks the scope authority through every registry state transition', async () => {
    const policy: SandboxExecutionPolicy = { mode: 'danger-full-access', workspaceRoot: primary }
    const authorityOf = (stack: RegistryStack) => stack.scope.resolve(policy).authority

    // Active: the accepted records published, so the scope is authoritative.
    const first = await mount()
    expect(first.registry.authority.kind).toBe('active')
    expect(authorityOf(first)).toBe('available')

    // Contended: the empty scope must read as "restrictions unknown".
    const second = await mount()
    expect(second.registry.authority.kind).toBe('contended')
    expect(authorityOf(second)).toBe('unavailable')

    // Storage-failed: same fail-closed marking on a broken medium.
    const failed = await mountRegistryStack(join(fixture.base, 'broken'), { leasePath: '' })
    stacks.push(failed)
    expect(failed.registry.authority.kind).toBe('storage-failed')
    expect(authorityOf(failed)).toBe('unavailable')

    // Config-invalid: the terminal fail-closed state also marks the scope.
    const invalid = await mountRegistryStack(join(fixture.base, 'invalid'), { maxAdditionalRoots: 0 })
    stacks.push(invalid)
    expect(invalid.registry.authority.kind).toBe('config-invalid')
    expect(authorityOf(invalid)).toBe('unavailable')

    // Teardown: the released stack stops claiming authority, and the waiter
    // becomes authoritative only after it publishes the durable records.
    await first.dispose()
    stacks = stacks.filter(stack => stack !== first)
    expect(authorityOf(first)).toBe('unavailable')
    await second.registry.refresh(primary)
    expect(second.registry.authority.kind).toBe('active')
    expect(authorityOf(second)).toBe('available')
  })
})

/** One registry mounted over a fake domain whose write and open steps can be interleaved by hand. */
interface ControlledWorld {
  readonly ctx: Context
  /** The mounted root fiber; `dispose()` is the teardown under test. */
  readonly fiber: Fiber
  readonly registry: MultiRootRegistry
  /** `put:start` / `put:end` / `close` / `open:start` / `open:end`, in the order they happened. */
  readonly events: readonly string[]
  /** Resolves once `put()` has been entered and is blocked. */
  readonly putStarted: () => Promise<void>
  /** Lets the blocked `put()` finish. */
  readonly finishPut: () => void
  /** Resolves once the gated `open()` has been entered and is blocked. */
  readonly openStarted: () => Promise<void>
  /** Lets the gated `open()` finish. */
  readonly finishOpen: () => void
}

/**
 * Mount the registry over a FAKE storage domain, so a mutation and the teardown
 * can be interleaved deterministically. The lease is the REAL kernel lease: the
 * ordering asserted here is exactly what a second DSH process observes.
 * @param options - `gatePut` blocks the first `put()`; `gateFirstOpen` blocks the first `open()`.
 * @returns the mounted world.
 */
async function mountWithControlledDomain(options: {
  readonly gatePut?: boolean
  readonly gateFirstOpen?: boolean
} = {}): Promise<ControlledWorld> {
  const events: string[] = []
  const putEntered = Promise.withResolvers<void>()
  const putGate = Promise.withResolvers<void>()
  const openEntered = Promise.withResolvers<void>()
  const openGate = Promise.withResolvers<void>()

  const table = {
    get: () => undefined,
    entries: () => [][Symbol.iterator](),
    put: async () => {
      events.push('put:start')
      putEntered.resolve()
      if (options.gatePut === true) await putGate.promise
      events.push('put:end')
    },
    delete: async () => undefined,
  }
  let opens = 0
  const ctx = new Context()
  await ctx.plugin(MultiRootScopeService)
  ctx.provide('storageDomain', {
    open: async () => {
      opens += 1
      if (options.gateFirstOpen === true && opens === 1) {
        events.push('open:start')
        openEntered.resolve()
        await openGate.promise
        events.push('open:end')
      }
      return { table: () => table, close: async () => { events.push('close') } }
    },
  })
  await mountCompat(ctx)
  await mountProviderGate(ctx)
  const fiber = await ctx.plugin(MultiRootRegistry, { leasePath })
  return {
    ctx,
    fiber,
    registry: ctx.multiRootRegistry,
    events,
    putStarted: () => putEntered.promise,
    finishPut: () => { putGate.resolve() },
    openStarted: () => openEntered.promise,
    finishOpen: () => { openGate.resolve() },
  }
}

describe('authority teardown', () => {
  it('drains an in-flight mutation before closing the domain, and closes it before the lease is free', async () => {
    const world = await mountWithControlledDomain({ gatePut: true })
    const extra = makeRoot('extra')
    const add = world.registry.add(primary, { path: extra })
    await world.putStarted()

    const disposal = world.fiber.dispose()
    // The teardown must be waiting for that write, not racing it.
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(world.events).not.toContain('close')

    world.finishPut()
    await add
    await disposal

    expect(world.events.indexOf('put:end')).toBeGreaterThan(-1)
    expect(world.events.indexOf('put:end')).toBeLessThan(world.events.indexOf('close'))
    // And nothing holds the store afterwards: a successor can take it.
    const successor = await RegistryAuthorityLease.acquire(leasePath)
    await successor.release()
  })

  it('lets a waiting process take over after a disposal that overlapped its acquisition', async () => {
    const first = await mountWithControlledDomain()
    // While `first` holds the lease, `second` never opens: its gated open is
    // consumed by the takeover below.
    const second = await mountWithControlledDomain({ gateFirstOpen: true })
    expect(second.registry.authority.kind).toBe('contended')

    await first.fiber.dispose()

    // The takeover acquires the real lease, then blocks inside openDomain().
    const refreshing = second.registry.refresh(primary)
    await second.openStarted()
    const disposal = second.fiber.dispose()
    second.finishOpen()
    await disposal
    await refreshing

    // A torn-down registry must not have finished by opening a medium it will
    // never close: the acquisition that overlapped the disposal is retired with
    // it, not left claiming authority.
    expect(second.registry.authority.kind).toBe('contended')
    // Nothing may still hold the store: the successor is the new authority.
    const successor = await RegistryAuthorityLease.acquire(leasePath)
    await successor.release()
  })
})

afterEach(() => {
  rmSync(leasePath, { force: true })
})
