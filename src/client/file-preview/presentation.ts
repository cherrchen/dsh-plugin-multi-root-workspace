/**
 * The read result → drawable presentation classifier (ADR-0053 P5).
 *
 * Pure functions: the same classification serves the Viewer, tests, and any
 * future surface. The contract it enforces is the frozen one — UTF-8 text
 * (plus a bounded safe Markdown subset), never markup from remote bytes:
 * no URL, link, image or any object derived from the bytes leaves here.
 *
 * - A fixed binary-extension list is `unsupported` BEFORE decoding — a `.png`
 *   that happens to start with ASCII stays metadata-only.
 * - `.svg`/HTML/JS are source-only: they classify as plain `text` like any
 *   other readable file; nothing here ever renders them as markup.
 * - UTF-8 is verified with a fatal decoder (BOM stripped by the decoder) and
 *   C0/C1 controls other than TAB/LF/CR refuse the whole file.
 * - `.md`/`.markdown` under 128 KiB additionally gets a safe block parse —
 *   line-scanner only, no npm dependency, every block's text literal.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/client/file-preview/presentation
 */
import { REMOTE_FILE_PREVIEW_LIMITS, type RemoteFilesReadContent } from '../../remote/files-contract.ts'

/** One drawable Markdown block; `text`/`items` are always literal source. */
export type MarkdownBlock =
  | { readonly kind: 'heading'; readonly level: 1 | 2 | 3; readonly text: string }
  | { readonly kind: 'paragraph' | 'code' | 'quote'; readonly text: string }
  | { readonly kind: 'list'; readonly items: readonly string[] }

/** What one read result may be drawn as. */
export type PreviewPresentation =
  | { readonly kind: 'unsupported'; readonly size: number }
  | { readonly kind: 'text'; readonly text: string; readonly size: number }
  | { readonly kind: 'markdown'; readonly text: string; readonly blocks: readonly MarkdownBlock[]; readonly size: number }

/** Extensions whose bytes are never previewed, whatever they decode to. */
const FORCED_UNSUPPORTED: ReadonlySet<string> = new Set([
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.odp',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp', '.ico', '.tif', '.tiff',
  '.zip', '.gz', '.7z', '.rar',
])

/** Safe-Markdown render ceiling — same scale as the host read block size. */
const MARKDOWN_BYTES = REMOTE_FILE_PREVIEW_LIMITS.markdownBytes

/** Blocks + list items before the renderer falls back to plain source. */
const MARKDOWN_BUDGET = REMOTE_FILE_PREVIEW_LIMITS.markdownNodes

const ATX = /^(#{1,3})[ \t]+(.+)$/u
const LINE_END = /\r\n|\r|\n/u

/**
 * Classify one read result for drawing. Never throws and never returns
 * remote-derived objects — `unsupported` carries only the size metadata.
 */
export function previewPresentation(relativePath: string, content: RemoteFilesReadContent): PreviewPresentation {
  const size = content.bytes.byteLength
  const basename = relativePath.split('/').pop() ?? relativePath
  const dot = basename.lastIndexOf('.')
  const extension = dot <= 0 ? '' : basename.slice(dot).toLowerCase()
  if (FORCED_UNSUPPORTED.has(extension)) return { kind: 'unsupported', size }
  let text: string
  try {
    // The fatal decoder rejects malformed UTF-8 and strips a leading BOM.
    text = new TextDecoder('utf-8', { fatal: true }).decode(content.bytes)
  } catch {
    return { kind: 'unsupported', size }
  }
  // C0 controls other than TAB/LF/CR, DEL and the C1 band mark binary.
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || (code >= 0x7f && code <= 0x9f)) {
      return { kind: 'unsupported', size }
    }
  }
  if ((extension === '.md' || extension === '.markdown') && content.bytes.byteLength <= MARKDOWN_BYTES) {
    const blocks = markdownBlocks(text)
    if (blocks !== undefined) return { kind: 'markdown', text, blocks, size }
  }
  return { kind: 'text', text, size }
}

/** Whether one line opens a non-paragraph block (paragraphs stop before it). */
function blockStart(line: string): boolean {
  return ATX.test(line) || line.startsWith('```') || line.startsWith('- ') || line.startsWith('> ')
}

/**
 * The bounded safe subset: ATX headings 1–3, backtick fences, `- ` lists,
 * `> ` quotes, paragraphs. A single forward scan; unclosed fences and an
 * over-budget document both fall back to plain source (`undefined`).
 */
function markdownBlocks(text: string): readonly MarkdownBlock[] | undefined {
  const lines = text.split(LINE_END)
  const blocks: MarkdownBlock[] = []
  let budget = 0
  let index = 0
  while (index < lines.length) {
    const line = lines[index]!
    if (line.trim() === '') {
      index++
      continue
    }
    const heading = ATX.exec(line)
    if (heading !== null) {
      blocks.push({ kind: 'heading', level: heading[1]!.length as 1 | 2 | 3, text: heading[2]! })
      budget++
      index++
      continue
    }
    if (line.startsWith('```')) {
      const chunk: string[] = []
      let end = index + 1
      while (end < lines.length && !lines[end]!.startsWith('```')) {
        chunk.push(lines[end]!)
        end++
      }
      // An unclosed fence is source, not half a code block.
      if (end >= lines.length) return undefined
      blocks.push({ kind: 'code', text: chunk.join('\n') })
      budget++
      index = end + 1
      continue
    }
    if (line.startsWith('- ')) {
      const items: string[] = []
      while (index < lines.length && lines[index]!.startsWith('- ')) {
        items.push(lines[index]!.slice(2))
        budget++
        if (budget > MARKDOWN_BUDGET) return undefined
        index++
      }
      blocks.push({ kind: 'list', items })
      budget++
      continue
    }
    if (line.startsWith('> ')) {
      const chunk: string[] = []
      while (index < lines.length && lines[index]!.startsWith('> ')) {
        chunk.push(lines[index]!.slice(2))
        index++
      }
      blocks.push({ kind: 'quote', text: chunk.join('\n') })
      budget++
      continue
    }
    const chunk: string[] = []
    while (index < lines.length && lines[index]!.trim() !== '' && !blockStart(lines[index]!)) {
      chunk.push(lines[index]!)
      index++
    }
    blocks.push({ kind: 'paragraph', text: chunk.join('\n') })
    budget++
    if (budget > MARKDOWN_BUDGET) return undefined
  }
  if (budget > MARKDOWN_BUDGET) return undefined
  return blocks
}
