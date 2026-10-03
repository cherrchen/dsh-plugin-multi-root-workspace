/** Wrap a public method on a Cordis service without capturing a caller-context proxy. */
export function wrapMethod<T extends object, K extends keyof T>(target: T, key: K, wrap: (original: T[K]) => T[K]): () => void {
  const own = Object.getOwnPropertyDescriptor(target, key)
  let prototype: object | null = target
  let descriptor: PropertyDescriptor | undefined
  while (prototype !== null && descriptor === undefined) {
    descriptor = Object.getOwnPropertyDescriptor(prototype, key)
    prototype = Object.getPrototypeOf(prototype) as object | null
  }
  if (typeof descriptor?.value !== 'function') throw new Error(`multi-root: ${String(key)} is not a public method`)
  const value = wrap(descriptor.value as T[K])
  Object.defineProperty(target, key, { configurable: true, writable: true, enumerable: own?.enumerable ?? false, value })
  return () => {
    if (Object.getOwnPropertyDescriptor(target, key)?.value !== value) return
    if (own === undefined) Reflect.deleteProperty(target, key)
    else Object.defineProperty(target, key, own)
  }
}
