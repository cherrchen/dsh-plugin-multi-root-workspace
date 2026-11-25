import { win32 } from 'node:path'

export function windowsSystem32(systemRoot: string | undefined = process.env.SystemRoot): string {
  if (systemRoot === undefined || !/^[A-Za-z]:[\\/]/u.test(systemRoot) || systemRoot.includes('\0')) {
    throw new Error('Windows SystemRoot is unavailable')
  }
  return win32.join(systemRoot, 'System32')
}

export function windowsOpenSshCommands(systemRoot?: string) {
  const root = win32.join(windowsSystem32(systemRoot), 'OpenSSH')
  return { ssh: win32.join(root, 'ssh.exe'), keygen: win32.join(root, 'ssh-keygen.exe'), keyscan: win32.join(root, 'ssh-keyscan.exe') }
}

const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`

export function windowsOpenSshHelperArgs(input: {
  readonly alias: string
  readonly node: string
  readonly helper: string
  readonly config?: string
}): string[] {
  if (!/^[A-Za-z0-9_.][A-Za-z0-9_.-]{0,63}$/u.test(input.alias)) throw new Error('Invalid SSH alias')
  if (![input.node, input.helper].every(path => path.startsWith('/') && !path.includes('\0'))) {
    throw new Error('Helper launch requires absolute POSIX paths')
  }
  if (input.config !== undefined && (!/^[A-Za-z]:[\\/]/u.test(input.config) || input.config.includes('\0'))) {
    throw new Error('Managed SSH config requires an absolute local Windows path')
  }
  const command = [input.node, '--disable-sigusr1', input.helper].map(quote).join(' ')
  return [
    '-T', ...(input.config === undefined ? [] : ['-F', input.config]),
    '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ForwardAgent=no',
    '-o', 'ClearAllForwardings=yes', '-o', 'UpdateHostKeys=no', '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=3', input.alias, command,
  ]
}
