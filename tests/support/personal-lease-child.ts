
import { RegistryAuthorityLease } from '../../src/registry-lease.ts'

const leasePath = process.argv[2]!
const lease = await RegistryAuthorityLease.acquire(leasePath)
process.stdout.write(`${JSON.stringify({ status: 'ready', pid: process.pid })}\n`)
await new Promise<void>(resolve => {
  process.stdin.on('end', resolve)
  process.stdin.resume()
})
await lease.release()
