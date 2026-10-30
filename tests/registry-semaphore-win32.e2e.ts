/** Real Windows semaphore lifetime, including a paused contender's open handle. */
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, afterEach, expect, it } from 'vitest'
import { createFixtureWorkspace, type FixtureWorkspace } from './support/temp-workspace.ts'
import { SharedHost } from './support/shared-host.ts'
let fixture: FixtureWorkspace, hosts: SharedHost[], waiter: ChildProcess | undefined
beforeEach(() => { fixture = createFixtureWorkspace('semaphore'); hosts = [] })
afterEach(async () => {
  if (waiter && waiter.exitCode === null && waiter.signalCode === null) {
    const exited = once(waiter, 'exit'); waiter.kill('SIGKILL'); await exited
  }
  await Promise.allSettled(hosts.map(host => host.kill()))
  fixture.dispose(); waiter = undefined
})
it.runIf(process.platform === 'win32')('recovers after the crashed holder and the paused waiter have both closed their handles', async () => {
  const root = join(fixture.base, 'store')
  const owner = new SharedHost(root, fixture.workspace); hosts.push(owner); await owner.ready
  const follower = new SharedHost(root, fixture.workspace); hosts.push(follower); await follower.ready
  await owner.request('add', [fixture.outside]); await follower.request('list')
  waiter = spawn(process.execPath, ['--experimental-transform-types', fileURLToPath(new URL('./support/windows-semaphore-waiter.ts', import.meta.url)), join(root, 'multi_root_workspace.lock')], { stdio: ['pipe', 'pipe', 'pipe'] })
  let output = '', stderr = ''
  const ready = Promise.withResolvers<void>()
  waiter.stdout!.on('data', data => { output += data; if (output.includes('waiter-holds-handle')) ready.resolve() })
  waiter.stderr!.on('data', data => { stderr = (stderr + data).slice(-8192) })
  waiter.once('error', ready.reject)
  waiter.once('exit', () => { if (!output.includes('waiter-holds-handle')) ready.reject(new Error(stderr)) })
  await ready.promise
  await owner.kill()
  expect(await follower.request('list')).toEqual([])
  expect(await follower.request('authority')).toMatchObject({ kind: 'contended' })
  await expect(follower.request('write', [join(fixture.outside, 'must-not-land'), 'no'])).rejects.toThrow()
  const exited = once(waiter, 'close')
  waiter.stdin!.end('resume\n'); await exited
  expect(waiter.exitCode, stderr).toBe(0)
  expect(output).toContain('waiter-closed-handle')
  expect(await follower.request('list')).toHaveLength(1)
  expect(await follower.request('authority')).toMatchObject({ kind: 'active' })
  await follower.request('write', [join(fixture.outside, 'after-last-close'), 'recovered'])
}, 30_000)
