/** Bind Connection's public RPC getter to the fiber that owns the route. */
import type { Context } from '@deepseek-ai/cordis'
import type { HostConnectionHandle, HostConnectionRpc } from '@deepseek-ai/dsh-client-connection'

/**
 * Newer Cordis keeps a service getter's definition site when tracing it, so
 * even reading Connection from the root can make its RPC getter capture the
 * provider's context (which does not inject webServer). Invoke the public
 * accessor with the actual consumer context instead. A data property is used
 * unchanged for simpler Connection implementations. The service is not
 * modified and the route remains owned by the injecting fiber.
 */
export function connectionRpcFor(ctx: Context, connection: HostConnectionHandle): HostConnectionRpc {
  for (let proto: object | null = connection; proto !== null; proto = Object.getPrototypeOf(proto) as object | null) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'rpc')
    if (descriptor === undefined) continue
    if (typeof descriptor.get !== 'function') return connection.rpc
    const receiver = new Proxy(connection, {
      get(target, key, proxy) { return key === 'ctx' ? ctx : Reflect.get(target, key, proxy) },
    })
    return Reflect.apply(descriptor.get, receiver, []) as HostConnectionRpc
  }
  return connection.rpc
}
