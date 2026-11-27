/**
 * P5 presentation classifier: the bytes → drawable-shape contract — the
 * forced-unsupported extension wall, fatal UTF-8 decoding with BOM strip and
 * C0/C1 refusal, and the bounded safe Markdown subset (literal text only,
 * budget fallback to source).
 */
import { describe, expect, it } from 'vitest'
import { previewPresentation, type MarkdownBlock } from '../src/client/file-preview/presentation.ts'
import type { RemoteFilesReadContent } from '../src/remote/files-contract.ts'

const encoder = new TextEncoder()

const content = (bytes: Uint8Array): RemoteFilesReadContent => ({
  kind: 'file',
  size: bytes.byteLength,
  complete: true,
  bytes,
})

const bytes = (text: string): Uint8Array => encoder.encode(text)

const markdownOf = (presentation: ReturnType<typeof previewPresentation>): readonly MarkdownBlock[] => {
  expect(presentation.kind).toBe('markdown')
  if (presentation.kind !== 'markdown') throw new Error('expected markdown')
  return presentation.blocks
}

describe('the presentation classifier', () => {
  it('parses the safe subset: ATX 1–3, fenced code, lists, quotes and paragraphs', () => {
    const presentation = previewPresentation('docs/readme.md', content(bytes(
      '# Title\n\n## Sub *head*\n\n### Third\n\nPara one\nstill para\n\n- first\n- second\n\n> quoted\n> more\n\n```ts\nconst x = 1\n```\n\nTail',
    )))
    expect(markdownOf(presentation)).toEqual([
      { kind: 'heading', level: 1, text: 'Title' },
      { kind: 'heading', level: 2, text: 'Sub *head*' },
      { kind: 'heading', level: 3, text: 'Third' },
      { kind: 'paragraph', text: 'Para one\nstill para' },
      { kind: 'list', items: ['first', 'second'] },
      { kind: 'quote', text: 'quoted\nmore' },
      { kind: 'code', text: 'const x = 1' },
      { kind: 'paragraph', text: 'Tail' },
    ])
  })

  it('keeps markup, links and images literal — no derived object ever leaves the classifier', () => {
    const presentation = previewPresentation('x.md', content(bytes(
      '# Head [link](https://evil.example) ![img](x.png)\n\nPara **bold** [t](u) ![i](s) <script>alert(1)</script>\n\n- item `code` [l](v)',
    )))
    const blocks = markdownOf(presentation)
    // Every block's text is the verbatim source — the renderer has no
    // href/src field to populate and inline markup stays characters.
    expect(blocks).toEqual([
      { kind: 'heading', level: 1, text: 'Head [link](https://evil.example) ![img](x.png)' },
      { kind: 'paragraph', text: 'Para **bold** [t](u) ![i](s) <script>alert(1)</script>' },
      { kind: 'list', items: ['item `code` [l](v)'] },
    ])
    if (presentation.kind !== 'markdown') throw new Error('expected markdown')
    expect(Object.keys(presentation).sort()).toEqual(['blocks', 'kind', 'size', 'text'])
  })

  it('falls back to plain text when blocks plus list items exceed the budget', () => {
    // 4097 list items in one run → over the 4096 budget → source, not blocks.
    const presentation = previewPresentation('big.md', content(bytes(Array.from({ length: 4100 }, (_, index) => `- item ${index}`).join('\n'))))
    expect(presentation.kind).toBe('text')
    // Blocks alone count too: 4100 paragraphs → same fallback.
    const paras = previewPresentation('big.md', content(bytes(Array.from({ length: 4100 }, (_, index) => `para ${index}`).join('\n\n'))))
    expect(paras.kind).toBe('text')
  })

  it('falls back to plain text on an unclosed fence and over-size markdown', () => {
    const unclosed = previewPresentation('x.md', content(bytes('text\n\n```\nnever closed')))
    expect(unclosed.kind).toBe('text')
    if (unclosed.kind !== 'text') throw new Error('expected text')
    expect(unclosed.text.startsWith('text')).toBe(true)
    // .md over the 128 KiB render ceiling is still valid text — just no blocks.
    const big = previewPresentation('x.md', content(bytes(`# t\n\n${'a'.repeat(200 * 1024)}`)))
    expect(big.kind).toBe('text')
  })

  it('rejects malformed UTF-8, NUL and C1 controls as unsupported', () => {
    expect(previewPresentation('x.txt', content(new Uint8Array([0xff, 0xfe, 0x61]))).kind).toBe('unsupported')
    expect(previewPresentation('x.txt', content(bytes('a\0b'))).kind).toBe('unsupported')
    expect(previewPresentation('x.txt', content(bytes('a\u0085b'))).kind).toBe('unsupported')
    expect(previewPresentation('x.txt', content(bytes('a\x01b'))).kind).toBe('unsupported')
    // TAB/LF/CR are the only allowed C0 controls.
    const okay = previewPresentation('x.txt', content(bytes('a\tb\nc\rd')))
    expect(okay.kind).toBe('text')
  })

  it('accepts empty files, strips the BOM and preserves Unicode', () => {
    const empty = previewPresentation('empty.txt', content(new Uint8Array(0)))
    expect(empty).toEqual({ kind: 'text', text: '', size: 0 })
    const bom = previewPresentation('bom.txt', content(new Uint8Array([0xef, 0xbb, 0xbf, ...bytes('你好 world')])))
    expect(bom).toEqual({ kind: 'text', text: '你好 world', size: 15 })
  })

  it('forces the binary-extension list unsupported even when the bytes are plain ASCII', () => {
    for (const path of ['a.pdf', 'b.PNG', 'c.Zip', 'd.docx', 'e.7z', 'f.TIFF', 'g.avif']) {
      const presentation = previewPresentation(path, content(bytes('plain ascii that decodes fine')))
      expect(presentation.kind, path).toBe('unsupported')
      if (presentation.kind !== 'unsupported') throw new Error('expected unsupported')
      expect(presentation.size).toBe(29)
    }
  })

  it('serves HTML, SVG and script files as source-only text', () => {
    for (const path of ['a.html', 'b.svg', 'c.js', 'd.mjs', 'e.tsx', 'f.mdx']) {
      const body = '<svg onload="alert(1)"><text>x</text></svg>'
      const presentation = previewPresentation(path, content(bytes(body)))
      expect(presentation.kind, path).toBe('text')
      if (presentation.kind !== 'text') throw new Error('expected text')
      expect(presentation.text).toBe(body)
    }
  })

  it('treats an extensionless or hidden name as ordinary text', () => {
    expect(previewPresentation('Makefile', content(bytes('all:\n\techo hi'))).kind).toBe('text')
    const hidden = previewPresentation('.gitignore', content(bytes('node_modules\n')))
    expect(hidden).toEqual({ kind: 'text', text: 'node_modules\n', size: 13 })
  })
})
