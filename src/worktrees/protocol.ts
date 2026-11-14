/** Strict wire schemas for the Registry methods the worktree feature adds. */
import { z } from 'zod'

const identity = z.object({ dev: z.string(), ino: z.string(), birthtimeMs: z.number().optional() }).strict()

const primarySnapshot = z.object({
  shape: z.enum(['main', 'linked']),
  canonical: z.string().min(1),
  common: z.string().min(1),
  adminId: z.string().optional(),
  adminGitdir: z.string().optional(),
  adminHead: z.string().optional(),
  rootIdentity: identity,
  adminIdentity: identity.optional(),
}).strict()

const candidateSnapshot = z.object({
  kind: z.enum(['worktree', 'main-checkout']),
  canonical: z.string().min(1),
  common: z.string().min(1),
  adminId: z.string().optional(),
  adminGitdir: z.string().optional(),
  adminHead: z.string().optional(),
  rootIdentity: identity,
  adminIdentity: identity.optional(),
}).strict()

/** The expected snapshot one confirmation binds. */
export const promptExpectedSchema = z.object({
  primaryKey: z.string().min(1),
  primaryRoot: z.string().min(1),
  primary: primarySnapshot,
  candidate: candidateSnapshot,
  promptKey: z.string().min(1),
}).strict()

/** `addNew` arguments. */
export const addNewSchema = z.object({
  path: z.string().min(1),
  access: z.literal('inherit').optional(),
  expected: promptExpectedSchema,
  track: z.object({ adminId: z.string().min(1), common: z.string().min(1) }).strict().optional(),
}).strict()

/** `removeForDeletedWorktree` arguments. */
export const deletedWorktreeSchema = z.object({
  rootId: z.string().min(1),
  expectedPath: z.string().min(1),
  expectedAddedAt: z.string().min(1),
}).strict()

/**
 * One reminder delay as the Registry owner persists it. The host that derived
 * the keys has already converted `7d`/`30d` into an absolute instant with its
 * own clock; `until` is required exactly for the `until` mode.
 */
export const snoozeRecordSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('until-new-worktree'),
    keys: z.array(z.string().min(1)).min(1).max(64),
    at: z.string().min(1),
  }).strict(),
  z.object({
    mode: z.literal('until'),
    until: z.string().min(1),
    keys: z.array(z.string().min(1)).min(1).max(64),
    at: z.string().min(1),
  }).strict(),
])

/** `worktreeSidecar` arguments. */
export const sidecarOperationSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('read') }).strict(),
  z.object({ op: z.literal('ignore'), key: z.string().min(1), kind: z.enum(['worktree', 'main-checkout']), path: z.string().min(1) }).strict(),
  z.object({ op: z.literal('reset') }).strict(),
  z.object({ op: z.literal('reconcile') }).strict(),
  z.object({ op: z.literal('snooze'), snooze: snoozeRecordSchema }).strict(),
])
