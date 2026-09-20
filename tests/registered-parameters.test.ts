import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TestRailClient } from '@dichovsky/testrail-api-client';
import type { JsonSchemaType } from '@modelcontextprotocol/server';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/server/validators/ajv';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_LIMITS } from '../src/config/limits.js';
import { z } from 'zod';
import { attachmentIdSchema, createListInput, positiveIdSchema, refsSchema, strictObject } from '../src/contracts/inputs.js';
import { operationRegistry } from '../src/operations/catalog.js';
import { driverCall } from '../src/operations/driver-call.js';
import { createRegistry, defineOperation } from '../src/operations/registry.js';
import { loadParameterManifests } from './contracts/parameter-manifest.js';
import { describeBody, materializeFiles, substituteTokens } from './contracts/uploads.js';
import { auditRegisteredParameters } from './contracts/registered-parameters.js';

const manifests = await loadParameterManifests();
const attachment = manifests.find((manifest) => manifest.endpoint.tool === 'testrail_get_attachment');
if (!attachment) throw new Error('Missing independent attachment parameter fixtures');

// Test-only binding. T12/F07 still own the production tool and persistent file.
const input = strictObject({ attachment_id: attachmentIdSchema });
const call = driverCall(input, 'attachments.getAttachment', (method, value) => method(value.attachment_id));
const operation = defineOperation({
  token: 'get_attachment', method: 'GET', route: 'get_attachment/{attachment_id}', family: 'T12',
  driverBinding: 'attachments.getAttachment', summary: 'Download a TestRail attachment.', inputSchema: input,
  argumentMap: [{ input: 'attachment_id', call: 'single', argument: 0, serialization: 'path' }],
  response: { shape: 'binary', outerSchema: z.instanceof(ArrayBuffer), entitySchema: null },
  pagination: { kind: 'none', single: call }, files: { kind: 'download' },
  effects: { testRail: 'read', destructive: false, idempotent: false }, retry: 'ordinary-read',
});
const validateJson = new AjvJsonSchemaValidator().getValidator(operation.jsonSchema as unknown as JsonSchemaType);

describe('registered parameter coverage gate', () => {
  it('requires a complete independent manifest for every production registration', () => {
    expect(auditRegisteredParameters(operationRegistry, manifests)).toEqual([]);
    expect(auditRegisteredParameters(createRegistry(operation), manifests)).toEqual([]);
    expect(auditRegisteredParameters(createRegistry(operation), [])).toEqual(['testrail_get_attachment: missing independent parameter manifest']);
    const partial = { ...attachment, review: { ...attachment.review, status: 'partial' as const, pending: ['unfinished parameter'] } };
    expect(auditRegisteredParameters(createRegistry(operation), [partial])).toContain('testrail_get_attachment: parameter review is incomplete');
  });

  it('detects argument target drift independently from source field names', () => {
    const changed = defineOperation({ ...operation, argumentMap: [{ input: 'attachment_id', call: 'single', argument: 1, serialization: 'path' }] });
    expect(auditRegisteredParameters(createRegistry(changed), manifests)).toEqual(['testrail_get_attachment: no single argument mapping for attachment_id']);
  });

  it('does not count a single-mode fixture that names another driver binding', () => {
    const accepted = attachment.cases.find((fixture) => fixture.expect.kind === 'accepted');
    if (accepted?.expect.kind !== 'accepted') throw new Error('Missing accepted attachment fixture');
    const changed = { ...attachment, cases: [{ ...accepted, expect: {
      ...accepted.expect, driver: { ...accepted.expect.driver, binding: 'projects.getProject' },
    } }] };
    expect(auditRegisteredParameters(createRegistry(operation), [changed])).toEqual([
      `testrail_get_attachment: fixture ${accepted.id} expects projects.getProject, but single mode selects attachments.getAttachment`,
      'testrail_get_attachment: no accepted single fixture',
    ]);
  });

  it.each([
    ['all', 'cases.getCasesPage'],
    ['all', 'projects.getAllProjects'],
    ['all', 'cases.getAllCases'],
    ['page', 'cases.getAllCases'],
    ['page', 'projects.getProjectsPage'],
    ['page', 'cases.getCasesPage'],
  ] as const)('checks the %s fixture against the selected binding: %s', (mode, binding) => {
    const listInput = createListInput({ path: { project_id: positiveIdSchema }, pagination: 'controlled' });
    const cases = defineOperation({
      ...operation, token: 'get_cases', route: 'get_cases/{project_id}', family: 'T02', driverBinding: 'cases.getCases',
      inputSchema: listInput, files: { kind: 'none' }, effects: { testRail: 'read', destructive: false, idempotent: true },
      argumentMap: [
        { input: 'project_id', call: 'page', argument: 0, serialization: 'path' },
        { input: 'project_id', call: 'all', argument: 0, serialization: 'path' },
      ],
      response: { shape: 'page', outerSchema: z.object({ kind: z.enum(['envelope', 'legacy-array']), items: z.array(z.unknown()) }), entitySchema: null },
      pagination: { kind: 'controlled', page: driverCall(listInput, 'cases.getCasesPage', (method) => method(7)), all: driverCall(listInput, 'cases.getAllCases', (method) => method(7)) },
    });
    const manifest = manifests.find((candidate) => candidate.endpoint.tool === cases.tool);
    const accepted = manifest?.cases.find((fixture) => fixture.id === 'defaults');
    if (!manifest || accepted?.expect.kind !== 'accepted') throw new Error('Missing accepted case-list fixture');
    // These synthetic fixtures isolate mode coverage; they do not complete T02's manifest.
    const sample = {
      ...manifest, review: { ...manifest.review, status: 'complete' as const, pending: [] },
      parameters: manifest.parameters.filter((parameter) => parameter.id === 'project_id'),
      cases: [
        { ...accepted, id: 'page', covers: [{ parameter: 'project_id', requirements: ['mapping', 'valid'] }], expect: {
          ...accepted.expect, driver: { ...accepted.expect.driver, binding: mode === 'page' ? binding : 'cases.getCasesPage' },
        } },
        { ...accepted, id: 'all', input: { project_id: 7, _mcp: { pagination: 'all' } },
          covers: [{ parameter: 'project_id', requirements: ['mapping', 'valid'] }], expect: {
            ...accepted.expect,
            driver: { binding: mode === 'all' ? binding : 'cases.getAllCases', arguments: [7, { pageSize: 50 }] },
            driver_result: { kind: 'json' as const, value: [] },
          } },
      ],
    };
    const selectedBinding = mode === 'all' ? 'cases.getAllCases' : 'cases.getCasesPage';
    expect(auditRegisteredParameters(createRegistry(cases), [sample])).toEqual(binding === selectedBinding ? [] : [
      `testrail_get_cases: fixture ${mode} expects ${binding}, but ${mode} mode selects ${selectedBinding}`,
      `testrail_get_cases: no accepted ${mode} fixture`,
    ]);
  });

  it('detects missing all-mode filters and reviewed fields omitted from schemas', () => {
    const manifest = manifests.find((candidate) => candidate.endpoint.tool === 'testrail_get_cases');
    const accepted = manifest?.cases.find((fixture) => fixture.id === 'defaults');
    if (!manifest || accepted?.expect.kind !== 'accepted') throw new Error('Missing accepted case-list fixture');
    // Only the refs filter is kept, so a registration without it disagrees with the one fixture.
    const sample = {
      ...manifest,
      parameters: manifest.parameters.filter((parameter) => ['project_id', 'query.refs'].includes(parameter.id)),
      cases: [{
        ...accepted, id: 'refs', input: { project_id: 7, query: { refs: 'REQ-1' } },
        covers: [{ parameter: 'query.refs', requirements: ['mapping', 'valid'] }],
      }],
    };
    for (const includeRefs of [true, false]) {
      const listInput = createListInput({ path: { project_id: positiveIdSchema }, query: includeRefs ? { refs: refsSchema.optional() } : {}, pagination: 'controlled' });
      const cases = defineOperation({
        ...operation, token: 'get_cases', route: 'get_cases/{project_id}', family: 'T02', driverBinding: 'cases.getCases',
        inputSchema: listInput, files: { kind: 'none' }, effects: { testRail: 'read', destructive: false, idempotent: true },
        argumentMap: [
          { input: 'project_id', call: 'page', argument: 0, serialization: 'path' },
          { input: 'project_id', call: 'all', argument: 0, serialization: 'path' },
          ...(includeRefs ? [{ input: 'query.refs', call: 'page' as const, argument: 1, property: 'refs', serialization: 'query-repeated' as const }] : []),
        ],
        response: { shape: 'page', outerSchema: z.object({ kind: z.enum(['envelope', 'legacy-array']), items: z.array(z.unknown()) }), entitySchema: null },
        pagination: { kind: 'controlled', page: driverCall(listInput, 'cases.getCasesPage', (method) => method(1)), all: driverCall(listInput, 'cases.getAllCases', (method) => method(1)) },
      });
      const errors = auditRegisteredParameters(createRegistry(cases), [sample]);
      expect(errors).toContain('testrail_get_cases: no all argument mapping for query.refs');
      expect(errors).toContain('testrail_get_cases: no accepted all fixture');
      expect(errors.some((error) => error.includes('schema disagrees'))).toBe(!includeRefs);
    }
  });

  it('keeps limit/offset in single mode on non-helper attachment lists', () => {
    const schema = strictObject({ test_id: positiveIdSchema, query: strictObject({ limit: positiveIdSchema, offset: z.number().int().nonnegative() }) });
    const listing = defineOperation({
      ...operation, token: 'get_attachments_for_test', route: 'get_attachments_for_test/{test_id}', driverBinding: 'attachments.getAttachmentsForTest',
      inputSchema: schema, files: { kind: 'none' }, effects: { testRail: 'read', destructive: false, idempotent: true },
      argumentMap: [
        { input: 'test_id', call: 'single', argument: 0, serialization: 'path' },
        { input: 'query.limit', call: 'single', argument: 1, property: 'limit', serialization: 'query-scalar' },
        { input: 'query.offset', call: 'single', argument: 1, property: 'offset', serialization: 'query-scalar' },
      ],
      response: { shape: 'array', outerSchema: z.array(z.unknown()), entitySchema: null },
      pagination: { kind: 'none', single: driverCall(schema, 'attachments.getAttachmentsForTest', (method, value) => method(value.test_id, value.query)) },
    });
    const parameter = attachment.parameters[0];
    const accepted = attachment.cases.find((fixture) => fixture.expect.kind === 'accepted');
    if (!parameter || accepted?.expect.kind !== 'accepted') throw new Error('Missing format examples');
    // Test-only format sample of the pinned public non-helper signature. It is
    // not added to the reviewed family manifest counts or production catalog.
    const sample = {
      ...attachment, endpoint: { ...attachment.endpoint, tool: listing.tool, route: listing.route, driver_method: listing.driverBinding },
      // This sample lists attachments rather than downloading one, so its outer result is
      // the array the non-helper method returns, not the reviewed binary download.
      outer_result: { ...attachment.outer_result, driver: 'array' as const, tool_data: 'array' as const },
      parameters: [
        { ...parameter, id: 'test_id', input_path: ['test_id'] },
        ...['limit', 'offset'].map((name) => ({ ...parameter, id: `query.${name}`, input_path: ['query', name], scope: 'query' as const, driver: { argument: 1, path: [name] } })),
      ],
      cases: [{ ...accepted, input: { test_id: 42, query: { limit: 10, offset: 20 } }, expect: {
        ...accepted.expect,
        driver: { binding: 'attachments.getAttachmentsForTest', arguments: [42, { limit: 10, offset: 20 }] },
        wire: { method: 'GET' as const, endpoint: 'get_attachments_for_test/42&limit=10&offset=20' },
        upstream_response: { kind: 'json' as const, body: [] },
        driver_result: { kind: 'json' as const, value: [] },
      } }],
    };
    expect(auditRegisteredParameters(createRegistry(listing), [sample])).toEqual([]);
  });
});

/*
 * The audit above proves a mapping is declared; this proves the registration honours it.
 * Every production registration is driven with every fixture of its manifest, and what
 * reaches the public driver method and the wire is compared with what the fixture
 * promised. A manifest argument nothing checks against the adapter would be a claim.
 */
describe('production registrations send what their fixtures promise', () => {
  for (const operation of operationRegistry.entries) {
    const manifest = manifests.find((candidate) => candidate.endpoint.tool === operation.tool);
    for (const fixture of manifest?.cases ?? []) {
      it(`${operation.tool}: ${fixture.id}`, async () => {
        // An upload fixture declares its file's contents; the token stands for the path
        // the file lands on here, in the input and in the expected driver arguments alike.
        const directory = (manifest?.files ?? []).length === 0
          ? undefined
          : await mkdtemp(join(tmpdir(), 'testrail-mcp-registered-'));
        const paths = directory === undefined || manifest === undefined
          ? {}
          : await materializeFiles(manifest, directory);
        const input = substituteTokens(fixture.input, paths);
        const expected = substituteTokens(fixture.expect, paths);
        const calls: { url: string; method: string | undefined; body: unknown }[] = [];
        const fetch = vi.fn<typeof globalThis.fetch>(async (target, init) => {
          const url = typeof target === 'string' ? target : target instanceof URL ? target.href : target.url;
          // Described inside the request: the driver owns an upload's streams and
          // cancels them once it settles, so a later read would never complete.
          calls.push({ url, method: init?.method, body: await describeBody(init?.body) });
          // Answer in the shape the fixture declares: one endpoint of this API returns
          // text rather than JSON, and a JSON reply would be read as the feature file.
          const response = expected.kind === 'accepted' ? expected.upstream_response : { kind: 'json' as const, body: {} };
          return Promise.resolve(response.kind === 'json'
            ? new Response(JSON.stringify(response.body), { headers: { 'content-type': 'application/json' } })
            : response.kind === 'text'
              ? new Response(response.text, { headers: { 'content-type': 'text/plain' } })
              : new Response(response.utf8, { headers: { 'content-type': 'application/octet-stream' } }));
        });
        const client = new TestRailClient({
          baseUrl: 'https://fixture.testrail.test', email: 'fixture@example.test', apiKey: 'synthetic',
          registerProcessHandlers: false, enableCache: false, maxRetries: 0, fetch,
          dnsLookup: () => Promise.resolve([{ address: '203.0.113.10', family: 4 }]),
        });
        const control = input._mcp;
        const all = typeof control === 'object' && control !== null && !Array.isArray(control) && control.pagination === 'all';
        const call = operation.pagination.kind === 'none' ? operation.pagination.single
          : all ? operation.pagination.all : operation.pagination.page;
        const [moduleName = '', methodName = ''] = call.binding.split('.');
        const owner: unknown = Reflect.get(client, moduleName);
        const publicMethod = vi.spyOn(owner as Record<string, (...args: never[]) => unknown>, methodName);
        /*
         * An upload operation is dispatched with the staged copy the transport would have
         * made. The staging itself, its root containment and its disposal belong to the
         * family suite; what this gate owns is that the registration hands the driver the
         * file it was given, under the filename and media type the caller asked for.
         */
        const staged = operation.files.kind !== 'upload' || typeof input.file_path !== 'string'
          ? undefined
          : { path: input.file_path, ...(typeof input.content_type === 'string' ? { type: input.content_type } : {}) };
        const context = staged === undefined
          ? { limits: DEFAULT_LIMITS }
          : { limits: DEFAULT_LIMITS, upload: staged };
        try {
          if (expected.kind === 'rejected') {
            await expect(call.invoke(client, input, context)).rejects.toThrow();
            expect(publicMethod).not.toHaveBeenCalled();
            expect(calls).toEqual([]);
            return;
          }
          const result = await call.invoke(client, input, context);
          expect(publicMethod.mock.calls).toEqual([expected.driver.arguments]);
          const sent = calls;
          expect(sent).toEqual([{
            url: `https://fixture.testrail.test/index.php?/api/v2/${expected.wire.endpoint}`,
            method: expected.wire.method,
            body: expected.wire.multipart ?? expected.wire.json,
          }]);
          expect(result).toEqual(expected.driver_result.kind === 'json' ? expected.driver_result.value : undefined);
          // What the driver returned must also satisfy the contract the registration
          // declares, or every real call fails in validateOuter while the arguments,
          // the wire and the result all still match the fixture.
          if (all) expect(Array.isArray(result), `${operation.tool}: aggregate result`).toBe(true);
          else expect(operation.response.outerSchema.safeParse(result).success, `${operation.tool}: outer schema`).toBe(true);
        } finally {
          client.destroy();
          if (directory !== undefined) await rm(directory, { recursive: true, force: true });
        }
      });
    }
  }
});

/** An aggregate fixture that names no bound of its own, so the configuration must supply them. */
function leavesEveryBoundToTheConfiguration(input: Record<string, unknown>): boolean {
  const control = input['_mcp'];
  if (typeof control !== 'object' || control === null || Array.isArray(control)) return false;
  const record = control as Record<string, unknown>;
  if (record['pagination'] !== 'all') return false;
  return (['max_items', 'max_pages', 'max_bytes', 'max_duration_ms'] as const)
    .every((bound) => record[bound] === undefined);
}

describe('configured limits reach the aggregate', () => {
  /*
   * Every fixture is invoked with the default limits, so the fixtures alone cannot tell
   * context.limits apart from a hard-coded DEFAULT_LIMITS. This can.
   *
   * It runs over every controlled list rather than one exemplar. A single instantiated
   * tool proves only itself: the T07 review showed that replacing context.limits with a
   * literal copy of the defaults in one family's aggregate call left the whole suite
   * green, because nothing outside get_projects was ever asked.
   */
  const controlled = operationRegistry.entries.filter(({ pagination }) => pagination.kind === 'controlled');

  it('covers every controlled list', () => {
    expect(controlled.length).toBeGreaterThan(1);
  });

  it.each(controlled.map((entry) => [entry.tool, entry] as const))(
    '%s forwards the operator\'s bounds, not the built-in defaults, when the caller sets none',
    async (tool, entry) => {
      if (entry.pagination.kind !== 'controlled') throw new Error(`${tool}: not a controlled list`);
      const manifest = manifests.find(({ endpoint }) => endpoint.tool === tool);
      const fixture = manifest?.cases.find((candidate) => candidate.expect.kind === 'accepted'
        && leavesEveryBoundToTheConfiguration(candidate.input));
      if (!fixture || fixture.expect.kind !== 'accepted') {
        throw new Error(`${tool}: no aggregate fixture leaves every bound to the configuration`);
      }
      // The endpoint's own reply, so the driver's collection step sees the shape it expects
      // and stops after one page.
      const reply = fixture.expect.upstream_response;
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(
        JSON.stringify(reply.kind === 'json' ? reply.body : {}),
        { headers: { 'content-type': 'application/json' } },
      ));
      const client = new TestRailClient({ baseUrl: 'https://example.test', email: 'fixture@example.test', apiKey: 'synthetic', allowPrivateHosts: true, fetch });
      const [moduleName, methodName] = entry.pagination.all.binding.split('.');
      if (moduleName === undefined || methodName === undefined) throw new Error(`${tool}: unreadable binding`);
      type DriverMethod = (...args: unknown[]) => Promise<unknown>;
      const module = (client as unknown as Record<string, Record<string, DriverMethod>>)[moduleName];
      if (module === undefined) throw new Error(`${tool}: no driver module ${moduleName}`);
      const all = vi.spyOn(module, methodName);
      try {
        const limits = { ...DEFAULT_LIMITS, max_all_items: 5, max_all_pages: 2, max_all_bytes: 512, max_all_duration_ms: 1_000 };
        await entry.pagination.all.invoke(client, fixture.input, { limits });
        // The bounds are the last argument whatever else the endpoint takes ahead of them.
        const options = all.mock.calls[0]?.at(-1);
        expect(options, tool).toMatchObject({ maxItems: 5, maxPages: 2, maxBytes: 512, maxDurationMs: 1_000 });
      } finally { client.destroy(); }
    });
});

describe('independent fixture → schema → real public driver', () => {
  for (const fixture of attachment.cases) {
    it(fixture.id, async () => {
      const response = fixture.expect.kind === 'accepted' && fixture.expect.upstream_response.kind === 'binary'
        ? fixture.expect.upstream_response.utf8 : '';
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(response));
      const client = new TestRailClient({ baseUrl: 'https://example.test', email: 'fixture@example.test', apiKey: 'synthetic', allowPrivateHosts: true, fetch });
      const publicMethod = vi.spyOn(client.attachments, 'getAttachment');
      try {
        expect(input.safeParse(fixture.input).success).toBe(fixture.expect.kind === 'accepted');
        expect(validateJson(fixture.input).valid).toBe(fixture.expect.kind === 'accepted');
        if (fixture.expect.kind === 'rejected') {
          await expect(call.invoke(client, fixture.input, { limits: DEFAULT_LIMITS })).rejects.toThrow();
          expect(publicMethod).not.toHaveBeenCalled();
          expect(fetch).not.toHaveBeenCalled();
        } else {
          const result = await call.invoke(client, fixture.input, { limits: DEFAULT_LIMITS });
          expect(publicMethod.mock.calls).toEqual([fixture.expect.driver.arguments]);
          expect(fetch.mock.calls[0]?.[0]).toBe(`https://example.test/index.php?/api/v2/${fixture.expect.wire.endpoint}`);
          expect(fetch.mock.calls[0]?.[1]?.method).toBe(fixture.expect.wire.method);
          expect(result).toBeInstanceOf(ArrayBuffer);
          if (fixture.expect.driver_result.kind !== 'binary') throw new Error('Expected binary fixture result');
          expect(new TextDecoder().decode(result as ArrayBuffer)).toBe(fixture.expect.driver_result.utf8);
        }
      } finally { client.destroy(); }
    });
  }
});
