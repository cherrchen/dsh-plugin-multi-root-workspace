import { z } from 'zod'

const validName = (value: string): boolean => value.length > 0 && value.length <= 256 && value.trim() === value
  && !Array.from(value).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)

export const isWslDistributionName = (value: string): boolean => validName(value) && !value.startsWith('-')

/** Effective initiator identity; POSIX is represented by absence in persisted authorization facts. */
export const windowsInitiatorIdentitySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('windows-openssh') }).strict(),
  z.object({ kind: z.literal('wsl'), distribution: z.string().refine(isWslDistributionName), user: z.string().refine(validName) }).strict(),
])
export type WindowsInitiatorIdentity = z.infer<typeof windowsInitiatorIdentitySchema>

export function sameInitiatorIdentity(left: WindowsInitiatorIdentity | undefined, right: WindowsInitiatorIdentity | undefined): boolean {
  if (left === undefined || right === undefined) return left === right
  if (left.kind === 'windows-openssh') return right.kind === 'windows-openssh'
  return right.kind === 'wsl' && left.distribution === right.distribution && left.user === right.user
}
