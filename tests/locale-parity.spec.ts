/**
 * The bilingual gate for this plugin's own client copy.
 *
 * The upstream repository enforces dictionary parity across its own packages;
 * an out-of-tree bundle gets no such sweep, so it carries its own. Chinese is
 * the canonical shape here (`Key` is `keyof typeof zh`) and English is pinned by
 * `satisfies`, but neither is a runtime guarantee — a key can be present in one
 * language and missing in the other the moment someone edits the file, and the
 * panel would then render a bare key to a user. This spec reads BOTH
 * dictionaries off the same module the bundle builds from and compares them.
 */

import { describe, expect, it } from 'vitest'
import { NS, en, zh } from '../src/client/locales.ts'

describe('panel dictionaries', () => {
  it('owns a namespace of its own', () => {
    expect(NS).toBe('multiRootWorkspace')
  })

  it('covers exactly the same keys in both languages', () => {
    const zhKeys = Object.keys(zh).sort()
    const enKeys = Object.keys(en).sort()
    expect(enKeys).toEqual(zhKeys)
  })

  it('ships no empty string', () => {
    for (const [key, value] of [...Object.entries(zh), ...Object.entries(en)]) {
      expect(value.trim(), `${key} must not be blank`).not.toBe('')
    }
  })

  it('actually translates instead of copying the Chinese text into English', () => {
    const identical = Object.keys(zh).filter(key => zh[key as keyof typeof zh] === en[key as keyof typeof en])
    // Only copy that is genuinely language-neutral may be identical; today that
    // is the empty set, and a growing set means untranslated copy.
    expect(identical).toEqual([])
  })

  it('covers every failure code the root vocabulary can produce', () => {
    for (const code of [
      'not-absolute',
      'missing',
      'not-a-directory',
      'equals-primary',
      'duplicate',
      'nested',
      'invalid-alias',
      'not-found',
      'invalid-ref',
      'storage-unavailable',
      'unavailable',
      'fallback',
    ]) {
      expect(Object.keys(zh), `error.${code} must be translated`).toContain(`error.${code}`)
    }
  })

  it('covers every state the panel renders', () => {
    for (const state of ['available', 'missing', 'invalid']) {
      expect(Object.keys(zh)).toContain(`state.${state}`)
    }
  })
})
