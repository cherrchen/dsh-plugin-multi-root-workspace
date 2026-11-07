/** The local binary write port: staging, read-back, no-replace publish, refusals. */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalBinarySink, LocalTransferError, type LocalDestinationAuthority } from '../src/remote/local-sink.ts'
import { createFixtureWorkspace, type FixtureWorkspace } from './support/temp-workspace.ts'

let fixture: FixtureWorkspace
beforeEach(() => { fixture = createFixtureWorkspace('local-sink') })
afterEach(() => fixture.dispose())

const authority = (over: Partial<LocalDestinationAuthority> = {}): LocalDestinationAuthority =>
  ({ rootId: 'primary', root: fixture.workspace, access: 'primary', deny: [], ...over })
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex')
const codeOf = (fn: () => unknown): string | undefined => {
  try { fn() } catch (error) { return (error as LocalTransferError).code }
  return undefined
}

// The local binary sink is POSIX-only by contract (ADR-0034); Windows
// initiators are deferred (ADR-0030). The direction is exercised on the
// POSIX lanes and the refusal itself is covered by the transfer suite.
describe.skipIf(process.platform === 'win32')('LocalBinarySink', () => {
  it('stages, verifies and publishes with a no-replace link', () => {
    const sink = LocalBinarySink.open(authority(), 'out.bin', 'op-1', 1024)
    try {
      sink.write(Buffer.from('hello-'))
      sink.write(Buffer.from('sink'))
      sink.finish()
      expect(sink.verify(sha('hello-sink'))).toBe(true)
      expect(readFileSync(join(fixture.workspace, '.dsh-staging-op-1'), 'utf8')).toBe('hello-sink')
      expect(sink.publish()).toBe('removed')
      expect(readFileSync(join(fixture.workspace, 'out.bin'), 'utf8')).toBe('hello-sink')
      expect(existsSync(join(fixture.workspace, '.dsh-staging-op-1'))).toBe(false)
      expect(statSync(join(fixture.workspace, 'out.bin')).mode & 0o777).toBe(0o600)
    } finally { sink.close() }
  })

  it('creates directories only when the relative path names a nested file', () => {
    mkdirSync(join(fixture.workspace, 'a', 'b'), { recursive: true })
    const sink = LocalBinarySink.open(authority(), 'a/b/out.bin', 'op-2', 1024)
    try {
      sink.write(Buffer.from('nested')); sink.finish()
      expect(sink.publish()).toBe('removed')
      expect(readFileSync(join(fixture.workspace, 'a', 'b', 'out.bin'), 'utf8')).toBe('nested')
    } finally { sink.close() }
  })

  it('never overwrites an existing target', () => {
    writeFileSync(join(fixture.workspace, 'out.bin'), 'keep')
    expect(codeOf(() => LocalBinarySink.open(authority(), 'out.bin', 'op-3', 1024))).toBe('target-exists')
    expect(readFileSync(join(fixture.workspace, 'out.bin'), 'utf8')).toBe('keep')
  })

  it('refuses a symlinked parent, a missing parent, and a redirected root', () => {
    mkdirSync(join(fixture.workspace, 'real'))
    symlinkSync(join(fixture.workspace, 'real'), join(fixture.workspace, 'link'))
    expect(codeOf(() => LocalBinarySink.open(authority(), 'link/out.bin', 'op-4', 1024))).toBe('destination-symlinked')
    expect(codeOf(() => LocalBinarySink.open(authority(), 'missing/out.bin', 'op-5', 1024))).toBe('destination-parent-missing')
    symlinkSync(fixture.workspace, join(fixture.base, 'alias'))
    expect(codeOf(() => LocalBinarySink.open(authority({ root: join(fixture.base, 'alias') }), 'out.bin', 'op-6', 1024))).toBe('local-root-redirected')
  })

  it('refuses an invalid relative path, the staging namespace, and every protected boundary', () => {
    expect(codeOf(() => LocalBinarySink.open(authority(), '../escape', 'op-7', 1024))).toBe('invalid-relative-path')
    expect(codeOf(() => LocalBinarySink.open(authority(), '.dsh-staging-op-7', 'op-7', 1024))).toBe('reserved-name')
    expect(codeOf(() => LocalBinarySink.open(authority({ deny: [fixture.workspace] }), 'out.bin', 'op-8', 1024))).toBe('protected-path')
  })

  it('bounds the staged bytes by the transfer budget', () => {
    const sink = LocalBinarySink.open(authority(), 'out.bin', 'op-9', 4)
    try {
      expect(() => sink.write(Buffer.from('12345'))).toThrowError(LocalTransferError)
      expect(sink.cleanup()).toBe('removed')
      expect(existsSync(join(fixture.workspace, 'out.bin'))).toBe(false)
    } finally { sink.close() }
  })

  it('detects staged bytes replaced after the write and cleans only its own name', () => {
    const sink = LocalBinarySink.open(authority(), 'out.bin', 'op-10', 1024)
    try {
      sink.write(Buffer.from('payload')); sink.finish()
      writeFileSync(join(fixture.workspace, '.dsh-staging-op-10'), 'tampered')
      expect(sink.verify(sha('payload'))).toBe(false)
      expect(sink.cleanup()).toBe('removed')
      expect(existsSync(join(fixture.workspace, 'out.bin'))).toBe(false)
    } finally { sink.close() }
  })

  it('never deletes another operation\'s staging name', () => {
    writeFileSync(join(fixture.workspace, '.dsh-staging-op-13'), 'someone-else')
    expect(codeOf(() => LocalBinarySink.open(authority(), 'out.bin', 'op-13', 1024))).toBe('staging-unavailable')
    expect(readFileSync(join(fixture.workspace, '.dsh-staging-op-13'), 'utf8')).toBe('someone-else')
  })

  it('refuses to publish when the parent was replaced after staging', () => {
    mkdirSync(join(fixture.workspace, 'sub'))
    const sink = LocalBinarySink.open(authority(), 'sub/out.bin', 'op-11', 1024)
    try {
      sink.write(Buffer.from('payload')); sink.finish()
      renameSync(join(fixture.workspace, 'sub'), join(fixture.workspace, 'sub-moved'))
      mkdirSync(join(fixture.workspace, 'sub'))
      expect(codeOf(() => sink.publish())).toBe('destination-changed')
      expect(sink.cleanup()).toBe('residual')
      expect(existsSync(join(fixture.workspace, 'sub', 'out.bin'))).toBe(false)
    } finally { sink.close() }
  })

  it('leaves a replaced staging name alone and reports residual', () => {
    const sink = LocalBinarySink.open(authority(), 'out.bin', 'op-12', 1024)
    try {
      sink.write(Buffer.from('payload')); sink.finish()
      const staging = join(fixture.workspace, '.dsh-staging-op-12')
      unlinkSync(staging)
      writeFileSync(staging, 'not-ours')
      expect(codeOf(() => sink.publish())).toBe('staging-changed')
      expect(sink.cleanup()).toBe('residual')
      expect(readFileSync(staging, 'utf8')).toBe('not-ours')
    } finally { sink.close() }
  })
})
