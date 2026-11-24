/**
 * The model-facing argument schemas of `remote_copy` and `remote_bash`, plus
 * the validator every execute boundary runs. The advertised JSON Schema and
 * the validation rules are the SAME declaration: `validateToolArguments`
 * interprets the schema object the tool registers, so a rule can never be
 * shown without being enforced or enforced without being shown.
 *
 * Both copy endpoints accept the same fields and only an OMITTED
 * `environmentId` defaults to `local`; an explicit `null` or empty string is
 * a structural error. `remote_bash` always names one remote environment.
 *
 * @module @dsh-electron/dsh-plugin-multi-root-workspace/remote-tool-arguments
 */

/** Annotations shared by every schema node. */
interface SchemaAnnotations {
  readonly description?: string
}

/** One object schema node. */
export interface ToolObjectSchema extends SchemaAnnotations {
  readonly type: 'object'
  readonly properties: Readonly<Record<string, ToolValueSchema>>
  readonly required?: readonly string[]
  readonly additionalProperties: false
}

/** One string schema node. */
export interface ToolStringSchema extends SchemaAnnotations {
  readonly type: 'string'
  readonly minLength?: number
  readonly maxLength?: number
  /** Non-validating annotation: execute applies it only when the key is absent. */
  readonly default?: string
}

/** One integer schema node. */
export interface ToolIntegerSchema extends SchemaAnnotations {
  readonly type: 'integer'
  readonly minimum?: number
}

/** A leaf or nested node the validator understands. */
export type ToolValueSchema = ToolObjectSchema | ToolStringSchema | ToolIntegerSchema

/** One structural problem, located by its field path (`from.relativePath`). */
export interface ArgumentIssue {
  /** Dot path of the offending field; empty for the arguments root. */
  readonly path: string
  /** A short, static description of the rule that failed. */
  readonly detail: string
}

/** The result of parsing one tool call's arguments. */
export type ParsedArguments<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly ArgumentIssue[] }

/** One copy endpoint after defaults: `environmentId` is always concrete. */
export interface CopyEndpointArguments {
  readonly environmentId: string
  readonly rootId: string
  readonly relativePath: string
}

/** Parsed `remote_copy` arguments. */
export interface RemoteCopyArguments {
  readonly from: CopyEndpointArguments
  readonly to: CopyEndpointArguments
}

/** Parsed `remote_bash` arguments. */
export interface RemoteBashArguments {
  readonly environmentId: string
  readonly rootId: string
  readonly cwdRelative: string
  readonly command: string
  readonly timeoutMs: number
  readonly maxOutputBytes?: number
}

/** The local endpoint id every omitted copy endpoint resolves to. */
export const LOCAL_ENVIRONMENT_ID = 'local'

const environmentIdSchema = {
  type: 'string',
  minLength: 1,
  maxLength: 128,
  description: 'Remote environment id. Omit it on a copy endpoint to mean the local workspace; a remote endpoint must name it explicitly.',
} as const satisfies ToolStringSchema

const rootIdSchema = {
  type: 'string',
  minLength: 1,
  maxLength: 256,
  description: 'Registered root id: "primary" for the local primary root, an additional root aliasId, or a remote binding rootId.',
} as const satisfies ToolStringSchema

const relativePathSchema = {
  type: 'string',
  minLength: 1,
  maxLength: 4096,
  description: 'Normalized relative POSIX path of one regular file inside the root (no leading "/", no "." or ".." segments).',
} as const satisfies ToolStringSchema

/** The endpoint schema both `from` and `to` register — one definition, no asymmetry. */
export const REMOTE_COPY_ENDPOINT_PARAMETERS = {
  type: 'object',
  properties: {
    environmentId: environmentIdSchema,
    rootId: rootIdSchema,
    relativePath: relativePathSchema,
  },
  required: ['rootId', 'relativePath'],
  additionalProperties: false,
} as const satisfies ToolObjectSchema

/** The advertised and enforced `remote_copy` parameter schema. */
export const REMOTE_COPY_PARAMETERS = {
  type: 'object',
  properties: {
    from: REMOTE_COPY_ENDPOINT_PARAMETERS,
    to: REMOTE_COPY_ENDPOINT_PARAMETERS,
  },
  required: ['from', 'to'],
  additionalProperties: false,
} as const satisfies ToolObjectSchema

/** The advertised and enforced `remote_bash` parameter schema. */
export const REMOTE_BASH_PARAMETERS = {
  type: 'object',
  properties: {
    environmentId: { ...environmentIdSchema, description: 'Remote environment id; must name a registered remote environment.' },
    rootId: rootIdSchema,
    cwdRelative: {
      type: 'string',
      default: '',
      description: 'Working directory relative to the granted root. Omit or pass "" for the root itself.',
    },
    command: { type: 'string', description: 'Command passed to the remote shell.' },
    timeoutMs: { type: 'integer', minimum: 1, description: 'Command timeout in milliseconds, capped by the environment.' },
    maxOutputBytes: {
      type: 'integer',
      minimum: 1,
      description: 'Per-stream preview cap in bytes, including JSON escaping. Defaults to 64 KiB and is bounded by the deployment limit.',
    },
  },
  required: ['environmentId', 'rootId', 'command', 'timeoutMs'],
  additionalProperties: false,
} as const satisfies ToolObjectSchema

const MAX_ISSUES = 8

/**
 * Validate one tool call's arguments against the schema the tool advertises.
 * The walker supports exactly the node kinds the two schemas use, so nested
 * objects, missing required fields, wrong types and unknown fields are all
 * reported with their field path.
 * @param schema - the registered root object schema.
 * @param value - the raw model arguments.
 * @returns the located issues; an empty array means structurally valid.
 */
export function validateToolArguments(schema: ToolObjectSchema, value: unknown): ArgumentIssue[] {
  const issues: ArgumentIssue[] = []
  visit(schema, value, '', issues)
  return issues
}

function visit(schema: ToolValueSchema, value: unknown, path: string, issues: ArgumentIssue[]): void {
  if (issues.length >= MAX_ISSUES) return
  switch (schema.type) {
    case 'object': {
      if (!isRecord(value)) {
        issues.push({ path, detail: 'must be an object' })
        return
      }
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(schema.properties, key)) issues.push({ path: join(path, key), detail: 'is not an accepted field' })
      }
      for (const key of schema.required ?? []) {
        if (!Object.hasOwn(value, key)) issues.push({ path: join(path, key), detail: 'is required' })
      }
      for (const [key, child] of Object.entries(schema.properties)) {
        if (Object.hasOwn(value, key)) visit(child, value[key], join(path, key), issues)
      }
      return
    }
    case 'string': {
      if (typeof value !== 'string') { issues.push({ path, detail: 'must be a string' }); return }
      const min = schema.minLength ?? 0
      if (value.length < min) { issues.push({ path, detail: min === 1 ? 'must not be empty' : `must be at least ${min} characters` }); return }
      if (schema.maxLength !== undefined && value.length > schema.maxLength) issues.push({ path, detail: `must be at most ${schema.maxLength} characters` })
      return
    }
    case 'integer': {
      if (typeof value !== 'number' || !Number.isInteger(value)) { issues.push({ path, detail: 'must be an integer' }); return }
      if (schema.minimum !== undefined && value < schema.minimum) issues.push({ path, detail: `must be at least ${schema.minimum}` })
      return
    }
  }
}

function join(path: string, key: string): string {
  return path === '' ? key : `${path}.${key}`
}

/** Whether a value is a plain JSON object (not null, not an array). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Parse `remote_copy` arguments: validate the advertised schema, then apply
 * the one default (an omitted `environmentId` means local).
 * @param input - the raw model arguments.
 * @returns the two endpoints, or the located structural issues.
 */
export function parseRemoteCopyArguments(input: unknown): ParsedArguments<RemoteCopyArguments> {
  const issues = validateToolArguments(REMOTE_COPY_PARAMETERS, input)
  if (issues.length > 0) return { ok: false, issues }
  const record = isRecord(input) ? input : {}
  return {
    ok: true,
    value: { from: endpointOf(record.from), to: endpointOf(record.to) },
  }
}

function endpointOf(value: unknown): CopyEndpointArguments {
  const record = isRecord(value) ? value : {}
  const environmentId = typeof record.environmentId === 'string' ? record.environmentId : LOCAL_ENVIRONMENT_ID
  return {
    environmentId,
    rootId: stringOf(record.rootId),
    relativePath: stringOf(record.relativePath),
  }
}

/**
 * Parse `remote_bash` arguments: validate the advertised schema, then apply
 * the documented `cwdRelative` default. The environment id stays mandatory and
 * must not be the local sentinel.
 * @param input - the raw model arguments.
 * @returns the typed request fields, or the located structural issues.
 */
export function parseRemoteBashArguments(input: unknown): ParsedArguments<RemoteBashArguments> {
  const issues = validateToolArguments(REMOTE_BASH_PARAMETERS, input)
  if (issues.length > 0) return { ok: false, issues }
  const record = isRecord(input) ? input : {}
  const maxOutputBytes = record.maxOutputBytes
  return {
    ok: true,
    value: {
      environmentId: stringOf(record.environmentId),
      rootId: stringOf(record.rootId),
      cwdRelative: typeof record.cwdRelative === 'string' ? record.cwdRelative : '',
      command: stringOf(record.command),
      timeoutMs: typeof record.timeoutMs === 'number' ? record.timeoutMs : 0,
      ...(typeof maxOutputBytes === 'number' ? { maxOutputBytes } : {}),
    },
  }
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

// oxlint-disable-next-line eslint/no-control-regex -- Model-supplied labels are sanitized on purpose before they reach a result.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g

/**
 * Bound one model-supplied value before it is echoed into a result label:
 * control characters become spaces and long values are truncated.
 * @param value - the raw value.
 * @param limit - maximum characters retained.
 * @returns a safe label fragment.
 */
export function safeLabelPart(value: string, limit = 96): string {
  const cleaned = value.replace(CONTROL_CHARACTERS, ' ')
  return cleaned.length <= limit ? cleaned : `${cleaned.slice(0, limit - 3)}...`
}
