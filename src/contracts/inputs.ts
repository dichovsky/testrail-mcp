import {
  DeleteCasesPayloadSchema,
  EditResultPayloadSchema,
} from '@dichovsky/testrail-api-client';
import { specTypeSchemas, type Tool } from '@modelcontextprotocol/server';
import { z } from 'zod';

/** Domains are deliberately composed per endpoint: body IDs may allow 0/null. */
export const positiveIdSchema = z.number().int().positive();
export const nonnegativeIntegerSchema = z.number().int().nonnegative();

// Match the public driver's UUID contract, which accepts every hex UUID layout
// without imposing UUID version or variant bits. Numeric attachment strings are
// rejected by the public driver; CLI-only normalization is not an API feature.
export const entryIdSchema = z.string().regex(
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(?![\s\S])/u,
);
export const attachmentIdSchema = z.union([positiveIdSchema, entryIdSchema]);
export const refsSchema = z.union([z.string(), z.array(z.string())]);
/** One identifier or several. The driver joins a list with commas and would drop an empty one. */
export const idFilterSchema = z.union([positiveIdSchema, z.array(positiveIdSchema).min(1)]);
/** A non-empty list of case identifiers, as every bulk case endpoint requires. */
export const caseIdsSchema = z.array(positiveIdSchema).min(1);
export const jsonValueSchema = z.json();

// eslint-disable-next-line no-control-regex -- Control bytes must be excluded from multipart names.
export const filenameSchema = z.string().regex(/^(?!\.{1,2}$)(?![a-zA-Z]:)[^/\\\x00-\x1f\x7f-\x9f]+(?![\s\S])/u);
export const bddFilenameSchema = filenameSchema.regex(/\.feature(?![\s\S])/u);

// RFC token type/subtype and optional token/quoted parameter values. A slash is
// valid in a media type and in a quoted parameter, never in a filename.
const mediaToken = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";
const quotedValue = '"(?:[\\x20-\\x21\\x23-\\x5b\\x5d-\\x7e]|\\\\[\\x20-\\x7e])*"';
export const contentTypeSchema = z.string().regex(new RegExp(
  `^${mediaToken}/${mediaToken}(?: *; *${mediaToken} *= *(?:${mediaToken}|${quotedValue}))*(?![\\s\\S])`, 'u',
));

/** Host-specific absolute-path checks and authority belong to the file layer. */
// eslint-disable-next-line no-control-regex -- Control bytes are never valid path inputs here.
export const filePathSchema = z.string().min(1).regex(/^[^\x00-\x1f\x7f-\x9f]+(?![\s\S])/u);

export function strictObject<Shape extends InputShape>(shape: Shape) {
  return z.strictObject(shape);
}

export type InputShape = Record<string, z.ZodType>;

type PayloadOptions<Fields extends InputShape> = {
  /** Explicit endpoint extension policy; nested objects remain strict. */
  extensions?: 'custom' | 'json';
  /** Explicit field replacements for endpoint domains and nested extensions. */
  fields?: Fields;
};

type PayloadOutput<Source extends z.ZodType, Fields extends InputShape> =
  Source extends z.ZodObject<infer Shape>
    ? z.output<z.ZodObject<Omit<Shape, keyof Fields> & Fields>> & Record<string, unknown>
    : z.output<Source>;

// Zod cannot infer JSON Schema for arbitrary custom checks. These two checks in
// the pinned driver's payloads have reviewed structural equivalents below.
const representedRefinements = new WeakMap<z.core.$ZodCheck, Record<string, unknown>>();

function customChecks(schema: z.ZodType): z.core.$ZodCheck[] {
  return schema.def.checks?.filter((check) => check._zod.def.check === 'custom') ?? [];
}

function refinementIsRepresented(check: z.core.$ZodCheck, schema: z.ZodType): boolean {
  const required = representedRefinements.get(check);
  if (required === undefined) return false;
  const metadata = schema.meta() ?? {};
  return Object.entries(required).every(([key, expected]) => JSON.stringify(metadata[key]) === JSON.stringify(expected));
}

function classic(schema: z.core.$ZodType): z.ZodType {
  if (!(schema instanceof z.ZodType)) throw new Error('Input schemas require Zod classic types');
  return schema;
}

function hasCustomCheck(schema: z.ZodType): boolean {
  return customChecks(schema).length !== 0;
}

/**
 * Reuse driver fields and checks while rejecting undeclared ordinary fields at
 * every object depth. Documented records remain open with their declared value
 * domain, and `unknown` becomes JSON rather than accepting functions/undefined.
 * Fields such as sentinel IDs are only tightened by explicit `fields` entries.
 * For bulk arrays, use payloadArray with a separately adapted item schema.
 */
export function payloadInput<Source extends z.ZodType, Fields extends InputShape = Record<never, never>>(
  source: Source,
  options: PayloadOptions<Fields> = {},
): z.ZodType<PayloadOutput<Source, Fields>> {
  if (options.fields !== undefined && !(source instanceof z.ZodObject)) {
    throw new Error('Payload field overrides require an object schema');
  }
  if (options.extensions !== undefined && !(source instanceof z.ZodObject)) {
    throw new Error('Payload extensions require an object schema');
  }
  // Structural adaptation retains the source output fields except the explicit
  // replacements. Its additional checks only narrow accepted values.
  return adaptPayload(source, options) as z.ZodType<PayloadOutput<Source, Fields>>;
}

function adaptPayload(source: z.ZodType, options: PayloadOptions<InputShape> = {}): z.ZodType {
  if (hasCustomCheck(source) && source !== DeleteCasesPayloadSchema && source !== EditResultPayloadSchema) {
    throw new Error('Payload contains a refinement without a reviewed JSON Schema equivalent');
  }
  if (source instanceof z.ZodObject) {
    const shape: InputShape = Object.fromEntries(
      Object.entries(source.shape as Record<string, unknown>).map(([key, field]) => {
        if (!(field instanceof z.ZodType)) throw new Error('Payload fields require Zod classic types');
        return [key, adaptPayload(field)];
      }),
    );
    Object.assign(shape, options.fields);
    let object: z.ZodType = source.clone({
      ...source.def,
      shape,
      catchall: options.extensions === undefined ? z.never() : jsonValueSchema,
    });
    if (source === EditResultPayloadSchema) {
      // The driver's existing refinement rejects empty edit payloads. JSON
      // Schema minProperties describes the identical rule, including custom_*.
      object = object.meta({ minProperties: 1 });
      for (const check of customChecks(source)) representedRefinements.set(check, { minProperties: 1 });
    }
    if (source === DeleteCasesPayloadSchema) {
      // Retain parity even when an explicit open-object policy or field override
      // would otherwise advertise `soft`: the driver always rejects body.soft.
      const forbidden = { required: ['soft'] };
      object = object.meta({ not: forbidden });
      for (const check of customChecks(source)) representedRefinements.set(check, { not: forbidden });
    }
    if (options.extensions === 'custom') {
      const names = new Set(Object.keys(shape));
      const customName = /^custom_[\s\S]+/u;
      // Zod 4.6 intersections intentionally suppress a record key rejection
      // when the other branch owns that key, unlike JSON Schema allOf. Pair
      // this check directly with propertyNames instead of such an intersection.
      const metadata = object.meta() ?? {};
      const propertyNames = { anyOf: [{ enum: [...names] }, { pattern: customName.source }] };
      object = object.refine((value) => Object.keys(value as object).every(
        (name) => names.has(name) || customName.test(name),
      )).meta({
        ...metadata,
        propertyNames,
      });
      const customCheck = customChecks(object).at(-1);
      if (customCheck === undefined) throw new Error('Custom property check was not created');
      representedRefinements.set(customCheck, { propertyNames });
    }
    return object;
  }
  if (source instanceof z.ZodArray) {
    return source.clone({ ...source.def, element: adaptPayload(classic(source.element)) });
  }
  if (source instanceof z.ZodOptional) {
    return source.clone({ ...source.def, innerType: adaptPayload(classic(source.unwrap())) });
  }
  if (source instanceof z.ZodNullable) {
    return source.clone({ ...source.def, innerType: adaptPayload(classic(source.unwrap())) });
  }
  if (source instanceof z.ZodUnion) {
    return source.clone({ ...source.def, options: source.options.map((option) => adaptPayload(option as z.ZodType)) });
  }
  if (source instanceof z.ZodRecord) {
    return source.clone({ ...source.def, valueType: adaptPayload(classic(source.valueType)) });
  }
  if (source instanceof z.ZodUnknown || source instanceof z.ZodAny) return jsonValueSchema;
  return source;
}

/** Preserve the driver's original array bounds while replacing its item schema. */
export function payloadArray<Item extends z.ZodType>(source: z.ZodArray, item: Item): z.ZodArray<Item> {
  if (hasCustomCheck(source)) throw new Error('Array refinement needs a JSON Schema equivalent');
  return source.clone({ ...source.def, element: item }) as z.ZodArray<Item>;
}

export const aggregateLimitDefaults = Object.freeze({
  max_items: 1_000,
  max_pages: 20,
  max_bytes: 1_048_576,
  max_duration_ms: 45_000,
});

export const aggregateLimitCeilings = Object.freeze({
  max_items: 10_000,
  max_pages: 100,
  max_bytes: 8_388_608,
  max_duration_ms: 45_000,
});

export type AggregateInputLimits = {
  [Key in keyof typeof aggregateLimitDefaults]: number;
};

type PaginationKind = 'controlled' | 'response-driven';
type ListInputOptions<Path extends InputShape, Query extends InputShape, Mode extends PaginationKind> = {
  path?: Path;
  query?: Query;
  pagination: Mode;
  limits?: AggregateInputLimits;
};

type PageControls = { limit?: number | undefined; offset?: number | undefined };
type AllControls = { page_size?: number | undefined; start_offset?: number | undefined };
type AllSafety = { [Key in keyof AggregateInputLimits]?: number | undefined };
type ShapeOutput<Shape extends InputShape> = z.output<z.ZodObject<Shape>>;
type ListOutput<Path extends InputShape, Query extends InputShape, Mode extends PaginationKind> = ShapeOutput<Path> & (
  | {
    query?: (ShapeOutput<Query> & (Mode extends 'controlled' ? PageControls : object)) | undefined;
    _mcp?: { pagination: 'page' } | undefined;
  }
  | {
    query?: (ShapeOutput<Query> & (Mode extends 'controlled' ? { limit?: never; offset?: never } : object)) | undefined;
    _mcp: { pagination: 'all' } & AllSafety & (Mode extends 'controlled' ? AllControls : object);
  }
);

/** No defaults are inserted: runtime adapters choose effective paging values. */
export function createListInput<
  Path extends InputShape = Record<never, never>,
  Query extends InputShape = Record<never, never>,
  Mode extends PaginationKind = PaginationKind,
>(options: ListInputOptions<Path, Query, Mode>): z.ZodType<ListOutput<Path, Query, Mode>> {
  const path = options.path ?? {};
  const filters = options.query ?? {};
  for (const reserved of ['query', '_mcp']) {
    if (Object.hasOwn(path, reserved)) throw new Error('List path contains a reserved field');
  }
  if (Object.hasOwn(filters, 'limit') || Object.hasOwn(filters, 'offset')) {
    throw new Error('List filters must not redefine pagination controls');
  }
  const limits = options.limits ?? aggregateLimitDefaults;
  const safety: InputShape = {};
  for (const key of Object.keys(aggregateLimitDefaults) as (keyof AggregateInputLimits)[]) {
    const maximum = limits[key];
    if (!Number.isSafeInteger(maximum) || maximum <= 0 || maximum > aggregateLimitCeilings[key]) {
      throw new Error('Invalid aggregate input limit');
    }
    safety[key] = positiveIdSchema.max(maximum).optional();
  }
  const pageControls = options.pagination === 'controlled'
    ? { limit: positiveIdSchema.max(250).optional(), offset: nonnegativeIntegerSchema.optional() }
    : {};
  const allControls = options.pagination === 'controlled'
    ? { page_size: positiveIdSchema.max(250).optional(), start_offset: nonnegativeIntegerSchema.optional() }
    : {};
  const schema = z.union([
    strictObject({
      ...path,
      query: strictObject({ ...filters, ...pageControls }).optional(),
      _mcp: strictObject({ pagination: z.literal('page') }).optional(),
    }),
    strictObject({
      ...path,
      query: strictObject(filters).optional(),
      _mcp: strictObject({ pagination: z.literal('all'), ...allControls, ...safety }),
    }),
  ]);
  // The construction branches on runtime mode, while callers retain their
  // literal mode and original path/filter field types in the output union.
  return schema as unknown as z.ZodType<ListOutput<Path, Query, Mode>>;
}

function children(schema: z.ZodType): z.ZodType[] {
  if (schema instanceof z.ZodObject) {
    return [
      ...Object.values(schema.shape).map(classic),
      ...(schema.def.catchall === undefined ? [] : [schema.def.catchall as z.ZodType]),
    ];
  }
  if (schema instanceof z.ZodArray) return [classic(schema.element)];
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable || schema instanceof z.ZodNonOptional) {
    return [classic(schema.unwrap())];
  }
  if (schema instanceof z.ZodUnion) return schema.options as z.ZodType[];
  if (schema instanceof z.ZodIntersection) return [schema.def.left as z.ZodType, schema.def.right as z.ZodType];
  if (schema instanceof z.ZodRecord) return [classic(schema.keyType), classic(schema.valueType)];
  if (schema instanceof z.ZodLazy) return [classic(schema.unwrap())];
  return [];
}

const annotationMetadata = new Set([
  'title', 'description', 'examples', 'deprecated', 'readOnly', 'writeOnly', '$comment',
]);

/** Generate SDK-compatible object schemas without silently dropping refinements. */
export function inputJsonSchema(schema: z.ZodType<object>): Tool['inputSchema'] {
  const seen = new Set<z.ZodType>();
  function visit(current: z.ZodType): void {
    if (seen.has(current)) return;
    seen.add(current);
    if (customChecks(current).some((check) => !refinementIsRepresented(check, current))) {
      throw new Error('Input refinement has no reviewed JSON Schema equivalent');
    }
    for (const [key, value] of Object.entries(current.meta() ?? {})) {
      if (!annotationMetadata.has(key) && !customChecks(current).some((check) => {
        const reviewed = representedRefinements.get(check);
        return reviewed !== undefined && Object.hasOwn(reviewed, key)
          && JSON.stringify(reviewed[key]) === JSON.stringify(value);
      })) {
        throw new Error(`Input metadata has no reviewed JSON Schema equivalent: ${key}`);
      }
    }
    for (const definition of [current.def, ...(current.def.checks ?? []).map((check) => check._zod.def)]) {
      // JSON Schema carries pattern.source only; the SDK validator uses Unicode
      // matching. Require that exact mode rather than changing runtime patterns.
      if ('pattern' in definition && definition.pattern instanceof RegExp && definition.pattern.flags !== 'u') {
        throw new Error('Input regex patterns require only the Unicode u flag for JSON Schema parity');
      }
      // Zod's floating-point tolerance differs from Ajv for both fractional
      // divisors and large integer values, including within safe-integer bounds.
      if ('check' in definition && definition.check === 'multiple_of') {
        throw new Error('Input multipleOf has no reviewed JSON Schema equivalent');
      }
    }
    if ('coerce' in current.def && current.def.coerce === true) {
      throw new Error('Input coercion is not supported');
    }
    if (current instanceof z.ZodDefault || current instanceof z.ZodPrefault || current instanceof z.ZodCatch) {
      throw new Error('Input defaults and recovery transforms are not supported');
    }
    if (current.def.checks?.some((check) => check._zod.def.check === 'overwrite')) {
      throw new Error('Input transforms are not supported');
    }
    if (current instanceof z.ZodIntersection) {
      throw new Error('Input intersections have different Zod and JSON Schema key semantics');
    }
    if (current instanceof z.ZodObject && (
      current.def.catchall === undefined
      || current.def.catchall instanceof z.ZodUnknown
      || current.def.catchall instanceof z.ZodAny
    )) {
      throw new Error('Input objects must explicitly reject unknown keys or validate JSON extensions');
    }
    if (![
      'object', 'array', 'optional', 'nullable', 'nonoptional', 'union',
      'record', 'lazy', 'string', 'number', 'boolean', 'literal', 'enum', 'null', 'never',
    ].includes(current.def.type)) {
      throw new Error('Input schema type may transform values or lack JSON Schema parity');
    }
    children(current).forEach(visit);
  }
  visit(schema);
  // Put type beside anyOf/allOf rather than wrapping definitions, so recursive
  // JSON-value references retain their original document-root resolution.
  const inputSchema = { ...z.toJSONSchema(schema, { io: 'input', target: 'draft-07' }), type: 'object' as const };
  const checked = specTypeSchemas.Tool['~standard'].validate({ name: 'input-schema-check', inputSchema });
  if (checked.issues !== undefined) throw new Error('Input JSON Schema is not an SDK tool schema');
  return checked.value.inputSchema;
}
