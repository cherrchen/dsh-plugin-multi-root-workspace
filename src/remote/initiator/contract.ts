import type { DeploymentManifest } from '../manifest.ts'
import type { SshExecManager } from '../ssh-exec-backend.ts'
import type { RemoteToolsManager } from '../tools-registration.ts'

export type SshInitiatorRuntime = RemoteToolsManager & SshExecManager & {
  readonly capability: { readonly eligible: boolean; readonly reason?: string }
  /** Retire superseded access synchronously. Only the latest requested manifest's ACK can make a remote runtime usable. */
  rebind(manifest: DeploymentManifest | undefined): void | Promise<void>
  disposeAll(): Promise<void>
}

export interface SshInitiatorBackend {
  readonly kind: 'posix' | 'windows-openssh' | 'wsl'
  readonly runtime: SshInitiatorRuntime
}
