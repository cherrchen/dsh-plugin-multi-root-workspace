import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { partitionInstructions } from '../../src/auto-review/context.ts'
const primary=resolve('fixture-primary'), additional=resolve('fixture-additional'), path=resolve(additional,'AGENTS.md')
const digest=(text:string)=>createHash('sha1').update(text).digest('hex')
const context=(text='current')=>({environment:{sessionOrigin:primary,effectiveCwd:additional},instructionProvenanceRoots:[additional],constraints:[{root:additional,path,relativeDirectory:'.',digest:'sha256',text}]}) as any
function native(text:string, mixed=false) {
  return {kind:'user-message',role:'constraint',source:{kind:'agent-instructions',baseline:true,baselineIdentity:JSON.stringify({projectRoot:additional}),changes:[{action:'set',path:'AGENTS.md',digest:digest(text)},...(mixed?[{action:'set',path:'$DSH_HOME/AGENTS.md',digest:digest('global')}]:[])]},content:[{type:'text',text}]} as any
}
describe('native instruction overlap',()=>{
  it('makes old additional-only native frames factual history and supplies one fresh constraint',()=>{
    const result=partitionInstructions([native('obsolete')],context())
    expect(result.currentNative).toHaveLength(0);expect(result.historical[0]?.role).toBe('fact');expect(result.fresh[0]?.text).toBe('current')
  })
  it('withdraws additional native constraints after removal without promoting old prose',()=>{
    const c=context();c.constraints=[]
    const result=partitionInstructions([native('old')],c)
    expect(result.currentNative).toHaveLength(0);expect(result.fresh).toHaveLength(0)
  })
  it('deduplicates proven current files inside a mixed native frame and preserves its other constraints',()=>{
    const result=partitionInstructions([native('current',true)],context())
    expect(result.currentNative).toHaveLength(1);expect(result.fresh).toHaveLength(0)
  })
  it('fails closed when a mixed native frame is stale or its scope cannot be established',()=>{
    expect(()=>partitionInstructions([native('obsolete',true)],context())).toThrow('mixed native')
    const msg=native('current');delete msg.source.baselineIdentity
    expect(()=>partitionInstructions([msg],context())).toThrow('scope is incomplete')
  })
})

it('preserves native constraints at an unregistered effective cwd',()=>{const c=context();c.instructionProvenanceRoots=[];c.constraints=[];const entry=native('native project');expect(partitionInstructions([entry],c).currentNative).toEqual([entry])})

it('honors the producer replacement-baseline marker without retaining obsolete mixed constraints',()=>{
  const result=partitionInstructions([native('obsolete',true),native('current',true)],context())
  expect(result.currentNative).toHaveLength(1)
  expect(result.historical).toHaveLength(1)
  expect(result.historical[0]?.role).toBe('fact')
})
