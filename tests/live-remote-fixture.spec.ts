/** The live GUI VPS fixture is per-run owned: no fixed path is ever removed, and cleanup requires a successful creation. */
import { describe, expect, it, vi } from 'vitest'
import {
  cleanupCreatedLiveRemoteFixture,
  LIVE_REMOTE_FIXTURE_CREATE,
  liveRemoteFixtureCleanupScript,
  liveRemoteFixturePopulateScript,
  validLiveRemoteFixtureBase,
} from '../scripts/lib/live-remote-fixture.mjs'

const BASE = '/root/dsh-live-browse.abcd1234'

describe('the live remote GUI fixture ownership', () => {
  it('creates with mktemp and never removes a fixed or pre-existing path while populating', () => {
    expect(LIVE_REMOTE_FIXTURE_CREATE).toBe('mktemp -d /root/dsh-live-browse.XXXXXXXX')
    const populate = liveRemoteFixturePopulateScript(BASE)
    expect(populate).not.toContain('rm -rf')
    expect(populate).toContain('mkdir -p "$base/deep/inner"')
    expect(populate).toContain('find "$base" | sort')
  })

  it('validates exactly the mktemp output shape before spelling a cleanup command', () => {
    expect(validLiveRemoteFixtureBase(BASE)).toBe(true)
    for (const bad of ['/root/dsh-live-browse', '/root', '/tmp/dsh-live-browse.abcd1234', `${BASE}/../x`, `${BASE};rm -rf /`]) {
      expect(validLiveRemoteFixtureBase(bad)).toBe(false)
      expect(() => liveRemoteFixtureCleanupScript(bad)).toThrow('unsafe remote fixture path')
    }
    expect(liveRemoteFixtureCleanupScript(BASE)).toContain(`base="${BASE}"`)
    expect(liveRemoteFixtureCleanupScript(BASE)).toContain('rm -rf -- "$base"')
  })

  it('issues cleanup only for a fixture this run created', () => {
    const ssh = vi.fn()
    expect(cleanupCreatedLiveRemoteFixture(ssh, undefined, false)).toBe(false)
    expect(cleanupCreatedLiveRemoteFixture(ssh, BASE, false)).toBe(false)
    expect(ssh).not.toHaveBeenCalled()
    expect(cleanupCreatedLiveRemoteFixture(ssh, BASE, true)).toBe(true)
    expect(ssh).toHaveBeenCalledWith(liveRemoteFixtureCleanupScript(BASE))
  })
})
