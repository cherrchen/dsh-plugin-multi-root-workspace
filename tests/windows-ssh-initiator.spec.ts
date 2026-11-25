/** Windows OpenSSH initiator command construction; pure argv shaping, no processes, no network. */
import { describe, expect, it } from 'vitest'
import { windowsOpenSshCommands, windowsOpenSshHelperArgs, windowsSystem32 } from '../src/remote/initiator/windows-openssh.ts'

describe('windowsOpenSshCommands', () => {
  it('resolves the bundled OpenSSH tools under a drive-letter SystemRoot', () => {
    expect(windowsOpenSshCommands('C:\\Windows')).toEqual({
      ssh: 'C:\\Windows\\System32\\OpenSSH\\ssh.exe',
      keygen: 'C:\\Windows\\System32\\OpenSSH\\ssh-keygen.exe',
      keyscan: 'C:\\Windows\\System32\\OpenSSH\\ssh-keyscan.exe',
    })
    expect(windowsOpenSshCommands('D:\\WinNT').ssh).toBe('D:\\WinNT\\System32\\OpenSSH\\ssh.exe')
  })

  it('rejects UNC, rooted non-drive, drive-relative and NUL SystemRoot values', () => {
    for (const value of ['\\\\server\\share', '\\Windows', '/Windows', 'C:Windows', 'C:\\Wi\0ndows', '']) {
      expect(() => windowsSystem32(value)).toThrow('Windows SystemRoot is unavailable')
    }
    expect(() => windowsSystem32(undefined)).toThrow('Windows SystemRoot is unavailable')
  })
})

describe('windowsOpenSshHelperArgs', () => {
  it('builds a strict BatchMode argv that keeps the managed config as one argument', () => {
    const args = windowsOpenSshHelperArgs({
      alias: 'ci', node: '/usr/bin/node', helper: "/a b/he'lp.mjs", config: 'C:\\Users\\A B\\config',
    })
    expect(args[0]).toBe('-T')
    expect(args[args.indexOf('-F') + 1]).toBe('C:\\Users\\A B\\config')
    for (const option of ['BatchMode=yes', 'StrictHostKeyChecking=yes', 'ForwardAgent=no',
      'ClearAllForwardings=yes', 'UpdateHostKeys=no', 'ConnectTimeout=10',
      'ServerAliveInterval=10', 'ServerAliveCountMax=3']) {
      expect(args).toContain(option)
    }
    expect(args).not.toContain('-M')
    expect(args).not.toContain('-S')
    expect(args.some(value => value.includes('/dev/null'))).toBe(false)
    expect(args.slice(-2)).toEqual(['ci', "'/usr/bin/node' '--disable-sigusr1' '/a b/he'\\''lp.mjs'"])
  })

  it('omits -F when no managed config is given', () => {
    const args = windowsOpenSshHelperArgs({ alias: 'ci', node: '/usr/bin/node', helper: '/h.mjs' })
    expect(args).not.toContain('-F')
    expect(args.slice(-2)).toEqual(['ci', "'/usr/bin/node' '--disable-sigusr1' '/h.mjs'"])
  })

  it('refuses option-shaped aliases, non-POSIX remote paths and non-drive config paths', () => {
    expect(() => windowsOpenSshHelperArgs({ alias: '-o', node: '/usr/bin/node', helper: '/h.mjs' }))
      .toThrow('Invalid SSH alias')
    expect(() => windowsOpenSshHelperArgs({ alias: 'ci', node: 'C:\\node.exe', helper: '/h.mjs' }))
      .toThrow('Helper launch requires absolute POSIX paths')
    expect(() => windowsOpenSshHelperArgs({ alias: 'ci', node: '/usr/bin/node', helper: 'relative/h.mjs' }))
      .toThrow('Helper launch requires absolute POSIX paths')
    expect(() => windowsOpenSshHelperArgs({ alias: 'ci', node: '/usr/bin/node', helper: '/h.mjs', config: '\\\\server\\share\\config' }))
      .toThrow('Managed SSH config requires an absolute local Windows path')
  })
})
