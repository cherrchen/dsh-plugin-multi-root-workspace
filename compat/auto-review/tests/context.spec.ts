import { mkdirSync, readFileSync, writeFileSync, rmSync, renameSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import LlmRuntime, { LlmAdapter, ToolCallId, createMessage, createUserMessage, createToolResultMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import Presets from '@deepseek-ai/dsh-permission-presets'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Policy from '@deepseek-ai/dsh-sandbox-policy'
import Tools from '@deepseek-ai/dsh-tools'
import Approval, {setApprovalPolicy} from '@deepseek-ai/dsh-user-approval'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import { NodePtcRuntime } from '@deepseek-ai/dsh-ptc-runtime-node'
import { MultiRootSandboxProvider } from '../../../src/sandbox.ts'
import * as ProcessFence from '../../../src/process-fence.ts'
import { requireKernelRunner } from '../../../tests/support/kernel-runner.ts'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import { MultiRootFileSystem } from '../../../src/fs.ts'
import * as Instructions from '../../../src/instructions.ts'
import ReviewContextService from '../../../src/review-context.ts'
import { mountRegistryStack } from '../../../tests/support/registry-stack.ts'
import { createFixtureWorkspace, REPO_ROOT } from '../../../tests/support/temp-workspace.ts'
import * as Companion from '../src/index.ts'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { vi.restoreAllMocks(); while(cleanup.length) await cleanup.pop()!() })
function chunks(text = '{"risk":"low","decision":"allow"}'): StreamChunk[] {
  return [{type:'block-start',index:0,blockType:'text'}, {type:'text-delta',index:0,text}, {type:'block-end',index:0,block:{type:'text',text}}, {type:'finish',reason:{kind:'stop'}}]
}
class Adapter extends LlmAdapter {
  requests: GenerateOptions[] = []
  response = '{"risk":"low","decision":"allow"}'
  onRequest?: (request: GenerateOptions) => Promise<void>
  async *stream(options: GenerateOptions) { this.requests.push(options); await this.onRequest?.(options); yield* chunks(this.response) }
}
async function world(toolAccess: Record<string,'read-only'> = {}, instructionConfig: Instructions.Config = {}, ptc = false) {
  const f = createFixtureWorkspace('review')
  const ro = join(f.base,'readonly'); mkdirSync(ro)
  const stack = await mountRegistryStack(join(f.base,'store'), {}, {scopeConfig:{toolAccess}, beforeGate: async ctx => {
    await ctx.plugin(Sessions); await ctx.plugin(Projections); await ctx.plugin(SystemPrompt)
    await ctx.plugin(Policy,{mode:'danger-full-access',workspaceRoot:f.workspace})
    await ctx.plugin(MultiRootFileSystem,{cwd:f.workspace})
    if(ptc){
      // The widened Windows ACL argv names ./windows-runner.js beside the
      // provider module; only lib/ ships it (src/ carries windows-runner.ts),
      // so the real-runner mount reads the built provider — the choice
      // tests/windows-multi-root.spec.ts makes for its Windows-native cases.
      const provider=process.platform==='win32'
        ?(await import(pathToFileURL(join(REPO_ROOT,'lib','sandbox.js')).href) as typeof import('../../../src/sandbox.ts')).MultiRootSandboxProvider
        :MultiRootSandboxProvider
      await ctx.plugin(provider,{})
    }
  }})
  cleanup.push(async () => { await stack.dispose(); f.dispose() })
  const ctx = stack.ctx
  await ctx.plugin(WorkingDirectory)
  await ctx.plugin(Instructions, instructionConfig)
  await ctx.plugin(ReviewContextService)
  await ctx.plugin(Tools,{mode:ptc?'ptc':'native'});
  if(ptc){await ctx.plugin(LocalSubprocess);await ctx.plugin(NodePtcRuntime,{});await ctx.plugin(ProcessFence)} await ctx.plugin(LlmRuntime)
  ctx.provide('shell', {sandboxMode:'danger-full-access'})
  await ctx.plugin(Approval,{policy:'never'})
  await ctx.plugin(Presets,{presets:{'danger-full-access':{sandbox:'danger-full-access',approval:'never'}}})
  await ctx.plugin(ToolFs,{})
  const adapter = new Adapter(); ctx.llm.registerAdapter(['review'],adapter)
  const auto = await ctx.plugin(Companion)
  expect(ctx.permissionPresets.names).toContain('auto')
  const session = ctx.sessions.create(SessionId('review-session'),{meta:{cwd:f.workspace}})
  ctx.permissionPresets.set(session,'auto')
  const agent = {id:session.id,session,ctx,options:{},inject() {}} as unknown as Agent
  await stack.registry.add(f.workspace,{path:f.outside,access:'inherit'})
  await stack.registry.add(f.workspace,{path:ro,access:'read-only'})
  let n = 0
  async function run(name: string, args: unknown, signal = new AbortController().signal) {
    const id = ToolCallId(`call-${++n}`)
    // Real published schemas, real Session identities, real tools scheduler.
    const definition = ctx.tools.schemas().find(x => x.name === name)!
    session.append('request/header',{header:{config:{provider:'review',model:'scripted'},tools:[definition]},reason:n===1?'initial':'change'})
    session.append('step/start',{turn:n,step:1})
    session.append('assistant/message',{turn:n,step:1,stream:[],message:createMessage({role:'assistant',source:{kind:'model',provider:'review',model:'scripted'},content:[{type:'tool-call',id,name,arguments:JSON.stringify(args)}]})},{surfaceOp:'append'})
    session.append('tool/call',{turn:n,step:1,callId:id,name,arguments:JSON.stringify(args)})
    const result = await ctx.tools.execute({signal,agent,callId:id,name,arguments:args})
    return result
  }
  const build = (name='write',args: unknown={file_path:join(f.outside,'x.txt')}) => ctx.multiRootReviewContext.build({agent,name,arguments:args},new AbortController().signal)
  return {f,ro,ctx,stack,session,agent,adapter,auto,run,build}
}
function body(request: GenerateOptions): string { const b=request.messages[0]!.content[0]!; if(b.type!=='text') throw Error('not text'); return b.text }
function section(request: GenerateOptions,label:string,next:string) { return JSON.parse(body(request).split(`${label}\n\n`)[1]!.split(`\n\n${next}`)[0]!) }

describe('current host review context and real tool fences', () => {
  it('sends trusted topology and current nested constraints as constraints, then fences scripted allow',async()=>{
    const w=await world({bash:'read-only'})
    mkdirSync(join(w.f.outside,'src','nested'),{recursive:true})
    writeFileSync(join(w.f.outside,'AGENTS.md'),'root rule: never deploy')
    writeFileSync(join(w.f.outside,'src','AGENTS.md'),'middle rule')
    writeFileSync(join(w.f.outside,'src','nested','CLAUDE.md'),'nested rule')
    w.session.append('user/message',createUserMessage({source:{kind:'user',rpcId:'human-1'},content:[{type:'text',text:'Edit the project'}]}),{surfaceOp:'append'})
    const target=join(w.f.outside,'src','nested','new.txt')
    expect((await w.run('write',{file_path:target,content:'allowed'})).isError).toBe(false)
    expect(readFileSync(target,'utf8')).toBe('allowed')
    expect(w.adapter.requests).toHaveLength(1)
    const request=w.adapter.requests[0]!
    const env=section(request,'ENVIRONMENT','PROJECT_INSTRUCTIONS')
    expect(env).toMatchObject({sessionOrigin:w.f.workspace,effectiveCwd:w.f.workspace,sandboxMode:'danger-full-access',registryAuthority:'available',ambientWrites:true,readConfinement:false})
    expect(env.roots).toEqual([{path:w.f.outside,access:'inherit',effectiveWritable:true},{path:w.ro,access:'read-only',effectiveWritable:false}])
    const constraints=section(request,'PROJECT_INSTRUCTIONS','FILTERED_HISTORY')
    expect(constraints).toHaveLength(3)
    expect(constraints.every((c:any)=>c.role==='constraint' && c.source.snapshot==='current')).toBe(true)
    expect(constraints.map((c:any)=>c.text)).toEqual(['root rule: never deploy','middle rule','nested rule'])
    expect(section(request,'FILTERED_HISTORY','PENDING_ACTION')[0].role).toBe('human-instruction')
    const denied=join(w.ro,'existing.txt');writeFileSync(denied,'unchanged')
    expect((await w.run('write',{file_path:denied,content:'bad'})).isError).toBe(true)
    expect(readFileSync(denied,'utf8')).toBe('unchanged')
    expect(w.adapter.requests).toHaveLength(2)
  })
  it('does not mark first-target discovery as success or consume delivery state',async()=>{
    const w=await world();mkdirSync(join(w.f.outside,'new'))
    const nested=join(w.f.outside,'new','AGENTS.md');writeFileSync(nested,'new-rule')
    expect((await w.build('write',{file_path:join(w.f.outside,'new','x')})).constraints.map(x=>x.path)).toContain(nested)
    expect((await w.build('bash',{})).constraints).toHaveLength(0)
    const decision=await w.ctx.waterfall('agent/pre-step',{agent:w.agent,messages:[],signal:new AbortController().signal},async()=>({kind:'enter',messages:[]}))
    expect(JSON.stringify(decision)).not.toContain('new-rule')
  })
  it.skipIf(process.platform==='win32')('finds first-target instructions through a final file symlink without reading its contents',async()=>{
    const w=await world();mkdirSync(join(w.f.outside,'actual'))
    const file=join(w.f.outside,'actual','target');writeFileSync(file,'ordinary source must stay private')
    const instruction=join(w.f.outside,'actual','AGENTS.md');writeFileSync(instruction,'canonical nested rule')
    const link=join(w.f.workspace,'alias');symlinkSync(file,link)
    const context=await w.build('edit',{file_path:link})
    expect(context.constraints.map(item=>item.path)).toContain(instruction)
    expect(JSON.stringify(context)).not.toContain('ordinary source must stay private')
  })
  it('restores nested constraints from successful seed activity without changing delivery state',async()=>{
    const w=await world();mkdirSync(join(w.f.outside,'seed'))
    const instruction=join(w.f.outside,'seed','AGENTS.md');writeFileSync(instruction,'resumed constraint')
    const id=ToolCallId('seed-success')
    w.session.append('tool/call',{turn:0,step:0,callId:id,name:'read',arguments:JSON.stringify({file_path:join(w.f.outside,'seed','file')})})
    w.session.append('tool/result',{turn:0,step:0,message:createToolResultMessage({callId:id,isError:false,content:[{type:'text',text:'ok'}]})},{surfaceOp:'append'})
    const resumed=w.ctx.sessions.create(SessionId('resumed-review'),{meta:{cwd:w.f.workspace},seed:w.session.snapshotEvents()})
    const agent={...w.agent,id:resumed.id,session:resumed} as Agent
    const snapshot=await w.ctx.multiRootReviewContext.build({agent,name:'bash',arguments:{}},new AbortController().signal)
    expect(snapshot.constraints.map(item=>item.path)).toContain(instruction)
    expect(snapshot.constraints[0]?.text).toBe('resumed constraint')
  })
  it('re-reads updates, deletion and revocation, and ignores historical prose',async()=>{
    const w=await world();const path=join(w.f.outside,'AGENTS.md');writeFileSync(path,'old-rule')
    const before=await w.build();writeFileSync(path,'new-rule');expect((await w.build()).constraints[0]?.text).toBe('new-rule')
    await expect(w.ctx.multiRootReviewContext.assertCurrent({agent:w.agent,name:'write',arguments:{}},before,new AbortController().signal)).rejects.toThrow('changed')
    rmSync(path);expect((await w.build()).constraints).toHaveLength(0)
    writeFileSync(path,'another-rule');const records=w.stack.registry.list(w.f.workspace)
    await w.stack.registry.remove(w.f.workspace,{kind:'id',id:records[0]!.id})
    expect((await w.build()).constraints).toHaveLength(0)
  })
  it.each(['instruction','roots','cwd'] as const)('fails closed when %s changes while the reviewer waits',async(change)=>{
    const w=await world();const file=join(w.f.outside,'AGENTS.md');writeFileSync(file,'initial')
    w.adapter.onRequest=async()=>{
      if(change==='instruction')writeFileSync(file,'changed')
      if(change==='roots')await w.stack.registry.setAccess(w.f.workspace,{kind:'id',id:w.stack.registry.list(w.f.workspace)[0]!.id},'read-only')
      if(change==='cwd')await w.ctx.workingDirectory.set(w.agent,w.ro)
    }
    const path=join(w.f.outside,'never.txt')
    const result=await w.run('write',{file_path:path,content:'no'})
    expect(result.isError).toBe(true);expect(JSON.stringify(result)).toContain('snapshot changed')
    expect(()=>readFileSync(path)).toThrow()
  })
  it('fails on budget exhaustion, collector errors and cancellation without a review or body',async()=>{
    const w=await world({}, {maxBytes:100});writeFileSync(join(w.f.outside,'AGENTS.md'),'constraint'.repeat(100))
    expect((await w.run('write',{file_path:join(w.f.outside,'x'),content:'bad'})).isError).toBe(true)
    expect(w.adapter.requests).toHaveLength(0)
    rmSync(join(w.f.outside,'AGENTS.md'))
    vi.spyOn(w.ctx.multiRootInstructions,'snapshot').mockRejectedValueOnce(new Error('collector broke'))
    expect((await w.run('write',{file_path:join(w.f.outside,'x'),content:'bad'})).isError).toBe(true)
    const abort=new AbortController();abort.abort()
    expect((await w.run('write',{file_path:join(w.f.outside,'x'),content:'bad'},abort.signal)).isError).toBe(true)
    expect(w.adapter.requests).toHaveLength(0)
  })
  it('bounds streamed instruction reads and closes an over-budget stream without calling the reviewer',async()=>{
    const w=await world({}, {maxSourceBytes:8})
    writeFileSync(join(w.f.outside,'AGENTS.md'),'small')
    let closed=false
    vi.spyOn(w.ctx.fs,'streamText').mockResolvedValueOnce((async function*(){try{yield 'small';yield 'grown beyond the stat size'}finally{closed=true}})())
    const result=await w.run('write',{file_path:join(w.f.outside,'never'),content:'no'})
    expect(result.isError).toBe(true);expect(closed).toBe(true);expect(w.adapter.requests).toHaveLength(0)
  })
  it('retains unavailable authority and redirect restrictions without stale constraints',async()=>{
    const w=await world();writeFileSync(join(w.f.outside,'AGENTS.md'),'stale')
    const displaced=`${w.f.outside}-old`;renameSync(w.f.outside,displaced);symlinkSync(w.ro,w.f.outside,process.platform==='win32'?'junction':'dir')
    const redirected=await w.build();expect(redirected.constraints).toHaveLength(0)
    expect(redirected.environment.roots.some(x=>x.path===w.f.outside)).toBe(false)
    w.ctx.multiRootScope.setRegistryAuthority(false)
    vi.spyOn(w.stack.registry,'refresh').mockResolvedValue([])
    const absent=await w.build();expect(absent.environment.registryAuthority).toBe('unavailable');expect(absent.environment.writeBoundary).toContain('primary-root-only');expect(absent.constraints).toHaveLength(0)
  })
  it('matches read-only preview to actual nested execution and isolates concurrent caps',async()=>{
    const w=await world({bash:'read-only'})
    const policy=w.ctx.sandboxPolicy.resolve({session:w.session})
    expect(w.ctx.multiRootScope.resolve(policy).writableRoots).toEqual([])
    expect(w.ctx.multiRootScope.previewForTool(policy,'write').writableRoots).toContain(w.f.outside)
    const dispatch=(name:string,fn:()=>Promise<any>)=> (w.ctx.waterfall as any)('tools/execute',{name,callId:name,token:{}},fn)
    await Promise.all([dispatch('bash',async()=>{
      expect((await w.build()).environment.writableRoots).toEqual([])
      await dispatch('write',async()=>expect(w.ctx.multiRootScope.resolve(policy)).toEqual(w.ctx.multiRootScope.previewForTool(policy,'write')))
    }),dispatch('write',async()=>{expect((await w.build()).environment.writableRoots).toContain(w.f.outside)})])
  })
  it('reviews real PTC inner fs calls once and retains the outer run_code tool cap',async(test)=>{
    const w=await world({}, {}, true)
    const target=join(w.f.outside,'ptc.txt')
    const result=await w.run('run_code',{code:`return await tools.write(${JSON.stringify({file_path:target,content:'ptc-ok'})});`,description:'Write one fixture'})
    if(result.isError && /sandbox|SANDBOX|Operation not permitted/.test(JSON.stringify(result)) && w.adapter.requests.length===0){
      test.skip(requireKernelRunner(process.platform==='darwin'?'seatbelt':process.platform==='win32'?'windows-acl':'bwrap',JSON.stringify(result)));return
    }
    expect(result.isError,JSON.stringify(result)).toBe(false)
    expect(readFileSync(target,'utf8')).toBe('ptc-ok');expect(w.adapter.requests).toHaveLength(1)
    expect(section(w.adapter.requests[0]!,'PENDING_ACTION','__END__').mode).toBe('ptc-inner')
    writeFileSync(join(w.ro,'ptc-keep'),'keep')
    await w.run('run_code',{code:`return await tools.write(${JSON.stringify({file_path:join(w.ro,'ptc-keep'),content:'no'})});`,description:'Try a readonly root'})
    expect(readFileSync(join(w.ro,'ptc-keep'),'utf8')).toBe('keep');expect(w.adapter.requests).toHaveLength(2)
    const direct=await w.run('run_code',{code:`await (await import('node:fs/promises')).writeFile(${JSON.stringify(join(w.ro,'ptc-keep'))},'kernel bypass');`,description:'Direct process write must remain fenced'})
    expect(direct.isError,JSON.stringify(direct)).toBe(true)
    expect(readFileSync(join(w.ro,'ptc-keep'),'utf8')).toBe('keep')
    expect(w.adapter.requests).toHaveLength(2)
    const capped=await world({run_code:'read-only'}, {}, true)
    const refused=join(capped.f.outside,'capped-ptc.txt')
    await capped.run('run_code',{code:`return await tools.write(${JSON.stringify({file_path:refused,content:'no'})});`,description:'Capped inner write'})
    expect(()=>readFileSync(refused)).toThrow()
    expect(capped.adapter.requests).toHaveLength(1)
    expect(section(capped.adapter.requests[0]!,'ENVIRONMENT','PROJECT_INSTRUCTIONS').writableRoots).toEqual([])
  })
  it('rechecks after human approval and does not let approval bypass a read-only fence',async()=>{
    const w=await world();setApprovalPolicy(w.session,'ask')
    w.adapter.response='{"risk":"medium","decision":"deny"}'
    w.ctx.on('approval/request',async()=> 'approved')
    const path=join(w.ro,'human.txt');writeFileSync(path,'keep')
    expect((await w.run('write',{file_path:path,content:'bad'})).isError).toBe(true)
    expect(readFileSync(path,'utf8')).toBe('keep')
  })
  it('fails stale snapshots after approval and after downstream gates',async()=>{
    const w=await world();setApprovalPolicy(w.session,'ask')
    const instruction=join(w.f.outside,'AGENTS.md');writeFileSync(instruction,'before')
    w.adapter.response='{"risk":"medium","decision":"deny"}'
    w.ctx.on('approval/request',async()=>{writeFileSync(instruction,'after');return 'approved'})
    const path=join(w.f.outside,'approved.txt')
    expect((await w.run('write',{file_path:path,content:'bad'})).isError).toBe(true)
    expect(()=>readFileSync(path)).toThrow()
    w.adapter.response='{"risk":"low","decision":"allow"}'
    w.ctx.on('tools/pre-execute',async(_exec,next)=>{const result=await next();writeFileSync(instruction,'last-minute');return result})
    expect((await w.run('write',{file_path:path,content:'bad'})).isError).toBe(true)
  })
  it('includes effective cwd without changing the origin or adding an ambient membership grant',async()=>{
    const w=await world();await w.ctx.workingDirectory.set(w.agent,w.ro)
    const context=await w.build('write',{file_path:'relative.txt'})
    expect(context.environment.sessionOrigin).toBe(w.f.workspace)
    expect(context.environment.effectiveCwd).toBe(w.ro)
    expect(context.environment.roots.find(x=>x.path===w.ro)?.effectiveWritable).toBe(false)
    expect((await w.run('write',{file_path:'relative.txt',content:'no'})).isError).toBe(true)
  })
  it('unloads Auto to Full access without removing write fences, and reinstalls one owner',async()=>{
    const w=await world();await w.auto.dispose()
    expect(w.ctx.permissionPresets.current(w.session)).toBe('danger-full-access')
    expect(w.ctx.permissionPresets.names).not.toContain('auto')
    expect(w.ctx.get('fs')).toBeDefined();expect(w.ctx.get('sandbox')).toBeDefined()
    await expect(w.ctx.fs.writeText(await w.ctx.fs.resolve(join(w.ro,'x')),'bad',undefined,undefined,w.ctx.sandboxPolicy.resolve({session:w.session}))).rejects.toMatchObject({code:'FS_SANDBOX_DENIED'})
    await w.ctx.plugin(Companion);expect(w.ctx.permissionPresets.names.filter(x=>x==='auto')).toHaveLength(1)
  })
})
