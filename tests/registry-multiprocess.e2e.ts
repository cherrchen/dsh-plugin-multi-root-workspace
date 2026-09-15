/**
 * Two OS processes sharing one registry store: the second never receives stale
 * grants, a clean exit and a SIGKILL both free the kernel lease, and the
 * successor reads the last durable mutation back from disk.
 */

import { mkdirSync } from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mountRegistryStack, type RegistryStack } from './support/registry-stack.ts'
import { createFixtureWorkspace, type FixtureWorkspace } from './support/temp-workspace.ts'

const CHILD = fileURLToPath(new URL('./support/registry-authority-child.ts', import.meta.url))

interface ChildReady {
  readonly status: 'ready'
  readonly pid: number
  readonly authority: string
  readonly granted: readonly string[]
}

let fixture: FixtureWorkspace
let storeRoot: string
let primary: string
let extra: string
let stacks: RegistryStack[] = []
let children: ChildProcess[] = []

async function mountLocal(): Promise<RegistryStack> {
  const stack = await mountRegistryStack(storeRoot)
  stacks.push(stack)
  return stack
}

async function disposeLocals(): Promise<void> {
  const pending = stacks
  stacks = []
  for (const stack of pending.reverse()) await stack.dispose()
}

function killChildren(signal: NodeJS.Signals): void {
  for (const child of children) {
    if (child.killed || child.exitCode !== null) continue
    child.kill(signal)
  }
}

async function waitExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>(resolve => child.once('exit', () => resolve()))
}

/**
 * Spawn the authority child with Node's TypeScript transform so the same `.ts`
 * sources the suite imports run in a second OS process (CI is Node 22.19).
 */
async function spawnAuthority(input: { extra?: string }): Promise<{ child: ChildProcess; ready: ChildReady }> {
  const child = spawn(
    process.execPath,
    ['--experimental-transform-types', CHILD, JSON.stringify({
      storeRoot,
      primary,
      ...(input.extra === undefined ? {} : { extra: input.extra }),
    })],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  )
  children.push(child)
  const stderr: Buffer[] = []
  child.stderr?.on('data', chunk => stderr.push(chunk as Buffer))
  const ready = await new Promise<ChildReady>((resolve, reject) => {
    let settled = false
    let buffer = ''
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      const detail = Buffer.concat(stderr).toString('utf8')
      reject(new Error(`${error.message}${detail === '' ? '' : `\n${detail}`}`))
    }
    const succeed = (value: ChildReady): void => {
      if (settled) return
      settled = true
      resolve(value)
    }
    child.once('error', error => fail(error))
    child.once('exit', (code, signal) => {
      fail(new Error(`authority child exited before ready (code=${String(code)} signal=${String(signal)})`))
    })
    child.stdout?.on('data', chunk => {
      buffer += String(chunk)
      const line = buffer.split('\n').find(entry => entry.trim().startsWith('{'))
      if (line === undefined) return
      try {
        succeed(JSON.parse(line) as ChildReady)
      } catch (error: unknown) {
        fail(error instanceof Error ? error : new Error(String(error)))
      }
    })
  })
  return { child, ready }
}

beforeEach(() => {
  fixture = createFixtureWorkspace('registry-multiprocess')
  storeRoot = join(fixture.base, 'storages')
  mkdirSync(storeRoot)
  primary = canonicalPath(fixture.workspace)
  extra = join(fixture.base, 'extra')
  mkdirSync(extra)
})

afterEach(async () => {
  killChildren('SIGTERM')
  await Promise.all(children.map(async child => await waitExit(child)))
  children = []
  await disposeLocals()
  fixture.dispose()
})

describe('two DSH processes sharing one registry store', () => {
  it('never lets the second process grant from a stale open while the first holds the lease', async () => {
    const { ready } = await spawnAuthority({ extra })
    expect(ready.authority).toBe('active')
    expect(ready.granted).toEqual([canonicalPath(extra)])

    const second = await mountLocal()
    expect(second.registry.authority.kind).toBe('contended')
    expect(second.scope.scopeOf(primary)).toEqual([])
    expect(second.registry.list(primary)).toEqual([])
    await expect(second.registry.add(primary, { path: join(fixture.base, 'other') })).rejects.toMatchObject({
      code: 'registry-contended',
    })
  })

  it('hands authority to the waiter after a clean exit, reading the last durable mutation', async () => {
    const { child, ready } = await spawnAuthority({ extra })
    expect(ready.granted).toEqual([canonicalPath(extra)])
    const second = await mountLocal()
    expect(second.registry.authority.kind).toBe('contended')

    child.stdin?.end()
    await waitExit(child)

    const statuses = await second.registry.refresh(primary)
    expect(second.registry.authority.kind).toBe('active')
    expect(statuses.map(status => status.path)).toEqual([canonicalPath(extra)])
    expect(second.scope.scopeOf(primary)).toEqual([canonicalPath(extra)])
  })

  it('hands authority to the waiter after SIGKILL, reading the last durable mutation', async () => {
    const { child, ready } = await spawnAuthority({ extra })
    expect(ready.granted).toEqual([canonicalPath(extra)])
    const second = await mountLocal()
    expect(second.registry.authority.kind).toBe('contended')

    const killed = child.kill('SIGKILL')
    expect(killed).toBe(true)
    await waitExit(child)

    const statuses = await second.registry.refresh(primary)
    expect(second.registry.authority.kind).toBe('active')
    expect(statuses.map(status => status.path)).toEqual([canonicalPath(extra)])
    expect(second.scope.scopeOf(primary)).toEqual([canonicalPath(extra)])
  })
})
