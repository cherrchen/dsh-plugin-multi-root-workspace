import { rm } from 'node:fs/promises'
import { setTimeout as pause } from 'node:timers/promises'

/**
 * Retry the WHOLE removal, never each recursive descendant. Node's recursive
 * rm retries at every ancestor of a locked file; nested retry loops can turn
 * a mapped Windows addon into hours of waiting. A persistent lock must fail
 * promptly with the original path/error, rather than count as a clean smoke.
 */
export async function removeScratchTree(root) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rm(root, { recursive: true, force: true, maxRetries: 0 })
      return
    } catch (error) {
      if (attempt === 3 || !['EBUSY', 'EMFILE', 'ENFILE', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(error.code)) {
        throw new Error(`scratch cleanup failed for ${root}: ${error.message}`, { cause: error })
      }
      await pause(250)
    }
  }
}

/** Only the packed-smoke parent opts in: it removes the tree after close. */
export async function removeBehaviorHome(root, deferToParent = false) {
  if (deferToParent) {
    console.log(`[smoke] deferred scratch home cleanup to parent after exit: ${root}`)
    return
  }
  await removeScratchTree(root)
}
