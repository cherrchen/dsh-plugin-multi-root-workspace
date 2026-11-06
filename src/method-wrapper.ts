interface WrapperLayer {
  readonly target: object
  readonly key: PropertyKey
  readonly own: PropertyDescriptor | undefined
  active: boolean
}

// Independent consumers can wrap the same service and dispose in either order.
// A later cleanup must not reinstall an already disposed inner wrapper.
const layers = new WeakMap<object, WrapperLayer>()

function liveDescriptor(target: object, key: PropertyKey, descriptor: PropertyDescriptor | undefined): PropertyDescriptor | undefined {
  let current = descriptor
  while (typeof current?.value === 'function') {
    const layer = layers.get(current.value as object)
    if (layer === undefined || layer.active || layer.target !== target || layer.key !== key) break
    current = layer.own
  }
  return current
}

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
  if (value === descriptor.value) return () => {}
  const layer: WrapperLayer = { target, key, own, active: true }
  layers.set(value as object, layer)
  Object.defineProperty(target, key, { configurable: true, writable: true, enumerable: own?.enumerable ?? false, value })
  return () => {
    layer.active = false
    if (Object.getOwnPropertyDescriptor(target, key)?.value !== value) return
    const previous = liveDescriptor(target, key, own)
    if (previous === undefined) Reflect.deleteProperty(target, key)
    else Object.defineProperty(target, key, previous)
  }
}
