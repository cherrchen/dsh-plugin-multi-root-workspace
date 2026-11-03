import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { opsActivityEvidenceKey, replayedInstructionTargets } from '../src/compat/instruction-activity.ts'
it('replays native and PTC success without treating failures or uncompleted calls as work',()=>{
  const origin=resolve('origin'),next=resolve('next')
  const paths=replayedInstructionTargets([
    {type:'tool/call',data:{callId:'read',name:'read',arguments:'{"file_path":"src/a"}'}},
    {type:'tool/result',data:{message:{source:{callId:'read'},isError:false}}},
    {type:'working-directory/change',data:{cwd:next}},
    {type:'tool/ptc-dispatch-start',data:{subCallId:'ptc1',name:'edit',arguments:{file_path:'nested/b'}}},
    {type:'tool/ptc-dispatch',data:{subCallId:'ptc1',isError:false}},
    {type:'tool/call',data:{callId:'failed',name:'write',arguments:'{"file_path":"failed"}'}},
    {type:'tool/result',data:{message:{source:{callId:'failed'},isError:true}}},
    {type:'tool/call',data:{callId:'pending',name:'write',arguments:'{"file_path":"pending"}'}},
  ],origin)
  expect(paths).toEqual([resolve(origin,'src/a'),resolve(next,'nested/b')])
})
it('checks candidate chains across cwd changes without manufacturing a durable touch',()=>{
  const start=resolve('start'),end=resolve('end')
  const events=[{type:'tool/call',data:{callId:'r',name:'read',arguments:'{"file_path":"a"}'}},{type:'working-directory/change',data:{cwd:end}},{type:'tool/result',data:{message:{source:{callId:'r'}}}}]
  expect(replayedInstructionTargets(events,start)).toEqual([resolve(start,'a'),resolve(end,'a')])
  expect(events).toHaveLength(3)
})

describe('replayedInstructionTargets — OPS live-evidence contract',()=>{
  const f='/tmp/p-a'
  const args=JSON.stringify({files:[{path:'/p/a'}]})
  const opsCall=(id:string,name:string,arg=args)=>({type:'tool/call',data:{callId:id,name,arguments:arg}})
  const opsResult=(id:string,isError=false)=>({type:'tool/result',data:{message:{source:{callId:id},content:[{type:'tool-result',toolCallId:id,content:[],isError}]}}})
  const ptcStart=(sub:string,name:string)=>({type:'tool/ptc-dispatch-start',data:{subCallId:sub,name,arguments:{files:[{path:'/p/a'}]}}})
  const ptcEnd=(sub:string,isError=false)=>({type:'tool/ptc-dispatch',data:{subCallId:sub,isError}})
  const ev=(kind:'native'|'ptc',id:string,name:string,arg:unknown,complete=true,targets:readonly {path:string;kind:'read'|'write'|'remove'}[]=[{path:f,kind:'read'}])=>
    new Map([[opsActivityEvidenceKey(kind,id,name,arg),{targets,complete}]])
  it('merges a proven native and PTC pair only with complete live evidence',()=>{
    const events=[opsCall('c1','ops_read_files'),opsResult('c1'),ptcStart('s2','ops_read_files'),ptcEnd('s2')]
    const map=new Map([...ev('native','c1','ops_read_files',{files:[{path:'/p/a'}]}),...ev('ptc','s2','ops_read_files',{files:[{path:'/p/a'}]})])
    expect(replayedInstructionTargets(events,undefined,map)).toEqual([f])
    expect(()=>replayedInstructionTargets(events,undefined)).toThrow('review-context')
    const wrong=ev('native','c1','ops_read_files',{files:[{path:'/p/a'}]})
    expect(()=>replayedInstructionTargets(events,undefined,wrong)).toThrow('review-context')
  })
  it('keeps native and PTC identities with the same raw id apart, including ptc: named natives',()=>{
    const events=[opsCall('ptc:s2','ops_read_files'),opsResult('ptc:s2'),ptcStart('s2','ops_read_files'),ptcEnd('s2')]
    const map=new Map([...ev('native','ptc:s2','ops_read_files',{files:[{path:'/p/a'}]}),...ev('ptc','s2','ops_read_files',{files:[{path:'/p/a'}]})])
    expect(replayedInstructionTargets(events,undefined,map)).toEqual([f])
    const onlyPtc=ev('ptc','s2','ops_read_files',{files:[{path:'/p/a'}]})
    expect(()=>replayedInstructionTargets(events,undefined,onlyPtc)).toThrow('review-context')
  })
  it('rejects duplicate starts, stray ends and unsettled calls',()=>{
    const map=ev('native','c1','ops_read_files',{files:[{path:'/p/a'}]})
    expect(()=>replayedInstructionTargets([opsCall('c1','ops_read_files'),opsCall('c1','ops_read_files')],undefined,map)).toThrow('review-context')
    expect(()=>replayedInstructionTargets([opsResult('zzz')],undefined,map)).not.toThrow()
    expect(()=>replayedInstructionTargets([opsCall('c1','ops_read_files'),opsResult('c1'),opsResult('c1')],undefined,map)).toThrow('review-context')
    expect(()=>replayedInstructionTargets([opsCall('c9','ops_replace')],undefined,map)).toThrow('review-context')
  })
  it('accepts effect-none complete-empty evidence on a failed call and rejects contradictions',()=>{
    const events=[opsCall('c1','ops_write_file'),opsResult('c1',true)]
    const empty=ev('native','c1','ops_write_file',{files:[{path:'/p/a'}]},true,[])
    expect(replayedInstructionTargets(events,undefined,empty)).toEqual([])
    const success=ev('native','c1','ops_write_file',{files:[{path:'/p/a'}]},true,[{path:f,kind:'write'}])
    expect(()=>replayedInstructionTargets(events,undefined,success)).toThrow('review-context')
    const incomplete=ev('native','c1','ops_write_file',{files:[{path:'/p/a'}]},false,[])
    expect(()=>replayedInstructionTargets(events,undefined,incomplete)).toThrow('review-context')
  })
  it('exempts only the exact pending exec, never an unstable or different-arg one',()=>{
    const events=[opsCall('cur','ops_read_files')]
    const pending={callId:'cur',name:'ops_read_files',arguments:{files:[{path:'/p/a'}]}}
    expect(replayedInstructionTargets(events,undefined,new Map(),pending)).toEqual([])
    expect(()=>replayedInstructionTargets(events,undefined,new Map(),{...pending,arguments:{files:[{path:'/p/b'}]}})).toThrow('review-context')
    expect(()=>replayedInstructionTargets(events,undefined,new Map(),{...pending,arguments:{files:[{path:'/p/a'}],extra:undefined}})).toThrow('review-context')
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic
    expect(()=>replayedInstructionTargets(events,undefined,new Map(),{...pending,arguments:cyclic})).toThrow('review-context')
    let deep: unknown = 1; for (let i=0;i<30;i+=1) deep = [deep]
    expect(()=>replayedInstructionTargets(events,undefined,new Map(),{...pending,arguments:deep})).toThrow('review-context')
    expect(()=>replayedInstructionTargets(events,undefined,new Map(),{...pending,parent:{}})).toThrow('review-context')
    expect(()=>replayedInstructionTargets([opsCall('cur','ops_read_files'),opsCall('ghost','ops_write_file')],undefined,new Map(),pending)).toThrow('review-context')
  })
  it('bounds the OPS end index at 512 without touching official history',()=>{
    const events: unknown[]=[]
    const map=new Map<string,{targets:readonly {path:string;kind:'read'}[];complete:boolean}>()
    for(let index=0;index<513;index+=1){
      events.push(opsCall(`op${index}`,'ops_read_files'),opsResult(`op${index}`))
      map.set(opsActivityEvidenceKey('native',`op${index}`,'ops_read_files',{files:[{path:'/p/a'}]}),{targets:[],complete:true})
    }
    expect(()=>replayedInstructionTargets(events,undefined,map)).toThrow('review-context')
    const official: unknown[]=[]
    for(let index=0;index<500;index+=1){
      official.push(opsCall(`f${index}`,'read',`{"file_path":"/p/f${index}"}`),opsResult(`f${index}`))
    }
    expect(()=>replayedInstructionTargets(official,undefined)).not.toThrow()
    expect(replayedInstructionTargets(official,undefined).length).toBe(500)
  })

  it('lets pure publish tools pass without evidence',()=>{
    const events=[opsCall('pub','ops_discover_tools','{}'),opsResult('pub'),opsCall('sdk','ops_load_sdk','{}')]
    expect(replayedInstructionTargets(events,undefined,new Map())).toEqual([])
  })
})
