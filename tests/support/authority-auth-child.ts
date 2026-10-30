/** A would-be agent knows the public endpoint but must not get management authority. */
import { AuthorityClient } from '../../src/authority/protocol.ts'
const [endpoint, store, primary, path] = process.argv.slice(2) as [string, string, string, string]
if (process.argv[6] === 'no-new-privs') {
  const koffi = (await import('koffi')).default
  const prctl = koffi.load('libc.so.6').func('int prctl(int option, ...)')
  if (prctl(38, 'ulong', 1, 'ulong', 0, 'ulong', 0, 'ulong', 0) !== 0) throw new Error('cannot set NoNewPrivs')
}
try {
  const client = await AuthorityClient.connect(endpoint, store, 16, () => {}, () => {})
  try { await client.request('add', [primary, { path }]); process.exitCode = 1 }
  finally { client.close() }
} catch { process.stdout.write('registry management refused\n') }
