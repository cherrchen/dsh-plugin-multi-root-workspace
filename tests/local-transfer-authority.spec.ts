/** The Registry-issued authority behind remote → local copies (G2). */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Sessions from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import Policy from '@deepseek-ai/dsh-sandbox-policy'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import { mountRegistryStack, type RegistryStack } from './support/registry-stack.ts'
import { createFixtureWorkspace, type FixtureWorkspace } from './support/temp-workspace.ts'

let fixture: FixtureWorkspace
let stacks: RegistryStack[]
beforeEach(() => { fixture = createFixtureWorkspace('local-authority'); stacks = [] })
afterEach(async () => { for (const stack of stacks.reverse()) await stack.dispose(); fixture.dispose() })

async function mount(toolAccess?: Record<string, 'read-only'>): Promise<RegistryStack> {
  const stack = await mountRegistryStack(join(fixture.base, 'store'), {}, {
    scopeConfig: toolAccess === undefined ? {} : { toolAccess },
    beforeGate: async ctx => {
      await ctx.plugin(Projections)
      await ctx.plugin(Sessions)
      await ctx.plugin(Policy, { mode: 'workspace-write', workspaceRoot: fixture.workspace })
    },
  })
  stacks.push(stack)
  return stack
}

async function addRoot(stack: RegistryStack, name: string, access: 'inherit' | 'read-only' | 'read-write'): Promise<string> {
  const directory = join(fixture.base, name)
  mkdirSync(directory)
  const statuses = await stack.registry.add(fixture.workspace, { path: directory, access })
  const added = statuses.find(entry => entry.path === canonicalPath(directory))
  if (added === undefined) throw new Error('the added root is missing from the status list')
  await stack.registry.setAliasId(fixture.workspace, { kind: 'id', id: added.id }, name)
  return directory
}

describe('registry.localTransferDestination', () => {
  it('grants the primary under workspace-write and every protected boundary', async () => {
    const stack = await mount()
    const authority = stack.registry.localTransferDestination(fixture.workspace, 'primary', 'workspace-write', 'remote_copy')
    expect(authority).toMatchObject({ rootId: 'primary', access: 'primary', root: canonicalPath(fixture.workspace) })
    expect(authority.deny.length).toBeGreaterThan(0)
    expect(authority.deny.some(path => path === canonicalPath(join(fixture.base, 'store')))).toBe(true)
    expect(() => stack.registry.localTransferDestination(fixture.workspace, 'primary', 'read-only', 'remote_copy'))
      .toThrowError(expect.objectContaining({ code: 'mode-denies' }))
  })

  it('follows the registration access level in every mode', async () => {
    const stack = await mount()
    const inherit = await addRoot(stack, 'inherit', 'inherit')
    await addRoot(stack, 'ro', 'read-only')
    const readWrite = await addRoot(stack, 'rw', 'read-write')
    expect(stack.registry.localTransferDestination(fixture.workspace, 'inherit', 'workspace-write', 'remote_copy'))
      .toMatchObject({ root: canonicalPath(inherit), access: 'inherit' })
    expect(() => stack.registry.localTransferDestination(fixture.workspace, 'inherit', 'read-only', 'remote_copy'))
      .toThrowError(expect.objectContaining({ code: 'mode-denies' }))
    expect(() => stack.registry.localTransferDestination(fixture.workspace, 'ro', 'workspace-write', 'remote_copy'))
      .toThrowError(expect.objectContaining({ code: 'local-destination-read-only' }))
    expect(stack.registry.localTransferDestination(fixture.workspace, 'rw', 'read-only', 'remote_copy'))
      .toMatchObject({ root: canonicalPath(readWrite), access: 'read-write' })
  })

  it('refuses unknown, missing, and invalid roots', async () => {
    const stack = await mount()
    expect(() => stack.registry.localTransferDestination(fixture.workspace, 'nope', 'workspace-write', 'remote_copy'))
      .toThrowError(expect.objectContaining({ code: 'local-root-unavailable' }))
    expect(() => stack.registry.localTransferDestination(fixture.workspace, '', 'workspace-write', 'remote_copy'))
      .toThrowError(expect.objectContaining({ code: 'invalid-arguments' }))
    const directory = await addRoot(stack, 'gone', 'inherit')
    await stack.registry.remove(fixture.workspace, { kind: 'path', path: directory })
    expect(() => stack.registry.localTransferDestination(fixture.workspace, 'gone', 'workspace-write', 'remote_copy'))
      .toThrowError(expect.objectContaining({ code: 'local-root-unavailable' }))
  })

  it('applies the per-tool cap to additional roots only', async () => {
    const stack = await mount({ remote_copy: 'read-only' })
    await addRoot(stack, 'extra', 'inherit')
    expect(() => stack.registry.localTransferDestination(fixture.workspace, 'extra', 'workspace-write', 'remote_copy'))
      .toThrowError(expect.objectContaining({ code: 'tool-capped' }))
    expect(stack.registry.localTransferDestination(fixture.workspace, 'primary', 'workspace-write', 'remote_copy'))
      .toMatchObject({ access: 'primary' })
  })

  it('refuses while the local registry authority is unavailable', async () => {
    const stack = await mount()
    await stack.dispose()
    stacks.pop()
    expect(() => stack.registry.localTransferDestination(fixture.workspace, 'primary', 'workspace-write', 'remote_copy'))
      .toThrowError(expect.objectContaining({ code: 'remote-unavailable' }))
  })
})
