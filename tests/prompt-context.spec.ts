/**
 * Snapshot coverage for `renderWorkspaceRootsContext`: the model-facing
 * topology text must state exactly the authority the scope carries — per
 * platform, per sandbox mode, per root access, and per configured tool cap —
 * and must stay a pure function of those inputs.
 */

import { describe, expect, it } from 'vitest'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { renderWorkspaceRootsContext } from '../src/scope.ts'
import type { ScopeRoot } from '../src/scope.ts'

const PRIMARY = '/work/primary'
const A: ScopeRoot = { path: '/repos/a', access: 'read-write', id: 'root-rec-a' }
const B: ScopeRoot = { path: '/repos/b', access: 'read-only', id: 'root-rec-b' }

function render(platform: string, mode: SandboxMode, roots: readonly ScopeRoot[], cappedTools: readonly string[] = []): string {
  return renderWorkspaceRootsContext({ platform, mode, primaryRoot: PRIMARY, roots, cappedTools })
}

const MODES: SandboxMode[] = ['workspace-write', 'read-only', 'danger-full-access']
const PLATFORMS = ['darwin', 'linux', 'win32']

describe('renderWorkspaceRootsContext', () => {
  it('is empty without members, on every platform and mode', () => {
    for (const platform of PLATFORMS) {
      for (const mode of MODES) {
        expect(render(platform, mode, [])).toBe('')
      }
    }
  })

  it('describes writable and read-only members separately under workspace-write', () => {
    expect(render('linux', 'workspace-write', [A, B])).toMatchInlineSnapshot(
      `"Current DSH workspace roots: ["/repos/a"] are writable additional roots and ["/repos/b"] are read-only additional roots (writes are refused) of this session's workspace. The session origin remains the primary root ("/work/primary"); changing the working directory does not change these grants. Grant changes apply to later operations and newly started processes, not to processes already running."`,
    )
  })

  it('omits an empty access group rather than printing it', () => {
    expect(render('darwin', 'workspace-write', [A])).toMatchInlineSnapshot(
      `"Current DSH workspace roots: ["/repos/a"] are writable additional roots of this session's workspace. The session origin remains the primary root ("/work/primary"); changing the working directory does not change these grants. Grant changes apply to later operations and newly started processes, not to processes already running."`,
    )
    expect(render('darwin', 'workspace-write', [B])).toMatchInlineSnapshot(
      `"Current DSH workspace roots: ["/repos/b"] are read-only additional roots (writes are refused) of this session's workspace. The session origin remains the primary root ("/work/primary"); changing the working directory does not change these grants. Grant changes apply to later operations and newly started processes, not to processes already running."`,
    )
  })

  it('names capped tools and never claims they can write a read-write member', () => {
    expect(render('linux', 'workspace-write', [A], ['bash'])).toMatchInlineSnapshot(
      `"Current DSH workspace roots: ["/repos/a"] are writable additional roots of this session's workspace. The session origin remains the primary root ("/work/primary"); changing the working directory does not change these grants. Grant changes apply to later operations and newly started processes, not to processes already running. The tools ["bash"] cannot write additional roots even where they are writable."`,
    )
  })

  it('states membership and readability under read-only mode, with no write promise', () => {
    for (const platform of PLATFORMS) {
      expect(render(platform, 'read-only', [A, B])).toMatchInlineSnapshot(
        `"Current DSH workspace roots: ["/repos/a","/repos/b"] are additional roots of this session's workspace and are readable; nothing is writable in read-only mode."`,
      )
    }
  })

  it('states membership and the absence of isolation under danger-full-access', () => {
    for (const platform of PLATFORMS) {
      expect(render(platform, 'danger-full-access', [A, B])).toMatchInlineSnapshot(
        `"Current DSH workspace roots: ["/repos/a","/repos/b"] are additional roots of this session's workspace; danger-full-access mode has no sandbox isolation."`,
      )
    }
  })

  it('adds the Windows restricted-token caveat only on win32 and only under workspace-write', () => {
    expect(render('win32', 'workspace-write', [A, B])).toMatchInlineSnapshot(
      `"Current DSH workspace roots: ["/repos/a"] are writable additional roots and ["/repos/b"] are read-only additional roots (writes are refused) of this session's workspace. The session origin remains the primary root ("/work/primary"); changing the working directory does not change these grants. Grant changes apply to later operations and newly started processes, not to processes already running. Writable additional roots are enforced for shell processes by the upstream Windows ACL restricted-token sandbox, whose enforcement is reported as partial; reads are not confined by it."`,
    )
    expect(render('win32', 'workspace-write', [A], ['bash'])).toMatchInlineSnapshot(
      `"Current DSH workspace roots: ["/repos/a"] are writable additional roots of this session's workspace. The session origin remains the primary root ("/work/primary"); changing the working directory does not change these grants. Grant changes apply to later operations and newly started processes, not to processes already running. Writable additional roots are enforced for shell processes by the upstream Windows ACL restricted-token sandbox, whose enforcement is reported as partial; reads are not confined by it. The tools ["bash"] cannot write additional roots even where they are writable."`,
    )
    // The caveat is a confinement fact: it does not belong to the read-only
    // or danger-full-access sentences.
    expect(render('win32', 'read-only', [A])).not.toContain('restricted-token')
    expect(render('win32', 'danger-full-access', [A])).not.toContain('restricted-token')
  })

  it('is a pure function of its inputs and never renders host internals', () => {
    const roots: ScopeRoot[] = [{ ...A, alias: 'payments' }, B]
    const first = render('darwin', 'workspace-write', roots, ['bash'])
    expect(render('darwin', 'workspace-write', roots, ['bash'])).toBe(first)
    // Aliases, ids, store paths and SIDs are display/registry facts, not prompt
    // facts: none of them may appear in the contribution.
    expect(first).not.toContain('payments')
    expect(first).not.toContain(A.id)
    expect(first).not.toContain('S-1-')
  })

  it('never promises writes for invalid toolAccess on any platform, preserving mode and empty semantics', () => {
    for (const platform of PLATFORMS) {
      for (const mode of MODES) {
        const options = { platform, mode, primaryRoot: PRIMARY, cappedTools: [], toolAccessInvalid: true }
        expect(renderWorkspaceRootsContext({ ...options, roots: [] })).toBe('')
        const text = renderWorkspaceRootsContext({ ...options, roots: [A, B] })
        if (mode === 'workspace-write') {
          expect(text).toContain('all additional-root writes are refused because toolAccess is invalid')
          expect(text).not.toContain('are writable additional roots')
          expect(text).not.toContain('Writable additional roots are enforced')
        } else {
          expect(text).toBe(render(platform, mode, [A, B]))
        }
      }
    }
  })
})
