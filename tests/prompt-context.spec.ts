/**
 * Snapshot coverage for `renderWorkspaceRootsContext`: the model-facing
 * topology text must state exactly the authority the scope carries — per
 * platform, per sandbox mode, per root access, and per configured tool cap —
 * and must stay a pure function of those inputs.
 */

import { describe, expect, it } from 'vitest'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { REGISTRY_UNAVAILABLE_NOTE, renderWorkspaceRootsContext } from '../src/scope.ts'
import type { ScopeRoot } from '../src/scope.ts'

const PRIMARY = '/work/primary'
const A: ScopeRoot = { path: '/repos/a', access: 'read-write', id: 'root-rec-a' }
const B: ScopeRoot = { path: '/repos/b', access: 'read-only', id: 'root-rec-b' }
const C: ScopeRoot = { path: '/repos/c', access: 'inherit', id: 'root-rec-c' }

function render(platform: string, mode: SandboxMode, roots: readonly ScopeRoot[], cappedTools: readonly string[] = []): string {
  return renderWorkspaceRootsContext({ platform, mode, primaryRoot: PRIMARY, roots, cappedTools })
}

const MODES: SandboxMode[] = ['workspace-write', 'read-only', 'danger-full-access']
const PLATFORMS = ['darwin', 'linux', 'win32']

describe('renderWorkspaceRootsContext', () => {
  it('describes configured caps in all modes, including fixed writes and Full-access inheritance', () => {
    for (const mode of MODES) {
      expect(render('linux', mode, [A, B, C], ['bash', 'run_code']))
        .toContain('The tools ["bash","run_code"] cannot write additional roots even where they are writable.')
    }
  })
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

  it('names the fixed read-write members a read-only session keeps writable', () => {
    for (const platform of PLATFORMS) {
      expect(render(platform, 'read-only', [A, B])).toMatchInlineSnapshot(
        `"Current DSH workspace roots: ["/repos/a"] are additional roots that stay writable even in read-only mode, and ["/repos/b"] are readable additional roots of this session's workspace; everything else is read-only."`,
      )
    }
  })

  it('promises nothing writable under read-only when no member is pinned read-write', () => {
    for (const platform of PLATFORMS) {
      expect(render(platform, 'read-only', [C, B])).toMatchInlineSnapshot(
        `"Current DSH workspace roots: ["/repos/c","/repos/b"] are additional roots of this session's workspace and are readable; nothing is writable in read-only mode."`,
      )
    }
  })

  it('states the absence of isolation under danger-full-access, except the read-only members', () => {
    for (const platform of PLATFORMS) {
      expect(render(platform, 'danger-full-access', [A, B])).toMatchInlineSnapshot(
        `"Current DSH workspace roots: ["/repos/a","/repos/b"] are additional roots of this session's workspace; danger-full-access mode has no sandbox isolation, except writes under the additional roots ["/repos/b"] are still refused."`,
      )
      expect(render(platform, 'danger-full-access', [A, C])).toMatchInlineSnapshot(
        `"Current DSH workspace roots: ["/repos/a","/repos/c"] are additional roots of this session's workspace; danger-full-access mode has no sandbox isolation."`,
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

  it('states the Full-access downgrade while the registry authority is unavailable', () => {
    for (const platform of PLATFORMS) {
      const options = { platform, mode: 'danger-full-access' as const, primaryRoot: PRIMARY, cappedTools: [] }
      expect(renderWorkspaceRootsContext({ ...options, roots: [], authority: 'unavailable' }))
        .toBe(REGISTRY_UNAVAILABLE_NOTE)
      // With members the note still comes first, ahead of the topology text.
      expect(renderWorkspaceRootsContext({ ...options, roots: [A, C], authority: 'unavailable' }))
        .toBe(`${REGISTRY_UNAVAILABLE_NOTE} Current DSH workspace roots: ["/repos/a","/repos/c"] are additional roots of this session's workspace; danger-full-access mode has no sandbox isolation.`)
    }
  })

  it('contributes nothing for an unavailable authority outside Full-access', () => {
    for (const platform of PLATFORMS) {
      for (const mode of ['workspace-write', 'read-only'] as const) {
        expect(renderWorkspaceRootsContext({ platform, mode, primaryRoot: PRIMARY, roots: [], cappedTools: [], authority: 'unavailable' }))
          .toBe('')
      }
    }
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
        } else if (mode === 'read-only') {
          // An invalid cap refuses every additional-root write: even a member
          // pinned read-write gets no write promise.
          expect(text).toContain('nothing is writable in read-only mode')
          expect(text).not.toContain('stay writable')
        } else {
          expect(text).toContain('writes under the additional roots ["/repos/a","/repos/b"] are still refused because toolAccess is invalid')
        }
      }
    }
  })
})
