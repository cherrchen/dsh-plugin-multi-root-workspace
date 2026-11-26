/**
 * The live GUI harness's remote fixture spelling. The directory is a real
 * `mktemp` product: creation and population are separate steps so a partial
 * population still has a proven this-run directory to clean, while a failed
 * creation never names — let alone removes — a pre-existing path.
 */

/** Remote command that mints the per-run directory and prints its absolute path. */
export const LIVE_REMOTE_FIXTURE_CREATE = 'mktemp -d /root/dsh-live-browse.XXXXXXXX'

const BASE_PATTERN = /^\/root\/dsh-live-browse\.[A-Za-z0-9]{8}$/

/** Whether `base` is exactly the mktemp shape this harness is allowed to remove. */
export function validLiveRemoteFixtureBase(base) {
  return typeof base === 'string' && BASE_PATTERN.test(base)
}

function requireValidBase(base) {
  if (!validLiveRemoteFixtureBase(base)) {
    throw new Error(`live-gui: refusing to use unsafe remote fixture path ${JSON.stringify(base)}`)
  }
}

/** Populate the already-created fixture directory; never remove anything first. */
export function liveRemoteFixturePopulateScript(base) {
  requireValidBase(base)
  return [
    'set -eu',
    `base="${base}"`,
    'mkdir -p "$base/deep/inner" "$base/space dir" "$base/literal\\\\dir"',
    'printf \'live-browse\\n\' > "$base/readme.txt"',
    'printf \'unicode name\\n\' > "$base/uni-名字.md"',
    'printf \'leaf of the live tree\\n\' > "$base/deep/inner/leaf.txt"',
    'printf \'a file with a space\\n\' > "$base/space dir/a file.txt"',
    'printf \'literal backslash dir\\n\' > "$base/literal\\\\dir/note.txt"',
    'ln -s readme.txt "$base/alias.link"',
    'find "$base" | sort',
  ].join('\n')
}

/** Remove exactly one validated per-run fixture directory. */
export function liveRemoteFixtureCleanupScript(base) {
  requireValidBase(base)
  return [
    'set -eu',
    `base="${base}"`,
    'rm -rf -- "$base"',
  ].join('\n')
}

/**
 * Clean only a fixture this run successfully created. Returns whether a
 * cleanup command ran; a failed or never-started creation returns false and
 * issues no remote mutation at all.
 */
export function cleanupCreatedLiveRemoteFixture(ssh, base, created) {
  if (created !== true || base === undefined) return false
  ssh(liveRemoteFixtureCleanupScript(base))
  return true
}
