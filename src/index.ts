/**
 * Barrel for the multi-root workspace bundle's host half.
 *
 * This entry is a plain re-export surface with no side effects: the loader
 * mounts the plugin through the subpath entries declared in `package.json` and
 * `cordis.patch.yml` (`./fs`, `./sandbox`, `./scope`, `./registry`,
 * `./command`), never through this one. It exists so the package root resolves
 * and so tests can import the whole public surface from a single specifier.
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
