import { readFile } from 'node:fs/promises';
import { TestRailClient, ProjectSchema, UpdateCasePayloadSchema } from '@dichovsky/testrail-api-client';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createListInput, payloadInput, positiveIdSchema, strictObject } from '../src/contracts/inputs.js';
import { driverCall } from '../src/operations/driver-call.js';
import { assertRegistryParity, compareRegistry, parseInventory, renderRegistryReference } from '../src/operations/parity.js';
import { createRegistry, defineOperation, type Operation, type OperationDefinition } from '../src/operations/registry.js';

const inventory = parseInventory(JSON.parse(await readFile(new URL('../docs/operation-inventory.json', import.meta.url), 'utf8')));
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

describe('typed endpoint registry', () => {
  it('derives the exact tool name and immutable read annotations', () => {
    expect(getProject.tool).toBe('testrail_get_project');
    expect(getProject.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true });
    expect(getProject.description).toContain('Required path arguments: project_id.');
    expect(getProject.jsonSchema).toMatchObject({ type: 'object', required: ['project_id'], additionalProperties: false });
    expect(Object.isFrozen(getProject)).toBe(true);
  });

  it('rejects duplicates even when entries arrive as a dynamically typed array', () => {
    const entries: Operation[] = [getProject, getProject];
    expect(() => createRegistry(...entries)).toThrow('Duplicate tool: testrail_get_project');
  });

  it('sorts discovery deterministically and only exposes explicit registrations', () => {
    const alternate = defineOperation({ ...getProjectDefinition, token: 'a_project', route: 'a_project/{project_id}' });
    const registry = createRegistry(getProject, alternate);
    expect(registry.entries.map((entry) => entry.tool)).toEqual(['testrail_a_project', 'testrail_get_project']);
    expect(registry.get('get_project')).toBeUndefined();
    expect(registry.get('testrail_get_project')).toBe(getProject);
    expect(Object.isFrozen(registry.entries)).toBe(true);
  });

  it('keeps report GET effects separate from ordinary reads and discloses email effects', () => {
    const input = strictObject({ report_template_id: positiveIdSchema });
    const report = defineOperation({
      ...getProjectDefinition,
      token: 'run_report', route: 'run_report/{report_template_id}', family: 'T11', driverBinding: 'reports.runReport',
      inputSchema: input, argumentMap: [{ input: 'report_template_id', call: 'single', argument: 0, serialization: 'path' }],
      pagination: { kind: 'none', single: driverCall(input, 'reports.runReport', (method, value) => method(value.report_template_id)) },
      effects: { testRail: 'report', destructive: false, idempotent: false }, retry: 'never',
    });
    expect(report.annotations).toMatchObject({ readOnlyHint: false, idempotentHint: false });
    expect(report.description).toContain('template-configured email');
    expect(report.description).toContain('do not generate the report again to poll');
    expect(() => defineOperation({ ...report, retry: 'ordinary-read' })).toThrow('Invalid report effects');
    expect(() => defineOperation({ ...report, effects: { testRail: 'read', destructive: false, idempotent: true }, retry: 'ordinary-read' })).toThrow('Report endpoint must declare report effects');
  });

  it('describes download effects without changing remote read retry policy', () => {
    const input = strictObject({ attachment_id: positiveIdSchema });
    const download = defineOperation({
      ...getProjectDefinition,
      token: 'get_attachment', route: 'get_attachment/{attachment_id}', family: 'T12', driverBinding: 'attachments.getAttachment',
      inputSchema: input, argumentMap: [{ input: 'attachment_id', call: 'single', argument: 0, serialization: 'path' }],
      pagination: { kind: 'none', single: driverCall(input, 'attachments.getAttachment', (method, value) => method(value.attachment_id)) },
      response: { shape: 'binary', outerSchema: z.instanceof(ArrayBuffer), entitySchema: null },
      files: { kind: 'download' }, effects: { testRail: 'read', destructive: false, idempotent: false },
    });
    expect(download.annotations).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true });
    expect(download.effects.testRail).toBe('read');
    expect(download.retry).toBe('ordinary-read');
    expect(download.description).toContain('unique persistent local file');
    expect(() => defineOperation({ ...download, effects: { ...download.effects, idempotent: true } })).toThrow('Invalid persistent download effects');
    expect(() => defineOperation({ ...download, files: { kind: 'none' }, effects: { testRail: 'read', destructive: false, idempotent: true } })).toThrow('get_attachment must declare persistent download behavior');
  });

  it('rejects malformed metadata, oversized UTF-8 descriptions and mismatched call schemas', () => {
    expect(() => defineOperation({ ...getProjectDefinition, route: 'get_suite/{suite_id}' })).toThrow('Invalid endpoint identity');
    expect(() => defineOperation({ ...getProjectDefinition, summary: '🐈'.repeat(512) })).toThrow('below 2 KiB');
    expect(() => defineOperation({ ...getProjectDefinition, inputSchema: strictObject({ project_id: positiveIdSchema }) })).toThrow('Different call input schema');
    expect(() => defineOperation({ ...getProjectDefinition, argumentMap: [{ input: 'query.limit', call: 'all', argument: 0, serialization: 'aggregate-control' }] })).toThrow('Invalid argument map');
    expect(() => defineOperation({ ...getProjectDefinition, argumentMap: [] })).toThrow('Unmapped path argument');
  });

  it('requires path inputs on every branch and reserves control/file fields for supported tools', () => {
    for (const input of [
      strictObject({ project_id: positiveIdSchema.optional() }),
      strictObject({ project_id: positiveIdSchema, _mcp: strictObject({}).optional() }),
      strictObject({ project_id: positiveIdSchema, file_path: z.string().optional() }),
      strictObject({ project_id: positiveIdSchema, query: z.record(z.string(), z.string()).optional() }),
    ]) {
      const definition = { ...getProjectDefinition, inputSchema: input, pagination: {
        kind: 'none' as const, single: driverCall(input, 'projects.getProject', (method) => method(1)),
      } };
      expect(() => defineOperation(definition)).toThrow();
    }
  });
});

describe('driver mapping boundary', () => {
  it('forwards original custom JSON including own __proto__ keys after validation', async () => {
    const schema = strictObject({ case_id: positiveIdSchema, body: payloadInput(UpdateCasePayloadSchema, { extensions: 'custom' }) });
    const call = driverCall(schema, 'cases.updateCase', (method, value) => method(value.case_id, value.body));
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('{"id":1,"title":"Case"}'));
    const client = new TestRailClient({ baseUrl: 'https://example.test', email: 'fixture@example.test', apiKey: 'synthetic', allowPrivateHosts: true, fetch });
    const raw: unknown = JSON.parse('{"case_id":1,"body":{"custom_value":{"__proto__":{"preserved":true},"safe":1}}}');
    try {
      await call.invoke(client, raw, {});
      expect(fetch.mock.calls[0]?.[1]?.body).toBe('{"custom_value":{"__proto__":{"preserved":true},"safe":1}}');
    } finally { client.destroy(); }
  });

  it('validates before invocation and binds the real public module receiver', async () => {
    const raw = { id: 42, name: 'Project', unknown_entity_field: { preserved: true } };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify(raw)));
    const client = new TestRailClient({ baseUrl: 'https://example.test/testrail', email: 'fixture@example.test', apiKey: 'synthetic', allowPrivateHosts: true, fetch });
    try {
      const call = getProjectDefinition.pagination.single;
      await expect(call.invoke(client, { project_id: '42' }, {})).rejects.toThrow();
      await expect(call.invoke(client, { project_id: 42, api_key: 'extra' }, {})).rejects.toThrow();
      expect(fetch).not.toHaveBeenCalled();
      expect(await call.invoke(client, { project_id: 42 }, {})).toEqual(raw);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch.mock.calls[0]?.[0]).toBe('https://example.test/testrail/index.php?/api/v2/get_project/42');
    } finally { client.destroy(); }
  });

  it('maps REST filters explicitly and preserves supported legacy overloads', async () => {
    const input = strictObject({ query: strictObject({ is_completed: z.boolean(), limit: positiveIdSchema }) });
    // getProjects' final .d.ts overload takes limit/offset. This callback still
    // accepts the primary options-object overload without copying driver types.
    const call = driverCall(input, 'projects.getProjects', (method, value) => method({ isCompleted: value.query.is_completed, limit: value.query.limit }));
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('[]'));
    const client = new TestRailClient({ baseUrl: 'https://example.test', email: 'fixture@example.test', apiKey: 'synthetic', allowPrivateHosts: true, fetch });
    try {
      await call.invoke(client, { query: { is_completed: false, limit: 12 } }, {});
      expect(fetch.mock.calls[0]?.[0]).toBe('https://example.test/index.php?/api/v2/get_projects&is_completed=0&limit=12');
    } finally { client.destroy(); }
  });
});

describe('independent inventory parity', () => {
  it('reports every missing endpoint identity instead of passing a count-only check', () => {
    expect(inventory).toHaveLength(133);
    const report = compareRegistry(createRegistry(getProject), inventory);
    expect(report.missing).toHaveLength(132);
    expect(report.extra).toEqual([]);
    expect(report.differences).toEqual([]);
    expect(() => assertRegistryParity(report, false)).not.toThrow();
    expect(() => assertRegistryParity(report, true)).toThrow('Missing: GET get_case/{case_id} -> testrail_get_case -> cases.getCase');
  });

  it('rejects an equally sized replacement and names binding/family differences', () => {
    const wrong = defineOperation({ ...getProjectDefinition, family: 'T02', driverBinding: 'suites.getSuite', pagination: {
      kind: 'none', single: driverCall(projectInput, 'suites.getSuite', (method, value) => method(value.project_id)),
    } });
    const baseline = inventory.filter((entry) => entry.tool === 'testrail_get_project');
    const report = compareRegistry(createRegistry(wrong), baseline);
    expect(report.differences).toEqual([
      { tool: 'testrail_get_project', field: 'family', expected: 'T01', actual: 'T02' },
      { tool: 'testrail_get_project', field: 'driver_binding', expected: 'projects.getProject', actual: 'suites.getSuite' },
    ]);
    expect(() => assertRegistryParity(report, false)).toThrow('expected projects.getProject, received suites.getSuite');
    const extra = defineOperation({ ...getProjectDefinition, token: 'dispatch', route: 'dispatch/{project_id}' });
    expect(compareRegistry(createRegistry(extra), baseline)).toMatchObject({ extra: ['testrail_dispatch'], missing: baseline });
  });

  it('checks page/all helper identity separately from endpoint binding', () => {
    const input = createListInput({ pagination: 'controlled' });
    const operation = defineOperation({
      ...getProjectDefinition, token: 'get_projects', route: 'get_projects', driverBinding: 'projects.getProjects', inputSchema: input,
      response: { shape: 'page', outerSchema: z.object({ kind: z.enum(['envelope', 'legacy-array']), items: z.array(z.unknown()) }), entitySchema: ProjectSchema },
      argumentMap: [], pagination: {
        kind: 'controlled',
        page: driverCall(input, 'projects.getProjectsPage', (method) => method()),
        all: driverCall(input, 'suites.getAllSuites', (method) => method(1)),
      },
    });
    const report = compareRegistry(createRegistry(operation), inventory);
    expect(report.differences).toContainEqual({ tool: 'testrail_get_projects', field: 'pagination.all_binding', expected: 'projects.getAllProjects', actual: 'suites.getAllSuites' });
  });

  it('renders input schemas and effects only for actual registrations', () => {
    const reference = renderRegistryReference(createRegistry(getProject), inventory);
    expect(reference).toContain('Implemented registrations: **1/133**');
    expect(reference).toContain('## testrail_get_project');
    expect(reference).toContain('"project_id"');
    expect(reference).toContain('| `testrail_get_case` | `GET get_case/{case_id}` | `cases.getCase` | T02 |');
    expect(reference).not.toContain('## testrail_get_case');
  });
});

// Compiled by tsc but never invoked. Negative checks prove that invalid public
// method shapes and literal duplicate registrations cannot compile.
export function compileTimeRegistryChecks(): void {
  const widened: Operation = getProject;
  createRegistry(widened, getProject); // Widened identities defer uniqueness to the runtime guard.
  // @ts-expect-error Root request() is not an endpoint module binding.
  driverCall(projectInput, 'request', () => Promise.resolve());
  // @ts-expect-error A nonexistent module method is not a public binding.
  driverCall(projectInput, 'projects.getSecret', () => Promise.resolve());
  // @ts-expect-error The selected public driver method requires a numeric ID.
  driverCall(projectInput, 'projects.getProject', (method) => method('42'));
  // @ts-expect-error Calls must preserve the async driver promise contract.
  driverCall(projectInput, 'projects.getProject', () => 42);
  // @ts-expect-error Literal duplicate tool names are rejected at compile time.
  createRegistry(getProject, getProject);
  // @ts-expect-error An outer record schema cannot return a string.
  defineOperation({ ...getProjectDefinition, response: { shape: 'record', outerSchema: z.string(), entitySchema: null } });
}
