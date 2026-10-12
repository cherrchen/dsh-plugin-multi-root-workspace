/**
 * The shared route constants split their names in `0.1.7-alpha.1` (`*_PATH`
 * + browser-relative `*_ROUTE`) and `PathLabel` exists only from that same
 * release. The plugin must bind whichever spelling the installed package
 * exports, and degrade the component a release does not carry.
 */

import { describe, expect, it } from 'vitest'
import { selectSharedRoute } from '../src/compat/open-in-app-routes.ts'
import { maybeComponent } from '../src/compat/client-icons.ts'

describe('selectSharedRoute', () => {
  it('prefers the document-relative name 0.1.7-alpha.1 introduced', () => {
    expect(selectSharedRoute(
      { OPEN_IN_APP_ICON_PREFIX_ROUTE: 'open-in-app/icon', OPEN_IN_APP_ICON_PREFIX: '/open-in-app/icon' },
      ['OPEN_IN_APP_ICON_PREFIX_ROUTE', 'OPEN_IN_APP_ICON_PREFIX'],
    )).toBe('open-in-app/icon')
  })

  it('falls through to the absolute name 0.1.5 and 0.1.6 export', () => {
    expect(selectSharedRoute(
      { OPEN_IN_APP_ICON_PREFIX: '/open-in-app/icon' },
      ['OPEN_IN_APP_ICON_PREFIX_ROUTE', 'OPEN_IN_APP_ICON_PREFIX'],
    )).toBe('/open-in-app/icon')
  })

  it('throws when the package exports neither name', () => {
    expect(() => selectSharedRoute({}, ['OPEN_IN_APP_ICON_PREFIX_ROUTE', 'OPEN_IN_APP_ICON_PREFIX'])).toThrow(/none of/)
  })
})

describe('maybeComponent', () => {
  it('returns the component a release carries', () => {
    // The installed tree (any supported release) exports the pixel-named
    // icons; a real binding proves the namespace probe resolves at all.
    const found = maybeComponent<unknown>(['IconFolderClose16', 'IconFolderCloseRegular'])
    expect(found).not.toBeUndefined()
  })

  it('returns undefined for a name no supported release has ever carried', () => {
    expect(maybeComponent<unknown>(['IconNotARealExportName'])).toBeUndefined()
  })
})
