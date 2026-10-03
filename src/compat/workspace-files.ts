/** Old releases watch a session; newer ones watch a path. Probe arity, never version. */
import type { WorkspaceFiles, WorkspaceFileScope, WorkspaceFileWatchFrame } from '@deepseek-ai/dsh-api-workspace-files'
import { wrapMethod } from '../method-wrapper.ts'

type PathWatch = (this: WorkspaceFiles, scope: WorkspaceFileScope, path: string, signal: AbortSignal) => AsyncIterable<WorkspaceFileWatchFrame>

export function adaptPathWatch(service: WorkspaceFiles, wrap: (original: PathWatch) => PathWatch): () => void {
  return wrapMethod(service, 'changes', original => original.length < 3 ? original : wrap(original as unknown as PathWatch) as unknown as typeof original)
}
