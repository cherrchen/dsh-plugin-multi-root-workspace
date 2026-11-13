/**
 * Managed SSH files (ADR-0041 §2): `<credentialRoot>/ssh_config` blocks for
 * `managed` environments, the plugin's own `known_hosts`, and the one-line
 * `Include` link into `~/.ssh/config` (with backup). POSIX only.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, copyFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { PersonalConfig, PersonalEnvironment } from './config.ts'

export function managedHostAlias(environmentId: string): string {
  return `dsh-${environmentId}`
}

/** The ssh_config text for one managed environment. */
export function renderHostBlock(environment: PersonalEnvironment, credentialRoot: string): string {
  const keyId = environment.credential.kind === 'managed'
    ? (environment.credential.accessKeyId ?? environment.credential.credentialId)
    : undefined
  return [
    `Host ${managedHostAlias(environment.environmentId)}`,
    `  HostName ${environment.endpoint.hostname}`,
    `  Port ${environment.endpoint.port}`,
    `  User ${environment.endpoint.user}`,
    `  IdentityFile ${join(credentialRoot, 'keys', keyId ?? 'none')}`,
    '  IdentitiesOnly yes',
    `  UserKnownHostsFile ${join(credentialRoot, 'known_hosts')}`,
    '  GlobalKnownHostsFile /dev/null',
    '  StrictHostKeyChecking yes',
    '  BatchMode yes',
    '  ForwardAgent no',
    '  UpdateHostKeys no',
    '',
  ].join('\n')
}

/** Regenerate `<credentialRoot>/ssh_config` after every config/credential change. */
export function renderSshConfig(config: PersonalConfig, credentialRoot: string): void {
  const blocks = config.environments
    .filter(environment => environment.credential.kind === 'managed')
    .map(environment => renderHostBlock(environment, credentialRoot))
  writeFileSync(join(credentialRoot, 'ssh_config'),
    ['# Managed by @dsh-electron/dsh-plugin-multi-root-workspace — do not edit.', ...blocks].join('\n'),
    { mode: 0o600 })
}

/**
 * Write the confirmed `ssh-keyscan` line(s) for `[hostname]:port` (bare
 * hostname for port 22), replacing that host's previous lines in the
 * plugin-managed `known_hosts` (0600).
 */
export function recordKnownHost(credentialRoot: string, hostname: string, port: number, lines: readonly string[]): void {
  const path = join(credentialRoot, 'known_hosts')
  const marker = port === 22 ? `${hostname} ` : `[${hostname}]:${port} `
  const kept = existsSync(path)
    ? readFileSync(path, 'utf8').split('\n').filter(line => line.trim() !== '' && !line.startsWith(marker) && !line.startsWith('#'))
    : []
  writeFileSync(path, `${[...kept, ...lines].join('\n')}\n`, { mode: 0o600 })
}

const includeLine = (credentialRoot: string): string => `Include "${join(credentialRoot, 'ssh_config')}"`

export interface LinkStatus {
  /** The managed config exists at all. */
  readonly managed: boolean
  /** ~/.ssh/config carries our exact Include line before any Host/Match line. */
  readonly linked: boolean
  readonly configPath: string
}

export function linkStatus(credentialRoot: string, home: string = homedir()): LinkStatus {
  const configPath = join(home, '.ssh', 'config')
  const managed = existsSync(join(credentialRoot, 'ssh_config'))
  if (!existsSync(configPath)) return { managed, linked: false, configPath }
  const expected = includeLine(credentialRoot)
  const lines = readFileSync(configPath, 'utf8').split('\n')
  for (const raw of lines) {
    const line = raw.trim()
    if (line === '') continue
    if (line === expected) return { managed, linked: true, configPath }
    if (/^(host|match)\s/i.test(line)) break
  }
  return { managed, linked: false, configPath }
}

/**
 * Prepend the Include line to `~/.ssh/config`: create `~/.ssh` 0700 if
 * missing, back the existing file up to `config.dsh-backup-<timestamp>`,
 * then write the line BEFORE any Host/Match (simplest: at the top), keeping
 * mode 0600. Nothing else in the user's file is touched.
 */
export function link(credentialRoot: string, home: string = homedir()): LinkStatus {
  const status = linkStatus(credentialRoot, home)
  if (status.linked) return status
  const sshDir = join(home, '.ssh')
  if (!existsSync(sshDir)) mkdirSync(sshDir, { mode: 0o700 })
  if (existsSync(status.configPath)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    copyFileSync(status.configPath, `${status.configPath}.dsh-backup-${stamp}`)
  }
  const previous = existsSync(status.configPath) ? readFileSync(status.configPath, 'utf8') : ''
  const temp = `${status.configPath}.tmp-${process.pid}`
  writeFileSync(temp, `${includeLine(credentialRoot)}\n${previous}`, { mode: 0o600 })
  renameSync(temp, status.configPath)
  return { managed: status.managed, linked: true, configPath: status.configPath }
}

/** The askpass helper (0700): prints the credential-root secret to stdout. */
export function renderAskpass(credentialRoot: string): void {
  if (!existsSync(credentialRoot)) mkdirSync(credentialRoot, { recursive: true, mode: 0o700 })
  writeFileSync(join(credentialRoot, 'askpass.sh'),
    '#!/bin/sh\nexec cat "$DSH_SSH_SECRET_FILE"\n',
    { mode: 0o700 })
}
