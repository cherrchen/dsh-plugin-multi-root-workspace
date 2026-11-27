/**
 * The `filePreview` draft flag's serialization rules (ADR-0053): the wire
 * field exists only while read AND stable-path listing hold, so a draft that
 * lost a prerequisite can never silently re-gain preview — the same posture
 * the checkbox cascade keeps in the editors.
 */
import { describe, expect, it } from 'vitest'
import { bindingDraftOf, blankBinding, type BindingDraft } from '../src/client/ssh-draft.ts'

const draft = (patch: Partial<BindingDraft> = {}): BindingDraft => ({
  ...blankBinding('env-prod'),
  path: '/srv/app',
  ...patch,
})

describe('bindingDraftOf filePreview serialization', () => {
  it('defaults off: a blank binding serializes no preview field', () => {
    expect(blankBinding('env-prod').filePreview).toBe(false)
    const wire = bindingDraftOf(draft())
    expect(wire).toEqual({ environmentId: 'env-prod', path: '/srv/app', actions: ['read'] })
    expect('filePreview' in wire).toBe(false)
  })

  it('serializes stable-path only while read AND listing hold', () => {
    const wire = bindingDraftOf(draft({ directoryListing: true, filePreview: true }))
    expect(wire.filePreview).toBe('stable-path')
    expect(wire.directoryListing).toBe('stable-path')
  })

  it('drops the flag when listing is off, even with read on', () => {
    const wire = bindingDraftOf(draft({ filePreview: true, directoryListing: false }))
    expect(wire.directoryListing).toBeUndefined()
    expect(wire.filePreview).toBeUndefined()
  })

  it('drops the flag when read is off, even with listing on', () => {
    const wire = bindingDraftOf(draft({ read: false, write: true, directoryListing: true, filePreview: true }))
    // Listing without read already serializes nothing for either opt-in.
    expect(wire.filePreview).toBeUndefined()
    expect(wire.actions).toEqual(['write'])
  })

  it('preserves the opt-in through unrelated field edits', () => {
    const wire = bindingDraftOf(draft({
      directoryListing: true, filePreview: true,
      imports: new Set(['payments']),
    }))
    expect(wire.filePreview).toBe('stable-path')
    expect(wire.transfers).toEqual([{ direction: 'import', peer: { environmentId: 'local', rootId: 'payments' } }])
  })
})
