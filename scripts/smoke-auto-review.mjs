import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { packTarball, readTarGz } from './check-pack.mjs'
import { autoReviewBattery } from './lib/auto-review-battery.mjs'
import { fileURLToPath } from 'node:url'
import { configure, COMPANION } from '../compat/auto-review/configure.mjs'
import { join } from 'node:path'
import { bootProfile, composeProfile } from './lib/profile-boot.mjs'
import { loadAppBoot, loadRuntimeModule, resolveScratchHome, installPluginProfile, ensureProfileCopyImport, runDsh, runtimeRequire } from './lib/dsh-runtime.mjs'
if (JSON.parse(readFileSync(runtimeRequire().resolve('@deepseek-ai/dsh/package.json'),'utf8')).version !== '0.2.1-rc.2') {
  console.log('[auto-review] skipped: joint runtime contract is only 0.2.1-rc.2; ordinary bundle gates remain active')
  process.exit(0)
}
const app = await loadAppBoot()
const home = resolveScratchHome(`auto-review-phase0-${process.pid}`)
mkdirSync(home, { recursive: true })
const packed=process.env.DSH_AUTO_REVIEW_PACKED==='1'
const packs=[]
if(packed){
  packs.push(packTarball())
  packs.push(packTarball(mkdtempSync(join(tmpdir(),'dsh-review-pack-')),fileURLToPath(new URL('../compat/auto-review',import.meta.url))))
  const members=readTarGz(packs[1].tarball)
  for(const file of ['package/lib/index.js','package/lib/types/index.d.ts','package/LICENSE','package/FORK.md','package/README.en.md','package/configure.mjs'])assert.ok(members.has(file),`missing companion ${file}`)
}
try {
  for (const template of ['web', 'headless']) {
    for (const first of packed ? [true] : [true, false]) {
      const name = `${template}-${first}`
      const dir = join(home, 'profiles', name)
      app.initProfile(dir, ['@deepseek-ai/dsh-base', `@deepseek-ai/dsh-${template === 'web' ? 'web-app' : 'headless'}`])
      ensureProfileCopyImport(home, name)
      assert.equal(await installPluginProfile(name, home, packs[0]?.tarball), 0)
      writeFileSync(join(dir,'cordis.patch.yml'),template==='web'?'[]\n':'- id: headless-runner\n  disabled: true\n')
      const ordinary = await bootProfile(name,home,async host=>{
        const {provideCmdline}=await loadRuntimeModule('@deepseek-ai/dsh-cmdline')
        provideCmdline(host,{args:template==='web'?['--no-open','--port','0']:[],exit:()=>{}})
      })
      try {
        assert.equal(ordinary.ctx.permissionPresets.names.includes('auto'),false)
        assert.equal(ordinary.ctx.get('multiRootReviewContext'),undefined)
        console.log(`[auto-review] ${name}: ordinary installation neither advertises Auto nor mounts reviewer context`)
      } finally {await ordinary.ctx.fiber.dispose()}
      const m = app.readProfileManifest('probe', dir)
      const official = '@deepseek-ai/dsh-experimental-auto-review'
      const bundles = m.dsh.profile.bundles
      app.writeProfileBundles(dir, m, first ? [...bundles.slice(0, 2), official, ...bundles.slice(2)] : [...bundles, official])
      writeFileSync(join(dir, 'cordis.patch.yml'), template === 'web' ? '[]\n' : '- id: headless-runner\n  disabled: true\n')
      let {ctx} = await bootProfile(name, home, async host => {
        const {provideCmdline} = await loadRuntimeModule('@deepseek-ai/dsh-cmdline')
        provideCmdline(host, {args:template === 'web' ? ['--no-open','--port','0'] : [], exit:()=>{}})
      })
      try {
        assert.ok(ctx.get('fs')); assert.ok(ctx.get('sandbox')); assert.ok(ctx.get('multiRootRegistry'))
        assert.ok(ctx.permissionPresets.catalog().options.some(x => x.id === 'auto' || x.value === 'auto'))
        console.log(`[phase0] ${name}: boot, providers, registry and Auto registered`)
      } finally { await ctx.fiber.dispose() }
      assert.equal(await runDsh(['plugin','--profile',name,'add',packs[1]?.tarball ?? fileURLToPath(new URL('../compat/auto-review',import.meta.url))], {DSH_HOME:home}),0)
      // Exercise both raw installation orders, then the explicit enable step.
      const before = app.readProfileManifest('probe',dir)
      if (first) before.dsh.profile.bundles = [COMPANION, ...before.dsh.profile.bundles.filter(x=>x!==COMPANION)]
      app.writeProfileManifest(dir,before)
      execFileSync(process.execPath,[join(dir,'node_modules',COMPANION,'configure.mjs'),'enable',dir],{stdio:'inherit'})
      ;({ctx} = await bootProfile(name,home,async host=>{
        const {provideCmdline}=await loadRuntimeModule('@deepseek-ai/dsh-cmdline')
        provideCmdline(host,{args:template==='web'?['--no-open','--port','0']:[],exit:()=>{}})
      }))
      try {
        assert.ok(ctx.get('multiRootReviewContext'))
        assert.equal(ctx.permissionPresets.names.filter(x=>x==='auto').length,1)
        const {session} = await autoReviewBattery(ctx,name)
        app.writeProfileManifest(dir,configure(app.readProfileManifest('probe',dir),false))
        let next = await composeProfile(name,home)
        await app.reconcileProfilePatches(ctx,next.patches,'auto-review-smoke')
        assert.equal(ctx.permissionPresets.current(session),'danger-full-access')
        assert.equal(ctx.get('multiRootReviewContext'),undefined)
        assert.equal(ctx.permissionPresets.names.filter(x=>x==='auto').length,1)
        assert.ok(ctx.get('fs'));assert.ok(ctx.get('sandbox'))
        app.writeProfileManifest(dir,configure(app.readProfileManifest('probe',dir),true))
        next = await composeProfile(name,home)
        await app.reconcileProfilePatches(ctx,next.patches,'auto-review-smoke')
        assert.ok(ctx.get('multiRootReviewContext'))
        assert.equal(ctx.permissionPresets.current(session),'danger-full-access')
        assert.equal(ctx.permissionPresets.names.filter(x=>x==='auto').length,1)
        console.log(`[auto-review] ${name}: live disable migrates Auto to Full access; official restore and companion re-enable keep one owner`)
        console.log(`[auto-review] ${name}: companion active, one owner, context and providers present`)
      } finally { await ctx.fiber.dispose() }
      app.writeProfileManifest(dir,configure(app.readProfileManifest('probe',dir),false))
      ;({ctx} = await bootProfile(name,home,async host=>{
        const {provideCmdline}=await loadRuntimeModule('@deepseek-ai/dsh-cmdline')
        provideCmdline(host,{args:template==='web'?['--no-open','--port','0']:[],exit:()=>{}})
      }))
      try {
        assert.equal(ctx.get('multiRootReviewContext'),undefined)
        assert.equal(ctx.permissionPresets.names.filter(x=>x==='auto').length,1)
        assert.ok(ctx.get('fs'));assert.ok(ctx.get('sandbox'))
        console.log(`[auto-review] ${name}: disable restores official owner and preserves providers`)
      } finally { await ctx.fiber.dispose() }
      assert.equal(await runDsh(['plugin','--profile',name,'remove',COMPANION],{DSH_HOME:home}),0)
      assert.ok(!app.readProfileManifest('probe',dir).dsh.profile.bundles.includes(COMPANION))
      console.log(`[auto-review] ${name}: actual package uninstall preserves the selected official bundle`)
    }
  }
} finally { rmSync(home, {recursive:true, force:true}); for(const pack of packs)rmSync(pack.dir,{recursive:true,force:true}) }
