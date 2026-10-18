#!/usr/bin/env node
/** Explicit enable/disable; preserves unrelated profile metadata and bundle order. */
import { readFileSync, realpathSync, statSync, rmSync, writeFileSync, renameSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
export const COMPANION = '@dsh-electron/dsh-plugin-multi-root-auto-review'
export const OFFICIAL = '@deepseek-ai/dsh-experimental-auto-review'
export const MULTI_ROOT = '@dsh-electron/dsh-plugin-multi-root-workspace'
export function configure(manifest, enabled) {
  const bundles = manifest.dsh?.profile?.bundles
  if (!Array.isArray(bundles) || bundles.some(x => typeof x !== 'string') || new Set(bundles).size !== bundles.length) {
    throw new Error('Auto Review: profile requires a unique ordered bundle list')
  }
  if (enabled && (!bundles.includes(OFFICIAL) || !bundles.includes(MULTI_ROOT))) {
    throw new Error('Auto Review: first explicitly select the official Auto Review and Multi-root bundles')
  }
  const kept = bundles.filter(x => x !== COMPANION)
  return { ...manifest, dsh: { ...manifest.dsh, profile: { ...manifest.dsh.profile, bundles: enabled ? [...kept, COMPANION] : kept } } }
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [action, directory] = process.argv.slice(2)
  if (!['enable', 'disable'].includes(action) || directory === undefined) throw new Error('Usage: dsh-multi-root-auto-review enable|disable <profile-directory>')
  const file = join(resolve(directory), 'package.json')
  const previous = readFileSync(file, 'utf8')
  const updated = configure(JSON.parse(previous), action === 'enable')
  if (action === 'enable' && updated.dependencies?.[COMPANION] === undefined) throw new Error('Auto Review: install the companion into this profile first')
  const pending = `${file}.multi-root-auto-review-${process.pid}`
  try {
    writeFileSync(pending, `${JSON.stringify(updated, null, 2)}\n`, {flag:'wx',mode:statSync(file).mode & 0o777})
    if (readFileSync(file, 'utf8') !== previous) throw new Error('Auto Review: profile changed concurrently; retry')
    renameSync(pending, file)
  } finally {rmSync(pending,{force:true})}
  console.log(`Auto Review companion ${action}d. Restart/recompose the profile; unloading live Auto migrates its sessions to Full access.`)
}
