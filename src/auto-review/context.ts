/** Reconcile native overlap by producer metadata, never by parsing instruction prose. */
import { createHash } from 'node:crypto'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { ReviewContext } from '../review-context.ts'
import type { ContentBlock, MessageSource } from '@deepseek-ai/dsh-llm'
interface NativeMessage { readonly kind: 'user-message'; readonly role: string; readonly source: MessageSource; readonly content: readonly ContentBlock[] }
function under(path: string, root: string): boolean {
  const tail = relative(root, path)
  return tail === '' || (tail !== '..' && !tail.startsWith(`..${sep}`) && !isAbsolute(tail))
}
export function partitionInstructions<T extends NativeMessage>(native: readonly T[], context: ReviewContext) {
  const relevantRoots = context.instructionProvenanceRoots ?? []
  if (relevantRoots.length === 0) return {currentNative:native,historical:[],demoted:[],fresh:context.constraints}
  const currentNative: T[] = []
  const historical: Array<Omit<T,'role'> & {role:'fact'}> = []
  /** The original entries behind `historical`, so a caller can splice them at their surface position. */
  const demoted: T[] = []
  const represented = new Set<string>()
  let project: string | undefined
  const baseline = native.findLastIndex(entry => (entry.source as {baseline?: boolean}).baseline === true)
  for (const [index, entry] of native.entries()) {
    if (index < baseline) {
      historical.push({...entry,role:'fact'})
      demoted.push(entry)
      continue
    }
    const source = entry.source as { baseline?: boolean; baselineIdentity?: string; changes?: Array<{action: string; path: string; digest?: string}> }
    if (source.baseline) project = undefined
    if (source.baselineIdentity !== undefined) {
      let identity: { projectRoot?: unknown }
      try { identity = JSON.parse(source.baselineIdentity) } catch { throw new Error('review-context: invalid native baseline identity') }
      if (typeof identity.projectRoot !== 'string') throw new Error('review-context: invalid native baseline identity')
      project = resolve(context.environment.effectiveCwd, identity.projectRoot)
    }
    const changes=source.changes ?? []
    if (project === undefined && changes.length > 0) {
      throw new Error('review-context: native instruction scope is incomplete; refresh the agent step')
    }
    const external: Array<{path:string;action:string;digest?:string}> = []
    let other=false
    for (const change of changes) {
      if (/^(?:~|\$|user-global[\\/]|agents-global[\\/])/.test(change.path)) {other=true;continue}
      if(project===undefined){other=true;continue}
      const path=resolve(project,change.path)
      if(under(path,context.environment.sessionOrigin) || !relevantRoots.some(root=>under(path,root))){other=true;continue}
      external.push({...change,path})
    }
    if(external.length===0){currentNative.push(entry);continue}
    if(!other){
      // Current additional-root files replace these historical native deltas.
      // Their old prose remains factual history, without current constraint authority.
      historical.push({...entry,role:'fact'})
      demoted.push(entry)
      continue
    }
    // A mixed global/primary/external frame has no public per-file content
    // interface. Preserve its non-additional constraints only when every
    // external file represented by this frame is provably current as well.
    for(const file of external){
      const current=context.constraints.find(item=>item.path===file.path)
      if(file.action==='remove' || current===undefined || createHash('sha1').update(current.text).digest('hex')!==file.digest){
        throw new Error('review-context: mixed native instruction frame is stale; refresh its baseline')
      }
      represented.add(file.path)
    }
    currentNative.push(entry)
  }
  return {currentNative,historical,demoted,fresh:context.constraints.filter(file=>!represented.has(file.path))}
}
