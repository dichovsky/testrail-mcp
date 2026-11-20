import { TestRailClient, type GetCasesOptions, type GetProjectsOptions } from '@dichovsky/testrail-api-client';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { z } from 'zod';
import { DEFAULT_LIMITS } from '../src/config/limits.js';
import { idFilterSchema, nonnegativeIntegerSchema, positiveIdSchema, refsSchema } from '../src/contracts/inputs.js';
import { createListDefinition, type ListFilters } from '../src/operations/lists.js';
import { defineOperation } from '../src/operations/registry.js';

// Deliberately unrelated input and option names: a naming convention cannot produce
// these mappings. The expected arguments below are authored independently.
const casesList = createListDefinition({
  pagination: 'controlled',
  path: { project_id: { schema: positiveIdSchema, argument: 0 } },
  optionsArgument: 1,
  filters: {
    authors: { schema: idFilterSchema.optional(), property: 'createdBy', serialization: 'query-list' },
    earliest: { schema: nonnegativeIntegerSchema.optional(), property: 'createdAfter', serialization: 'query-scalar' },
    text: { schema: z.string().optional(), property: 'filter', serialization: 'query-scalar' },
    references: { schema: refsSchema.optional(), property: 'refs', serialization: 'query-repeated' },
  } satisfies ListFilters<GetCasesOptions>,
  entitySchema: null,
});

const cases = defineOperation({
  token: 'get_cases', method: 'GET', route: 'get_cases/{project_id}', family: 'T02',
  driverBinding: 'cases.getCases', summary: 'List test cases with explicit filter names.',
  ...casesList.bind({
    page: { binding: 'cases.getCasesPage', call: (method, input, options) => {
      expectTypeOf(input.project_id).toBeNumber();
      expectTypeOf(options.createdBy).toEqualTypeOf<number | number[] | undefined>();
      expectTypeOf(options.refs).toEqualTypeOf<string | string[] | undefined>();
      return method(input.project_id, options);
    } },
    all: { binding: 'cases.getAllCases', call: (method, input, options) => method(input.project_id, options) },
  }),
  files: { kind: 'none' }, effects: { testRail: 'read', destructive: false, idempotent: true }, retry: 'ordinary-read',
});

const projectsList = createListDefinition({
  pagination: 'controlled', optionsArgument: 0,
  filters: { finished: { schema: z.boolean().optional(), property: 'isCompleted', serialization: 'query-scalar' } } satisfies ListFilters<GetProjectsOptions>,
  entitySchema: null,
});
const projects = defineOperation({
  token: 'get_projects', method: 'GET', route: 'get_projects', family: 'T01',
  driverBinding: 'projects.getProjects', summary: 'List projects by completion state.',
  ...projectsList.bind({
    page: { binding: 'projects.getProjectsPage', call: (method, _input, options) => method(options) },
    all: { binding: 'projects.getAllProjects', call: (method, _input, options) => method(options) },
  }),
  files: { kind: 'none' }, effects: { testRail: 'read', destructive: false, idempotent: true }, retry: 'ordinary-read',
});

const variablesList = createListDefinition({
  pagination: 'response-driven', path: { project_id: { schema: positiveIdSchema, argument: 0 } },
  optionsArgument: 1, entitySchema: null,
});
const variables = defineOperation({
  token: 'get_variables', method: 'GET', route: 'get_variables/{project_id}', family: 'T09',
  driverBinding: 'variables.getVariables', summary: 'List project variables.',
  ...variablesList.bind({
    page: { binding: 'variables.getVariablesPage', call: (method, input, options) => {
      expectTypeOf(options).not.toHaveProperty('limit');
      expectTypeOf(options).not.toHaveProperty('offset');
      return method(input.project_id);
    } },
    all: { binding: 'variables.getAllVariables', call: (method, input, options) => {
      expectTypeOf(options).not.toHaveProperty('pageSize');
      expectTypeOf(options).not.toHaveProperty('startOffset');
      return method(input.project_id, options);
    } },
  }),
  files: { kind: 'none' }, effects: { testRail: 'read', destructive: false, idempotent: true }, retry: 'ordinary-read',
});

function client(): TestRailClient {
  return new TestRailClient({
    baseUrl: 'https://list-definition.test', email: 'fixture@example.test', apiKey: 'synthetic',
    registerProcessHandlers: false, fetch: vi.fn<typeof globalThis.fetch>(),
  });
}

describe('explicit list filter declarations', () => {
  it('derives both modes of every filter mapping with the declared serialization', () => {
    expect(cases.argumentMap.filter(({ input }) => input.startsWith('query.') && !['query.limit', 'query.offset'].includes(input)))
      .toEqual(expect.arrayContaining([
        { input: 'query.authors', call: 'page', argument: 1, property: 'createdBy', serialization: 'query-list' },
        { input: 'query.authors', call: 'all', argument: 1, property: 'createdBy', serialization: 'query-list' },
        { input: 'query.earliest', call: 'page', argument: 1, property: 'createdAfter', serialization: 'query-scalar' },
        { input: 'query.earliest', call: 'all', argument: 1, property: 'createdAfter', serialization: 'query-scalar' },
        { input: 'query.text', call: 'page', argument: 1, property: 'filter', serialization: 'query-scalar' },
        { input: 'query.text', call: 'all', argument: 1, property: 'filter', serialization: 'query-scalar' },
        { input: 'query.references', call: 'page', argument: 1, property: 'refs', serialization: 'query-repeated' },
        { input: 'query.references', call: 'all', argument: 1, property: 'refs', serialization: 'query-repeated' },
      ]));
    expect(cases.argumentMap).toHaveLength(18);
  });

  it.each(['page', 'all'] as const)('preserves supplied zero, empty text and filter arrays without changing %s input', async (mode) => {
    if (cases.pagination.kind === 'none') throw new Error('Expected a list');
    const authors = Object.freeze([3, 7]);
    const references = Object.freeze(['REQ-1', 'REQ-2']);
    const input = Object.freeze({
      project_id: 9,
      query: Object.freeze({ authors, earliest: 0, text: '', references }),
      ...(mode === 'all' ? { _mcp: Object.freeze({ pagination: 'all' }) } : {}),
    });
    const driver = client();
    const page = vi.spyOn(driver.cases, 'getCasesPage').mockResolvedValue({ kind: 'legacy-array', items: [], size: 0 });
    const all = vi.spyOn(driver.cases, 'getAllCases').mockResolvedValue([]);
    try {
      await cases.pagination[mode].invoke(driver, input, { limits: DEFAULT_LIMITS });
      const sent = mode === 'page' ? page.mock.calls[0] : all.mock.calls[0];
      expect(sent).toEqual([9, {
        createdBy: [3, 7], createdAfter: 0, filter: '', refs: ['REQ-1', 'REQ-2'],
        ...(mode === 'page' ? { limit: 50, offset: 0 }
          : { maxItems: 1_000, maxPages: 20, maxBytes: 1_048_576, maxDurationMs: 45_000 }),
      }]);
      expect(sent?.[1]?.createdBy).toBe(authors);
      expect(sent?.[1]?.refs).toBe(references);
      expect(Object.keys(input.query)).toEqual(['authors', 'earliest', 'text', 'references']);
      expect(Object.hasOwn(input.query, 'limit')).toBe(false);
    } finally { driver.destroy(); }
  });

  it('retains scalar IDs and scalar references, while omitted filters stay absent', async () => {
    if (cases.pagination.kind === 'none') throw new Error('Expected a list');
    const driver = client();
    const page = vi.spyOn(driver.cases, 'getCasesPage').mockResolvedValue({ kind: 'legacy-array', items: [], size: 0 });
    try {
      await cases.pagination.page.invoke(driver, { project_id: 9, query: { authors: 3, references: 'REQ-1' } }, { limits: DEFAULT_LIMITS });
      expect(page.mock.calls).toEqual([[9, { createdBy: 3, refs: 'REQ-1', limit: 50, offset: 0 }]]);
      await cases.pagination.page.invoke(driver, { project_id: 9 }, { limits: DEFAULT_LIMITS });
      expect(page.mock.calls[1]).toEqual([9, { limit: 50, offset: 0 }]);
    } finally { driver.destroy(); }
  });

  it.each([
    [{ limit: 250, offset: 0 }, { limit: 250, offset: 0 }],
    [{ offset: 100 }, { limit: 50, offset: 100 }],
  ])('forwards caller page controls and fills only missing defaults: %j', async (query, expected) => {
    if (cases.pagination.kind === 'none') throw new Error('Expected a list');
    const driver = client();
    const page = vi.spyOn(driver.cases, 'getCasesPage').mockResolvedValue({ kind: 'legacy-array', items: [], size: 0 });
    const input = Object.freeze({ project_id: 9, query: Object.freeze(query) });
    try {
      await cases.pagination.page.invoke(driver, input, { limits: DEFAULT_LIMITS });
      expect(page.mock.calls).toEqual([[9, expected]]);
    } finally { driver.destroy(); }
  });

  it.each(['page', 'all'] as const)('forwards explicit false in %s mode', async (mode) => {
    if (projects.pagination.kind === 'none') throw new Error('Expected a list');
    const driver = client();
    const page = vi.spyOn(driver.projects, 'getProjectsPage').mockResolvedValue({ kind: 'legacy-array', items: [], size: 0 });
    const all = vi.spyOn(driver.projects, 'getAllProjects').mockResolvedValue([]);
    try {
      await projects.pagination[mode].invoke(driver, {
        query: { finished: false }, ...(mode === 'all' ? { _mcp: { pagination: 'all' } } : {}),
      }, { limits: DEFAULT_LIMITS });
      expect(mode === 'page' ? page.mock.calls[0] : all.mock.calls[0]).toEqual([{
        isCompleted: false,
        ...(mode === 'page' ? { limit: 50, offset: 0 }
          : { maxItems: 1_000, maxPages: 20, maxBytes: 1_048_576, maxDurationMs: 45_000 }),
      }]);
    } finally { driver.destroy(); }
  });

  it('uses configured aggregate defaults without widening the advertised input ceiling', async () => {
    if (cases.pagination.kind === 'none') throw new Error('Expected a list');
    const driver = client();
    const all = vi.spyOn(driver.cases, 'getAllCases').mockResolvedValue([]);
    const limits = { ...DEFAULT_LIMITS, max_all_items: 2_000 };
    try {
      await cases.pagination.all.invoke(driver, { project_id: 9, _mcp: { pagination: 'all' } }, { limits });
      expect(all.mock.calls).toEqual([[9, { maxItems: 2_000, maxPages: 20, maxBytes: 1_048_576, maxDurationMs: 45_000 }]]);
      await expect(cases.pagination.all.invoke(driver, {
        project_id: 9, _mcp: { pagination: 'all', max_items: 1_001 },
      }, { limits })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      expect(all).toHaveBeenCalledTimes(1);
    } finally { driver.destroy(); }
  });

  it('keeps explicit aggregate controls and a zero start offset unchanged', async () => {
    if (cases.pagination.kind === 'none') throw new Error('Expected a list');
    const driver = client();
    const all = vi.spyOn(driver.cases, 'getAllCases').mockResolvedValue([]);
    const input = Object.freeze({
      project_id: 9,
      _mcp: Object.freeze({ pagination: 'all', page_size: 25, start_offset: 0, max_items: 10, max_pages: 2, max_bytes: 512, max_duration_ms: 1000 }),
    });
    try {
      await cases.pagination.all.invoke(driver, input, { limits: DEFAULT_LIMITS });
      expect(all.mock.calls).toEqual([[9, { pageSize: 25, startOffset: 0, maxItems: 10, maxPages: 2, maxBytes: 512, maxDurationMs: 1000 }]]);
      expect(input._mcp.start_offset).toBe(0);
      expect(Object.hasOwn(input._mcp, 'maxItems')).toBe(false);
    } finally { driver.destroy(); }
  });
});

describe('response-driven list definitions', () => {
  it('passes only the path to a page and only safety bounds to an aggregate', async () => {
    if (variables.pagination.kind === 'none') throw new Error('Expected a list');
    const driver = client();
    const page = vi.spyOn(driver.variables, 'getVariablesPage').mockResolvedValue({ kind: 'legacy-array', items: [], size: 0 });
    const all = vi.spyOn(driver.variables, 'getAllVariables').mockResolvedValue([]);
    try {
      await variables.pagination.page.invoke(driver, { project_id: 9 }, { limits: DEFAULT_LIMITS });
      await variables.pagination.all.invoke(driver, { project_id: 9, _mcp: { pagination: 'all' } }, { limits: DEFAULT_LIMITS });
      expect(page.mock.calls).toEqual([[9]]);
      expect(all.mock.calls).toEqual([[9, { maxItems: 1_000, maxPages: 20, maxBytes: 1_048_576, maxDurationMs: 45_000 }]]);
      for (const control of ['query.limit', 'query.offset', '_mcp.page_size', '_mcp.start_offset']) {
        expect(variables.argumentMap.map(({ input }) => input)).not.toContain(control);
      }
    } finally { driver.destroy(); }
  });

  it.each([
    { query: { limit: 1 } }, { query: { offset: 0 } },
    { _mcp: { pagination: 'all', page_size: 1 } }, { _mcp: { pagination: 'all', start_offset: 0 } },
  ])('rejects caller-controlled pagination %j', (input) => {
    expect(() => variables.input.validate({ project_id: 9, ...input })).toThrow();
  });
});

describe('direct aggregate input validation', () => {
  const invalidInputs: readonly (readonly [string, (onAccess: () => never) => object])[] = [
    ['symbol bound', () => ({ project_id: 9, _mcp: { pagination: 'all', max_items: Symbol('bound') } })],
    ['throwing valueOf', (onAccess) => ({ project_id: 9, _mcp: { pagination: 'all', max_items: { valueOf: onAccess } } })],
    ['bound getter', (onAccess) => ({ project_id: 9, _mcp: { pagination: 'all', get max_items() { return onAccess(); } } })],
    ['controls getter', (onAccess) => ({ project_id: 9, get _mcp() { return onAccess(); } })],
  ];

  it.each([cases, variables].flatMap((operation) => invalidInputs.map(([name, makeInput]) =>
    [operation.tool, name, operation, makeInput] as const)))(
    '%s rejects a %s as INVALID_ARGUMENT before inspecting bounds or looking up the driver',
    async (_tool, _name, operation, makeInput) => {
      if (operation.pagination.kind === 'none') throw new Error('Expected a list');
      const onAccess = vi.fn((): never => { throw new Error('Input hook must not run'); });
      const lookup = vi.fn((): never => { throw new Error('Driver lookup must not run'); });
      const driver = client();
      const guardedDriver = new Proxy(driver, { get: lookup });
      try {
        await expect(operation.pagination.all.invoke(guardedDriver, makeInput(onAccess), { limits: DEFAULT_LIMITS }))
          .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
        expect(onAccess).not.toHaveBeenCalled();
        expect(lookup).not.toHaveBeenCalled();
      } finally { driver.destroy(); }
    },
  );
});

describe('list declaration authoring guards', () => {
  const malformedPaths: { optionsArgument: number; path?: Record<string, { schema: z.ZodType; argument: number }> }[] = [
    { optionsArgument: 1 },
    { optionsArgument: 0, path: { project_id: { schema: positiveIdSchema, argument: 0 } } },
    { optionsArgument: 1, path: { project_id: { schema: positiveIdSchema, argument: -1 } } },
    { optionsArgument: 1, path: { project_id: { schema: positiveIdSchema, argument: 0.5 } } },
    { optionsArgument: 1, path: { project_id: { schema: positiveIdSchema, argument: 1 } } },
    { optionsArgument: 2, path: { run_id: { schema: positiveIdSchema, argument: 0 }, case_id: { schema: positiveIdSchema, argument: 0 } } },
  ];
  it.each(malformedPaths)(
    'refuses paths that cannot form the common path/options argument layout: %j', (definition) => {
    expect(() => createListDefinition({ ...definition, pagination: 'controlled', entitySchema: null })).toThrow('List paths');
  });

  it.each(['limit', 'offset', 'pageSize', 'startOffset', 'maxItems', 'maxPages', 'maxBytes', 'maxDurationMs'])(
    'refuses a filter that would overwrite the %s paging control', (property) => {
      expect(() => createListDefinition({
        pagination: 'controlled', optionsArgument: 0, entitySchema: null,
        filters: { filter: { schema: z.number().optional(), property, serialization: 'query-scalar' } },
      })).toThrow('conflicts');
    },
  );

  it('refuses two input filters that overwrite the same driver option', () => {
    expect(() => createListDefinition({
      pagination: 'controlled', optionsArgument: 0, entitySchema: null,
      filters: {
        first: { schema: z.boolean().optional(), property: 'isCompleted', serialization: 'query-scalar' },
        second: { schema: z.boolean().optional(), property: 'isCompleted', serialization: 'query-scalar' },
      },
    })).toThrow('conflicts');
  });

  it('refuses a serialization outside the supported query formats', () => {
    expect(() => createListDefinition({
      pagination: 'controlled', optionsArgument: 0, entitySchema: null,
      // @ts-expect-error JavaScript callers can still supply an unsupported serialization.
      filters: { value: { schema: z.string().optional(), property: 'filter', serialization: 'json-body' } },
    })).toThrow('serialization');
  });
});

// Compile-time probes only. A schema and its explicit property must agree with
// the public driver, while supported overloads remain available to list authors.
export function compileTimeListChecks(): void {
  const misspelled: ListFilters<GetProjectsOptions> = {
    // @ts-expect-error Driver property names are checked without guessing their spelling.
    finished: { schema: z.boolean().optional(), property: 'isComplete', serialization: 'query-scalar' },
  };
  const wrongValue: ListFilters<GetProjectsOptions> = {
    // @ts-expect-error Completion state is boolean in the actual public driver options.
    finished: { schema: z.string().optional(), property: 'isCompleted', serialization: 'query-scalar' },
  };
  void misspelled;
  void wrongValue;
  projectsList.bind({
    page: { binding: 'projects.getProjects', call: (method, _input, options) => {
      expectTypeOf(method).toEqualTypeOf<TestRailClient['projects']['getProjects']>();
      return options.isCompleted === undefined ? method(options.limit, options.offset) : method(options);
    } },
    all: { binding: 'projects.getAllProjects', call: (method, _input, options) => method(options) },
  });
}
