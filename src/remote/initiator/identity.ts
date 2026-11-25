import { z } from 'zod'

const name = z.string().min(1).max(256).refine(value => value.trim() === value
  && !Array.from(value).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127))

/** Effective initiator identity; POSIX is represented by absence in persisted authorization facts. */
export const windowsInitiatorIdentitySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('windows-openssh') }).strict(),
  z.object({ kind: z.literal('wsl'), distribution: name, user: name }).strict(),
])
export type WindowsInitiatorIdentity = z.infer<typeof windowsInitiatorIdentitySchema>

export function sameInitiatorIdentity(left: WindowsInitiatorIdentity | undefined, right: WindowsInitiatorIdentity | undefined): boolean {
  if (left === undefined || right === undefined) return left === right
  if (left.kind === 'windows-openssh') return right.kind === 'windows-openssh'
  return right.kind === 'wsl' && left.distribution === right.distribution && left.user === right.user
}
