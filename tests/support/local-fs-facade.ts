/** G1 POC only. This module is neither a package export nor a production row. */
import type { Context } from '@deepseek-ai/cordis'
import { MultiRootFileSystem, type Config } from '../../src/fs.ts'

const METHODS = new Set([
  'resolve', 'lstat', 'processPath', 'processPathFromHostPath', 'fileUrl', 'contains',
  'stat', 'listDir', 'readText', 'streamText', 'readBytes', 'readByteRange', 'watch',
  'writeText', 'editText', 'patchText', 'deleteFile', 'moveFile',
])
const SYNC = new Set(['processPath', 'processPathFromHostPath', 'fileUrl', 'contains'])
const REMOTE_URI = /^(?:remote:|ssh:|sftp:|[a-z][a-z0-9+.-]*:\/\/)/iu

export class RemoteReferenceUnavailable extends Error {
  readonly code = 'G1_REMOTE_REFERENCE_UNAVAILABLE'
  constructor() { super('Remote references are unavailable in the local-only G1 composition') }
}

function remoteLocation(value: unknown): boolean {
  if (typeof value === 'string') return REMOTE_URI.test(value)
  if (value === null || typeof value !== 'object') return false
  const target = value as { targetKey?: unknown; displayPath?: unknown }
  return remoteLocation(target.targetKey) || remoteLocation(target.displayPath)
}

/** Preserve return shape and backend receiver; inspect only location arguments. */
export function localFilesystemFacade<T extends object>(backend: T): T {
  const facade = Object.create(backend) as T
  // Cordis recovers a service's own context through an own `ctx` descriptor
  // (tracker.property); inherited `ctx` leaves traced callers bound to their
  // context, which on cordis 4.0.x cannot resolve this plugin's injections.
  const ctxDescriptor = Object.getOwnPropertyDescriptor(backend, 'ctx')
  if (ctxDescriptor) Object.defineProperty(facade, 'ctx', ctxDescriptor)
  for (const property of METHODS) {
    const value: unknown = Reflect.get(backend, property)
    if (typeof value !== 'function') continue
    // Cordis traces data descriptors before property reads. A Proxy get trap
    // alone looks wrapped through get('fs'), but a traced ctx.fs bypasses it.
    Object.defineProperty(facade, property, {
      configurable: true, writable: true,
      value: function (this: unknown, ...args: unknown[]): unknown {
        const second = args[1] as { cwd?: unknown } | undefined
        const remote = remoteLocation(args[0])
          || ((property === 'contains' || property === 'moveFile') && remoteLocation(args[1]))
          || ((property === 'resolve' || property === 'lstat') && remoteLocation(second?.cwd))
        if (remote) {
          const error = new RemoteReferenceUnavailable()
          if (SYNC.has(property)) throw error
          return Promise.reject(error)
        }
        return Reflect.apply(value, this, args)
      },
    })
  }
  return facade
}

/** Replace only the service value owned by this test fiber, via Cordis's public setter. */
export class LocalOnlyFileSystem extends MultiRootFileSystem {
  constructor(ctx: Context, config: Config) {
    super(ctx, config)
    ctx.set('fs', localFilesystemFacade(this))
  }
}

export default LocalOnlyFileSystem
