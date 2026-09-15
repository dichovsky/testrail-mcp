import type { Tool, ToolAnnotations } from '@modelcontextprotocol/server';
import type { z } from 'zod';
import { inputJsonSchema } from '../contracts/inputs.js';
import type { DriverBinding, DriverCall } from './driver-call.js';
import { InputPaths, isRecord } from './input-paths.js';

export type Family = `T0${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}` | `T${10 | 11 | 12}`;
export type HttpMethod = 'GET' | 'POST';
export type CallMode = 'single' | 'page' | 'all';
export type Pagination =
  | { readonly kind: 'none'; readonly single: DriverCall }
  | { readonly kind: 'controlled' | 'response_driven'; readonly page: DriverCall; readonly all: DriverCall };
export type Files =
  | { readonly kind: 'none' }
  | { readonly kind: 'upload'; readonly featureFilename: boolean }
  | { readonly kind: 'download' };

export type ResponseContract = {
  readonly entitySchema: z.ZodType | null;
} & (
  | { readonly shape: 'record'; readonly outerSchema: z.ZodType<Record<string, unknown>> }
  | { readonly shape: 'array'; readonly outerSchema: z.ZodType<unknown[]> }
  | { readonly shape: 'text'; readonly outerSchema: z.ZodType<string> }
  | { readonly shape: 'void'; readonly outerSchema: z.ZodType<undefined> }
  | { readonly shape: 'page'; readonly outerSchema: z.ZodType<{ kind: 'envelope' | 'legacy-array'; items: unknown[] }> }
  | { readonly shape: 'binary'; readonly outerSchema: z.ZodType<ArrayBuffer> }
  | { readonly shape: 'union'; readonly outerSchema: z.ZodType }
);

export interface ArgumentMapping {
  /** REST input location; map filters explicitly, e.g. query.is_completed. */
  readonly input: string;
  readonly call: CallMode;
  readonly argument: number;
  readonly property?: string;
  readonly serialization: 'path' | 'query-scalar' | 'query-list' | 'query-repeated'
    | 'json-body' | 'multipart' | 'staged-file' | 'aggregate-control';
}

export interface OperationDefinition<Token extends string = string> {
  readonly token: Token;
  readonly method: HttpMethod;
  readonly route: string;
  readonly family: Family;
  readonly driverBinding: DriverBinding;
  readonly summary: string;
  readonly inputSchema: z.ZodType<object>;
  readonly argumentMap: readonly ArgumentMapping[];
  readonly response: ResponseContract;
  readonly pagination: Pagination;
  readonly files: Files;
  readonly effects: {
    readonly testRail: 'read' | 'write' | 'report';
    readonly destructive: boolean;
    readonly idempotent: boolean;
  };
  /** Driver policy documentation; never used to implement an adapter retry. */
  readonly retry: 'ordinary-read' | 'json-write' | 'never';
}

export interface Operation<Token extends string = string> extends OperationDefinition<Token> {
  readonly tool: `testrail_${Token}`;
  readonly description: string;
  readonly annotations: Readonly<ToolAnnotations>;
  readonly jsonSchema: Tool['inputSchema'];
}

export function operationCalls(operation: OperationDefinition): readonly [CallMode, DriverCall][] {
  return operation.pagination.kind === 'none'
    ? [['single', operation.pagination.single]]
    : [['page', operation.pagination.page], ['all', operation.pagination.all]];
}

function validateDefinition(operation: OperationDefinition): void {
  const { token, route, pagination, effects, files } = operation;
  if (!/^[a-z][a-z0-9_]*$/u.test(token) ||
      !new RegExp(`^${token}(?:/\\{[a-z][a-z0-9_]*\\})*$`, 'u').test(route)) {
    throw new Error(`Invalid endpoint identity: ${token}`);
  }
  if (!/^T(?:0[1-9]|1[0-2])$/u.test(operation.family)) throw new Error('Invalid endpoint family');
  if (operation.summary.trim().length === 0) throw new Error(`Missing description: ${token}`);
  if ((token === 'run_report' || token === 'run_cross_project_report') && effects.testRail !== 'report') {
    throw new Error(`Report endpoint must declare report effects: ${token}`);
  }
  if (token === 'get_attachment' && files.kind !== 'download') throw new Error('get_attachment must declare persistent download behavior');
  const calls = operationCalls(operation);
  for (const [, call] of calls) {
    if (call.inputSchema !== operation.inputSchema) throw new Error(`Different call input schema: ${token}`);
  }
  if (pagination.kind === 'none' && pagination.single.binding !== operation.driverBinding) {
    throw new Error(`Different endpoint driver binding: ${token}`);
  }
  if (pagination.kind !== 'none' && operation.response.shape !== 'page') throw new Error(`Paginated response must describe a page: ${token}`);
  if (files.kind === 'download' && operation.response.shape !== 'binary') throw new Error(`Download response must describe binary data: ${token}`);
  const mappings = new Set<string>();
  for (const mapping of operation.argumentMap) {
    if (!calls.some(([mode]) => mode === mapping.call) ||
        !Number.isSafeInteger(mapping.argument) || mapping.argument < 0 ||
        !/^[a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_*]*|\[\])*$/u.test(mapping.input) ||
        (mapping.property !== undefined && !/^[a-zA-Z_][a-zA-Z0-9_.]*$/u.test(mapping.property))) {
      throw new Error(`Invalid argument map: ${token}`);
    }
    const key = JSON.stringify(mapping);
    if (mappings.has(key)) throw new Error(`Duplicate argument mapping: ${token}`);
    mappings.add(key);
  }
  const pathNames = [...route.matchAll(/\{([a-z][a-z0-9_]*)\}/gu)].map((match) => match[1]);
  for (const pathName of pathNames) {
    for (const [mode] of calls) {
      if (!operation.argumentMap.some((mapping) => mapping.input === pathName && mapping.call === mode && mapping.serialization === 'path')) {
        throw new Error(`Unmapped path argument: ${token} ${mode} ${pathName}`);
      }
    }
  }
  if (effects.testRail === 'read' && (operation.method !== 'GET' || effects.destructive || (!effects.idempotent && files.kind !== 'download'))) {
    throw new Error(`Invalid read effects: ${token}`);
  }
  if (effects.testRail === 'report' && (operation.method !== 'GET' || effects.idempotent || operation.retry !== 'never')) {
    throw new Error(`Invalid report effects: ${token}`);
  }
  if (effects.testRail === 'write' && operation.method !== 'POST') throw new Error(`Invalid write method: ${token}`);
  if (files.kind === 'download' && (effects.testRail !== 'read' || effects.destructive || effects.idempotent || operation.retry !== 'ordinary-read')) {
    throw new Error(`Invalid persistent download effects: ${token}`);
  }
  if (files.kind === 'upload' && (effects.testRail !== 'write' || operation.retry !== 'never')) {
    throw new Error(`Invalid upload effects: ${token}`);
  }
  if (effects.testRail === 'read' && operation.retry !== 'ordinary-read') throw new Error(`Invalid read retry policy: ${token}`);
  if (effects.testRail === 'write' && files.kind === 'none' && operation.retry !== 'json-write') throw new Error(`Invalid JSON write retry policy: ${token}`);
}

function describeOperation(operation: OperationDefinition): string {
  const parts = [operation.summary.trim()];
  const pathNames = [...operation.route.matchAll(/\{([a-z][a-z0-9_]*)\}/gu)].map((match) => match[1]);
  if (pathNames.length > 0) parts.push(`Required path arguments: ${pathNames.join(', ')}.`);
  if (operation.pagination.kind === 'controlled') {
    parts.push('Returns one page by default. Use _mcp.pagination="all" for bounded remaining matches.');
  } else if (operation.pagination.kind === 'response_driven') {
    parts.push('Returns the server-selected first page by default; manual continuation is unavailable. Use _mcp.pagination="all" for bounded complete retrieval.');
  }
  if (operation.effects.testRail === 'report') {
    parts.push('Generates a report and may send template-configured email. The returned URL may not be ready; do not generate the report again to poll.');
  }
  if (operation.files.kind === 'download') {
    parts.push('Creates a unique persistent local file in the configured download directory on each call; returns its path, attachment ID and byte count.');
  } else if (operation.files.kind === 'upload') {
    parts.push('Reads file_path within configured upload roots and uploads an owned staged copy.');
    if (operation.files.featureFilename) parts.push('The multipart filename must end in .feature.');
  }
  if (operation.effects.testRail === 'write') parts.push('Changes TestRail data.');
  const description = parts.join(' ');
  if (Buffer.byteLength(description, 'utf8') >= 2048) throw new Error(`Description must be below 2 KiB: ${operation.token}`);
  return description;
}

/** Supported input composition is a closed object or a union of closed objects. */
function objectVariants(paths: InputPaths, schema: unknown): Record<string, unknown>[] {
  const variants = paths.variants(schema);
  if (variants.length === 0) throw new Error('Operation inputs require object schemas');
  if (variants.some((variant) => variant.type !== 'object' || variant.additionalProperties !== false)) {
    throw new Error('Top-level and query inputs must be closed objects');
  }
  return variants;
}

function validateInputLayout(operation: OperationDefinition, schema: Tool['inputSchema']): void {
  const pathNames = [...operation.route.matchAll(/\{([a-z][a-z0-9_]*)\}/gu)].map((match) => match[1]);
  const allowed = new Set<string | undefined>([
    ...pathNames, 'query',
    ...(operation.method === 'POST' && operation.files.kind === 'none' ? ['body'] : []),
    ...(operation.files.kind === 'upload' ? ['file_path', 'filename', 'content_type'] : []),
    ...(operation.pagination.kind === 'none' ? [] : ['_mcp']),
  ]);
  const paths = new InputPaths(schema);
  const variants = objectVariants(paths, schema);
  for (const variant of variants) {
    const properties = isRecord(variant.properties) ? variant.properties : {};
    const required = Array.isArray(variant.required) ? variant.required : [];
    for (const name of pathNames) {
      if (name === undefined || !Object.hasOwn(properties, name) || !required.includes(name)) {
        throw new Error(`Missing required path input: ${operation.token} ${name}`);
      }
    }
    for (const name of Object.keys(properties)) {
      if (!allowed.has(name)) throw new Error(`Unsupported top-level input: ${operation.token} ${name}`);
    }
    if (properties.query !== undefined) objectVariants(paths, properties.query);
    if (properties._mcp !== undefined) objectVariants(paths, properties._mcp);
  }
  for (const mapping of operation.argumentMap) {
    if (!paths.forMode(variants, mapping.call).some((variant) => paths.has(variant, mapping.input))) {
      throw new Error(`Argument mapping has no input: ${operation.token} ${mapping.call} ${mapping.input}`);
    }
  }
}

export function defineOperation<const Token extends string>(definition: OperationDefinition<Token>): Operation<Token> {
  validateDefinition(definition);
  const jsonSchema = inputJsonSchema(definition.inputSchema);
  validateInputLayout(definition, jsonSchema);
  const annotations: Readonly<ToolAnnotations> = Object.freeze({
    readOnlyHint: definition.effects.testRail === 'read' && definition.files.kind === 'none',
    destructiveHint: definition.effects.destructive,
    idempotentHint: definition.effects.idempotent,
    openWorldHint: true,
  });
  return Object.freeze({
    ...definition,
    tool: `testrail_${definition.token}`,
    description: describeOperation(definition),
    annotations,
    jsonSchema,
  });
}

type UniqueTools<Entries extends readonly Operation[], Seen extends string = never> =
  Entries extends readonly [infer First extends Operation, ...infer Rest extends readonly Operation[]]
    ? string extends First['token'] ? UniqueTools<Rest, Seen>
      : First['tool'] extends Seen ? never : UniqueTools<Rest, Seen | First['tool']>
    : unknown;

export interface OperationRegistry {
  readonly entries: readonly Operation[];
  readonly get: (name: string) => Operation | undefined;
}

export function createRegistry<const Entries extends readonly Operation[]>(...entries: Entries & UniqueTools<Entries>): OperationRegistry {
  const byName = new Map<string, Operation>();
  const byRoute = new Set<string>();
  for (const entry of entries) {
    const route = `${entry.method} ${entry.route}`;
    if (byName.has(entry.tool)) throw new Error(`Duplicate tool: ${entry.tool}`);
    if (byRoute.has(route)) throw new Error(`Duplicate endpoint: ${route}`);
    byName.set(entry.tool, entry);
    byRoute.add(route);
  }
  const sorted = Object.freeze([...entries].sort((left, right) => left.tool.localeCompare(right.tool, 'en')));
  return Object.freeze({ entries: sorted, get: (name: string) => byName.get(name) });
}
