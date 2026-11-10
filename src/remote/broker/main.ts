/**
 * The credential broker daemon entry (ADR-0039). The deployer's unit file
 * starts `node remote-broker.js --config /etc/dsh-ssh-broker/broker.json`
 * under the dedicated account; custody, manifest loading, peer
 * authentication and socket permissions are all enforced by `BrokerServer`.
 * This file only parses the deployer's config, starts the listener and keeps
 * the process alive until SIGINT/SIGTERM.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/remote-broker/main
 */
import { readFileSync } from 'node:fs'
import { BrokerServer, type BrokerServerOptions } from './server.ts'

function string(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`broker config: ${name} must be a non-empty string`)
  return value
}

function uid(value: unknown, name: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) throw new Error(`broker config: ${name} must be a non-negative integer`)
  return value as number
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const configArg = args.length === 2 && args[0] === '--config' ? args[1]
    : args.length === 1 && args[0]!.startsWith('--config=') ? args[0]!.slice('--config='.length)
    : undefined
  if (configArg === undefined) {
    console.error('usage: remote-broker --config <broker.json>')
    process.exit(2)
  }
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(readFileSync(configArg, 'utf8')) as Record<string, unknown>
  } catch (error) {
    throw new Error(`broker config: cannot read ${configArg}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('broker config: expected a JSON object')
  const options: BrokerServerOptions = {
    manifestPath: string(raw.manifestPath, 'manifestPath'),
    socketPath: string(raw.socketPath, 'socketPath'),
    clientUid: uid(raw.clientUid, 'clientUid'),
    ...(raw.brokerUid === undefined ? {} : { brokerUid: uid(raw.brokerUid, 'brokerUid') }),
    ...(raw.auditPath === undefined ? {} : { auditPath: string(raw.auditPath, 'auditPath') }),
    logger: {
      debug: message => console.log(`dsh-ssh-broker: ${message}`),
      warn: message => console.warn(`dsh-ssh-broker: ${message}`),
    },
  }
  const server = new BrokerServer(options)
  await server.start()
  // The kernel listener's accept poll is unref'd by design (in the Host it is
  // one service among many); the daemon's only remaining job is staying alive.
  const keepAlive = setInterval(() => {}, 60_000)
  const shutdown = () => {
    clearInterval(keepAlive)
    void server.stop().then(() => process.exit(0), () => process.exit(1))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch(error => {
  console.error(`dsh-ssh-broker: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
