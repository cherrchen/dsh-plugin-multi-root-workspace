/**
 * Compose a scratch profile's effective entry list and boot it in-process.
 *
 * This mirrors what `apps/cli` does before it mounts a profile: load the
 * profile's bundle layers, heal the profile-level module fallback so the
 * bundles' bare specifiers resolve, then hand the composed patch stack to
 * `app-boot`'s `boot()`. Booting in-process is what makes the behavior smoke
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
 * Load the composed patch stack of a profile without mounting anything.
 * @param profileName - profile under the scratch home.
 * @param home - scratch `$DSH_HOME`.
 * @returns the loaded profile and its patch layers.
 */
export async function composeProfile(profileName, home) {
  assertIsolatedHome(home)
  // `healProfilesModuleFallback` and the include loader read the harness home
  // from the ENVIRONMENT, not from the profile object; pinning it here is what
  // keeps an in-process boot inside the scratch home instead of the operator's.
  process.env.DSH_HOME = home
  const appBoot = await loadAppBoot()
  const installAnchor = resolveInstallAnchor()
  const profile = appBoot.loadProfile(BIN_NAME, profileName, installAnchor, home, { userLayer: true })
  await appBoot.healProfilesModuleFallback({ installAnchor, profile })
  // The CLI writes this root include before booting; a profile created by
  // `dsh plugin add` alone does not have it yet.
  writeFileSync(join(profile.dir, PROFILE_ROOT_FILENAME), PROFILE_ROOT_CONFIG)
  return { appBoot, installAnchor, profile, patches: profile.layers.flatMap(layer => layer.patches) }
}

/**
 * Boot one profile's tree in-process on an isolated home.
 * @param profileName - profile under the scratch home.
 * @param home - scratch `$DSH_HOME`.
 * @returns the settled root context plus the composition facts.
 */
export async function bootProfile(profileName, home) {
  const { appBoot, installAnchor, profile, patches } = await composeProfile(profileName, home)
  const ctx = await appBoot.boot(BIN_NAME, join(profile.dir, 'cordis.yml'), patches)
  return { ctx, appBoot, installAnchor, profile }
}
