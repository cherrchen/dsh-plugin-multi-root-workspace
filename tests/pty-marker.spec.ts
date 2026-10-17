/**
 * The agent-PTY marker contract probe.
 *
 * `spawnTerminal` can only tell an agent terminal from the user's own because
 * `dsh-terminal-bash` stamps `DSH_PTY_SESSION_ID` into the agent PTY's spawn
 * env and the panel controller never does. The marker is an env key inside
 * upstream's emitted code — no export to probe — so the gate reads the
 * installed package's sources for the stamp. These specs pin the probe's own
 * failure semantics: an absent backend is vacuously fine, but an installed
 * backend whose marker cannot be confirmed is a refused composition, never a
 * silently unconfined one.
 */

import { describe, expect, it } from 'vitest'
import {
  AGENT_PTY_MARKER,
  agentPtyMarkerVerdict,
  assertAgentPtyMarker,
  PtyMarkerContractError,
  type AgentPtyMarkerIo,
} from '../src/compat/pty-marker.ts'

/** An in-memory backend tree. */
function fakeIo(files: Record<string, string> | undefined): AgentPtyMarkerIo {
  return {
    resolveBackendRoot: () => (files === undefined ? undefined : '/backend'),
    listSources: () => Object.keys(files ?? {}),
    read: path => {
      const content = files?.[path]
      if (content === undefined) throw new Error(`unreadable: ${path}`)
      return content
    },
  }
}

describe('the agent-PTY marker probe', () => {
  it('reports the installed backend stamped when its emitted code writes the marker', () => {
    expect(agentPtyMarkerVerdict(fakeIo({
      '/backend/lib/index.js': `env: { DSH_SESSION_ID: spec.owner.id, ${AGENT_PTY_MARKER}: spec.sessionId }`,
    }))).toBe('stamped')
  })

  it('finds the marker in any emitted file, not just the entry', () => {
    expect(agentPtyMarkerVerdict(fakeIo({
      '/backend/lib/index.js': 'export * from "./pty.js"',
      '/backend/lib/pty.js': `spawnTerminal({ env: { ${AGENT_PTY_MARKER}: id } })`,
    }))).toBe('stamped')
  })

  it('is uninstalled — vacuously satisfied — when the backend does not resolve', () => {
    expect(agentPtyMarkerVerdict(fakeIo(undefined))).toBe('uninstalled')
    expect(() => assertAgentPtyMarker(fakeIo(undefined))).not.toThrow()
  })

  it('is unverifiable when the installed backend never writes the marker', () => {
    const io = fakeIo({ '/backend/lib/index.js': 'env: { DSH_SESSION_ID: spec.owner.id }' })
    expect(agentPtyMarkerVerdict(io)).toBe('unverifiable')
    try {
      assertAgentPtyMarker(io)
      expect.unreachable('an unstamped installed backend must refuse the composition')
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(PtyMarkerContractError)
      expect((error as PtyMarkerContractError).backend).toBe('/backend')
      expect((error as Error).message).toContain(AGENT_PTY_MARKER)
    }
  })

  it('is unverifiable when a source cannot be read — never "absent means fine"', () => {
    const io: AgentPtyMarkerIo = {
      resolveBackendRoot: () => '/backend',
      listSources: () => ['/backend/lib/index.js'],
      read: () => { throw new Error('EIO') },
    }
    expect(agentPtyMarkerVerdict(io)).toBe('unverifiable')
    expect(() => assertAgentPtyMarker(io)).toThrow(PtyMarkerContractError)
  })

  it('is unverifiable when listing the package tree itself fails', () => {
    const io: AgentPtyMarkerIo = {
      resolveBackendRoot: () => '/backend',
      listSources: () => { throw new Error('ENOTDIR') },
      read: () => '',
    }
    expect(agentPtyMarkerVerdict(io)).toBe('unverifiable')
  })

  it('is unverifiable — not uninstalled — when resolution fails for a non-NOT_FOUND reason', () => {
    const io: AgentPtyMarkerIo = {
      resolveBackendRoot: () => { throw new Error('exports violation') },
      listSources: () => [],
      read: () => '',
    }
    expect(agentPtyMarkerVerdict(io)).toBe('unverifiable')
  })

  it('verifies the marker on the backend this repository actually installs', () => {
    // The dev pin carries the stamp on every supported release; this is the
    // live structural assertion that keeps the contract honest on the pin —
    // and what the upgrade lane re-runs against a candidate release.
    expect(agentPtyMarkerVerdict()).toBe('stamped')
  })
})
