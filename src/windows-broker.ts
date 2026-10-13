/** Client of the administrator-installed token-attribute broker. No command,
 * path, privilege, caller SID or caller PID is accepted as a broker operation.
 */
import { createHash } from 'node:crypto'
import { createConnection } from 'node:net'

export function brokerPipeName(userSid: string): string {
  if (!/^S-1-[0-9]+(?:-[0-9]+)+$/.test(userSid)) throw new Error('invalid broker user SID')
  return `DshMultiRootBroker-${createHash('sha256').update(userSid).digest('hex').slice(0, 16)}`
}

/** The broker must acknowledge before any ACL edits or process creation. The
 * caller independently reads the mandatory attribute back from the token;
 * even an impersonated pipe server cannot fabricate that kernel state.
 */
export async function requestDenyAttribute(userSid: string, tokenHandle: bigint, deniedIds: readonly string[]): Promise<void> {
  if (tokenHandle <= 0n || deniedIds.length === 0 || deniedIds.length > 64
    || deniedIds.some(id => !/^S-1-4-(?:[0-9]{1,10}-){4}3$/.test(id))) {
    throw new Error('invalid token-attribute broker request')
  }
  const pipe = `\\\\.\\pipe\\${brokerPipeName(userSid)}`
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(pipe)
    let response = ''
    const timer = setTimeout(() => finish(new Error('token-attribute broker timed out')), 10_000)
    const finish = (error?: Error): void => {
      clearTimeout(timer)
      socket.destroy()
      if (error === undefined) resolve()
      else reject(error)
    }
    socket.once('connect', () => { socket.write(`1|${tokenHandle}|${deniedIds.join(',')}\n`) })
    socket.once('error', error => finish(new Error(
      `Windows read-only roots require the installed SYSTEM broker (${brokerPipeName(userSid)}): ${error.message}`,
    )))
    socket.once('end', () => { if (!response.includes('\n')) finish(new Error('token-attribute broker disconnected')) })
    socket.on('data', bytes => {
      response += bytes.toString('utf8')
      if (response.length > 1024) return finish(new Error('invalid token-attribute broker response'))
      const end = response.indexOf('\n')
      if (end < 0) return
      const line = response.slice(0, end)
      finish(line === 'OK' ? undefined : new Error(`token-attribute broker refused: ${line}`))
    })
  })
}
