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
import { DialectUnrecognizedError, denyProfileArgs, detectDialect, restrictProfileArgs, splitConfined, widenProfileArgs } from '../src/dialects.ts'

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

describe('seatbelt widening (POSIX argv)', () => {
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

describe('bwrap widening (POSIX argv)', () => {
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

describe('landlock widening (POSIX argv)', () => {
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
  it('requires the dedicated Windows capability runner', () => {
    expect(() => widenProfileArgs('windows-acl', WINDOWS_ACL, policy(), [EXTRA])).toThrow(/requires widenWindowsProfile/)
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

describe('deny ancestors (renaming a parent must not walk a tree past its deny)', () => {
  // The restricted SBPL is rebuilt from `(allow default)` onward — anything
  // the skeleton carries after it is replaced, never kept.
  const SKELETON_SBPL = '(version 1) (allow default) (deny file-write*)'
  const RESTRICTED_SBPL = '(version 1) (allow default)'
  const SKELETON_BWRAP = ['bwrap', '--ro-bind', '/', '/']

  it('pins every ancestor as a Seatbelt literal in the restricted profile', () => {
    const restricted = restrictProfileArgs('seatbelt', ['sandbox-exec', '-p', SKELETON_SBPL], ['/T/parent/root'])
    expect(restricted).toEqual(['sandbox-exec', '-p',
      `${RESTRICTED_SBPL} (deny file-write* (subpath "/T/parent/root") (literal "/T") (literal "/T/parent"))`])
  })

  it('dedupes shared ancestors and skips the filesystem root and the denied roots themselves', () => {
    const restricted = restrictProfileArgs('seatbelt', ['sandbox-exec', '-p', SKELETON_SBPL],
      ['/a/b', '/a/b/c', '/a/d'])
    expect(restricted[2]).toContain('(deny file-write* (subpath "/a/b") (subpath "/a/b/c") (subpath "/a/d") (literal "/a"))')
    expect(restricted[2]).not.toContain('(literal "/")')
    expect(restricted[2]).not.toContain('(literal "/a/b")')
  })

  it('emits no literal for a root directly under /', () => {
    const restricted = restrictProfileArgs('seatbelt', ['sandbox-exec', '-p', SKELETON_SBPL], ['/root'])
    expect(restricted[2]).toBe(`${RESTRICTED_SBPL} (deny file-write* (subpath "/root"))`)
  })

  it('keeps ancestor literals out of the deny form when no covered root exists (workspace-write)', () => {
    const widened = [...SEATBELT.slice(0, -1), `${SEATBELT_PROFILE}`]
    expect(denyProfileArgs('seatbelt', widened, ['/elsewhere/root'])).toEqual(widened)
  })

  it('pins ancestors of the covered roots only, inside the same deny form (workspace-write)', () => {
    const denied = denyProfileArgs('seatbelt', SEATBELT, ['/private/tmp/parent/root'])
    expect(denied[2]).toContain('(deny file-write* (subpath "/private/tmp/parent/root")'
      + ' (literal "/private") (literal "/private/tmp") (literal "/private/tmp/parent"))')
  })

  it('self-binds every ancestor before the ro-binds in the restricted bwrap profile', () => {
    expect(restrictProfileArgs('bwrap', SKELETON_BWRAP, ['/a/b/root', '/c/root']))
      .toEqual(['bwrap', '--bind', '/', '/', '--die-with-parent',
        '--bind', '/a', '/a', '--bind', '/c', '/c', '--bind', '/a/b', '/a/b',
        '--ro-bind', '/a/b/root', '/a/b/root', '--ro-bind', '/c/root', '/c/root'])
  })

  it('pins ancestors in the Landlock → bwrap fallback the same way', () => {
    expect(restrictProfileArgs('landlock', ['/landlock-run', '--ro', '/'], ['/a/b/root']))
      .toEqual(['bwrap', '--bind', '/', '/', '--die-with-parent',
        '--bind', '/a', '/a', '--bind', '/a/b', '/a/b',
        '--ro-bind', '/a/b/root', '/a/b/root'])
  })

  it('self-binds a covered root\'s renamable ancestors before the ro-binds (workspace-write)', () => {
    const profile = ['bwrap', '--ro-bind', '/', '/', '--bind', '/work', '/work']
    expect(denyProfileArgs('bwrap', profile, ['/work/parent/root']))
      .toEqual([...profile, '--bind', '/work/parent', '/work/parent', '--ro-bind', '/work/parent/root', '/work/parent/root'])
  })

  it('never self-binds an ancestor inside a --tmpfs target', () => {
    const profile = ['bwrap', '--ro-bind', '/', '/', '--tmpfs', '/tmp', '--bind', '/work', '/work']
    expect(denyProfileArgs('bwrap', profile, ['/tmp/parent/root']))
      .toEqual([...profile, '--ro-bind', '/tmp/parent/root', '/tmp/parent/root'])
  })

  it('never self-binds an ancestor at or outside the writable bind targets', () => {
    const profile = ['bwrap', '--ro-bind', '/', '/', '--bind', '/work', '/work']
    // `/work` IS a mountpoint already and `/` is outside every writable target.
    expect(denyProfileArgs('bwrap', profile, ['/work/root']))
      .toEqual([...profile, '--ro-bind', '/work/root', '/work/root'])
  })

  it('does no profile work for a denied root no grant covers (workspace-write)', () => {
    const profile = ['bwrap', '--ro-bind', '/', '/', '--bind', '/work', '/work']
    expect(denyProfileArgs('bwrap', profile, ['/elsewhere/parent/root'])).toEqual(profile)
  })
})
