/**
 * The Plugin Manager detail document's package wiring.
 *
 * `readPluginMeta` resolves `locale/en.json` through the package's own
 * `exports`, and `readPackageDocument` then reads `meta.detail` plus the
 * README fallback from the packed `files` — so the contract that must hold is
 * not "files exist" but "the manifest, the locale dictionaries, the detail
 * documents and the preview assets agree":
 *
 * 1. every locale JSON is a language-id file carrying meta.title, meta.
 *    description and a meta.detail that names an existing in-package Markdown
 *    file;
 * 2. every detail document is the upstream convention — one line, an image
 *    that resolves to an existing SVG beside the document;
 * 3. the preview SVGs are the fixed 640×300 self-contained kind: no text,
 *    script, foreignObject, stylesheet, or external reference (the page
 *    renders them through <img>);
 * 4. `exports` exposes the locale files and `files` packs them plus the
 *    detail directory, or the installed bundle shows nothing.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

const LANGUAGE_ID = /^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/u
const metaOf = file => (JSON.parse(readFileSync(file, 'utf8')) as { meta?: Record<string, unknown> }).meta

describe('plugin detail document wiring', () => {
  it('every locale dictionary carries title, description and an existing detail document', () => {
    const dir = join(ROOT, 'locale')
    const files = readdirSync(dir).filter(name => name.endsWith('.json')).sort()
    expect(files).toEqual(['en.json', 'zh.json'])
    for (const name of files) {
      expect(LANGUAGE_ID.test(name.slice(0, -5)), `${name} must be a language-id file`).toBe(true)
      const meta = metaOf(join(dir, name))
      expect(typeof meta?.title, name).toBe('string')
      expect(typeof meta?.description, name).toBe('string')
      expect(typeof meta?.detail, name).toBe('string')
      const detail = join(ROOT, String(meta!.detail))
      expect(existsSync(detail), `${name}: meta.detail ${String(meta!.detail)} must exist`).toBe(true)
      expect(String(meta!.detail)).toMatch(/\.(?:md|markdown)$/u)
    }
  })

  it('detail documents are a single image line resolving to a preview beside them', () => {
    const documents = ['detail/DETAIL.md', 'detail/DETAIL.en.md']
    const previews: string[] = []
    for (const rel of documents) {
      const text = readFileSync(join(ROOT, rel), 'utf8').trim()
      const match = /^!\[[^\]]*\]\(([^)]+)\)$/u.exec(text)
      expect(match, `${rel} must contain exactly one image line`).toBeTruthy()
      const target = join(ROOT, dirname(rel), match![1]!)
      expect(existsSync(target), `${rel} image ${match![1]} must exist`).toBe(true)
      previews.push(target)
    }
    const [zh, en] = previews.map(file => readFileSync(file, 'utf8'))
    for (const svg of [zh, en]) {
      expect(svg).toContain('width="640" height="300" viewBox="0 0 640 300"')
      expect(svg).not.toMatch(/<text|<script|<foreignObject|<image|<style|@font|on[a-z]+=|href=|xlink|url\(/u)
    }
    expect(zh, 'the English and Chinese previews must differ').not.toBe(en)
  })

  it('exports and files ship what the Plugin Manager resolves', () => {
    expect(pkg.exports['./locale/*.json']).toBe('./locale/*.json')
    expect(pkg.files).toContain('locale')
    expect(pkg.files).toContain('detail')
  })
})
