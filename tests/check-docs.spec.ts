/**
 * Regression coverage for the documentation gate itself.
 *
 * `scripts/check-docs.mjs` is the only mechanical guard over the repository's
 * documentation rules, and the eight-language root README is the newest rule it
 * carries. A broken rule there is invisible until someone edits the README and
 * CI stays green, so each acceptance path runs the real checker against a
 * throwaway tree and proves the expected failure is reported. The tree is
 * selected through `DSH_DOCS_CHECK_ROOT`; normal runs still inspect the
 * checkout the script lives in.
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

/** The checker actually executed by `pnpm docs:check`. */
const CHECKER = resolve(import.meta.dirname, '..', 'scripts', 'check-docs.mjs')

/** The root README languages, in the order the language selector lists them. */
const LANGUAGES = ['zh', 'en', 'ja', 'es', 'fr', 'de', 'ru', 'pt'] as const

/** Each language's endonym in the selector. */
const LABELS = ['中文', 'English', '日本語', 'Español', 'Français', 'Deutsch', 'Русский', 'Português'] as const

/** The file name a language owns. */
function readmeFile(language: (typeof LANGUAGES)[number]): string {
  return language === 'zh' ? 'README.md' : `README.${language}.md`
}

const README_FILES = LANGUAGES.map(readmeFile)

/** Temporary fixture roots, removed after each case. */
const fixtureRoots: string[] = []

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** Create an empty fixture root under the system temporary directory. */
function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-docs-check-'))
  fixtureRoots.push(root)
  return root
}

/** Build one minimal README whose selector links the other seven languages. */
function readmeFor(file: string): string {
  const selector = README_FILES.map((candidate, index) =>
    candidate === file ? LABELS[index] : `[${LABELS[index]}](./${candidate})`
  ).join(' | ')
  return [
    '<div align="center">',
    '',
    '# Example',
    '',
    selector,
    '',
    '</div>',
    '',
    '## Usage',
    '',
    '```sh',
    'echo ok',
    '```',
    '',
  ].join('\n')
}

/** Write the complete eight-language README set, optionally omitting one file. */
function writeReadmeSet(root: string, omitted?: string): void {
  for (const file of README_FILES) {
    if (file === omitted) continue
    writeFileSync(join(root, file), readmeFor(file))
  }
}

/** Run the real checker against a fixture root. */
function runChecker(root: string): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [CHECKER], {
    cwd: root,
    env: { ...process.env, DSH_DOCS_CHECK_ROOT: root },
    encoding: 'utf8',
  })
}

/** Rewrite one line of one README in a fixture. */
function replaceInReadme(root: string, file: string, search: string, replacement: string): void {
  const path = join(root, file)
  const text = readFileSync(path, 'utf8')
  writeFileSync(path, text.replace(search, replacement))
}

describe('documentation checker', () => {
  it('accepts a complete eight-language root README set', () => {
    const root = fixtureRoot()
    writeReadmeSet(root)
    const result = runChecker(root)
    expect(result.status, `${result.stdout ?? ''}${result.stderr ?? ''}`).toBe(0)
    expect(result.stdout).toContain('Documentation checks passed.')
  })

  it('rejects a missing root README language', () => {
    const root = fixtureRoot()
    writeReadmeSet(root, 'README.pt.md')
    const result = runChecker(root)
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('Missing root README variant: README.pt.md')
  })

  it('rejects a root README that does not link every other language', () => {
    const root = fixtureRoot()
    writeReadmeSet(root)
    replaceInReadme(root, 'README.ja.md', '[Deutsch](./README.de.md)', 'Deutsch')
    const result = runChecker(root)
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('Root README does not link to README.de.md')
  })

  it('rejects a heading structure that diverges from the Chinese canonical README', () => {
    const root = fixtureRoot()
    writeReadmeSet(root)
    replaceInReadme(root, 'README.fr.md', '## Usage', '### Usage')
    const result = runChecker(root)
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('Heading levels differ from README.md')
  })

  it('rejects a fenced code-block language that diverges from the Chinese canonical README', () => {
    const root = fixtureRoot()
    writeReadmeSet(root)
    replaceInReadme(root, 'README.es.md', '```sh', '```bash')
    const result = runChecker(root)
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('Fenced code-block languages differ from README.md')
  })

  it('still requires the English counterpart for a non-root README', () => {
    const root = fixtureRoot()
    writeReadmeSet(root)
    mkdirSync(join(root, 'docs'))
    writeFileSync(join(root, 'docs', 'README.md'), '# Docs\n')
    const result = runChecker(root)
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('Missing counterpart: README.en.md')
  })
})
