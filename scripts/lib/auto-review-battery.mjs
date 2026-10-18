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
    const {defineContentToolFixture}=await loadRuntimeModule('@deepseek-ai/dsh-tools')
    const requests=[]
    class Scripted extends LlmAdapter {
      async *stream(options) {
        requests.push(options)
        const text='{"risk":"low","decision":"allow"}'
        yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text};yield {type:'block-end',index:0,block:{type:'text',text}};yield {type:'finish',reason:{kind:'stop'}}
      }
    }
    ctx.llm.registerAdapter(['multi-root-review-smoke'],new Scripted())
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
      return ctx.tools.execute({callId:id,name,arguments:args,agent,signal:new AbortController().signal})
    }
    assert.equal((await call(join(rw,'ok'))).isError,false)
    writeFileSync(join(ro,'keep'),'unchanged')
    assert.equal((await call(join(ro,'keep'))).isError,true)
    assert.equal(readFileSync(join(ro,'keep'),'utf8'),'unchanged')
    assert.equal(requests.length,2,'one reviewer request per call')
    const text=requests[0].messages[0].content[0].text
    assert.ok(text.includes(primary) && text.includes(rw) && text.includes(ro) && text.includes('registryAuthority'))
    assert.ok(text.includes('"role": "constraint"') && text.includes('Keep all edits local.'))
    assert.equal(existsSync(join(rw,'ok')),true)
    console.log(`[auto-review] ${label}: captured real reviewer context; scripted allow wrote rw and could not alter ro (2 calls / 2 reviews)`)
    return {session}
  } finally {rmSync(root,{recursive:true,force:true})}
}
