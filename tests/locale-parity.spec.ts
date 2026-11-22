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

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
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
    // OS product names are proper nouns and stay identical in both languages;
    // every other identical value is untranslated copy.
    const languageNeutral = new Set(['ssh.platform.linux', 'ssh.platform.darwin', 'ssh.step.helper'])
    const identical = Object.keys(zh).filter(key =>
      !languageNeutral.has(key) && zh[key as keyof typeof zh] === en[key as keyof typeof en])
    expect(identical).toEqual([])
  })

  it('allows identical English technical labels only in the languages that use them', () => {
    const shared = ['ssh.platform.linux', 'ssh.platform.darwin', 'ssh.step.helper'] as const
    const experimental = ['autoReview.experimental', 'ops.experimental', 'worktree.experimental', 'remote.experimental'] as const
    const workspace = ['panel.accessEffective', 'ssh.errorField'] as const
    const checkout = ['effective.full-access', 'worktree.kind.main-checkout'] as const
    const neutral = {
      zh: shared,
      ja: shared,
      es: [...shared, ...experimental, ...workspace],
      fr: [...shared, 'panel.accessEffective', 'ssh.field.port', 'ssh.tab.keys'],
      de: [...shared, ...workspace, ...checkout, 'remote.mode.team', 'ssh.field.hostname', 'ssh.field.port'],
      ru: [...shared, ...workspace],
      pt: [...shared, ...experimental, ...workspace, ...checkout],
    } satisfies Record<Exclude<(typeof LOCALES)[number], 'en'>, readonly (keyof typeof en)[]>
    const keys = Object.keys(en) as (keyof typeof en)[]
    for (const locale of LOCALES) {
      if (locale === 'en') continue
      const allowed = new Set<keyof typeof en>(neutral[locale])
      const identical = keys.filter(key => !allowed.has(key) && DICTIONARIES[locale][key] === en[key])
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

  it('translates every literal error code the host can emit', () => {
    // Codes reach the panel verbatim inside `error.<code>` lookups; a code
    // without a key silently renders as `error.fallback`. Enumerate the
    // throw sites instead of a hand-maintained list so a new code fails
    // here the day it lands.
    const codedErrors = new Set([
      'AuthorityRpcError',
      'CredentialError',
      'ManifestError',
      'PanelError',
      'RemoteAdmissionError',
      'RemoteOperationError',
      'RootValidationError',
      'SshEnvironmentError',
      'WorktreeError',
    ])
    const source = join(import.meta.dirname, '..', 'src')
    const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
      entry.isDirectory() ? files(join(dir, entry.name)) : entry.name.endsWith('.ts') ? [join(dir, entry.name)] : [])
    const thrown = new Set<string>()
    const pattern = new RegExp(`new (?:${[...codedErrors].join('|')})\\(\\s*['"\`]([a-zA-Z][a-zA-Z0-9/_-]*)`, 'g')
    for (const file of files(source)) {
      for (const match of readFileSync(file, 'utf8').matchAll(pattern)) thrown.add(match[1]!)
    }
    expect(thrown.size).toBeGreaterThan(30)
    for (const code of thrown) {
      expect(Object.keys(zh), `error.${code} must be translated (${code})`).toContain(`error.${code}`)
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
