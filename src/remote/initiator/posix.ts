import { SshEnvironmentManager, type SshEnvironmentManagerOptions } from '../ssh-environment.ts'
import type { SshInitiatorBackend } from './contract.ts'

export function createPosixInitiator(options: SshEnvironmentManagerOptions): SshInitiatorBackend {
  return { kind: 'posix', runtime: new SshEnvironmentManager(options) }
}
