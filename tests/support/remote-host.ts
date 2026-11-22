/** SharedHost twin for the remote e2e: extra manifest/mode child args. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

export class RemoteHost {
  readonly child: ChildProcessWithoutNullStreams
  private next = 0
  private stderr = ''
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
  readonly ready: Promise<import('../src/remote/contract.ts').RemoteStatus>
  constructor(root: string, primary: string, options: { manifest?: string; mode?: string } = {}) {
    this.child = spawn(process.execPath, ['--experimental-transform-types', fileURLToPath(new URL('./remote-authority-child.ts', import.meta.url)), JSON.stringify({ root, primary, ...options })], { stdio: 'pipe' })
    this.child.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk).slice(-8192) })
    const ready = Promise.withResolvers<import('../src/remote/contract.ts').RemoteStatus>(); this.ready = ready.promise
    createInterface({ input: this.child.stdout }).on('line', line => {
      if (!line.startsWith('{')) return
      const reply = JSON.parse(line)
      if (reply.ready) {
        if (!['active', 'follower'].includes(reply.authority)) ready.reject(new Error(reply.unavailable))
        else ready.resolve(reply.remote)
      } else {
        const request = this.pending.get(reply.id)
        this.pending.delete(reply.id)
        if (reply.error) request?.reject(Object.assign(new Error(reply.error), { code: reply.code }))
        else request?.resolve(reply.value)
      }
    })
    const fail = (error: Error) => { ready.reject(error); for (const request of this.pending.values()) request.reject(error); this.pending.clear() }
    this.child.once('error', fail)
    this.child.once('exit', (code, signal) => fail(new Error(`Host exited (${code}/${signal}): ${this.stderr}`)))
  }
  async request<T = unknown>(method: string, args: unknown[] = []): Promise<T> {
    const id = ++this.next, reply = Promise.withResolvers<unknown>()
    this.pending.set(id, reply)
    this.child.stdin.write(JSON.stringify({ id, method, args }) + '\n')
    const timeout = setTimeout(() => reply.reject(new Error(`Host request timed out: ${method}: ${this.stderr}`)), 15_000)
    return reply.promise.finally(() => { clearTimeout(timeout); this.pending.delete(id) }) as Promise<T>
  }
  async kill(signal: NodeJS.Signals = 'SIGKILL') {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return
    const exited = once(this.child, 'exit'); this.child.kill(signal); await exited
  }
}
