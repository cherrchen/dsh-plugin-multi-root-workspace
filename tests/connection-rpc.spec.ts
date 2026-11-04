import { Context, Service } from '@deepseek-ai/cordis'
import { expect, it } from 'vitest'
import { connectionRpcFor } from '../src/compat/connection-rpc.ts'

/** A real Cordis service with the same public getter/context contract as Connection. */
class Connection extends Service {
  constructor(ctx: Context) { super(ctx, 'connection') }
  get rpc() {
    const owner = this.ctx
    return {
      handle: () => owner.effect(() => (owner as unknown as { webServer: { register(): () => void } }).webServer.register(), 'channel'),
    }
  }
}

it('owns a channel on the consumer fiber and disposes it with that fiber', async () => {
  const root = new Context()
  let routes = 0
  const connection = await root.plugin({ name: 'connection-provider', apply(ctx: Context) { new Connection(ctx) } })
  const web = await root.plugin({ name: 'web-provider', apply(ctx: Context) {
    ctx.provide('webServer', { register() { routes += 1; return () => { routes -= 1 } } })
  } })
  const consumer = await root.plugin({ name: 'consumer', inject: ['connection', 'webServer'], apply(ctx: Context) {
    connectionRpcFor(ctx, ctx.get('connection') as never).handle('/test', async () => ({ ok: true, value: null }))
  } })
  expect(routes).toBe(1)
  await consumer.dispose()
  expect(routes).toBe(0)
  await web.dispose()
  await connection.dispose()
})

it('accepts Connection implementations with an ordinary rpc property', () => {
  const rpc = { handle: () => () => {} }
  expect(connectionRpcFor(new Context(), { rpc } as never)).toBe(rpc)
})
