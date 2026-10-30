/** Open an explicitly bound medium through public storage APIs only. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { DomainSpec } from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-storage'

export async function openAuthorityStorage<S extends DomainSpec>(ctx: Context, root: string, spec: S) {
  const { JsonStorageBackend } = await import('@deepseek-ai/dsh-storage-json')
  const backend = new JsonStorageBackend(root)
  const name = `multi-root-${randomUUID()}`
  const unmount = ctx.get('storage')!.backend.register(name, backend)
  let facility: DomainFacility | undefined
  // DomainFacility reads ctx.storage through its declared capability scope.
  // The Registry itself deliberately keeps storage optional in legacy stacks.
  const fiber = ctx.inject(['storage'], scope => { facility = new DomainFacility(scope, { backend: name, routes: {} }) })
  try {
    await fiber
    if (!facility) throw new Error('shared registry requires the storage hub')
    const domain = await facility.open(spec)
    return {
      table: domain.table.bind(domain) as typeof domain.table,
      async close() { try { await domain.close() } finally { unmount(); await backend.close(); await fiber.dispose() } },
    }
  } catch (error) { unmount(); await backend.close(); await fiber.dispose(); throw error }
}
