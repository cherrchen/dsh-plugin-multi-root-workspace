/**
 * Compatibility adapter for upstream's instruction discovery and rendering.
 *
 * `@deepseek-ai/dsh-agent-instructions` renamed its renderer between two
 * releases this plugin supports, without changing its signature:
 *
 * ```text
 * 0.1.5-rc.2     renderWorkspaceContext(files, options)   RenderedWorkspaceContext
 * 0.1.6-alpha.1  renderAgentInstructions(files, options)  RenderedAgentInstructions
 * ```
 *
 * `discoverBaselineInstructionFiles` kept both its name and its signature.
 *
 * All coupling to that package is concentrated here so the business layer
 * (`src/instructions.ts`) only ever calls {@link renderInstructions} and
 * {@link InstructionsApi.discover}. A future rename is one edit in this file,
 * not a version check sprinkled through the provider.
 *
 * The export is picked by NAME rather than by comparing the release string:
 * a structural probe also copes with upstream keeping both names for a release,
 * or reshaping within one, which a version comparison does not.
 *
 * The package is loaded LAZILY, and its absence is reported as absence rather
 * than thrown. It is an optional peer: the default DSH bundle mounts it, but a
 * minimal composition legitimately has neither it nor an agent, and in that
 * case this plugin's instruction row must simply contribute nothing.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/compat/agent-instructions
 */

import type {
  InstructionFile,
  LoadedInstructionFile,
  TruncatedInstruction,
} from '@deepseek-ai/dsh-agent-instructions'

export type { InstructionFile, LoadedInstructionFile, TruncatedInstruction }

/** Model-facing instruction text plus the byte-budget diagnostics. */
export interface RenderedInstructions {
  /** The rendered text, within the requested budget. */
  readonly text: string
  /** Files the budget excluded entirely. */
  readonly omitted: readonly InstructionFile[]
  /** Files the budget included only in part. */
  readonly truncated: readonly TruncatedInstruction[]
}

/** The rendering budget, spelled the way both releases spell it. */
export interface RenderOptions {
  /** UTF-8 byte cap for the whole rendered batch. */
  readonly maxBytes: number
  /** Whether this batch supersedes a previously visible baseline. */
  readonly replacePreviousBaseline?: boolean
}

/** Discovery inputs this plugin uses; a subset of upstream's option bag. */
export interface DiscoverOptions {
  /** The directory discovery starts from. */
  readonly cwd: string
  /** The root the walk stops at; pinned to the additional root by the caller. */
  readonly projectRoot?: string
  /** Harness home, so the user-global file is discovered from the right place. */
  readonly dshHome?: string
  /** Directory entries that identify a project root. */
  readonly projectRootMarkers?: readonly string[]
  /** Ordered same-directory instruction candidates. */
  readonly instructionFileCandidates?: readonly string[]
  /** Ordered same-directory local-overlay candidates. */
  readonly localInstructionFileCandidates?: readonly string[]
  /** Cancellation for the probes discovery performs. */
  readonly signal?: AbortSignal
}

/** The upstream surface this plugin depends on, after adaptation. */
export interface InstructionsApi {
  /** Discover instruction candidates, in model precedence order. */
  discover: (options: DiscoverOptions) => Promise<readonly InstructionFile[]>
  /** Render loaded files within a byte budget. */
  render: (files: readonly LoadedInstructionFile[], options: RenderOptions) => RenderedInstructions
}

/**
 * The shape this adapter probes for. Both renderer names are optional because
 * exactly one of them exists on any given release.
 */
interface UpstreamModule {
  readonly discoverBaselineInstructionFiles?: (options: DiscoverOptions) => Promise<InstructionFile[]>
  readonly renderAgentInstructions?: (files: readonly LoadedInstructionFile[], options: RenderOptions) => RenderedInstructions
  readonly renderWorkspaceContext?: (files: readonly LoadedInstructionFile[], options: RenderOptions) => RenderedInstructions
}

/** Raised when the package is present but carries neither renderer name. */
export class DshInstructionApiError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DshInstructionApiError'
  }
}

/** Resolution is attempted once per process; `null` records a confirmed absence. */
let resolution: Promise<InstructionsApi | null> | undefined

/**
 * Pick the renderer this release exports.
 * @param module - the loaded upstream module.
 * @returns the renderer.
 * @throws {DshInstructionApiError} when neither name is present.
 */
export function selectRenderer(module: UpstreamModule): NonNullable<UpstreamModule['renderAgentInstructions']> {
  const render = module.renderAgentInstructions ?? module.renderWorkspaceContext
  if (render === undefined) {
    throw new DshInstructionApiError(
      'multi-root workspace: @deepseek-ai/dsh-agent-instructions exports neither renderAgentInstructions '
      + '(0.1.6 and later) nor renderWorkspaceContext (0.1.5); the additional roots\' instruction files '
      + 'cannot be rendered. Adapt src/compat/agent-instructions.ts to the installed release.',
    )
  }
  return render
}

/**
 * Adapt one loaded upstream module to {@link InstructionsApi}.
 * @param module - the loaded upstream module.
 * @returns the adapted surface.
 * @throws {DshInstructionApiError} when a function this plugin needs is absent.
 */
export function adaptInstructionsModule(module: UpstreamModule): InstructionsApi {
  const discover = module.discoverBaselineInstructionFiles
  if (discover === undefined) {
    throw new DshInstructionApiError(
      'multi-root workspace: @deepseek-ai/dsh-agent-instructions does not export '
      + 'discoverBaselineInstructionFiles; adapt src/compat/agent-instructions.ts to the installed release.',
    )
  }
  return { discover: options => discover(options), render: selectRenderer(module) }
}

/**
 * Load and adapt the upstream instruction surface, once.
 *
 * @returns the adapted surface, or `undefined` when the package is not
 *   installed. A package that IS installed but exports neither renderer throws
 *   instead: that is a compatibility break to fix, not an optional seam.
 */
export async function instructionsApi(): Promise<InstructionsApi | undefined> {
  resolution ??= (async () => {
    let module: UpstreamModule
    try {
      module = await import('@deepseek-ai/dsh-agent-instructions') as unknown as UpstreamModule
    } catch {
      return null
    }
    return adaptInstructionsModule(module)
  })()
  return (await resolution) ?? undefined
}

/**
 * Render loaded instruction files within a byte budget, through whichever
 * renderer the installed release exports.
 *
 * This is the only rendering entry point the business layer uses.
 * @param files - loaded files, ordered broadest to most specific.
 * @param options - the byte budget.
 * @returns the rendered text and its budget diagnostics.
 * @throws {DshInstructionApiError} when no usable renderer is installed.
 */
export async function renderInstructions(
  files: readonly LoadedInstructionFile[],
  options: RenderOptions,
): Promise<RenderedInstructions> {
  const api = await instructionsApi()
  if (api === undefined) {
    throw new DshInstructionApiError(
      'multi-root workspace: @deepseek-ai/dsh-agent-instructions is not installed, so instruction files '
      + 'cannot be rendered. Check for its presence with instructionsApi() before calling renderInstructions().',
    )
  }
  return api.render(files, options)
}

/** Reset the cached resolution. Tests use it to probe both renderer names. */
export function resetInstructionsApi(): void {
  resolution = undefined
}
