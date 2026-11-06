import { describe, expect, it } from 'vitest'
import { wrapMethod } from '../src/method-wrapper.ts'

describe('layered public method cleanup', () => {
  it('leaves a structural no-op wrapper unchanged without creating a cleanup cycle', () => {
    const target = { run() { return 1 } }
    const initial = Object.getOwnPropertyDescriptor(target, 'run')
    const noop = wrapMethod(target, 'run', original => original)
    const outer = wrapMethod(target, 'run', original => () => original() + 1)
    noop(); outer()
    expect(Object.getOwnPropertyDescriptor(target, 'run')).toEqual(initial)
  })
  it.each([false, true])('restores the original descriptor after out-of-order disposal (own: %s)', (own) => {
    const prototype = { value: 3, run() { return this.value } }
    const target = Object.create(prototype) as typeof prototype
    if (own) Object.defineProperty(target, 'run', { value: prototype.run, configurable: true, writable: true, enumerable: false })
    const initial = Object.getOwnPropertyDescriptor(target, 'run')
    const inner = wrapMethod(target, 'run', original => function () { return original.call(this) + 1 })
    const outer = wrapMethod(target, 'run', original => function () { return original.call(this) * 2 })
    expect(target.run.call({ value: 5 })).toBe(12)
    inner()
    outer()
    expect(Object.getOwnPropertyDescriptor(target, 'run')).toEqual(initial)
    expect(target.run()).toBe(3)
  })
})
