/**
 * Icon export names changed in `0.1.7-alpha.1` from a pixel size to a stroke
 * weight. The panel must bind whichever name the installed package exports.
 */

import { describe, expect, it } from 'vitest'
import { selectIcon, type PanelIcon } from '../src/compat/client-icons.ts'

const pixel: PanelIcon = () => null
const regular: PanelIcon = () => null

describe('selectIcon', () => {
  it('prefers the pixel-sized name 0.1.5 and 0.1.6 export', () => {
    expect(selectIcon(
      { IconFolderClose16: pixel, IconFolderCloseRegular: regular },
      ['IconFolderClose16', 'IconFolderCloseRegular'],
    )).toBe(pixel)
  })

  it('falls through to the Regular weight 0.1.7-alpha.1 exports', () => {
    expect(selectIcon(
      { IconFolderCloseRegular: regular },
      ['IconFolderClose16', 'IconFolderCloseRegular'],
    )).toBe(regular)
  })

  it('throws when the package exports neither name', () => {
    expect(() => selectIcon({}, ['IconFolderClose16', 'IconFolderCloseRegular'])).toThrow(/none of/)
  })
})
