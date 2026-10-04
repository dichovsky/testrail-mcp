import { TestRailClient, ProjectSchema } from '@dichovsky/testrail-api-client';
import type { Tool } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { DEFAULT_LIMITS } from '../src/config/limits.js';
import { createListInput, positiveIdSchema, strictObject } from '../src/contracts/inputs.js';
import { driverCall, type DriverBinding } from '../src/operations/driver-call.js';
import { InputPaths } from '../src/operations/input-paths.js';
import { assertRegistryParity, compareRegistry, parseInventory } from '../src/operations/parity.js';
import { createRegistry, defineOperation, type Family, type Operation, type OperationDefinition } from '../src/operations/registry.js';

/*
 * Authoring-time guards of the operation layer: each malformed definition, inventory or
 * binding below is one an endpoint author could write, and each must be refused by name.
 *
 * Zod always emits `properties` for the closed objects registration accepts, so the one
 * layout rule about a closed object without `properties` is reached by substituting the
 * emitted JSON Schema. The substitute is unset by default and the real emitter runs.
 */
const emitted = vi.hoisted(() => ({ override: undefined as Tool['inputSchema'] | undefined }));
vi.mock('../src/contracts/inputs.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/contracts/inputs.js')>();
  return {
    ...actual,
    inputJsonSchema: (schema: z.ZodType<object>): Tool['inputSchema'] => emitted.override ?? actual.inputJsonSchema(schema),
  };
});

const projectInput = strictObject({ project_id: positiveIdSchema });
const getProjectDefinition = {
  token: 'get_project', method: 'GET', route: 'get_project/{project_id}', family: 'T01',
  driverBinding: 'projects.getProject', summary: 'Get a TestRail project.', inputSchema: projectInput,
  argumentMap: [{ input: 'project_id', call: 'single', argument: 0, serialization: 'path' }],
  response: { shape: 'record', outerSchema: z.record(z.string(), z.unknown()), entitySchema: ProjectSchema },
  pagination: { kind: 'none', single: driverCall(projectInput, 'projects.getProject', (method, input) => method(input.project_id)) },
  files: { kind: 'none' }, effects: { testRail: 'read', destructive: false, idempotent: true }, retry: 'ordinary-read',
} as const satisfies OperationDefinition;
const getProject = defineOperation(getProjectDefinition);

const writeEffects = { testRail: 'write', destructive: false, idempotent: false } as const;
const listInput = createListInput({ pagination: 'controlled' });
const getProjectsDefinition = {
  ...getProjectDefinition, token: 'get_projects', route: 'get_projects', driverBinding: 'projects.getProjects', inputSchema: listInput,
  argumentMap: [],
  response: { shape: 'page', outerSchema: z.object({ kind: z.enum(['envelope', 'legacy-array']), items: z.array(z.unknown()) }), entitySchema: ProjectSchema },
  pagination: {
    kind: 'controlled',
    page: driverCall(listInput, 'projects.getProjectsPage', (method) => method()),
    all: driverCall(listInput, 'projects.getAllProjects', (method) => method()),
  },
} as const satisfies OperationDefinition;

describe('endpoint definition validation', () => {
  it('rejects a family outside T01-T12 and a blank summary', () => {
    expect(() => defineOperation({ ...getProjectDefinition, family: 'T13' as unknown as Family })).toThrow('Invalid endpoint family');
    expect(() => defineOperation({ ...getProjectDefinition, family: 'T00' as unknown as Family })).toThrow('Invalid endpoint family');
    expect(() => defineOperation({ ...getProjectDefinition, summary: ' \n\t ' })).toThrow('Missing description: get_project');
  });

  it('rejects a single call bound to a different driver method than the endpoint', () => {
    const single = driverCall(projectInput, 'suites.getSuite', (method, input) => method(input.project_id));
    expect(() => defineOperation({ ...getProjectDefinition, pagination: { kind: 'none', single } }))
      .toThrow('Different endpoint driver binding: get_project');
  });

  it('requires a paginated endpoint to describe a page response', () => {
    expect(() => defineOperation(getProjectsDefinition)).not.toThrow();
    expect(() => defineOperation({ ...getProjectsDefinition, response: getProjectDefinition.response }))
      .toThrow('Paginated response must describe a page: get_projects');
  });

  it('requires a download to describe a binary response', () => {
    expect(() => defineOperation({
      ...getProjectDefinition, files: { kind: 'download' }, effects: { testRail: 'read', destructive: false, idempotent: false },
    })).toThrow('Download response must describe binary data: get_project');
  });

  it('rejects an identical argument mapping declared twice', () => {
    const mapping = getProjectDefinition.argumentMap[0];
    expect(() => defineOperation({ ...getProjectDefinition, argumentMap: [mapping, { ...mapping }] }))
      .toThrow('Duplicate argument mapping: get_project');
    // The same input feeding a different argument is a distinct mapping, not a duplicate.
    expect(() => defineOperation({ ...getProjectDefinition, argumentMap: [mapping, { ...mapping, argument: 1 }] })).not.toThrow();
  });

  it.each([
    ['a POST method', { method: 'POST' }],
    ['a destructive hint', { effects: { testRail: 'read', destructive: true, idempotent: true } }],
    ['a non-idempotent hint without a download', { effects: { testRail: 'read', destructive: false, idempotent: false } }],
  ] as const)('rejects a TestRail read declaring %s', (_label, change) => {
    expect(() => defineOperation({ ...getProjectDefinition, ...change })).toThrow('Invalid read effects: get_project');
  });

  it('rejects a TestRail read documenting any retry policy but ordinary-read', () => {
    for (const retry of ['json-write', 'never'] as const) {
      expect(() => defineOperation({ ...getProjectDefinition, retry })).toThrow('Invalid read retry policy: get_project');
    }
  });

  it('requires TestRail writes to use POST', () => {
    expect(() => defineOperation({ ...getProjectDefinition, effects: writeEffects, retry: 'json-write' }))
      .toThrow('Invalid write method: get_project');
  });

  it('requires a JSON write to document the json-write retry policy', () => {
    const write = { ...getProjectDefinition, method: 'POST', effects: writeEffects } as const;
    expect(() => defineOperation({ ...write, retry: 'json-write' })).not.toThrow();
    for (const retry of ['never', 'ordinary-read', 'rate-limit-only'] as const) {
      expect(() => defineOperation({ ...write, retry })).toThrow('Invalid JSON write retry policy: get_project');
    }
  });

  it('requires an upload to be a never-retried TestRail write', () => {
    const files = { kind: 'upload', featureFilename: false } as const;
    const upload = { ...getProjectDefinition, method: 'POST', files, effects: writeEffects } as const;
    expect(() => defineOperation({ ...upload, retry: 'never' })).not.toThrow();
    expect(() => defineOperation({ ...upload, retry: 'json-write' })).toThrow('Invalid upload effects: get_project');
    expect(() => defineOperation({ ...getProjectDefinition, files })).toThrow('Invalid upload effects: get_project');
  });
});

describe('endpoint input layout', () => {
  it('refuses a query input that has no object variant at all', () => {
    const input = strictObject({ project_id: positiveIdSchema, query: z.union([]) });
    expect(() => defineOperation({
      ...getProjectDefinition, inputSchema: input,
      pagination: { kind: 'none', single: driverCall(input, 'projects.getProject', (method, value) => method(value.project_id)) },
    })).toThrow('Operation inputs require object schemas');
  });

  it('treats a closed object variant without properties as declaring no path input', () => {
    emitted.override = { type: 'object', additionalProperties: false };
    try {
      expect(() => defineOperation(getProjectDefinition)).toThrow('Missing required path input: get_project project_id');
    } finally {
      emitted.override = undefined;
    }
  });
});

describe('registry runtime identity', () => {
  it('rejects a second tool name claiming an already registered method and route', () => {
    const alias: Operation = { ...getProject, tool: 'testrail_project_alias' };
    expect(() => createRegistry(getProject, alias)).toThrow('Duplicate endpoint: GET get_project/{project_id}');
    expect(() => createRegistry(getProject, { ...alias, method: 'POST' })).not.toThrow();
  });
});

describe('driver call binding guards', () => {
  const fixtureClient = (shape: Record<string, unknown>): TestRailClient => shape as unknown as TestRailClient;

  it.each(['request.getProject', 'projects', 'constructor.name'])('refuses the unsupported binding %s after validating input', async (binding) => {
    const call = driverCall(projectInput, binding as DriverBinding, () => Promise.resolve('unreachable'));
    const client = fixtureClient({ projects: { getProject: () => Promise.resolve('unreachable') } });
    await expect(call.invoke(client, { project_id: 'x' }, { limits: DEFAULT_LIMITS })).rejects.toThrow(z.ZodError);
    await expect(call.invoke(client, { project_id: 1 }, { limits: DEFAULT_LIMITS })).rejects.toThrow('Unsupported public driver binding');
  });

  it.each([
    ['absent', {}],
    ['null', { projects: null }],
    ['a primitive', { projects: 'projects' }],
  ])('refuses a client whose module is %s', async (_label, shape) => {
    const callback = vi.fn(() => Promise.resolve('unreachable'));
    const call = driverCall(projectInput, 'projects.getProject', callback);
    await expect(call.invoke(fixtureClient(shape), { project_id: 1 }, { limits: DEFAULT_LIMITS })).rejects.toThrow('Missing public driver module');
    expect(callback).not.toHaveBeenCalled();
  });

  it('refuses a module whose selected member is not a method', async () => {
    const callback = vi.fn(() => Promise.resolve('unreachable'));
    const call = driverCall(projectInput, 'projects.getProject', callback);
    for (const projects of [{}, { getProject: 'not callable' }]) {
      await expect(call.invoke(fixtureClient({ projects }), { project_id: 1 }, { limits: DEFAULT_LIMITS })).rejects.toThrow('Missing public driver method');
    }
    expect(callback).not.toHaveBeenCalled();
  });
});

describe('input path resolution', () => {
  const root = {
    type: 'object',
    definitions: { 'a/b~c': { type: 'string' }, leaf: 'text' },
  } as unknown as Tool['inputSchema'];
  const paths = new InputPaths(root);

  it('resolves escaped local pointers and refuses non-local or unresolved references', () => {
    expect(paths.variants({ $ref: '#/definitions/a~1b~0c' })).toEqual([{ type: 'string' }]);
    expect(() => paths.variants({ $ref: 'https://example.test/schema.json' })).toThrow('Input paths require local schema references');
    expect(() => paths.variants({ $ref: '#' })).toThrow('Input paths require local schema references');
    expect(() => paths.variants({ $ref: '#/definitions/missing' })).toThrow('Unresolved input schema reference: #/definitions/missing');
    // A pointer that continues through a non-object value does not resolve either.
    expect(() => paths.variants({ $ref: '#/definitions/leaf/length' })).toThrow('Unresolved input schema reference: #/definitions/leaf/length');
  });

  /*
   * A result body states its "status, comment or assignee" rule as an anyOf beside its
   * properties. The alternatives only add requirements, so every declared field must
   * stay reachable through each of them.
   */
  it('reads an anyOf as a condition beside its sibling keywords, not in place of them', () => {
    const body = {
      type: 'object', properties: { a: {}, b: {} }, required: ['b'], additionalProperties: false,
      anyOf: [{ required: ['a'] }, { required: ['b'], properties: { c: {} } }],
    };
    expect(paths.variants(body)).toEqual([
      { type: 'object', properties: { a: {}, b: {} }, required: ['b', 'a'], additionalProperties: false },
      { type: 'object', properties: { a: {}, b: {}, c: {} }, required: ['b'], additionalProperties: false },
    ]);
    expect(paths.has({ type: 'object', properties: { body } }, 'body.a')).toBe(true);
    expect(paths.has({ type: 'object', properties: { body } }, 'body.d')).toBe(false);
    // Siblings without properties or requirements of their own leave the alternative's in place.
    expect(paths.variants({ type: 'object', anyOf: [{ properties: { a: {} }, required: ['a'] }, true] }))
      .toEqual([{ type: 'object', properties: { a: {} }, required: ['a'] }]);
  });

  it('honours boolean propertyNames schemas when walking open objects', () => {
    expect(paths.has({ type: 'object', propertyNames: true, additionalProperties: {} }, 'anything')).toBe(true);
    expect(paths.has({ type: 'object', propertyNames: false, additionalProperties: {} }, 'anything')).toBe(false);
  });

  it('selects page mode by omission for a variant without declared properties', () => {
    const variant = { type: 'object' };
    expect(paths.forMode([variant], 'page')).toEqual([{ type: 'object', properties: {} }]);
    expect(paths.forMode([variant], 'all')).toEqual([]);
  });

  it('admits a required control object without pagination fields only in page mode', () => {
    const variant = { type: 'object', properties: { _mcp: { type: 'object' } }, required: ['_mcp'] };
    expect(paths.forMode([variant], 'page')).toEqual([variant]);
    expect(paths.forMode([variant], 'all')).toEqual([]);
    expect(paths.forMode([variant], 'single')).toEqual([variant]);
  });
});

describe('inventory identity', () => {
  const entry = {
    family_id: 'T01', http_method: 'GET', route: 'get_project/{project_id}', tool: 'testrail_get_project',
    driver_method: 'projects.getProject', pagination: { kind: 'none', page_method: null, all_method: null },
  };
  const other = {
    family_id: 'T01', http_method: 'GET', route: 'get_projects', tool: 'testrail_get_projects', driver_method: 'projects.getProjects',
    pagination: { kind: 'controlled', page_method: 'projects.getProjectsPage', all_method: 'projects.getAllProjects' },
  };

  it('accepts distinct consistent identities', () => {
    expect(parseInventory({ operations: [entry, other] })).toEqual([entry, other]);
  });

  it.each([
    ['tool', { ...other, tool: 'testrail_get_project' }],
    ['route', { ...entry, tool: 'testrail_get_project_copy', driver_method: 'projects.getProjectCopy' }],
    ['driver method', { ...other, driver_method: 'projects.getProject' }],
  ])('rejects a repeated %s', (_label, duplicate) => {
    expect(() => parseInventory({ operations: [entry, duplicate] })).toThrow(`Duplicate inventory identity: ${duplicate.tool}`);
  });

  it.each([
    ['a tool not named after its route token', { ...entry, tool: 'testrail_get_projectx' }],
    ['an unpaginated entry naming a page method', { ...entry, pagination: { kind: 'none', page_method: 'projects.getProjectsPage', all_method: null } }],
    ['a paginated entry without helpers', { ...other, pagination: { kind: 'controlled', page_method: null, all_method: null } }],
    ['a paginated entry missing its all helper', { ...other, pagination: { kind: 'response_driven', page_method: 'projects.getProjectsPage', all_method: null } }],
  ])('rejects %s', (_label, inconsistent) => {
    expect(() => parseInventory({ operations: [inconsistent] })).toThrow(`Inconsistent inventory identity: ${inconsistent.tool}`);
  });

  it('names every extra registration when asserting parity', () => {
    const baseline = parseInventory({ operations: [entry] });
    const extra = defineOperation({ ...getProjectDefinition, token: 'dispatch', route: 'dispatch/{project_id}' });
    const report = compareRegistry(createRegistry(getProject, extra), baseline);
    expect(report.extra).toEqual(['testrail_dispatch']);
    expect(() => assertRegistryParity(report, false)).toThrow('Extra tool: testrail_dispatch');
    expect(() => assertRegistryParity(compareRegistry(createRegistry(getProject), baseline), true)).not.toThrow();
  });
});
