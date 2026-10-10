/** Recognize files already represented by the native instruction baseline in this step. */
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { LoadedInstructionFile } from './agent-instructions.ts'

export function nativeInstructionCopies(messages: readonly UserMessage[], cwd: string | undefined): (file: LoadedInstructionFile) => boolean {
  const represented = new Map<string, string>()
  if (cwd !== undefined) for (const message of messages) {
    const source = message.source as unknown as { kind: string; baselineIdentity?: string; changes?: Array<{ action: string; path: string; digest?: string }> }
    if (source.kind !== 'agent-instructions' || source.baselineIdentity === undefined || source.changes === undefined) continue
    let identity: { projectRoot?: unknown }
    try { identity = JSON.parse(source.baselineIdentity) } catch { continue }
    if (typeof identity.projectRoot !== 'string') continue
    const project = resolve(cwd, identity.projectRoot)
    for (const change of source.changes) {
      if (change.action === 'remove' || typeof change.digest !== 'string') continue
      // Globals are upstream's own scope and cannot name a project file.
      if (/^(?:~|\$|user-global[\\/]|agents-global[\\/])/.test(change.path)) continue
      represented.set(resolve(project, change.path), change.digest)
    }
  }
  return file => represented.get(file.absolutePath) === createHash('sha1').update(file.content).digest('hex')
}
