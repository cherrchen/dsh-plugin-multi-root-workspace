/**
 * The multilingual gate for this plugin's own client copy.
 *
 * The upstream repository enforces dictionary parity across its own packages;
 * an out-of-tree bundle gets no such sweep, so it carries its own. Chinese is
 * the canonical shape here (`Key` is `keyof typeof zh`) and every other
 * language is pinned by `satisfies`, but neither is a runtime guarantee — a key
 * can be present in one language and missing in another the moment someone
 * edits a file, and the panel would then render a bare key to a user. This spec
 * reads every dictionary off the same modules the bundle builds from and
 * compares them, placeholders included.
 */

import { describe, expect, it } from 'vitest'
import { DICTIONARIES, NS, en, zh } from '../src/client/locales.ts'

/** The languages DSH ships in the box, in the order its language menu lists them. */
const LOCALES = ['zh', 'en', 'ja', 'es', 'fr', 'de', 'ru', 'pt'] as const

/** Every placeholder token a template can carry. */
function placeholders(value: string): string[] {
  return [...value.matchAll(/\{[a-zA-Z]+\}/gu)].map(match => match[0]).sort()
}

describe('panel dictionaries', () => {
  it('owns a namespace of its own', () => {
    expect(NS).toBe('multiRootWorkspace')
  })

  it('ships exactly the eight languages the DSH client offers', () => {
    expect(Object.keys(DICTIONARIES)).toEqual([...LOCALES])
    for (const locale of LOCALES) {
      expect(Object.keys(DICTIONARIES[locale]).length).toBeGreaterThan(20)
    }
  })

  it('covers exactly the canonical keys in every language', () => {
    const zhKeys = Object.keys(zh).sort()
    for (const locale of LOCALES) {
      expect(Object.keys(DICTIONARIES[locale]).sort(), locale).toEqual(zhKeys)
    }
  })

  it('keeps every entry on one physical line', () => {
    for (const locale of LOCALES) {
      for (const [key, value] of Object.entries(DICTIONARIES[locale])) {
        expect(value.includes('\n'), `${locale}/${key} must not contain a newline`).toBe(false)
      }
    }
  })

  it('ships no empty string', () => {
    for (const locale of LOCALES) {
      for (const [key, value] of Object.entries(DICTIONARIES[locale])) {
        expect(value.trim(), `${locale}/${key} must not be blank`).not.toBe('')
      }
    }
  })

  it('keeps the canonical placeholders in every translation', () => {
    for (const [key, value] of Object.entries(zh)) {
      for (const locale of LOCALES) {
        expect(placeholders(DICTIONARIES[locale][key]), `${locale}/${key}`).toEqual(placeholders(value))
      }
    }
  })

  it('actually translates instead of copying the Chinese text into English', () => {
    const identical = Object.keys(zh).filter(key => zh[key as keyof typeof zh] === en[key as keyof typeof en])
    // Only copy that is genuinely language-neutral may be identical; today that
    // is the empty set, and a growing set means untranslated copy.
    expect(identical).toEqual([])
  })

  it('does not leave a language on the English copy', () => {
    // A handful of entries are language-neutral by construction: the access
    // caption is a pure format string, "Experimental" is the ordinary Spanish
    // and Portuguese word, and the pinned permission/worktree tokens
    // (`Full-access`, `Main checkout`) stay verbatim on purpose. Everything
    // else matching English means the translation never happened.
    const neutral = new Set([
      'panel.accessEffective',
      'autoReview.experimental',
      'ops.experimental',
      'worktree.experimental',
      'effective.full-access',
      'worktree.kind.main-checkout',
    ])
    const keys = Object.keys(en) as (keyof typeof en)[]
    for (const locale of LOCALES.filter((id): id is Exclude<(typeof LOCALES)[number], 'en'> => id !== 'en')) {
      const identical = keys.filter(key => !neutral.has(key) && DICTIONARIES[locale][key] === en[key])
      expect(identical, `${locale} still copies English entries: ${identical.join(', ')}`).toHaveLength(0)
    }
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
      'registry-contended',
      'reveal-unavailable',
      'session-not-found',
      'session-not-live',
      'unsupported-path',
      'unavailable',
      'copy-failed',
      'fallback',
    ]) {
      for (const locale of LOCALES) {
        expect(Object.keys(DICTIONARIES[locale]), `${locale}: error.${code} must be translated`).toContain(`error.${code}`)
      }
    }
  })

  it('covers every state the panel renders', () => {
    for (const state of ['available', 'missing', 'invalid']) {
      for (const locale of LOCALES) {
        expect(Object.keys(DICTIONARIES[locale]), `${locale}: state.${state}`).toContain(`state.${state}`)
      }
    }
  })
})
