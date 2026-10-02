/** Additional-root file browsing through the plugin's existing Connection channel. */
import { isAbsolute, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-workspace-files'
import type { PanelCall, FilePreview, FilesView } from './contract.ts'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import { isCanonicallyUnder, resolveRootRef, RootValidationError } from './roots.ts'

export async function browseRoot(ctx: Context, primaryRoot: string, request: PanelCall, signal: AbortSignal): Promise<FilesView | FilePreview> {
  const roots = await ctx.multiRootRegistry.refresh(primaryRoot)
  const ref = request.entry === undefined
    ? request.id === undefined ? undefined : { kind: 'id' as const, id: request.id }
    : { kind: 'entry' as const, ...request.entry }
  if (ref === undefined) throw new RootValidationError('invalid-ref', 'an exact root entry is required')
  const root = resolveRootRef(roots, ref)
  if (root.state !== 'available') throw new RootValidationError('missing', 'the additional root is not available')
  const path = request.path ?? '.'
  if (isAbsolute(path) || /^[a-z][a-z\d+.-]*:/iu.test(path) || path.includes('\0')) throw new RootValidationError('invalid-ref', 'a root-relative path is required')
  const absolute = canonicalPath(resolve(root.path, path))
  if (!isCanonicallyUnder(absolute, root.path)) throw new RootValidationError('invalid-ref', 'the path is outside the selected root')
  const files = ctx.root.get('workspaceFiles')
  if (files === undefined) throw new Error('workspace-files is not composed')
  const scope = { sessionId: request.sessionId as never, workspaceRoot: root.path }
  let result: FilesView | FilePreview
  if (request.endpoint === 'files') {
    const listing = await files.list(scope, absolute, signal)
    result = { path, entries: listing.entries.map(entry => ({ name: entry.name, type: entry.type })), truncated: listing.truncated }
  } else {
    const preview = await files.read(scope, absolute, { offset: 1, limit: 200 }, signal)
    result = { text: preview.text, eof: preview.eof }
  }
  // A removal or replacement while I/O was pending must discard the answer.
  const latest = resolveRootRef(await ctx.multiRootRegistry.refresh(primaryRoot), ref)
  if (latest.state !== 'available' || latest.path !== root.path || canonicalPath(resolve(root.path, path)) !== absolute) {
    throw new RootValidationError('missing', 'the additional root changed while reading')
  }
  return result
}
