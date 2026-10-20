import { Context } from '@deepseek-ai/cordis'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import { afterEach, expect, it } from 'vitest'
import Scope from '../src/scope.ts'
import { createFixtureWorkspace } from './support/temp-workspace.ts'
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { while(cleanup.length)await cleanup.pop()!() })
it('projects every access/mode/tool combination identically to execution without authorizing unknown contexts',async()=>{
  const fixture=createFixtureWorkspace('preview'),ctx=new Context()
  await ctx.plugin(Scope,{toolAccess:{bash:'read-only'},dshHome:fixture.base})
  cleanup.push(async()=>{await ctx.fiber.dispose();fixture.dispose()})
  const path=canonicalPath(fixture.outside)
  const dispatch=(name:string,next:()=>Promise<void>)=>(ctx.waterfall as any)('tools/execute',{name,callId:name},next)
  for(const access of ['inherit','read-only','read-write'] as const){
    ctx.multiRootScope.setAdditionalRoots(fixture.workspace,[{id:'r',path,recordedPath:path,access}])
    for(const mode of ['read-only','workspace-write','danger-full-access'] as const){
      const policy={mode,workspaceRoot:fixture.workspace}
      const unknown=ctx.multiRootScope.resolve(policy)
      expect(unknown.writableRoots).toEqual([])
      for(const tool of ['write','bash']){
        const preview=ctx.multiRootScope.previewForTool(policy,tool)
        expect(ctx.multiRootScope.resolve(policy)).toEqual(unknown)
        await dispatch(tool,async()=>{
          expect(ctx.multiRootScope.resolve(policy)).toEqual(preview)
          const nested=ctx.multiRootScope.previewForTool(policy,'write')
          await dispatch('write',async()=>expect(ctx.multiRootScope.resolve(policy)).toEqual(nested))
        })
      }
    }
  }
  ctx.multiRootScope.setRegistryAuthority(false)
  expect(ctx.multiRootScope.previewForTool({mode:'danger-full-access',workspaceRoot:fixture.workspace},'write').writableRoots).toEqual([])
})
