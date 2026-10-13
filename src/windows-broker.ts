/** Client of the administrator-installed deny-token broker. Requests carry
 * only the caller process token handle and bounded deny identities.
 */
import { createHash } from 'node:crypto'
import { createConnection } from 'node:net'

export function brokerPipeName(userSid: string): string {
  if (!/^S-1-[0-9]+(?:-[0-9]+)+$/.test(userSid)) throw new Error('invalid broker user SID')
  return `DshMultiRootBroker-${createHash('sha256').update(userSid).digest('hex').slice(0, 16)}`
}

/** The broker must acknowledge before any ACL edits or process creation. The
 * caller independently reads the deny-only groups from the token;
 * even an impersonated pipe server cannot fabricate that kernel state.
 */
export async function requestDenyToken(userSid: string, tokenHandle: bigint, deniedIds: readonly string[]): Promise<bigint> {
  if (tokenHandle <= 0n || tokenHandle > 0xffffffffffffffffn || deniedIds.length === 0 || deniedIds.length > 64
    || deniedIds.some(id => !/^S-1-4-(?:[0-9]{1,10}-){4}3$/.test(id))) {
    throw new Error('invalid deny-token broker request')
  }
  const pipe = `\\\\.\\pipe\\${brokerPipeName(userSid)}`
  return await new Promise<bigint>((resolve, reject) => {
    const socket = createConnection(pipe)
    let response = ''
    const timer = setTimeout(() => finish(new Error('deny-token broker timed out')), 10_000)
    const finish = (error?: Error, handle?: bigint): void => {
      clearTimeout(timer)
      socket.destroy()
      if (error === undefined && handle !== undefined) resolve(handle)
      else reject(error ?? new Error('missing broker token handle'))
    }
    socket.once('connect', () => { socket.write(`2|${tokenHandle}|${deniedIds.join(',')}\n`) })
    socket.once('error', error => finish(new Error(
      `Windows read-only roots require the installed privileged broker (${brokerPipeName(userSid)}): ${error.message}`,
    )))
    socket.once('end', () => { if (!response.includes('\n')) finish(new Error('deny-token broker disconnected')) })
    socket.on('data', bytes => {
      response += bytes.toString('utf8')
      if (response.length > 1024) return finish(new Error('invalid deny-token broker response'))
      const end = response.indexOf('\n')
      if (end < 0) return
      const line = response.slice(0, end)
      if (/^OK\|[1-9][0-9]{0,19}$/.test(line)) {
        const handle = BigInt(line.slice(3))
        if (handle <= 0xffffffffffffffffn) return finish(undefined, handle)
      }
      finish(new Error(`deny-token broker refused: ${line}`))
    })
  })
}


/** Synchronous, bounded RPC inside the public suspended-create binding. The
 * caller verifies the child's kernel token before the helper can resume it.
 */
export function assignDenyToken(
  userSid: string, processHandle: bigint, threadHandle: bigint, deniedIds: readonly string[],
  io: {
    open(pipe: string): unknown
    write(pipe: unknown, bytes: Buffer): void
    available(pipe: unknown): number
    read(pipe: unknown, count: number): Buffer
    pause(): void
    close(pipe: unknown): void
  },
): void {
  if (processHandle <= 0n || threadHandle <= 0n || processHandle > 0xffffffffffffffffn || threadHandle > 0xffffffffffffffffn
    || deniedIds.length < 1 || deniedIds.length > 64 || deniedIds.some(id => !/^S-1-4-(?:[0-9]{1,10}-){4}3$/.test(id))) {
    throw new Error('invalid deny-token assignment request')
  }
  const pipe = io.open(`\\\\.\\pipe\\${brokerPipeName(userSid)}`)
  try {
    const deadline = Date.now() + 10_000
    io.write(pipe, Buffer.from(`3|${processHandle}|${threadHandle}|${deniedIds.join(',')}\n`, 'ascii'))
    let response = ''
    while (!response.includes('\n')) {
      if (Date.now() > deadline) throw new Error('deny-token assignment timed out')
      const count = io.available(pipe)
      if (count > 1024 || response.length + count > 1024) throw new Error('invalid deny-token assignment response')
      if (count > 0) response += io.read(pipe, count).toString('utf8')
      else io.pause()
    }
    if (response.slice(0, response.indexOf('\n')) !== 'OK') throw new Error(`deny-token assignment refused: ${response.trim()}`)
  } finally { io.close(pipe) }
}
