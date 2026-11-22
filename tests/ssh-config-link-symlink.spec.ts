/**
 * `link()` over a symlinked `~/.ssh/config` (dotfiles-managed): the Include
 * line, the backup, and the atomic rewrite all land on the resolved TARGET —
 * the symlink itself survives untouched and `linkStatus` keeps working
 * through it. A dangling symlink writes through to the path it points at.
 */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { link, linkStatus } from '../src/remote/personal/ssh-files.ts'

describe.skipIf(process.platform === 'win32')('link() over a symlinked ~/.ssh/config', () => {
  it('keeps the symlink, writes the Include into the target, and backs it up beside the target', () => {
    const home = mkdtempSync(join(tmpdir(), 'r5-home-'))
    try {
      const credentialRoot = join(home, 'cred')
      const dotfiles = join(home, 'dotfiles')
      mkdirSync(join(home, '.ssh'))
      mkdirSync(dotfiles)
      const target = join(dotfiles, 'ssh_config')
      writeFileSync(target, 'Host kept\n  HostName kept.internal\n', { mode: 0o640 })
      const configPath = join(home, '.ssh', 'config')
      symlinkSync(target, configPath)

      const result = link(credentialRoot, home)

      // The user's symlink survives; the dotfiles target got the Include
      // first and kept its mode; the backup sits beside the target.
      expect(lstatSync(configPath).isSymbolicLink()).toBe(true)
      const written = readFileSync(target, 'utf8')
      expect(written.startsWith(`Include "${join(credentialRoot, 'ssh_config')}"\n`)).toBe(true)
      expect(written).toContain('Host kept')
      expect(statSync(target).mode & 0o777).toBe(0o640)
      const backups = readdirSync(dotfiles).filter(name => name.startsWith('ssh_config.dsh-backup-'))
      expect(backups).toHaveLength(1)
      expect(readFileSync(join(dotfiles, backups[0]!), 'utf8')).toBe('Host kept\n  HostName kept.internal\n')
      expect(result.linked).toBe(true)
      expect(linkStatus(credentialRoot, home).linked).toBe(true)
      // No backup or temp file leaks next to the symlink itself.
      expect(readdirSync(join(home, '.ssh')).every(name => !name.startsWith('config.dsh-backup-') && !name.startsWith('config.tmp-'))).toBe(true)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('writes through a dangling symlink to the path it points at', () => {
    const home = mkdtempSync(join(tmpdir(), 'r5-dangle-'))
    try {
      const credentialRoot = join(home, 'cred')
      const dotfiles = join(home, 'dotfiles')
      mkdirSync(join(home, '.ssh'))
      mkdirSync(dotfiles)
      const target = join(dotfiles, 'ssh_config')
      const configPath = join(home, '.ssh', 'config')
      symlinkSync(target, configPath)

      const result = link(credentialRoot, home)

      expect(lstatSync(configPath).isSymbolicLink()).toBe(true)
      const written = readFileSync(target, 'utf8')
      expect(written).toBe(`Include "${join(credentialRoot, 'ssh_config')}"\n`)
      expect(statSync(target).mode & 0o777).toBe(0o600)
      expect(result.linked).toBe(true)
      expect(linkStatus(credentialRoot, home).linked).toBe(true)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('preserves both links and creates the final target of a dangling chain', () => {
    const home = mkdtempSync(join(tmpdir(), 'r5-chain-'))
    try {
      mkdirSync(join(home, '.ssh'))
      const config = join(home, '.ssh', 'config')
      const intermediate = join(home, 'intermediate')
      const target = join(home, 'dotfile')
      symlinkSync('../intermediate', config)
      symlinkSync('dotfile', intermediate)
      const credentialRoot = join(home, 'managed')
      link(credentialRoot, home)
      expect(readlinkSync(config)).toBe('../intermediate')
      expect(readlinkSync(intermediate)).toBe('dotfile')
      expect(readFileSync(target, 'utf8')).toContain('Include')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('keeps a regular config untouched by the symlink path handling', () => {
    const home = mkdtempSync(join(tmpdir(), 'r5-regular-'))
    try {
      const credentialRoot = join(home, 'cred')
      mkdirSync(join(home, '.ssh'))
      const configPath = join(home, '.ssh', 'config')
      writeFileSync(configPath, 'Host kept\n', { mode: 0o600 })
      link(credentialRoot, home)
      expect(lstatSync(configPath).isSymbolicLink()).toBe(false)
      expect(readFileSync(configPath, 'utf8').startsWith(`Include "${join(credentialRoot, 'ssh_config')}"\n`)).toBe(true)
      expect(existsSync(join(home, '.ssh', readdirSync(join(home, '.ssh')).find(name => name.startsWith('config.dsh-backup-'))!))).toBe(true)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
