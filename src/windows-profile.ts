/** Windows runner argv and capability identity. No Win32 calls at module load. */
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { DialectUnrecognizedError } from './dialects.ts'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'

/** A root-set capability: removing or adding a root changes the token's identity. */
export function workspaceScopeSid(roots: readonly string[]): string {
  const paths = [...new Set(roots.map(root => root.toLowerCase()))].sort()
  const hash = createHash('sha256').update('dsh-multi-root-workspace\0').update(JSON.stringify(paths)).digest()
  const words = [0, 4, 8, 12].map(offset => (hash.readUInt32LE(offset) % (2 ** 30 - 1)) + 1)
  return `S-1-4-${words.join('-')}-2`
}

export interface WindowsProfile {
  workspace: string
  temp: string
  mode: 'workspace-write'
  additionalRoots: string[]
  writeSid?: string
  tempWriteSid?: string
}

/** Strictly recognize the upstream public runner contract, failing closed on new flags. */
export function parseWindowsProfile(args: readonly string[], allowAdditional = false): WindowsProfile {
  const fields = new Map<string, string>()
  const additionalRoots: string[] = []
  const known = new Set(['--workspace', '--temp', '--mode', '--write-sid', '--temp-write-sid'])
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]
    const value = args[index + 1]
    if (key === undefined || value === undefined || value === '') throw new DialectUnrecognizedError('Windows ACL profile has a missing value')
    if (allowAdditional && key === '--additional-root') { additionalRoots.push(value); continue }
    if (!known.has(key) || fields.has(key)) throw new DialectUnrecognizedError(`Windows ACL profile has unknown or duplicate flag ${key}`)
    fields.set(key, value)
  }
  const workspace = fields.get('--workspace')
  const temp = fields.get('--temp')
  if (workspace === undefined || temp === undefined || fields.get('--mode') !== 'workspace-write') {
    throw new DialectUnrecognizedError('Windows multi-root requires --workspace, --temp and --mode workspace-write')
  }
  const writeSid = fields.get('--write-sid')
  const tempWriteSid = fields.get('--temp-write-sid')
  if ((writeSid === undefined) !== (tempWriteSid === undefined)) throw new DialectUnrecognizedError('Windows ACL profile requires both capability SIDs or neither')
  return { workspace, temp, mode: 'workspace-write', additionalRoots,
    ...(writeSid === undefined ? {} : { writeSid }), ...(tempWriteSid === undefined ? {} : { tempWriteSid }) }
}

export function widenWindowsProfile(profile: readonly string[], roots: readonly string[], primaryRoot?: string): string[] {
  if (profile.length < 2 || profile[0] === undefined || profile[1]?.startsWith('--')) throw new DialectUnrecognizedError('Windows ACL runner invocation is not [node, runner, ...flags]')
  const parsed = parseWindowsProfile(profile.slice(2))
  if (primaryRoot !== undefined && canonicalPath(parsed.workspace) !== primaryRoot) throw new DialectUnrecognizedError('Windows ACL profile workspace does not match the policy root')
  return [profile[0], fileURLToPath(new URL('./windows-runner.js', import.meta.url)), ...profile.slice(2), ...roots.flatMap(root => ['--additional-root', root])]
}
