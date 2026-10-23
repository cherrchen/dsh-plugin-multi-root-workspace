import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { packTarball, readTarGz } from './check-pack.mjs'
import { autoReviewBattery } from './lib/auto-review-battery.mjs'
import { bootProfile, composeProfile } from './lib/profile-boot.mjs'
import { removeBehaviorHome, removeScratchTree } from './lib/smoke-cleanup.mjs'
import { loadAppBoot, loadRuntimeModule, resolveScratchHome, installPluginProfile, ensureProfileCopyImport, runtimeRequire } from './lib/dsh-runtime.mjs'
if (JSON.parse(readFileSync(runtimeRequire().resolve('@deepseek-ai/dsh/package.json'),'utf8')).version !== '0.2.1-rc.2') {
  console.log('[auto-review] skipped: optional integration targets only 0.2.1-rc.2; ordinary gates remain active')
  process.exit(0)
}
const app = await loadAppBoot()
const home = resolveScratchHome(`auto-review-${process.pid}`)
mkdirSync(home, { recursive: true })
const packed = process.env.DSH_AUTO_REVIEW_PACKED === '1'
const pack = packed ? packTarball() : undefined
if (pack) {
  const members = readTarGz(pack.tarball)
  for (const file of ['package/lib/auto-review.js','package/lib/types/auto-review/entry.d.ts','package/src/auto-review/LICENSE','package/src/auto-review/FORK.md']) assert.ok(members.has(file), `missing ${file}`)
  assert.ok(!members.has('package/configure.mjs'))
}
const official = '@deepseek-ai/dsh-experimental-auto-review'
const entryId = 'include:multi-root-auto-review'
try {
  for (const template of ['web', 'headless']) for (const first of [true, false]) {
    const name = `${template}-${first}`
    const dir = join(home, 'profiles', name)
    app.initProfile(dir, ['@deepseek-ai/dsh-base', `@deepseek-ai/dsh-${template === 'web' ? 'web-app' : 'headless'}`])
    ensureProfileCopyImport(home, name)
    assert.equal(await installPluginProfile(name, home, pack?.tarball), 0)
    const baselinePatch = template === 'web' ? '' : '- id: headless-runner\n  disabled: true\n'
    const patch = join(dir, 'cordis.patch.yml')
    writeFileSync(patch, baselinePatch || '[]\n')
    const prepare = async (host, {installAnchor}) => {
      host.provide('profileContext', {
        name, dir, home, patchPath:patch, installAnchor, cwd:process.cwd(),
        startedBundles:app.readProfileManifest('probe',dir).dsh.profile.bundles,
        overlays:[], telemetryDisabledEnv:undefined,
      })
      const {provideCmdline} = await loadRuntimeModule('@deepseek-ai/dsh-cmdline')
      provideCmdline(host,{args:template === 'web' ? ['--no-open','--port','0'] : [],exit:()=>{}})
    }
    let {ctx} = await bootProfile(name,home,prepare)
    try {
      assert.equal(ctx.permissionPresets.names.includes('auto'),false)
      assert.equal(ctx.get('multiRootReviewContext'),undefined)
      const row = [...ctx.loader.entries()].find(row => row.id === entryId)
      assert.ok(row); assert.equal(row.disabled,true); assert.equal(row.fiber,undefined)
      console.log(`[auto-review] ${name}: default entry visible and disabled; no owner or context`)
    } finally { await ctx.fiber.dispose() }
    const manifest = app.readProfileManifest('probe',dir)
    const bundles = manifest.dsh.profile.bundles
    app.writeProfileBundles(dir,manifest,first ? [...bundles.slice(0,2),official,...bundles.slice(2)] : [...bundles,official])
    const activated = await bootProfile(name,home,prepare)
    ctx = activated.ctx
    const bootApp = activated.appBoot
    const recompose = async () => {
      const next = await composeProfile(name,home)
      await bootApp.reconcileProfilePatches(ctx,next.patches,'auto-review-smoke')
    }
    const setEnabled = async enabled => {
      console.log(`[auto-review] ${name}: row -> ${enabled}`)
      const manager = ctx.get('pluginManager')
      if (manager !== undefined) {
        const row = (await manager.listPlugins()).find(row => row.entryId === entryId)
        assert.ok(row); assert.equal(row.readOnlyReason,undefined)
        const result = await manager.setPluginEnabled(entryId,enabled)
        assert.notEqual(result.application,'failed',JSON.stringify(result))
        if (result.application === 'restart-required') await recompose()
      } else {
        writeFileSync(patch,`${baselinePatch}- id: multi-root-auto-review\n  disabled: ${!enabled}\n`)
        await recompose()
      }
    }
    try {
      assert.equal(ctx.permissionPresets.names.filter(x=>x==='auto').length,1)
      assert.equal(ctx.get('multiRootReviewContext'),undefined)
      await setEnabled(true)
      assert.ok(ctx.get('multiRootReviewContext'))
      assert.equal(ctx.permissionPresets.names.filter(x=>x==='auto').length,1)
      assert.ok(![...ctx.loader.entries()].some(row=>row.options.name===official))
      const filesBefore = [readFileSync(join(dir,'package.json'),'utf8'),readFileSync(patch,'utf8')]
      for (let i=0;i<2;i++) await recompose()
      assert.deepEqual([readFileSync(join(dir,'package.json'),'utf8'),readFileSync(patch,'utf8')],filesBefore)
      assert.ok(ctx.get('multiRootReviewContext'))
      const {session} = await autoReviewBattery(ctx,name)
      await setEnabled(false)
      assert.equal(ctx.permissionPresets.current(session),'danger-full-access')
      assert.equal(ctx.get('multiRootReviewContext'),undefined)
      assert.equal(ctx.permissionPresets.names.filter(x=>x==='auto').length,1)
      assert.ok([...ctx.loader.entries()].some(row=>row.options.name===official&&!row.disabled))
      await setEnabled(true)
      assert.equal(ctx.permissionPresets.current(session),'danger-full-access')
      assert.ok(ctx.get('multiRootReviewContext'))
      assert.equal(ctx.permissionPresets.names.filter(x=>x==='auto').length,1)
      await setEnabled(false)
      assert.ok(ctx.get('fs')); assert.ok(ctx.get('sandbox')); assert.ok(ctx.get('multiRootRegistry'))
      console.log(`[auto-review] ${name}: single row toggle, both bundle orders, repeated reload, owner drain and official restore passed`)
    } finally { await ctx.fiber.dispose() }
    ;({ctx} = await bootProfile(name,home,prepare))
    try {
      assert.equal(ctx.get('multiRootReviewContext'),undefined)
      assert.equal(ctx.permissionPresets.names.filter(x=>x==='auto').length,1)
    } finally { await ctx.fiber.dispose() }
  }
} finally {
  await removeBehaviorHome(home,process.env.DSH_SMOKE_DEFER_HOME_CLEANUP === '1')
  if(pack)await removeScratchTree(pack.dir)
}
