import {
  AddCasePayloadSchema,
  AddCasesBulkPayloadSchema,
  AddDatasetPayloadSchema,
  AddPlanPayloadSchema,
  AddResultPayloadSchema,
  DeleteCasesPayloadSchema,
  DynamicFiltersPayloadSchema,
  EditResultPayloadSchema,
  MoveSectionPayloadSchema,
  UpdateProjectUserAssignmentPayloadSchema,
  UserAddPayloadSchema,
  UserUpdatePayloadSchema,
  type TestRailClient,
} from '@dichovsky/testrail-api-client';
import type { JsonSchemaType } from '@modelcontextprotocol/server';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/server/validators/ajv';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import {
  aggregateLimitCeilings,
  aggregateLimitDefaults,
  attachmentIdSchema,
  bddFilenameSchema,
  contentTypeSchema,
  createListInput,
  entryIdSchema,
  filenameSchema,
  filePathSchema,
  inputJsonSchema,
  nonnegativeIntegerSchema,
  payloadArray,
  payloadInput,
  positiveIdSchema,
  refsSchema,
  strictObject,
  emailSchema,
} from '../src/contracts/inputs.js';

const validator = new AjvJsonSchemaValidator();
const uuid = '3933d74b-4282-0000-0000-f4faaf144175';

/** Expectations are explicit cases, validated independently by Zod and AJV. */
function acceptsBoth(schema: z.ZodType<object>, valid: object[], invalid: unknown[]): void {
  const jsonSchema = inputJsonSchema(schema);
  expect(jsonSchema.type).toBe('object');
  const validateJson = validator.getValidator(jsonSchema as unknown as JsonSchemaType);
  for (const value of valid) {
    expect(schema.safeParse(value).success, JSON.stringify(value)).toBe(true);
    expect(validateJson(value).valid, JSON.stringify(value)).toBe(true);
    expect(schema.parse(value)).toEqual(value);
  }
  for (const value of invalid) {
    expect(schema.safeParse(value).success, JSON.stringify(value)).toBe(false);
    expect(validateJson(value).valid, JSON.stringify(value)).toBe(false);
  }
}

describe('endpoint input domains', () => {
  it('preserves safe numeric IDs and the driver UUID layout without coercion', () => {
    acceptsBoth(strictObject({ case_id: positiveIdSchema, entry_id: entryIdSchema, attachment_id: attachmentIdSchema }), [
      { case_id: 1, entry_id: uuid, attachment_id: 2 },
      { case_id: Number.MAX_SAFE_INTEGER, entry_id: uuid.toUpperCase(), attachment_id: uuid },
    ], [
      { case_id: 0, entry_id: uuid, attachment_id: 2 },
      { case_id: 1.5, entry_id: uuid, attachment_id: 2 },
      { case_id: Number.MAX_SAFE_INTEGER + 1, entry_id: uuid, attachment_id: 2 },
      { case_id: '1', entry_id: uuid, attachment_id: 2 },
      { case_id: 1, entry_id: 123, attachment_id: 2 },
      { case_id: 1, entry_id: `${uuid}\n`, attachment_id: 2 },
      { case_id: 1, entry_id: '../../plan', attachment_id: 2 },
      { case_id: 1, entry_id: uuid, attachment_id: '2' },
      { case_id: 1, entry_id: uuid, attachment_id: null },
    ]);
  });

  it('composes sentinel zero and null per field and preserves omission', () => {
    const schema = strictObject({
      role_id: nonnegativeIntegerSchema.nullable().optional(),
      query: strictObject({ refs: refsSchema.optional() }).optional(),
    });
    acceptsBoth(schema, [
      {}, { role_id: 0 }, { role_id: null }, { role_id: 1 },
      { query: { refs: 'REQ-1,REQ-2' } }, { query: { refs: ['REQ-1', 'REQ-2'] } }, { query: { refs: [] } },
    ], [
      { role_id: -1 }, { role_id: 0.5 }, { query: { refs: [1] } },
      { query: { refs: null } }, { query: { refs: 'REQ-1', unknown: 1 } }, { unexpected: 1 },
    ]);
    expect(Object.hasOwn(schema.parse({}), 'role_id')).toBe(false);
    expect(Object.hasOwn(schema.parse({ role_id: null }), 'role_id')).toBe(true);
  });

  it('keeps multipart filename rules separate from media types', () => {
    acceptsBoth(strictObject({ file_path: filePathSchema, filename: filenameSchema, content_type: contentTypeSchema }), [
      { file_path: '/tmp/test file.txt', filename: 'test file.txt', content_type: 'text/plain' },
      { file_path: 'C:\\upload\\file', filename: 'result.json', content_type: 'application/json; charset=utf-8' },
      { file_path: '/tmp/file', filename: 'é.txt', content_type: 'text/plain; profile="https://example.test/a"' },
      { file_path: '/tmp/📄', filename: '📄.txt', content_type: 'text/plain' },
    ], [
      { file_path: '/tmp/file', filename: '../file', content_type: 'text/plain' },
      { file_path: '/tmp/file', filename: 'a\\b', content_type: 'text/plain' },
      { file_path: '/tmp/file', filename: 'C:file', content_type: 'text/plain' },
      { file_path: '/tmp/file', filename: '.', content_type: 'text/plain' },
      { file_path: '/tmp/file', filename: '..', content_type: 'text/plain' },
      { file_path: '/tmp/file', filename: 'file\n', content_type: 'text/plain' },
      // DEL and the C1 control range, not only the C0 controls.
      { file_path: '/tmp/file', filename: 'file\u007f', content_type: 'text/plain' },
      { file_path: '/tmp/file', filename: 'file\u0085', content_type: 'text/plain' },
      { file_path: '/tmp/file', filename: 'file\u009f', content_type: 'text/plain' },
      { file_path: '/tmp/file', filename: 'file', content_type: 'text/plain\n' },
      { file_path: '/tmp/file', filename: 'file', content_type: 'text/plain\r\nx-test: value' },
      { file_path: '/tmp/file', filename: 'file', content_type: 'text/plain; charset="utf\u0000-8"' },
      // DEL and the C1 range in a media type too, in the type and in a quoted value.
      { file_path: '/tmp/file', filename: 'file', content_type: 'text/plain\u007f' },
      { file_path: '/tmp/file', filename: 'file', content_type: 'text/pla\u0085in' },
      { file_path: '/tmp/file', filename: 'file', content_type: 'text/plain; a="x\u009f"' },
      { file_path: '/tmp/file', filename: 'file', content_type: 'text' },
      { file_path: '/tmp/file', filename: 'file', content_type: '/plain' },
      { file_path: '/tmp/file', filename: 'file', content_type: 'text/plain; bad' },
      { file_path: '/tmp/file\u0000', filename: 'file', content_type: 'text/plain' },
    ]);
    acceptsBoth(strictObject({ filename: bddFilenameSchema }), [{ filename: 'test.feature' }], [
      { filename: 'test.txt' }, { filename: '../test.feature' }, { filename: 'test.feature\n' },
    ]);
  });
});

describe('faithful input schema export', () => {
  it.each([
    ['case-insensitive', /^abc$/iu, 'ABC'],
    ['multiline', /^abc$/mu, 'before\nabc\nafter'],
    ['dot-all', /^a.b$/su, 'a\nb'],
    ['global', /abc/gu, 'abc'],
    ['sticky', /abc/uy, 'abc'],
    ['match indices', /abc/du, 'abc'],
    ['Unicode sets', new RegExp('^abc$', 'v'), 'abc'],
  ] as const)('rejects %s regex flags that JSON Schema cannot carry', (_label, pattern, value) => {
    const schema = strictObject({ body: strictObject({ value: z.string().regex(pattern) }).optional() });
    expect(schema.safeParse({ body: { value } }).success).toBe(true);
    expect(() => inputJsonSchema(schema)).toThrow('regex patterns require only the Unicode u flag');
  });

  it('requires explicit Unicode mode rather than silently changing code-unit matching', () => {
    const schema = strictObject({ value: z.string().regex(/^.$/) });
    expect(schema.safeParse({ value: '😀' }).success).toBe(false);
    expect(() => inputJsonSchema(schema)).toThrow('regex patterns require only the Unicode u flag');
    acceptsBoth(strictObject({ value: z.string().regex(/^.$/u) }), [{ value: 'a' }, { value: '😀' }], [{ value: 'ab' }, { value: '' }]);
    acceptsBoth(strictObject({ value: z.string().regex(/^abc$/u) }), [{ value: 'abc' }], [{ value: 'ABC' }]);
  });

  it('checks patterns on standalone string formats and adapted driver fields', () => {
    expect(() => inputJsonSchema(strictObject({ value: z.email({ pattern: /^abc$/iu }) }))).toThrow('regex patterns');
    const source = z.object({ email: z.string().regex(/^abc$/i) });
    expect(() => inputJsonSchema(strictObject({ body: payloadInput(source) }))).toThrow('regex patterns');
    acceptsBoth(strictObject({ body: payloadInput(source, { fields: { email: z.string().regex(/^[aA][bB][cC]$/u) } }) }), [
      { body: { email: 'abc' } }, { body: { email: 'ABC' } },
    ], [{ body: { email: 'def' } }]);
    // Adapting an endpoint must not rewrite the public driver's original schema.
    expect(source.safeParse({ email: 'ABC' }).success).toBe(true);
  });

  it.each([
    ['fractional divisor', z.number().multipleOf(0.1), 0.3],
    ['unsafe integer value', z.number().multipleOf(3), 9_007_199_254_740_992],
    ['large integral multiple', z.number().multipleOf(1), 1e25],
    ['safe integer tolerance', z.number().int().multipleOf(2), Number.MAX_SAFE_INTEGER],
  ] as const)('rejects multipleOf with unreviewed numerical parity: %s', (_label, field, value) => {
    const schema = strictObject({ value: field });
    expect(schema.safeParse({ value }).success).toBe(true);
    expect(() => inputJsonSchema(schema)).toThrow('multipleOf has no reviewed JSON Schema equivalent');
  });

  it('rejects metadata that changes structural validation or reference resolution', () => {
    const widened = strictObject({ value: z.string().max(1).meta({ maxLength: 4 }) });
    expect(widened.safeParse({ value: 'abc' }).success).toBe(false);
    expect(() => inputJsonSchema(widened)).toThrow('metadata has no reviewed JSON Schema equivalent: maxLength');
    for (const metadata of [
      { pattern: '^anything$' }, { anyOf: [{ type: 'number' }] }, { type: 'number' },
      { $ref: '#/anything' }, { id: 'replacement' }, { minimum: 1 }, { default: 'a' },
    ]) {
      expect(() => inputJsonSchema(strictObject({ value: z.string().meta(metadata) }))).toThrow('metadata has no reviewed JSON Schema equivalent');
    }
    expect(() => inputJsonSchema(strictObject({ value: z.string() }).meta({ additionalProperties: true }))).toThrow('metadata has no reviewed JSON Schema equivalent');
  });

  it('retains annotations and only the structural metadata tied to reviewed refinements', () => {
    const schema = strictObject({ value: z.string().max(1).meta({
      title: 'Value', description: 'A short value.', examples: ['a'],
      deprecated: false, readOnly: false, writeOnly: false, $comment: 'An annotation.',
    }) });
    acceptsBoth(schema, [{ value: 'a' }], [{ value: 'abc' }, {}]);
    expect(inputJsonSchema(schema).properties?.value).toMatchObject({ title: 'Value', description: 'A short value.', maxLength: 1 });
    const reviewed = payloadInput(EditResultPayloadSchema, { extensions: 'custom' }).describe('Correct a result.');
    acceptsBoth(strictObject({ body: reviewed }), [{ body: { custom_value: 0 } }], [{ body: {} }, { body: { unexpected: 1 } }]);
    expect(() => inputJsonSchema(strictObject({ body: reviewed.meta({ ...reviewed.meta(), maxProperties: 3 }) }))).toThrow('metadata has no reviewed JSON Schema equivalent: maxProperties');
  });
});

describe('strict reuse of public driver payload schemas', () => {
  it('retains known fields, flat custom JSON and explicit endpoint constraints', () => {
    const casePayload = payloadInput(AddCasePayloadSchema, {
      extensions: 'custom',
      fields: { title: AddCasePayloadSchema.shape.title.min(1), priority_id: positiveIdSchema.optional() },
    });
    const schema = strictObject({ body: casePayload });
    const custom = {
      custom_note: 'note', custom_steps: [{ content: 'one', expected: ['a', null] }],
      custom_null: null, custom_zero: 0, custom_flag: false,
    };
    acceptsBoth(schema, [
      { body: { title: 'Case', ...custom } },
      { body: { title: 'Case', priority_id: 2, labels: [1, 'label'], is_legacy: false } },
    ], [
      { body: { title: '' } }, { body: { title: 'Case', priority_id: 0 } },
      { body: { title: 'Case', unexpected: true } }, { body: { title: 'Case', custom_: 1 } },
      { body: { title: null } }, { body: { title: 'Case', labels: [false] } }, { body: {} },
    ]);
    for (const value of [undefined, () => 1, Symbol('x'), 1n, Infinity, NaN, new Date()]) {
      expect(schema.safeParse({ body: { title: 'Case', custom_value: value } }).success).toBe(false);
      expect(schema.safeParse({ body: { title: 'Case', custom_value: { nested: value } } }).success).toBe(false);
    }
    // The original driver schema remains untouched and permissive.
    expect(AddCasePayloadSchema.safeParse({ title: '', unexpected: true }).success).toBe(true);
  });

  it('rejects nested ordinary fields while preserving documented open records', () => {
    const plan = strictObject({ body: payloadInput(AddPlanPayloadSchema) });
    acceptsBoth(plan, [
      { body: { name: 'Plan', entries: [{ runs: [{ refs: 'REQ-1', case_ids: [] }] }] } },
      { body: { name: 'Plan', entries: [{ dynamic_filters: { mode: 'and', filters: { priority_id: { values: [1, 2] } } } }] } },
    ], [
      { body: { name: 'Plan', entries: [{ unexpected: true }] } },
      { body: { name: 'Plan', entries: [{ runs: [{ unexpected: true }] }] } },
      { body: { name: 'Plan', entries: [{ dynamic_filters: { mode: 'and', filters: {}, unexpected: true } }] } },
    ]);
    const open = strictObject({ body: payloadInput(DynamicFiltersPayloadSchema, { extensions: 'json' }) });
    acceptsBoth(open, [{ body: { mode: 'and', filters: {}, explicitly_open: { arbitrary: [true, null] } } }], [
      { body: { mode: 'and', filters: 1 } },
    ]);
    expect(open.safeParse({ body: { mode: 'and', filters: {}, explicitly_open: () => 1 } }).success).toBe(false);
  });

  it('checks a record\'s __proto__ key as it checks every other key', () => {
    // Zod's record parser skips this one key. JSON.parse keeps it as an own property, as
    // an MCP request does, and it is that original object which reaches the driver.
    const agree = (schema: z.ZodType<object>, text: string, valid: boolean): void => {
      const value: unknown = JSON.parse(text);
      const validateJson = validator.getValidator(inputJsonSchema(schema) as unknown as JsonSchemaType);
      expect(schema.safeParse(value).success, text).toBe(valid);
      expect(validateJson(value).valid, text).toBe(valid);
    };
    const dataset = strictObject({ body: payloadInput(AddDatasetPayloadSchema) });
    agree(dataset, '{"body":{"name":"D","variables":{"__proto__":12345}}}', false);
    agree(dataset, '{"body":{"name":"D","variables":{"__proto__":"x"}}}', true);
    // A record nested in another record, as dynamic filters are.
    const plan = strictObject({ body: payloadInput(AddPlanPayloadSchema) });
    agree(plan, '{"body":{"name":"P","entries":[{"dynamic_filters":{"mode":"and","filters":{"__proto__":5}}}]}}', false);
    agree(plan, '{"body":{"name":"P","entries":[{"dynamic_filters":{"mode":"and","filters":{"__proto__":{}}}}]}}', true);
    // The key schema applies to it as well, where it constrains the name.
    const named = strictObject({ body: payloadInput(z.record(z.string().regex(/^custom_/u), z.string())) });
    agree(named, '{"body":{"__proto__":"x"}}', false);
    agree(named, '{"body":{"custom_a":"x"}}', true);
    // It follows Zod's own rule for every other key. A loose record lets a key its schema
    // refuses through unchecked, and the advertised JSON Schema accepts it as well.
    const loose = strictObject({ body: payloadInput(z.looseRecord(z.string().regex(/^custom_/u), z.string())) });
    agree(loose, '{"body":{"__proto__":5}}', true);
    // A record whose keys are listed reports an undeclared one once, as unrecognized.
    const listed = strictObject({ body: payloadInput(z.record(z.enum(['a']), z.string())) });
    agree(listed, '{"body":{"a":"x","__proto__":"y"}}', false);
    expect(listed.safeParse(JSON.parse('{"body":{"a":"x","__proto__":"y"}}')).error?.issues.map(({ code }) => code))
      .toEqual(['unrecognized_keys']);
  });

  it('checks an own __proto__ key against an object\'s extension policy', () => {
    // Zod's object parser skips this key in its catch-all, and the custom_* name check
    // only sees the parsed clone, so neither applied to it. The original object is
    // what reaches the driver, so the key must meet the same policy as any other.
    const agree = (schema: z.ZodType<object>, text: string, valid: boolean): void => {
      const value: unknown = JSON.parse(text);
      const validateJson = validator.getValidator(inputJsonSchema(schema) as unknown as JsonSchemaType);
      expect(schema.safeParse(value).success, text).toBe(valid);
      expect(validateJson(value).valid, text).toBe(valid);
    };
    // Neither a declared field nor custom_*, so refused like any other unknown name.
    const custom = strictObject({ body: payloadInput(AddCasePayloadSchema, { extensions: 'custom' }) });
    agree(custom, '{"body":{"title":"x","__proto__":5}}', false);
    agree(custom, '{"body":{"title":"x","custom_a":5}}', true);
    // An open JSON object accepts the name, and its value must still be JSON.
    const open = strictObject({ body: payloadInput(DynamicFiltersPayloadSchema, { extensions: 'json' }) });
    agree(open, '{"body":{"mode":"and","filters":{},"__proto__":{"a":[1]}}}', true);
    const body = { mode: 'and', filters: {} };
    Object.defineProperty(body, '__proto__', { value: () => 1, enumerable: true });
    expect(open.safeParse({ body }).success).toBe(false);
  });

  it('retains driver array bounds and uses independently composed item extensions', () => {
    const schema = strictObject({
      body: payloadArray(AddCasesBulkPayloadSchema, payloadInput(AddCasePayloadSchema, { extensions: 'custom' })),
    });
    acceptsBoth(schema, [{ body: [{ title: 'A', custom_flag: false }, { title: 'B' }] }], [
      { body: [] }, { body: [{ title: 'A', unexpected: true }] }, { body: [{ title: 1 }] },
    ]);
  });

  it('preserves documented nullable and sentinel fields in exported schemas', () => {
    const role = strictObject({ body: payloadInput(UpdateProjectUserAssignmentPayloadSchema) });
    acceptsBoth(role, [
      { body: { user_id: 1, role_id: 0 } }, { body: { user_id: 1, role_id: null } },
    ], [{ body: { user_id: 1, role_id: -1 } }]);
    const section = strictObject({ body: payloadInput(MoveSectionPayloadSchema) });
    acceptsBoth(section, [
      { body: {} }, { body: { parent_id: null, after_id: null } }, { body: { parent_id: 0 } },
    ], [{ body: { parent_id: '0' } }]);
  });

  it('represents the two exported driver payload refinements in JSON Schema', () => {
    acceptsBoth(strictObject({ body: payloadInput(DeleteCasesPayloadSchema) }), [
      { body: { case_ids: [1] } },
    ], [{ body: { case_ids: [1], soft: 1 } }]);
    acceptsBoth(strictObject({ body: payloadInput(EditResultPayloadSchema, { extensions: 'custom' }) }), [
      { body: { comment: 'corrected' } }, { body: { custom_value: null } },
    ], [{ body: {} }, { body: { unexpected: 1 } }]);
    // Custom result fields remain flat and JSON, rather than moved or stripped.
    acceptsBoth(strictObject({ body: payloadInput(AddResultPayloadSchema, { extensions: 'custom' }) }), [
      { body: { status_id: 1, custom_actual: { actual: 'ok' } } },
    ], [{ body: { status_id: 1, unexpected: 1 } }]);
    acceptsBoth(strictObject({ body: payloadInput(DeleteCasesPayloadSchema, { extensions: 'json' }) }), [
      { body: { case_ids: [1], explicitly_open: true } },
    ], [{ body: { case_ids: [1], soft: 1 } }]);
    acceptsBoth(strictObject({ body: payloadInput(DeleteCasesPayloadSchema, { fields: { soft: z.number().optional() } }) }), [
      { body: { case_ids: [1] } },
    ], [{ body: { case_ids: [1], soft: 1 } }]);
    acceptsBoth(strictObject({
      body: payloadInput(EditResultPayloadSchema, { extensions: 'custom' }).describe('Correct an existing result.'),
    }), [{ body: { comment: 'corrected', custom_flag: false } }], [{ body: {} }, { body: { unexpected: true } }]);
  });

  /*
   * A result needs a status, a comment or an assignee (#49). The rule is the adapter's,
   * since driver 8.0.0 declares status_id required instead, and it must read the same in
   * Zod and in the advertised JSON Schema, alongside the custom_* name policy it is
   * combined with on every result body.
   */
  it('requires at least one of the named fields, in Zod and JSON Schema alike', () => {
    const body = payloadInput(AddResultPayloadSchema, {
      extensions: 'custom',
      fields: { status_id: z.number().int().positive().optional() },
      requireOneOf: ['status_id', 'comment', 'assignedto_id'],
    });
    const input = strictObject({ body });
    acceptsBoth(input, [
      { body: { status_id: 1 } }, { body: { comment: '' } }, { body: { assignedto_id: 2 } },
      { body: { comment: 'note', custom_actual: 'ok' } },
    ], [
      { body: {} }, { body: { version: '1.0' } }, { body: { custom_actual: 'ok' } },
      { body: { comment: 'note', unexpected: 1 } },
    ]);
    expect(inputJsonSchema(input).properties?.body).toMatchObject({
      anyOf: [{ required: ['status_id'] }, { required: ['comment'] }, { required: ['assignedto_id'] }],
    });
  });

  it('retains known payload fields and explicit override types for public driver calls', () => {
    const schema = strictObject({
      section_id: positiveIdSchema,
      body: payloadInput(AddCasePayloadSchema, {
        extensions: 'custom', fields: { title: AddCasePayloadSchema.shape.title.min(1), milestone_id: z.literal(0).optional() },
      }),
    });
    const input = schema.parse({ section_id: 1, body: { title: 'Case', custom_flag: false } });
    expectTypeOf(input.section_id).toBeNumber();
    expectTypeOf(input.body.title).toBeString();
    expectTypeOf(input.body.milestone_id).toEqualTypeOf<0 | undefined>();
    const invoke = (client: TestRailClient, parsed: z.output<typeof schema>) => client.cases.addCase(parsed.section_id, parsed.body);
    expectTypeOf(invoke).toBeFunction();
    const bulk = payloadArray(AddCasesBulkPayloadSchema, payloadInput(AddCasePayloadSchema, { extensions: 'custom' }));
    expectTypeOf<z.output<typeof bulk>[number]['title']>().toBeString();
    expect(bulk.parse([{ title: 'Case' }])).toEqual([{ title: 'Case' }]);
  });

  it('fails clearly when a refinement or transform cannot be advertised faithfully', () => {
    expect(() => payloadInput(z.object({ title: z.string() }).refine(() => true))).toThrow('refinement');
    expect(() => payloadInput(z.array(z.string()), { extensions: 'custom' })).toThrow('object');
    expect(() => inputJsonSchema(strictObject({ value: z.string().refine((value) => value === 'x') }))).toThrow('refinement');
    expect(() => inputJsonSchema(strictObject({ value: z.coerce.number() }))).toThrow('coercion');
    expect(() => inputJsonSchema(strictObject({ value: z.number().default(1) }))).toThrow('defaults');
    expect(() => inputJsonSchema(strictObject({ value: EditResultPayloadSchema }))).toThrow('refinement');
    for (const field of [
      z.string().trim(), z.string().overwrite((value) => value.toUpperCase()),
      z.string().transform((value) => value.length), z.preprocess((value) => String(value), z.string()),
      z.string().pipe(z.string()), z.string().catch('fallback'), z.string().prefault('fallback'),
    ]) {
      expect(() => inputJsonSchema(strictObject({ value: field }))).toThrow(/transform/);
    }
    expect(() => inputJsonSchema(strictObject({ value: z.string().superRefine(() => { /* Unrepresented. */ }) }))).toThrow('refinement');
    expect(() => inputJsonSchema(z.object({ value: z.string() }))).toThrow('unknown keys');
    expect(() => inputJsonSchema(z.object({ value: z.string() }).passthrough())).toThrow('unknown keys');
    expect(() => inputJsonSchema(strictObject({ query: z.object({ refs: refsSchema.optional() }).optional() }))).toThrow('unknown keys');
    expect(() => inputJsonSchema(strictObject({ body: z.object({ title: z.string() }) }))).toThrow('unknown keys');
    expect(() => inputJsonSchema(strictObject({ value: z.tuple([z.string().trim()]) }))).toThrow('transform');
    // Pinned Zod suppresses key errors rejected by only one intersection side,
    // while JSON Schema allOf keeps both. Do not advertise that mismatch.
    expect(() => inputJsonSchema(z.intersection(
      z.strictObject({ a: z.string() }), z.strictObject({ b: z.string() }),
    ))).toThrow('intersections');
    expect(() => inputJsonSchema(strictObject({
      body: payloadInput(AddCasePayloadSchema, { extensions: 'custom' }).meta({ propertyNames: { pattern: '.*' } }),
    }))).toThrow('refinement');
  });
});

describe('structural page/all input discrimination', () => {
  it('keeps page controls and aggregate controls mutually exclusive', () => {
    const schema = createListInput({
      pagination: 'controlled', path: { project_id: positiveIdSchema }, query: { refs: refsSchema.optional() },
    });
    acceptsBoth(schema, [
      { project_id: 1 }, { project_id: 1, _mcp: { pagination: 'page' } },
      { project_id: 1, query: { limit: 250, offset: 0, refs: ['REQ-1'] } },
      { project_id: 1, _mcp: { pagination: 'all' } },
      { project_id: 1, query: { refs: [] }, _mcp: { pagination: 'all', page_size: 50, start_offset: 0, ...aggregateLimitDefaults } },
    ], [
      {}, { project_id: 1, unexpected: 1 }, { project_id: 1, _mcp: {} },
      { project_id: 1, query: { limit: 251 } }, { project_id: 1, query: { offset: -1 } },
      { project_id: 1, query: { limit: 50 }, _mcp: { pagination: 'all' } },
      { project_id: 1, query: { offset: 0 }, _mcp: { pagination: 'all' } },
      { project_id: 1, _mcp: { pagination: 'page', max_items: 1 } },
      { project_id: 1, _mcp: { pagination: 'page', page_size: 1 } },
      // Every aggregate-only control, not just the first two: page mode would ignore it.
      { project_id: 1, _mcp: { pagination: 'page', start_offset: 0 } },
      { project_id: 1, _mcp: { pagination: 'page', max_pages: 1 } },
      { project_id: 1, _mcp: { pagination: 'page', max_bytes: 1 } },
      { project_id: 1, _mcp: { pagination: 'page', max_duration_ms: 1 } },
      { project_id: 1, _mcp: { pagination: 'all', max_items: 1001 } },
      { project_id: 1, _mcp: { pagination: 'all', max_pages: 0 } },
      { project_id: 1, _mcp: { pagination: 'all', max_bytes: 1.5 } },
      { project_id: 1, _mcp: { pagination: 'all', max_duration_ms: 45001 } },
      { project_id: 1, _mcp: { pagination: 'all', start_offset: -1 } },
      { project_id: 1, _mcp: { pagination: 'all', page_size: 251 } },
    ]);
  });

  it('advertises first-page/all response-driven lists without controllable cursors', () => {
    const schema = createListInput({ pagination: 'response-driven' });
    acceptsBoth(schema, [
      {}, { _mcp: { pagination: 'page' } }, { _mcp: { pagination: 'all', max_items: 2 } },
    ], [
      { query: { limit: 1 } }, { query: { offset: 0 } },
      { _mcp: { pagination: 'all', page_size: 1 } }, { _mcp: { pagination: 'all', start_offset: 0 } },
      { _mcp: { pagination: 'all', next: 'https://example.test/' } },
      { _mcp: { pagination: 'page', max_items: 1 } }, { _mcp: { pagination: 'page', max_pages: 1 } },
      { _mcp: { pagination: 'page', max_bytes: 1 } }, { _mcp: { pagination: 'page', max_duration_ms: 1 } },
    ]);
  });

  it('uses configured maxima without clamping and rejects invalid configuration', () => {
    const lower = createListInput({ pagination: 'controlled', limits: { ...aggregateLimitDefaults, max_items: 2 } });
    acceptsBoth(lower, [{ _mcp: { pagination: 'all', max_items: 2 } }], [{ _mcp: { pagination: 'all', max_items: 3 } }]);
    const higher = createListInput({ pagination: 'controlled', limits: aggregateLimitCeilings });
    acceptsBoth(higher, [{ _mcp: { pagination: 'all', ...aggregateLimitCeilings } }], []);
    for (const max_items of [0, -1, 1.5, 10_001, NaN, Infinity]) {
      expect(() => createListInput({ pagination: 'controlled', limits: { ...aggregateLimitDefaults, max_items } })).toThrow('limit');
    }
    expect(() => createListInput({ pagination: 'controlled', path: { _mcp: z.string() } })).toThrow('reserved');
    expect(() => createListInput({ pagination: 'controlled', query: { limit: z.number() } })).toThrow('redefine');
  });

  it('retains typed path/filter/control inputs for public driver page/all calls', () => {
    const schema = createListInput({
      pagination: 'controlled', path: { project_id: positiveIdSchema }, query: { refs: refsSchema.optional() },
    });
    expect(schema.parse({ project_id: 1, query: { refs: ['REQ-1'] } })).toEqual({ project_id: 1, query: { refs: ['REQ-1'] } });
    const invoke = (client: TestRailClient, input: z.output<typeof schema>) => {
      expectTypeOf(input.project_id).toBeNumber();
      expectTypeOf(input.query?.refs).toEqualTypeOf<string | string[] | undefined>();
      const filters = input.query?.refs === undefined ? {} : { refs: input.query.refs };
      if (input._mcp?.pagination === 'all') {
        expectTypeOf(input._mcp.page_size).toEqualTypeOf<number | undefined>();
        return client.cases.getAllCases(input.project_id, {
          ...filters,
          ...(input._mcp.page_size === undefined ? {} : { pageSize: input._mcp.page_size }),
          ...(input._mcp.start_offset === undefined ? {} : { startOffset: input._mcp.start_offset }),
          ...(input._mcp.max_items === undefined ? {} : { maxItems: input._mcp.max_items }),
        });
      }
      return client.cases.getCasesPage(input.project_id, {
        ...filters,
        ...(input.query?.limit === undefined ? {} : { limit: input.query.limit }),
        ...(input.query?.offset === undefined ? {} : { offset: input.query.offset }),
      });
    };
    expectTypeOf(invoke).toBeFunction();
    const responseDriven = createListInput({ pagination: 'response-driven' });
    const input = responseDriven.parse({ _mcp: { pagination: 'all' } });
    if (input._mcp?.pagination === 'all') expectTypeOf(input._mcp).not.toHaveProperty('page_size');
  });
});

/*
 * Every user tool takes one address rule, the shape check the driver applies to
 * get_user_by_email. Driver 8.0.0 also declares a stricter, dotted-domain format on its
 * user write payloads but never applies it, because addUser and updateUser forward the
 * payload unparsed; the published-driver evidence in tests/parameter-manifest.test.ts
 * drives a single-label address through both to the wire.
 */
describe('the user email rule', () => {
  it.each([
    ['ada@example.com', true], ['a.b+c@sub.example.co.uk', true], ['ADA@EXAMPLE.COM', true],
    ['ada@corp', true], ['user@localhost', true], ['user@[10.0.0.1]', true],
    ['nope', false], ['a@@b', false], ['ada@a@b', false], ['@example.com', false], ['ada@', false],
    [' ada@example.com', false], ['ada@example.com\n', false], ['', false],
  ])('judges %j by shape alone: %s', (address, accepted) => {
    expect(emailSchema.safeParse(address).success).toBe(accepted);
  });

  /*
   * The alarm for the upgrade. Driver 9.0.0 declares the lookup's rule on the writes, so
   * when the pin moves this fails, and with it go the comment in src/contracts/inputs.ts
   * and the widened write parses in the published-driver evidence.
   */
  it('is looser than the dotted format the pinned driver declares, and never applies, on writes', () => {
    // The control: a dotted address passes both payloads, so each refusal below is the email's alone.
    expect(UserAddPayloadSchema.safeParse({ name: 'Ada', email: 'ada@example.com' }).success).toBe(true);
    expect(UserUpdatePayloadSchema.safeParse({ email: 'ada@example.com' }).success).toBe(true);
    for (const address of ['ada@corp', 'user@localhost', 'user@[10.0.0.1]']) {
      expect(emailSchema.safeParse(address).success, address).toBe(true);
      for (const parsed of [
        UserAddPayloadSchema.safeParse({ name: 'Ada', email: address }),
        UserUpdatePayloadSchema.safeParse({ email: address }),
      ]) {
        expect(parsed.error?.issues.map((issue) => issue.path), address).toEqual([['email']]);
      }
    }
  });
});
