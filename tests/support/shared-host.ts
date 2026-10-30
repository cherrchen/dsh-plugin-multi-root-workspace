/** Independent production Registry/fs Host driven over bounded NDJSON. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

export class SharedHost {
  readonly child: ChildProcessWithoutNullStreams
  private next = 0
  private stderr = ''
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
  private readonly events = new Map<number, () => void>()
  readonly ready: Promise<void>
  constructor(root: string, primary: string) {
    this.child = spawn(process.execPath, ['--experimental-transform-types', fileURLToPath(new URL('./shared-authority-child.ts', import.meta.url)), JSON.stringify({ root, primary })], { stdio: 'pipe' })
    this.child.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk).slice(-8192) })
    const ready = Promise.withResolvers<void>(); this.ready = ready.promise
    createInterface({ input: this.child.stdout }).on('line', line => {
      // Cordis diagnostics may share stdout; only our NDJSON is a reply.
      if (!line.startsWith('{')) return
      const reply = JSON.parse(line)
      if (reply.ready) {
        if (!['active', 'follower'].includes(reply.authority)) ready.reject(new Error(reply.unavailable))
        else ready.resolve()
      } else if (reply.event) this.events.get(reply.id)?.()
      else {
        const request = this.pending.get(reply.id)
        this.pending.delete(reply.id)
        if (reply.error) request?.reject(new Error(reply.error))
        else request?.resolve(reply.value)
      }
    })
    const fail = (error: Error) => { ready.reject(error); for (const request of this.pending.values()) request.reject(error); this.pending.clear() }
    this.child.once('error', fail)
    this.child.once('exit', (code, signal) => fail(new Error(`Host exited (${code}/${signal}): ${this.stderr}`)))
  }
  async request<T = unknown>(method: string, args: unknown[] = []): Promise<T> {
    const { result } = this.send<T>(method, args)
    return result
  }
  send<T>(method: string, args: unknown[]) {
    const id = ++this.next, reply = Promise.withResolvers<unknown>()
    this.pending.set(id, reply)
    const admitted = Promise.withResolvers<void>()
    if (method === 'pause-write') this.events.set(id, admitted.resolve)
    this.child.stdin.write(JSON.stringify({ id, method, args }) + '\n')
    const timeout = setTimeout(() => reply.reject(new Error(`Host request timed out: ${method}: ${this.stderr}`)), 10_000)
    const result = reply.promise.finally(() => { clearTimeout(timeout); this.pending.delete(id); this.events.delete(id) }) as Promise<T>
    return { result, admitted: admitted.promise }
  }
  async kill(signal: NodeJS.Signals = 'SIGKILL') {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return
    const exited = once(this.child, 'exit'); this.child.kill(signal); await exited
  }
}
