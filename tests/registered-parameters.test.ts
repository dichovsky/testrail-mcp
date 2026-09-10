import { TestRailClient } from '@dichovsky/testrail-api-client';
import type { JsonSchemaType } from '@modelcontextprotocol/server';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/server/validators/ajv';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { attachmentIdSchema, createListInput, positiveIdSchema, refsSchema, strictObject } from '../src/contracts/inputs.js';
import { operationRegistry } from '../src/operations/catalog.js';
import { driverCall } from '../src/operations/driver-call.js';
import { createRegistry, defineOperation } from '../src/operations/registry.js';
import { loadParameterManifests } from './contracts/parameter-manifest.js';
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

  it('allows a reviewed whole-body mapping to carry nested wildcard fields', () => {
    const nested = manifests.find((manifest) => manifest.endpoint.tool === 'testrail_update_project');
    if (!nested) throw new Error('Missing nested-field manifest');
    // Exercise mapping audit independently; this partial endpoint is not a production registration.
    const mapped = { ...operation, tool: 'testrail_update_project' as const, argumentMap: [
      { input: 'project_id', call: 'single' as const, argument: 0, serialization: 'path' as const },
      { input: 'body', call: 'single' as const, argument: 1, serialization: 'json-body' as const },
    ] };
    const errors = auditRegisteredParameters({ entries: [mapped], get: () => mapped }, [nested]);
    expect(errors).toContain('testrail_update_project: parameter review is incomplete');
    expect(errors.filter((error) => error.includes('argument mapping'))).toEqual([]);
  });

  it('detects missing all-mode filters and reviewed fields omitted from schemas', () => {
    for (const includeRefs of [true, false]) {
      const listInput = createListInput({ path: { project_id: positiveIdSchema }, query: includeRefs ? { refs: refsSchema.optional() } : {}, pagination: 'controlled' });
      const cases = defineOperation({
        ...operation, token: 'get_cases', route: 'get_cases/{project_id}', family: 'T02', driverBinding: 'cases.getCases',
        inputSchema: listInput, files: { kind: 'none' }, effects: { testRail: 'read', destructive: false, idempotent: true },
        argumentMap: [
          { input: 'project_id', call: 'page', argument: 0, serialization: 'path' },
          { input: 'project_id', call: 'all', argument: 0, serialization: 'path' },
          { input: 'query.refs', call: 'page', argument: 1, property: 'refs', serialization: 'query-repeated' },
        ],
        response: { shape: 'page', outerSchema: z.object({ kind: z.enum(['envelope', 'legacy-array']), items: z.array(z.unknown()) }), entitySchema: null },
        pagination: { kind: 'controlled', page: driverCall(listInput, 'cases.getCasesPage', (method) => method(1)), all: driverCall(listInput, 'cases.getAllCases', (method) => method(1)) },
      });
      const errors = auditRegisteredParameters(createRegistry(cases), manifests);
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
    if (!parameter || !accepted) throw new Error('Missing format examples');
    // Test-only format sample of the pinned public non-helper signature. It is
    // not added to the reviewed family manifest counts or production catalog.
    const sample = {
      ...attachment, endpoint: { ...attachment.endpoint, tool: listing.tool, route: listing.route, driver_method: listing.driverBinding },
      parameters: [
        { ...parameter, id: 'test_id', input_path: ['test_id'] },
        ...['limit', 'offset'].map((name) => ({ ...parameter, id: `query.${name}`, input_path: ['query', name], scope: 'query' as const, driver: { argument: 1, path: [name] } })),
      ],
      cases: [{ ...accepted, input: { test_id: 42, query: { limit: 10, offset: 20 } } }],
    };
    expect(auditRegisteredParameters(createRegistry(listing), [sample])).toEqual([]);
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
          await expect(call.invoke(client, fixture.input, {})).rejects.toThrow();
          expect(publicMethod).not.toHaveBeenCalled();
          expect(fetch).not.toHaveBeenCalled();
        } else {
          const result = await call.invoke(client, fixture.input, {});
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
