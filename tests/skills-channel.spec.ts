/** Real published Connection HTTP adapter; only the webserver route registry/auth are fixtures. */
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import { createFixtureWorkspace, type FixtureWorkspace } from './support/temp-workspace.ts'
import { skillsStack, project, writeSkill } from './support/skills-stack.ts'
import * as Command from '../src/command.ts'
import { SkillsClient } from '../src/client/skills-client.ts'
let fixture: FixtureWorkspace
beforeEach(() => { fixture = createFixtureWorkspace('skills-channel') })
afterEach(() => fixture.dispose())

it('serves cold Session metadata, preview and revocation over the real Connection channel', async () => {
  const stack = await skillsStack(fixture.base)
  const routes: { path: string; handler(req: IncomingMessage, res: ServerResponse): Promise<void> }[] = []
  const server = createServer((req, res) => {
    const route = routes.find(route => req.url?.startsWith(route.path))
    if (route) void route.handler(req, res).catch(error => { res.writeHead(500); res.end(String(error)) })
    else { res.writeHead(404); res.end() }
  })
  try {
    const ctx = stack.ctx
    ctx.provide('webServer', { host: '127.0.0.1', protocol: 'http:', port: 0, register: (route: typeof routes[number]) => { routes.push(route); return () => { routes.splice(routes.indexOf(route), 1) } } } as never)
    new HostConnectionService(ctx, [], { isAuthenticated: () => true } as never)
    ctx.provide('commands', { register: () => () => {} } as never)
    ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'workspace-write', workspaceRoot: fixture.workspace }) } as never)
    await ctx.plugin(Command)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    const connection = { rpc: { call: async (channel: string, endpoint: string, payload: unknown, signal?: AbortSignal) => {
      const response = await fetch(`http://127.0.0.1:${port}${channel}/${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'skills-test', method: endpoint, payload }), ...(signal ? { signal } : {}) })
      expect(response.status).toBe(200)
      return (await response.json() as { result: unknown }).result
    } } }
    const primary = project(fixture.base, 'primary'), root = project(fixture.base, 'root')
    writeSkill(root, 'review', 'CHANNEL BODY')
    const [row] = await stack.registry.add(primary, { path: root })
    const agent = stack.agent(primary), cold = 'cold-channel' as typeof agent.id
    stack.headers.set(cold, { ...agent.session.header, id: cold })
    const client = new SkillsClient(connection)
    try {
      const catalog = await client.list(cold)
      expect(catalog.skills.map(row => row.name)).toEqual(['root:review'])
      expect((await client.preview(cold, 'root:review')).content).toContain('CHANNEL BODY')
      // Buffer a real HTTP response at the Connection boundary, then switch
      // epoch before delivering it. The old payload must never repopulate UI.
      let releaseReply!: () => void, replyReady!: () => void
      const held = new Promise<void>(resolve => { releaseReply = resolve })
      const ready = new Promise<void>(resolve => { replyReady = resolve })
      const delayed = new SkillsClient({ rpc: { call: async (...args: Parameters<typeof connection.rpc.call>) => {
        const result = await connection.rpc.call(...args)
        replyReady(); await held; return result
      } } })
      const oldReply = delayed.list(cold).catch(error => error)
      await ready; delayed.reset(); releaseReply()
      expect(await oldReply).toBeInstanceOf(Error)
      expect(delayed.snapshot(cold)).toBeUndefined(); delayed.dispose()
      const changed = connection.rpc.call('/multi-root-workspace', 'skillsChanges', { sessionId: cold, generation: catalog.generation })
      await stack.registry.setSkillsEnabled(primary, { kind: 'id', id: row!.id }, false)
      expect(await changed).toMatchObject({ ok: true, value: { generation: expect.any(Number) } })
      expect((await client.list(cold)).skills).toEqual([])
      await expect(client.preview(cold, 'root:review')).rejects.toThrow()
      const rejected = await connection.rpc.call('/multi-root-workspace', 'skillsList', { sessionId: cold, primaryRoot: primary })
      expect(rejected).toMatchObject({ ok: false })
    } finally { client.dispose() }
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
    await stack.dispose()
  }
})
