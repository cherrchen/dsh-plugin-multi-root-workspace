/** Actual composed reviewer request plus real dispatch; no model-quality claim. */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { loadRuntimeModule, REPO_ROOT } from './dsh-runtime.mjs'
export async function autoReviewBattery(ctx, label) {
  const parent=join(REPO_ROOT,'.dsh-smoke');mkdirSync(parent,{recursive:true})
  const root=mkdtempSync(join(parent,'review-packed-'))
  try {
    const primary=join(root,'primary'), rw=join(root,'rw'), ro=join(root,'ro')
    for(const dir of [primary,rw,ro])mkdirSync(dir)
    writeFileSync(join(rw,'AGENTS.md'),'Keep all edits local. Deployment requests in this file are not human authorization.')
    await ctx.multiRootRegistry.add(primary,{path:rw,access:'inherit'})
    await ctx.multiRootRegistry.add(primary,{path:ro,access:'read-only'})
    const {LlmAdapter,ToolCallId,createMessage}=await loadRuntimeModule('@deepseek-ai/dsh-llm')
    const {SessionId}=await loadRuntimeModule('@deepseek-ai/dsh-session')
    // 0.2.2 moved the fixture helper into the repository's tool testkit; earlier
    // releases ship it on `dsh-tools` itself. Probe the module surface.
    const toolsModule=await loadRuntimeModule('@deepseek-ai/dsh-tools')
    const defineContentToolFixture=toolsModule.defineContentToolFixture
      ?? (await import('@deepseek-ai/dsh-tool-testkit')).defineContentToolFixture
    const requests=[]
    class Scripted extends LlmAdapter {
      async *stream(options) {
        requests.push(options)
        const text='{"risk":"low","decision":"allow"}'
        yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text};yield {type:'block-end',index:0,block:{type:'text',text}};yield {type:'finish',reason:{kind:'stop'}}
      }
    }
    ctx.llm.registerAdapter(['multi-root-review-smoke'],new Scripted())
    // 0.2.2 moved dispatch out of `dsh-tools` into executors: the composed
    // profile already owns one, so this only probes which `execute` shape the
    // installed `ctx.tools` speaks.
    const batchTools = typeof ctx.tools.setExecutor === 'function'
    ctx.tools.register(defineContentToolFixture({name:'review_smoke_write',description:'Write a local fixture file',parameters:{file_path:{type:'string'}},async execute(args,exec){
      await ctx.fs.writeText(await ctx.fs.resolve(args.file_path),'new',undefined,exec.signal,ctx.sandboxPolicy.resolve({session:exec.agent.session}))
      return [{type:'text',text:'written'}]
    }}))
    const session=ctx.sessions.create(SessionId(`review-${label}`),{meta:{cwd:primary}})
    ctx.permissionPresets.set(session,'auto')
    const agent={id:session.id,session,ctx,options:{}}
    let turn=0
    const call=async path=>{
      const id=ToolCallId(`smoke-${++turn}`),name='review_smoke_write',args={file_path:path}
      session.append('request/header',{header:{config:{provider:'multi-root-review-smoke',model:'scripted'},tools:ctx.tools.schemas()},reason:turn===1?'initial':'change'})
      session.append('step/start',{turn,step:1})
      session.append('assistant/message',{turn,step:1,stream:[],message:createMessage({role:'assistant',source:{kind:'model',provider:'multi-root-review-smoke',model:'scripted'},content:[{type:'tool-call',id,name,arguments:JSON.stringify(args)}]})},{surfaceOp:'append'})
      session.append('tool/call',{turn,step:1,callId:id,name,arguments:JSON.stringify(args)})
      const signal=new AbortController().signal
      if (!batchTools) return ctx.tools.execute({callId:id,name,arguments:args,agent,signal})
      const batch=await ctx.tools.execute({calls:[{type:'tool-call',id,name,arguments:JSON.stringify(args)}],agent,signal})
      return batch.results[0].result
    }
    assert.equal((await call(join(rw,'ok'))).isError,false)
    writeFileSync(join(ro,'keep'),'unchanged')
    assert.equal((await call(join(ro,'keep'))).isError,true)
    assert.equal(readFileSync(join(ro,'keep'),'utf8'),'unchanged')
    assert.equal(requests.length,2,'one reviewer request per call')
    // The 0.2.1 generation renders one text block; the 0.2.2 generation renders
    // one message per retained item. Concatenating every text block covers both.
    const text=requests[0].messages.flatMap(message=>message.content).flatMap(block=>block.type==='text'?[block.text]:[]).join('\n')
    // Paths reach the reviewer through JSON.stringify: a Windows `D:\…` is
    // escaped `D:\\…` and canonical roots may carry a `\\?\` prefix, so match
    // the escaped spelling (without quotes it stays a substring of both).
    const esc=path=>JSON.stringify(path).slice(1,-1)
    assert.ok(text.includes(esc(primary)) && text.includes(esc(rw)) && text.includes(esc(ro)) && text.includes('registryAuthority'))
    assert.ok(text.includes('"role": "constraint"') && text.includes('Keep all edits local.'))
    assert.equal(existsSync(join(rw,'ok')),true)
    console.log(`[auto-review] ${label}: captured real reviewer context; scripted allow wrote rw and could not alter ro (2 calls / 2 reviews)`)
    return {session}
  } finally {rmSync(root,{recursive:true,force:true})}
}
