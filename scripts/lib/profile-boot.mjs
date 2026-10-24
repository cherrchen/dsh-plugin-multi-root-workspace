/**
 * Compose a scratch profile's effective entry list and boot it in-process.
 *
 * This mirrors what the CLI does before it mounts a profile: load the
 * profile's bundle layers, make the bundles' bare specifiers resolve, then
 * hand the composed patch stack to `app-boot`'s `boot()`. How resolution is
 * installed changed shape, and this file probes that by export name:
 *
 * ```text
 * 0.1.5-rc.2 / 0.1.6   healProfilesModuleFallback({ installAnchor, profile })
 * 0.1.7-alpha.1 through 0.2.0-rc.2   createRuntimeResolution(...) then PluginPackages
 * ```
 *
 * `0.1.7-alpha.1` computes the resolution and installs it as a host service
 * inside `boot`'s prepare callback; it no longer writes a module-fallback
 * directory. Booting in-process is what makes the behavior smoke
 * credential-free — no model call is involved.
 *
 * @module scripts/lib/profile-boot
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { assertIsolatedHome, loadAppBoot, resolveInstallAnchor } from './dsh-runtime.mjs'

const BIN_NAME = 'dsh-multi-root-smoke'
/** Profile root entry list: an empty tree whose rows come from the patch layers. */
const PROFILE_ROOT_FILENAME = 'cordis.yml'
const PROFILE_ROOT_CONFIG = '# dsh profile root — an empty entry list. The tree is composed as patches.\n[]\n'

/**
 * Install package resolution the way the installed app-boot release does.
 *
 * Older releases write a module-fallback directory. `0.1.7-alpha.1` returns a
 * resolution object that `boot` must publish as `PluginPackages` before the
 * tree mounts. A release that exports neither cannot be booted in-process.
 * @param appBoot - the app-boot module of the runtime under test.
 * @param installAnchor - absolute path of a file inside the running dsh package.
 * @param profile - the loaded profile.
 * @returns the resolution to publish, or `undefined` when the release wrote
 *   the fallback itself.
 */
async function resolveProfileModules(appBoot, installAnchor, profile) {
  if (typeof appBoot.healProfilesModuleFallback === 'function') {
    await appBoot.healProfilesModuleFallback({ installAnchor, profile })
    return undefined
  }
  if (typeof appBoot.createRuntimeResolution === 'function') {
    return await appBoot.createRuntimeResolution({ installAnchor, profile })
  }
  throw new Error(
    'app-boot exports neither healProfilesModuleFallback nor createRuntimeResolution; '
    + 'scripts/lib/profile-boot.mjs cannot boot this release in-process.',
  )
}

/**
 * Load the composed patch stack of a profile without mounting anything.
 * @param profileName - profile under the scratch home.
 * @param home - scratch `$DSH_HOME`.
 * @returns the loaded profile and its patch layers.
 */
export async function composeProfile(profileName, home) {
  assertIsolatedHome(home)
  // Resolution and the include loader read the harness home from the
  // ENVIRONMENT, not from the profile object; pinning it here is what keeps
  // an in-process boot inside the scratch home instead of the operator's.
  process.env.DSH_HOME = home
  const appBoot = await loadAppBoot()
  const installAnchor = resolveInstallAnchor()
  const profile = appBoot.loadProfile(BIN_NAME, profileName, installAnchor, home, { userLayer: true })
  const resolution = await resolveProfileModules(appBoot, installAnchor, profile)
  // The CLI writes this root include before booting; a profile created by
  // `dsh plugin add` alone does not have it yet.
  writeFileSync(join(profile.dir, PROFILE_ROOT_FILENAME), PROFILE_ROOT_CONFIG)
  // The profile's own patch layer is applied AFTER every bundle layer (the
  // real boot path does this through `readProfilePatches`'s `patchPath`), so
  // an id-targeted config override written into `cordis.patch.yml` reaches the
  // in-process boot exactly as it reaches the CLI.
  const profilePatch = typeof appBoot.loadOptionalPatches === 'function'
    ? appBoot.loadOptionalPatches(BIN_NAME, join(profile.dir, appBoot.PROFILE_PATCH_FILENAME ?? 'cordis.patch.yml')) ?? []
    : []
  return {
    appBoot,
    installAnchor,
    profile,
    resolution,
    patches: [...profile.layers.flatMap(layer => layer.patches), ...profilePatch],
  }
}

/**
 * Boot one profile's tree in-process on an isolated home.
 * @param profileName - profile under the scratch home.
 * @param home - scratch `$DSH_HOME`.
 * @param prepare - pre-tree host setup (launcher facts an app profile requires).
 * @returns the settled root context plus the composition facts.
 */
export async function bootProfile(profileName, home, prepare) {
  const { appBoot, installAnchor, profile, patches, resolution } = await composeProfile(profileName, home)
  // Publishing the resolution has to happen inside prepare, before
  // `mountRootInclude` loads the tree. A release that already wrote the
  // fallback has nothing to publish, and passing `undefined` keeps `boot`'s
  // own "no prepare" path.
  let applicationReady = false
  const readyListeners = new Set()
  const prepareBoot = async (hostCtx) => {
    if (resolution !== undefined) await hostCtx.plugin(appBoot.PluginPackages, { resolution })
    if (prepare !== undefined) await prepare(hostCtx, { profile, installAnchor })
    if (hostCtx.get('appReady') === undefined) hostCtx.provide('appReady', {
      onReady(listener) { if (applicationReady) listener(); else readyListeners.add(listener); return () => readyListeners.delete(listener) },
    })
    // The CLI publishes this immutable launcher fact. Modern ConfigEditor and
    // Settings inject it; omitting it silently disables the whole settings UI.
    if (hostCtx.get('profileContext') === undefined) hostCtx.provide('profileContext', {
      name: profileName, dir: profile.dir, home, installAnchor, cwd: process.cwd(),
      patchPath: join(profile.dir, appBoot.PROFILE_PATCH_FILENAME ?? 'cordis.patch.yml'),
      startedBundles: profile.layers.map(layer => layer.packageName), overlays: [],
      telemetryDisabledEnv: process.env.DSH_TELEMETRY_DISABLED,
    })
  }
  const ctx = await appBoot.boot(BIN_NAME, join(profile.dir, 'cordis.yml'), patches, prepareBoot)
  applicationReady = true
  for (const listener of readyListeners) listener()
  readyListeners.clear()
  return { ctx, appBoot, installAnchor, profile }
}
