/** Recognize files already represented by the native instruction baseline in this step. */
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { LoadedInstructionFile } from './agent-instructions.ts'

export interface NativeInstructionCopies {
  pathOf: (file: LoadedInstructionFile) => string | undefined
  withdraws: (displayPath: string) => boolean
}

export function nativeInstructionCopies(messages: readonly UserMessage[], cwd: string | undefined): NativeInstructionCopies {
  const represented = new Map<string, { digest: string; displayPath: string }>()
  const removed = new Set<string>()
  let replacesBaseline = false
  for (const message of messages) {
    const source = message.source as unknown as { kind: string; baseline?: boolean; baselineIdentity?: string; changes?: Array<{ action: string; path: string; digest?: string }> }
    if (source.kind !== 'agent-instructions' || source.changes === undefined) continue
    // Replacement removals name the OLD baseline's relative scopes, even
    // though this message's identity and cwd describe the NEW project. Never
    // resolve those removals against the new project to identify borrowed files.
    if (source.baseline === true) {
      replacesBaseline = true
      represented.clear()
    }
    for (const change of source.changes) {
      if (change.action !== 'remove') continue
      removed.add(change.path)
      for (const [path, copy] of represented) if (copy.displayPath === change.path) represented.delete(path)
    }
    if (cwd === undefined || source.baselineIdentity === undefined) continue
    let identity: { projectRoot?: unknown }
    try { identity = JSON.parse(source.baselineIdentity) } catch { continue }
    if (typeof identity.projectRoot !== 'string') continue
    const project = resolve(cwd, identity.projectRoot)
    for (const change of source.changes) {
      if (change.action === 'remove' || typeof change.digest !== 'string') continue
      // Globals are upstream's own scope and cannot name a project file.
      if (/^(?:~|\$|user-global[\\/]|agents-global[\\/])/.test(change.path)) continue
      represented.set(resolve(project, change.path), { digest: change.digest, displayPath: change.path })
    }
  }
  return {
    pathOf: file => {
      const copy = represented.get(file.absolutePath)
      return copy?.digest === createHash('sha1').update(file.content).digest('hex') ? copy.displayPath : undefined
    },
    withdraws: displayPath => replacesBaseline || removed.has(displayPath),
  }
}
