/** Constrain the native parser before discovery can read a candidate's body. */
import { constants } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import { filesystemSkillsApi } from '../compat/skills.ts'

export function containsPath(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

export async function rootReader(ctx: Context, root: string, signal: AbortSignal, valid: () => boolean) {
  const api = await filesystemSkillsApi()
  if (api === undefined) return undefined
  const fs = ctx.fs
  const guard = (value: Parameters<typeof fs.processPath>[0]): string => {
    signal.throwIfAborted()
    const path = typeof value === 'string' ? value : fs.processPath(value)
    const canonical = canonicalPath(path)
    if (!valid() || !containsPath(root, resolve(path)) || !containsPath(root, canonical)) throw Object.assign(new Error('multi-root skills: path is outside the authorized root'), { code: 'ENOENT' })
    return canonical
  }
  const guarded = new Proxy(fs, { get(target, key) {
    if (key === 'readText') return async (path: Parameters<typeof guard>[0], requestSignal?: AbortSignal) => {
      requestSignal?.throwIfAborted()
      const canonical = guard(path)
      const handle = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      try {
        const before = await handle.stat()
        if (!before.isFile()) throw new Error('multi-root skills: candidate is not a regular file')
        const text = await handle.readFile('utf8')
        requestSignal?.throwIfAborted()
        if (guard(path) !== canonical) throw new Error('multi-root skills: candidate changed during read')
        const after = await handle.stat(), current = await stat(canonical)
        if (before.dev !== current.dev || before.ino !== current.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('multi-root skills: candidate changed during read')
        return text
      } finally { await handle.close() }
    }
    if (key === 'resolve' || key === 'stat' || key === 'listDir') return async (...args: unknown[]) => {
      guard(args[0] as Parameters<typeof guard>[0])
      const method = Reflect.get(target, key)
      return await Reflect.apply(method, target, args)
    }
    const value = Reflect.get(target, key)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  const delegateContext = { get: (name: string) => name === 'fs' ? guarded : undefined, logger: ctx.logger } as unknown as Context
  return new api.FileSystemSkillProvider(delegateContext, { signal, invalidate() {} }, {
    includeDefaultRoots: false, watch: false, providerName: 'multi-root-skills-filesystem',
    customSkillDirs: [resolve(root, '.dsh/skills'), resolve(root, '.agents/skills')],
  })
}
