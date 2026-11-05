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
  expect(() => ecosystemPin('~1.0.7-alpha.1', ['1.0.7-alpha.2'])).toThrow('not published')
  expect(() => ecosystemPin('~1.0.7', [])).toThrow('no admitted')
})

it('keeps stable vendor patch fixes without crossing the host vendor minor line', () => {
  // rc.1 publishes loader 1.1.0: it satisfies the old ^1.0.3 peer but its
  // fiber.entry contract crashes Cordis 4.0.2 during real profile boot.
  expect(ecosystemPin('^1.0.3', ['1.0.3', '1.0.6', '1.1.0'])).toBe('1.0.6')
  expect(ecosystemPin('^1.1.4', ['1.1.4', '1.1.7', '1.2.0'])).toBe('1.1.7')
  expect(ecosystemPin('~1.0.6', ['1.0.6', '1.0.6-patch.1'])).toBe('1.0.6')
  expect(ecosystemPin('^3.18.2', ['3.19.0', '3.18.5', '3.18.2', '3.18.6-alpha.2'])).toBe('3.18.5')
  expect(ecosystemPin('~1.1.0', ['1.1.0'])).toBe('1.1.0')
  expect(() => ecosystemPin('^1.0.3', ['1.1.0'])).toThrow('not published')
  expect(() => ecosystemPin('>=1 <2', ['1.1.0'])).toThrow('not a single')
})
