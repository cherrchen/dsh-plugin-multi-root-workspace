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

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
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
    // OS product names are proper nouns and stay identical in both languages;
    // every other identical value is untranslated copy.
    const languageNeutral = new Set(['ssh.platform.linux', 'ssh.platform.darwin'])
    const identical = Object.keys(zh).filter(key =>
      !languageNeutral.has(key) && zh[key as keyof typeof zh] === en[key as keyof typeof en])
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
      'registry-contended',
      'reveal-unavailable',
      'session-not-found',
      'session-not-live',
      'unsupported-path',
      'unavailable',
      'copy-failed',
      'fallback',
    ]) {
      expect(Object.keys(zh), `error.${code} must be translated`).toContain(`error.${code}`)
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
      expect(Object.keys(zh)).toContain(`state.${state}`)
    }
  })
})
