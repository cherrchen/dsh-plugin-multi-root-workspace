/**
 * Adapt the mutation methods introduced by newer filesystem backends.
 * Older supported backends do not expose these methods at all.
 */
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'

export type AdditionalMutation = 'patchText' | 'deleteFile' | 'moveFile'

type Invoke = (args: unknown[]) => unknown
type Fence<T> = (receiver: T, method: AdditionalMutation, args: unknown[], invoke: Invoke) => unknown

/** Install only methods present on the actual backend, preserving the caller as `this`. */
export function installAdditionalMutations<T extends object>(prototype: T, fence: Fence<T>): void {
  for (const method of ['patchText', 'deleteFile', 'moveFile'] as const) {
    const inherited: unknown = Reflect.get(LocalFileSystem.prototype, method)
    if (typeof inherited !== 'function') continue
    Object.defineProperty(prototype, method, {
      configurable: true,
      writable: true,
      value: function (this: T, ...args: unknown[]): unknown {
        return fence(this, method, args, next => Reflect.apply(inherited, this, next))
      },
    })
  }
}
