/**
 * Barrel for the multi-root workspace bundle's host half.
 *
 * The loader mounts the plugin's responsibilities through the subpath entries
 * declared in `package.json` and `cordis.patch.yml` (`./fs`, `./sandbox`,
 * `./scope`, `./registry`, `./command`); this entry carries only the no-op
 * `apply` below. The patch still inserts a row with THIS specifier (the bare
 * package name) because the web client-module scan reads a package's
 * `dsh.client` declaration solely from a loader row mounted at its package
 * root — subpath rows are never client rows — so without that row the browser
 * is never served `lib/client.js` and the sidebar footer action never
 * registers. The barrel itself stays side-effect free so tests can import the
 * whole public surface from a single specifier.
 *
 * The two facts worth remembering about this surface: a registration carries the
 * canonical directory it was GRANTED for (`recordedPath`), and the panel channel
 * has one declared response shape per endpoint (`PanelResponseMap`).
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace
 */

export { MultiRootFileSystem } from './fs.ts'
export type { Config as FileSystemConfig } from './fs.ts'
export { MultiRootSandboxProvider } from './sandbox.ts'
export type { Config as SandboxConfig } from './sandbox.ts'
export { MultiRootScopeService, sanitizeAdditionalRoots, renderWorkspaceRootsContext } from './scope.ts'
export type { AdditionalWorkspaceRoot, FilesystemScope } from './scope.ts'
export { MultiRootRegistry, DOMAIN_NAME, MAX_ALIAS_LENGTH, multiRootDomainSpec } from './registry.ts'
export type { AddRootInput, PersistedPrimaryRoot } from './registry.ts'
export {
  availableRoots,
  canonicalRoot,
  classifyStoredRoots,
  expandRootInput,
  indexedStatuses,
  isCanonicallyUnder,
  additionalRootId,
  removeStatusAt,
  resolveRootRef,
  RootValidationError,
  validateRootCandidate,
} from './roots.ts'
export type {
  AdditionalRootId,
  RegisteredRoot,
  RootRef,
  RootState,
  RootStatus,
  RootValidationCode,
} from './roots.ts'
export { COMMAND_NAME, parseFoldersCommand, renderRootsReport, revealArgv } from './command.ts'
export type { FoldersCommand } from './command.ts'
export { PANEL_CHANNEL, PANEL_ENDPOINTS, parsePanelCall, parseRevealedView, parseRootsView } from './contract.ts'
export type {
  PanelCall,
  PanelEndpoint,
  PanelFailure,
  PanelRequest,
  PanelResponseMap,
  RevealedView,
  RootView,
  RootsView,
} from './contract.ts'

/**
 * Carrier plugin face for the bare-package-name loader row (see the module
 * doc). It deliberately provides nothing: every host responsibility is owned
 * by a subpath entry, and this row exists only so the web client-module scan
 * can locate the package root and read its `dsh.client` declaration.
 */
export const inject: string[] = []

export function apply(): void {}
