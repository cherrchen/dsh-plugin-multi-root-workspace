/**
 * Unit tests for the dialect adaptation module.
 *
 * These use HAND-WRITTEN profile arguments, copied from the shapes the pinned
 * provider actually produced (see `docs/reference/multi-root-workspace-research.md`
 * §10), so the module is pinned against the upstream spelling without deriving
 * its own expectations from the code under test. The provider-level integration
 * (real `super.confine` output) lives in `tests/sandbox-multi-root.spec.ts`, and
 * the cross-provider allow-matrix in `tests/parity-matrix.spec.ts`.
 */

import { describe, expect, it } from 'vitest'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { DialectUnrecognizedError, detectDialect, splitConfined, widenProfileArgs } from '../src/dialects.ts'

const WORKSPACE = '/ws'
const EXTRA = '/extra'
const EXTRA_TWO = '/extra-two'

function policy(mode: SandboxPolicy['mode'] = 'workspace-write', workspaceRoot = WORKSPACE): SandboxPolicy {
  return { mode, workspaceRoot }
}

const SEATBELT_PROFILE = '(version 1) (allow default) (deny file-write*) (allow file-write* (literal "/dev/null")) '
  + `(allow file-write* (subpath ${JSON.stringify(WORKSPACE)}) (subpath "/private/tmp") (subpath "/private/var/folders/T"))`
const SEATBELT = ['sandbox-exec', '-p', SEATBELT_PROFILE]
const BWRAP = ['bwrap', '--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent', '--tmpfs', '/tmp', '--bind', WORKSPACE, WORKSPACE]
const LANDLOCK = ['/usr/local/bin/landlock-run', '--ro', '/', '--rw', '/dev/null', '--rw', '/tmp', '--rw', WORKSPACE]
const WINDOWS_ACL = ['node', '/fake/runner.js', '--workspace', WORKSPACE, '--temp', '/tmp', '--mode', 'workspace-write']
const COMMAND = ['bash', '-c', 'echo hi']

describe('dialect recognition', () => {
  it('recognizes each upstream profile shape', () => {
    expect(detectDialect(SEATBELT)).toBe('seatbelt')
    expect(detectDialect(BWRAP)).toBe('bwrap')
    expect(detectDialect(LANDLOCK)).toBe('landlock')
    expect(detectDialect(WINDOWS_ACL)).toBe('windows-acl')
  })

  it('recognizes an operator runnerCommand profile as bwrap (the upstream config contract)', () => {
    expect(detectDialect(['my-runner', ...BWRAP.slice(1)])).toBe('bwrap')
  })

  it('refuses an unknown shape', () => {
    expect(() => detectDialect(['my-runner', '--profile', '/x'])).toThrow(DialectUnrecognizedError)
  })

  it('refuses an ambiguous shape', () => {
    expect(() => detectDialect(['-p', '--rw'])).toThrow(/ambiguous/)
  })
})

describe('confined argv splitting', () => {
  it('splits at the separator confine inserted', () => {
    const confined = [...SEATBELT, '--', ...COMMAND]
    const shape = splitConfined(confined, COMMAND)
    expect(shape.dialect).toBe('seatbelt')
    expect(shape.profileArgs).toEqual(SEATBELT)
    expect(shape.separator).toBe(SEATBELT.length)
    expect(shape.commandArgs).toEqual(COMMAND)
  })

  it('handles an empty caller argv', () => {
    const out = splitConfined([...BWRAP, '--'], [])
    expect(out.dialect).toBe('bwrap')
    expect(out.profileArgs).toEqual(BWRAP)
    expect(out.commandArgs).toEqual([])
  })

  it('refuses an argv that is not "[...profile, --, ...argv]"', () => {
    expect(() => splitConfined([...SEATBELT, ...COMMAND], COMMAND)).toThrow(DialectUnrecognizedError)
    expect(() => splitConfined([...SEATBELT, '--', 'bash', '-c', 'echo other'], COMMAND)).toThrow(/verbatim/)
  })
})

describe('seatbelt widening', () => {
  it('extends the observed subpath form with each additional root', () => {
    const widened = widenProfileArgs('seatbelt', SEATBELT, policy(), [EXTRA, EXTRA_TWO])
    expect(widened).toEqual([
      'sandbox-exec',
      '-p',
      `${SEATBELT_PROFILE.slice(0, -1)} (subpath ${JSON.stringify(EXTRA)}) (subpath ${JSON.stringify(EXTRA_TWO)}))`,
    ])
  })

  it('never grants a root the profile already grants', () => {
    expect(widenProfileArgs('seatbelt', SEATBELT, policy(), ['/private/tmp'])).toEqual(SEATBELT)
  })

  it('escapes backslashes and quotes exactly like the upstream builder', () => {
    const root = '/we"ird\\root'
    const widened = widenProfileArgs('seatbelt', SEATBELT, policy(), [root])
    expect(widened[2]).toContain(String.raw`(subpath "/we\"ird\\root")`)
  })

  it('fails loudly when the profile carries no subpath form to extend', () => {
    const readOnlyShaped = ['sandbox-exec', '-p', '(version 1) (allow default) (deny file-write*) (allow file-write* (literal "/dev/null"))']
    expect(() => widenProfileArgs('seatbelt', readOnlyShaped, policy(), [EXTRA])).toThrow(/no "\(allow file-write\* \(subpath …\)\)" form/)
  })

  it('fails loudly on a shape it does not recognize as seatbelt', () => {
    expect(() => widenProfileArgs('seatbelt', ['sandbox-exec', '-p'], policy(), [EXTRA])).toThrow(DialectUnrecognizedError)
  })})

describe('bwrap widening', () => {
  it('binds each additional root after the upstream root bind', () => {
    expect(widenProfileArgs('bwrap', BWRAP, policy(), [EXTRA, EXTRA_TWO]))
      .toEqual([...BWRAP, '--bind', EXTRA, EXTRA, '--bind', EXTRA_TWO, EXTRA_TWO])
  })

  it('clones the operator runner spelling when runnerCommand is configured', () => {
    const configured = ['my-runner', ...BWRAP.slice(1)]
    expect(widenProfileArgs('bwrap', configured, policy(), [EXTRA]))
      .toEqual([...configured, '--bind', EXTRA, EXTRA])
  })

  it('does not bind the real /tmp over the ephemeral tmpfs mount', () => {
    expect(widenProfileArgs('bwrap', BWRAP, policy(), ['/tmp'])).toEqual(BWRAP)
  })

  it('fails loudly when the profile has no writable bind of the policy root', () => {
    const readOnlyShaped = ['bwrap', '--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent']
    expect(() => widenProfileArgs('bwrap', readOnlyShaped, policy(), [EXTRA])).toThrow(/no writable bind of the policy root/)
  })

  it('never mistakes the read-only root mount for the writable bind', () => {
    // `--ro-bind / /` is the only doubled path when the policy root is `/`.
    const rooted = ['bwrap', '--ro-bind', '/', '/', '--tmpfs', '/tmp', '--bind', '/', '/']
    expect(widenProfileArgs('bwrap', rooted, policy('workspace-write', '/'), [EXTRA])).toEqual([...rooted, '--bind', EXTRA, EXTRA])
  })
})

describe('landlock widening', () => {
  it('clones the observed read-write flag per additional root', () => {
    expect(widenProfileArgs('landlock', LANDLOCK, policy(), [EXTRA, EXTRA_TWO]))
      .toEqual([...LANDLOCK, '--rw', EXTRA, '--rw', EXTRA_TWO])
  })

  it('never grants a path the launcher already grants read-write', () => {
    expect(widenProfileArgs('landlock', LANDLOCK, policy(), ['/tmp', '/dev/null'])).toEqual(LANDLOCK)
  })

  it('fails loudly when the policy root has no read-write grant', () => {
    const readOnlyShaped = ['/usr/local/bin/landlock-run', '--ro', '/', '--rw', '/dev/null']
    expect(() => widenProfileArgs('landlock', readOnlyShaped, policy(), [EXTRA])).toThrow(/no read-write grant of the policy root/)
  })
})

describe('the windows-acl rung and mode gating', () => {
  it('leaves the Windows ACL argv untouched (the provider warns once instead)', () => {
    expect(widenProfileArgs('windows-acl', WINDOWS_ACL, policy(), [EXTRA])).toEqual(WINDOWS_ACL)
  })

  it('refuses to widen outside workspace-write', () => {
    // `danger-full-access` never confines at all (bash and the PTY backend skip
    // `confine`), so `read-only` is the mode that must reach here and add nothing.
    expect(() => widenProfileArgs('bwrap', BWRAP, policy('read-only'), [EXTRA])).toThrow(/only under workspace-write/)
    expect(() => widenProfileArgs('bwrap', BWRAP, { mode: 'danger-full-access', workspaceRoot: WORKSPACE } as never, [EXTRA]))
      .toThrow(/only under workspace-write/)
  })

  it('returns an unchanged copy when the scope carries no additional roots', () => {
    const widened = widenProfileArgs('bwrap', BWRAP, policy(), [])
    expect(widened).toEqual(BWRAP)
    expect(widened).not.toBe(BWRAP)
  })
})
