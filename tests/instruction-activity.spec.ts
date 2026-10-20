import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { replayedInstructionTargets } from '../src/compat/instruction-activity.ts'
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
