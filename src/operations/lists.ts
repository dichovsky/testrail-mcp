import type { Page } from '@dichovsky/testrail-api-client';
import { z } from 'zod';
import type { Limits } from '../config/limits.js';
import { AdapterError } from '../contracts/errors.js';
import { createListInput } from '../contracts/inputs.js';
import { aggregateMetadata, DEFAULT_PAGE_SIZE, pageMetadata } from '../contracts/pagination.js';
import { validateOuter } from '../contracts/results.js';
import type { DriverBinding, DriverCall, DriverCallBinder, DriverMethod } from './driver-call.js';
import type { ArgumentMapping, Pagination, ResponseContract } from './registry.js';

type ListKind = 'controlled' | 'response-driven';
type FilterSerialization = 'query-scalar' | 'query-list' | 'query-repeated';
interface FilterDefinition {
  readonly schema: z.ZodType;
  readonly property: string;
  readonly serialization: FilterSerialization;
}
type FilterDefinitions = Readonly<Record<string, FilterDefinition>>;
type PathDefinitions = Readonly<Record<string, { readonly schema: z.ZodType; readonly argument: number }>>;

/** Check both the explicitly named driver option and the schema's inferred value. */
export type ListFilters<Options> = Readonly<Record<string, {
  [Property in keyof Options & string]-?: {
    readonly schema: z.ZodType<Options[Property]>;
    readonly property: Property;
    readonly serialization: FilterSerialization;
  }
}[keyof Options & string]>>;

type PathShape<Path extends PathDefinitions> = { [Name in keyof Path]: Path[Name]['schema'] };
type FilterShape<Filters extends FilterDefinitions> = { [Name in keyof Filters]: Filters[Name]['schema'] };
type ProjectedFilters<Filters extends FilterDefinitions> = {
  [Name in keyof Filters as Filters[Name]['property']]?: Exclude<z.output<Filters[Name]['schema']>, undefined>;
};
type PageOptions<Filters extends FilterDefinitions, Kind extends ListKind> = ProjectedFilters<Filters>
  & (Kind extends 'controlled' ? { limit: number; offset: number } : object);
type AllOptions<Filters extends FilterDefinitions, Kind extends ListKind> = ProjectedFilters<Filters> & {
  maxItems: number; maxPages: number; maxBytes: number; maxDurationMs: number;
} & (Kind extends 'controlled' ? { pageSize?: number; startOffset?: number } : object);
interface ListBinding<Binding extends DriverBinding, Input extends object, Options> {
  readonly binding: Binding;
  readonly call: (method: DriverMethod<Binding>, input: Input, options: Options) => Promise<unknown>;
}

interface Controls {
  readonly pagination?: 'page' | 'all';
  readonly page_size?: number;
  readonly start_offset?: number;
  readonly max_items?: number;
  readonly max_pages?: number;
  readonly max_bytes?: number;
  readonly max_duration_ms?: number;
}

const aggregateBounds = [
  ['max_items', 'maxItems', 'max_all_items'],
  ['max_pages', 'maxPages', 'max_all_pages'],
  ['max_bytes', 'maxBytes', 'max_all_bytes'],
  ['max_duration_ms', 'maxDurationMs', 'max_all_duration_ms'],
] as const satisfies readonly (readonly [keyof Controls, string, keyof Limits])[];
const controlledBounds = [['page_size', 'pageSize'], ['start_offset', 'startOffset']] as const;
const reservedProperties = new Set([
  'limit', 'offset', ...controlledBounds.map(([, property]) => property),
  ...aggregateBounds.map(([, property]) => property),
]);

/** Input validation precedes these reads, including on standalone binding calls. */
function controls(input: unknown): Controls {
  if (typeof input !== 'object' || input === null) return {};
  const mcp = (input as { _mcp?: unknown })._mcp;
  return typeof mcp === 'object' && mcp !== null && !Array.isArray(mcp) ? mcp : {};
}

/** Schema ceilings are fixed at registration; operator limits may be lower. */
function refuseBoundsAboveLimits(stated: Controls, limits: Limits): void {
  for (const [input, , limit] of aggregateBounds) {
    const value = stated[input];
    if (value !== undefined && value > limits[limit]) throw new AdapterError('INVALID_ARGUMENT');
  }
}

const pageResponse = z.object({ kind: z.enum(['envelope', 'legacy-array']), items: z.array(z.unknown()) });

/** Own list authoring, projection and mappings without inferring driver names. */
export function createListDefinition<
  const Kind extends ListKind,
  const Path extends PathDefinitions = Record<never, never>,
  const Filters extends FilterDefinitions = Record<never, never>,
>(definition: {
  readonly pagination: Kind;
  readonly path?: Path;
  readonly filters?: Filters;
  readonly optionsArgument: number;
  readonly entitySchema: z.ZodType | null;
}) {
  const kind = definition.pagination;
  const optionsArgument = definition.optionsArgument;
  const paths = Object.entries(definition.path ?? {}).map(([input, { schema, argument }]) => ({ input, schema, argument }));
  const filters = Object.entries(definition.filters ?? {}).map(([input, { schema, property, serialization }]) => ({ input, schema, property, serialization }));
  if (optionsArgument !== paths.length || paths.some(({ argument }) => !Number.isInteger(argument) || argument < 0 || argument >= optionsArgument)
      || new Set(paths.map(({ argument }) => argument)).size !== paths.length) {
    throw new Error('List paths must occupy distinct arguments before the options argument');
  }
  const properties = new Set<string>();
  for (const { property, serialization } of filters) {
    if (properties.has(property) || reservedProperties.has(property)) throw new Error('List filter property conflicts with another filter or paging control');
    if (!['query-scalar', 'query-list', 'query-repeated'].includes(serialization)) throw new Error('Invalid list filter serialization');
    properties.add(property);
  }
  // These owned entries are never exposed: later edits to declaration objects
  // cannot change projection independently of the captured input and mappings.
  const inputSchema = createListInput<PathShape<Path>, FilterShape<Filters>, Kind>({
    path: Object.fromEntries(paths.map(({ input, schema }) => [input, schema])) as PathShape<Path>,
    query: Object.fromEntries(filters.map(({ input, schema }) => [input, schema])) as FilterShape<Filters>,
    pagination: kind,
  });
  type Input = z.output<typeof inputSchema>;
  const mappings: ArgumentMapping[] = [];
  for (const call of ['page', 'all'] as const) {
    for (const { input, argument } of paths) mappings.push({ input, call, argument, serialization: 'path' });
    for (const { input, property, serialization } of filters) {
      mappings.push({ input: `query.${input}`, call, argument: optionsArgument, property, serialization });
    }
    if (call === 'page' && kind === 'controlled') {
      for (const property of ['limit', 'offset']) {
        mappings.push({ input: `query.${property}`, call, argument: optionsArgument, property, serialization: 'query-scalar' });
      }
    }
    if (call === 'all') {
      for (const [input, property] of [...(kind === 'controlled' ? controlledBounds : []), ...aggregateBounds]) {
        mappings.push({ input: `_mcp.${input}`, call, argument: optionsArgument, property, serialization: 'aggregate-control' });
      }
    }
  }
  const argumentMap = Object.freeze(mappings.map((mapping) => Object.freeze(mapping)));
  const response = Object.freeze({ shape: 'page', outerSchema: pageResponse, entitySchema: definition.entitySchema } as const satisfies ResponseContract);

  function project(input: Input): Record<string, unknown> {
    const query: Record<string, unknown> | undefined = input.query;
    return Object.fromEntries(filters.filter(({ input: name }) => query?.[name] !== undefined)
      .map(({ input: name, property }) => [property, query?.[name]]));
  }

  return Object.freeze({
    bind<const PageBinding extends DriverBinding, const AllBinding extends DriverBinding>(bindings: {
      readonly page: ListBinding<PageBinding, Input, PageOptions<Filters, Kind>>;
      readonly all: ListBinding<AllBinding, Input, AllOptions<Filters, Kind>>;
    }) {
      // Capture callback identity as well as filter declarations before registration.
      const pageBinding = { ...bindings.page };
      const allBinding = { ...bindings.all };
      return {
        inputSchema, argumentMap, response,
        pagination(bind: DriverCallBinder<Input>): Pagination {
          const page = bind(pageBinding.binding, (method, input) => {
            const query = input.query as { limit?: number; offset?: number } | undefined;
            const options = { ...project(input), ...(kind === 'controlled'
              ? { limit: query?.limit ?? DEFAULT_PAGE_SIZE, offset: query?.offset ?? 0 } : {}) };
            return pageBinding.call(method, input, options as PageOptions<Filters, Kind>);
          });
          const all = bind(allBinding.binding, (method, input, context) => {
            const stated = controls(input);
            const options = {
              ...project(input),
              ...Object.fromEntries((kind === 'controlled' ? controlledBounds : [])
                .filter(([name]) => stated[name] !== undefined).map(([name, property]) => [property, stated[name]])),
              ...Object.fromEntries(aggregateBounds.map(([name, property, limit]) => [property, stated[name] ?? context.limits[limit]])),
            };
            return allBinding.call(method, input, options as AllOptions<Filters, Kind>);
          });
          return Object.freeze({
            kind: kind === 'controlled' ? 'controlled' : 'response_driven',
            page,
            all: Object.freeze({
              ...all,
              async invoke(client, input, context) {
                // Standalone calls must enforce configured bounds before lookup too.
                all.input.validate(input);
                refuseBoundsAboveLimits(controls(input), context.limits);
                return all.invoke(client, input, context);
              },
            } satisfies DriverCall),
          });
        },
      };
    },
  });
}

export interface ListResult {
  readonly data: unknown;
  readonly pagination: object;
}

/** Select and bound a call before admission; interpret its reply after acknowledgement. */
export function prepareListCall(
  pagination: Exclude<Pagination, { kind: 'none' }>,
  outerSchema: z.ZodType,
  input: unknown,
  limits: Limits,
): { readonly mode: 'page' | 'all'; readonly call: DriverCall; readonly result: (value: unknown) => ListResult } {
  const mode = controls(input).pagination === 'all' ? 'all' : 'page';
  if (mode === 'all') refuseBoundsAboveLimits(controls(input), limits);
  return {
    mode,
    call: pagination[mode],
    result(value) {
      if (mode === 'page') {
        validateOuter(outerSchema, value);
        if (typeof value !== 'object' || value === null || !Array.isArray((value as { items?: unknown }).items)) {
          throw new AdapterError('INVALID_RESPONSE');
        }
        const page = value as Page<unknown>;
        return { data: page.items, pagination: pageMetadata(page, { responseDriven: pagination.kind === 'response_driven' }) };
      }
      if (!Array.isArray(value)) throw new AdapterError('INVALID_RESPONSE');
      return {
        data: value,
        pagination: aggregateMetadata(value, pagination.kind === 'response_driven'
          ? {} : { startOffset: controls(input).start_offset ?? 0 }),
      };
    },
  };
}
