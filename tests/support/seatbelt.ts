/**
 * Capability probe for specs that need a real Seatbelt confine but not the
 * shared-Registry IPC handshake. `nativeHostAvailability` also refuses hosts
 * that are themselves sandboxed — but an owner-only registry stack and a
 * nested `sandbox-exec` still work there, so the minted-profile ledger cases
 * gate on this cheaper probe instead.
 *
 * @module tests/support/seatbelt
 */

import { spawnSync } from 'node:child_process'

/**
 * Whether this host can nest a trivial Seatbelt confine. `false` off Darwin
 * or when `sandbox-exec` cannot launch at all.
 */
export function seatbeltConfineCapable(): boolean {
  if (process.platform !== 'darwin') return false
  try {
    return spawnSync('sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true'], { stdio: 'ignore' }).status === 0
  } catch { return false }
}
