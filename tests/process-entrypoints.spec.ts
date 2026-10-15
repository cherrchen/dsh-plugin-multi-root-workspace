/**
 * Unit tests for the process-entrypoint adapter.
 *
 * The process fence wraps every public entry through which a Full-access call
 * can spawn a subprocess; which entries a mounted service exposes is a
 * per-release shape, so the adapter probes structure (is the member a
 * function?) and never a version string.
 */

import { describe, expect, it } from 'vitest'
import { ptcEntrypoints, shellEntrypoints } from '../src/compat/process-entrypoints.ts'

const noop = (): void => undefined

describe('shellEntrypoints', () => {
  it('reports execute-only shells', () => {
    expect(shellEntrypoints({ execute: noop })).toEqual(['execute'])
  })

  it('reports a legacy shell that still exposes start alongside execute', () => {
    expect(shellEntrypoints({ execute: noop, start: noop })).toEqual(['execute', 'start'])
  })

  it('reports a shell that exposes run, in the fixed execute → run → start order', () => {
    expect(shellEntrypoints({ run: noop, execute: noop, start: noop })).toEqual(['execute', 'run', 'start'])
    expect(shellEntrypoints({ run: noop })).toEqual(['run'])
  })

  it('ignores non-function properties', () => {
    expect(shellEntrypoints({ execute: 'x', run: 42, start: null })).toEqual([])
    expect(shellEntrypoints({ execute: { apply: noop } })).toEqual([])
  })
})

describe('ptcEntrypoints', () => {
  it('reports only the public run entry, never the private execute helper', () => {
    expect(ptcEntrypoints({ run: noop, execute: noop })).toEqual(['run'])
  })

  it('reports nothing when run is absent or not a function', () => {
    expect(ptcEntrypoints({ execute: noop })).toEqual([])
    expect(ptcEntrypoints({ run: 'not a function' })).toEqual([])
  })
})
