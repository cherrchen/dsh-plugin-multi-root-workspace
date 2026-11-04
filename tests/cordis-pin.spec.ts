import { expect, it } from 'vitest'
import { cordisPin, ecosystemPin } from '../scripts/lib/cordis-pin.mjs'

it('keeps the exact prerelease when extracting Cordis and rejects compound ranges', () => {
  expect(cordisPin('~4.0.5-alpha.1')).toBe('4.0.5-alpha.1')
  expect(cordisPin('^4.0.3')).toBe('4.0.3')
  expect(cordisPin('4.0.4')).toBe('4.0.4')
  for (const range of ['>=4 <5', '4.0.4 || 4.0.5', '~4.0.5-alpha.1 extra', undefined]) expect(() => cordisPin(range)).toThrow('not a single')
})

it('keeps an ecosystem prerelease on the vendor generation the host declared', () => {
  expect(ecosystemPin('~1.0.7-alpha.1', ['1.0.7-alpha.1', '1.0.7-alpha.2'])).toBe('1.0.7-alpha.1')
  expect(ecosystemPin('~1.0.7-alpha.2', ['1.0.7-alpha.2'])).toBe('1.0.7-alpha.2')
  expect(ecosystemPin('~1.0.6', ['1.0.6', '1.0.6-patch.1'])).toBe('1.0.6-patch.1')
  expect(() => ecosystemPin('~1.0.7-alpha.1', ['1.0.7-alpha.2'])).toThrow('not published')
  expect(() => ecosystemPin('~1.0.7', [])).toThrow('no admitted')
})
