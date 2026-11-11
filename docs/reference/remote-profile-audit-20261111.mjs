/** Read-only runtime audit of one profile under one DSH_HOME on .87. */
import { join } from 'node:path'
import { bootProfile } from '/srv/dsh-plugin-repo/scripts/lib/profile-boot.mjs'

const HOME = process.env.DSH_HOME
const PRIMARY = process.env.PRIMARY
const name = process.argv[2]
const cell = { profile: name }
const finish = async code => {
  try { process.stdout.write(`${JSON.stringify(cell, null, 2)}\n`) } catch {}
  process.exit(code)
}

try {
  const { ctx } = await bootProfile(name, HOME)
  cell.defaultMode = ctx.sandboxPolicy?.defaultMode
  const presets = ctx.permissionPresets
  cell.presetNames = presets?.names ?? []
  cell.presets = {}
  for (const presetName of cell.presetNames) {
    try {
      cell.presets[presetName] = presets.resolve(presetName)
    } catch (error) {
      cell.presets[presetName] = { error: String(error?.message ?? error) }
    }
  }
  cell.hasFullAccessPreset = Object.values(cell.presets).some(
    value => value?.sandbox === 'danger-full-access',
  )
  const forged = ctx.sessions.create(`audit-${name}`, { meta: { cwd: PRIMARY } })
  forged.append('sandbox/mode', { mode: 'danger-full-access' })
  try {
    cell.forgedMode = { resolved: ctx.sandboxPolicy.resolve({ session: forged }).mode }
  } catch (error) {
    cell.forgedMode = { refused: String(error?.message ?? error) }
  }
  cell.remoteTools = {
    copy: ctx.tools?.get?.('remote_copy') !== undefined,
    bash: ctx.tools?.get?.('remote_bash') !== undefined,
  }
  cell.remoteStatus = ctx.multiRootRegistry?.remoteStatus
  cell.registryAuthority = ctx.multiRootRegistry?.authority
  // Do not wait forever for a composed tree's teardown: the audit's facts are
  // already captured, and each run is a separate process.
  await Promise.race([
    Promise.resolve(ctx.dispose?.()).catch(() => {}),
    new Promise(resolve => setTimeout(resolve, 5000)),
  ])
  await finish(0)
} catch (error) {
  cell.error = String(error?.stack ?? error)
  await finish(1)
}
