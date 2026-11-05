/**
 * Kernel lease for the registry store: POSIX flock (and the Windows named
 * semaphore on that host) elects one holder; contention fails closed; release
 * — including process death — lets a successor take over.
 */

import { mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import { DOMAIN_NAME } from '../src/registry.ts'
import { RegistryAuthorityLease, RegistryLeaseContendedError } from '../src/registry-lease.ts'
import { leaseNameWin32 } from '../src/registry-lease-win32.ts'
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
      // One owner; every other process is a follower over IPC (shared mode).
      expect(ready.filter(entry => entry.authority === 'active')).toHaveLength(1)
      expect(ready.filter(entry => entry.authority === 'follower')).toHaveLength(2)
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
    expect(scope.snapshot({ mode: 'workspace-write', workspaceRoot: primary }).additionalRoots).toHaveLength(1)
  })

  it('does not open a second domain for the same store: the second stack is a follower whose reads and writes go through the owner', async () => {
    const first = await mount()
    const extra = makeRoot('extra')
    await first.registry.add(primary, { path: extra })
    expect(first.scope.snapshot({ mode: 'workspace-write', workspaceRoot: primary }).additionalRoots).toHaveLength(1)

    const second = await mount()
    expect(second.registry.authority.kind).toBe('follower')
    expect(second.registry.unavailable).toBeUndefined()
    // The follower never opens the medium: it sees the owner's durable record
    // over IPC, and its own mutations are dispatched to the owner too.
    expect((await second.registry.refresh(primary)).map(status => status.path)).toEqual([extra])
    const other = makeRoot('other')
    const statuses = await second.registry.add(primary, { path: other })
    expect(statuses.map(status => status.path)).toEqual([extra, other])
    // The owner's view and the follower's projection agree afterwards.
    expect(first.scope.snapshot({ mode: 'workspace-write', workspaceRoot: primary }).additionalRoots).toEqual([extra, other])
    expect(second.scope.snapshot({ mode: 'workspace-write', workspaceRoot: primary }).additionalRoots).toEqual([extra, other])
    expect(first.registry.authority).toEqual({ kind: 'active' })
  })

  it('lets the waiting process become authority after the holder disposes, and reads the last durable mutation', async () => {
    const first = await mount()
    const extra = makeRoot('extra')
    await first.registry.add(primary, { path: extra })
    const second = await mount()
    expect(second.registry.authority.kind).toBe('follower')

    await first.dispose()
    stacks = stacks.filter(stack => stack !== first)

    const statuses = await second.registry.refresh(primary)
    expect(second.registry.authority).toEqual({ kind: 'active' })
    expect(second.registry.unavailable).toBeUndefined()
    expect(statuses).toHaveLength(1)
    expect(second.scope.snapshot({ mode: 'workspace-write', workspaceRoot: primary }).additionalRoots).toHaveLength(1)
  })

  it('still degrades to storage-failed (not a stale grant) when the holder cannot parse the store', async () => {
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(storeRoot, `${DOMAIN_NAME}.json`), '{ this is not the document this build writes')
    const { registry, scope } = await mount()
    expect(registry.authority.kind).toBe('storage-failed')
    expect(registry.unavailable).toContain(DOMAIN_NAME)
    expect(registry.list(primary)).toEqual([])
    expect(scope.snapshot({ mode: 'workspace-write', workspaceRoot: primary }).additionalRoots).toEqual([])
    await expect(registry.add(primary, { path: makeRoot('extra') })).rejects.toMatchObject({
      code: 'storage-unavailable',
    })
  })

  it('marks the scope authority through every registry state transition', async () => {
    const policy: SandboxExecutionPolicy = { mode: 'danger-full-access', workspaceRoot: primary }
    const authorityOf = (stack: RegistryStack) => stack.scope.snapshot(policy).authority

    // Active: the accepted records published, so the scope is authoritative.
    const first = await mount()
    expect(first.registry.authority.kind).toBe('active')
    expect(authorityOf(first)).toBe('available')

    // Follower: once the projection is synced the scope is authoritative too.
    const second = await mount()
    expect(second.registry.authority.kind).toBe('follower')
    expect(authorityOf(second)).toBe('available')

    // Storage-failed: same fail-closed marking on a broken medium.
    const failed = await mountRegistryStack(join(fixture.base, 'broken'), { leasePath: '' })
    stacks.push(failed)
    expect(failed.registry.authority).toMatchObject({ kind: 'storage-failed', recovery: 'config' })
    expect(authorityOf(failed)).toBe('unavailable')
    // A `config` failure is terminal: refreshing never re-enters the failure path.
    const entered = vi.spyOn(failed.registry as unknown as { enterStorageFailed(reason: string, recovery: string): void }, 'enterStorageFailed')
    let scopeCalls = 0
    const unsubscribe = failed.scope.subscribe(() => { scopeCalls += 1 })
    await failed.registry.refresh(primary)
    expect(entered).not.toHaveBeenCalled()
    expect(scopeCalls).toBe(0)
    unsubscribe()

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

afterEach(() => {
  rmSync(leasePath, { force: true })
})
