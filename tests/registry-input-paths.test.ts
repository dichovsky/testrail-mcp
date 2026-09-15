import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createListInput, payloadInput, positiveIdSchema, refsSchema, strictObject } from '../src/contracts/inputs.js';
import { driverCall } from '../src/operations/driver-call.js';
import { defineOperation, type ArgumentMapping, type OperationDefinition } from '../src/operations/registry.js';

// These definitions exercise registration only. Endpoint adapters and their
// independent wire fixtures remain responsible for actual argument values.
function mutationDefinition(body: z.ZodType, paths: readonly string[]): OperationDefinition {
  const input = strictObject({ project_id: positiveIdSchema, body });
  return {
    token: 'update_project', method: 'POST', route: 'update_project/{project_id}', family: 'T01',
    driverBinding: 'projects.updateProject', summary: 'Update a TestRail project.', inputSchema: input,
    argumentMap: [
      { input: 'project_id', call: 'single', argument: 0, serialization: 'path' },
      ...paths.map((path) => ({ input: path, call: 'single' as const, argument: 1, serialization: 'json-body' as const })),
    ],
    response: { shape: 'record', outerSchema: z.record(z.string(), z.unknown()), entitySchema: null },
    pagination: { kind: 'none', single: driverCall(input, 'projects.updateProject', (method) => method(1, {})) },
    files: { kind: 'none' }, effects: { testRail: 'write', destructive: false, idempotent: false }, retry: 'json-write',
  };
}

function listDefinition(mappings: readonly ArgumentMapping[]): OperationDefinition {
  const input = createListInput({ path: { project_id: positiveIdSchema }, query: { refs: refsSchema.optional() }, pagination: 'controlled' });
  return {
    token: 'get_cases', method: 'GET', route: 'get_cases/{project_id}', family: 'T02',
    driverBinding: 'cases.getCases', summary: 'Get TestRail cases.', inputSchema: input,
    argumentMap: [
      { input: 'project_id', call: 'page', argument: 0, serialization: 'path' },
      { input: 'project_id', call: 'all', argument: 0, serialization: 'path' },
      ...mappings,
    ],
    response: { shape: 'page', outerSchema: z.object({ kind: z.enum(['envelope', 'legacy-array']), items: z.array(z.unknown()) }), entitySchema: null },
    pagination: {
      kind: 'controlled',
      page: driverCall(input, 'cases.getCasesPage', (method) => method(1)),
      all: driverCall(input, 'cases.getAllCases', (method) => method(1)),
    },
    files: { kind: 'none' }, effects: { testRail: 'read', destructive: false, idempotent: true }, retry: 'ordinary-read',
  };
}

describe('complete argument input paths', () => {
  it('rejects a misspelled query field even when the query object exists', () => {
    const definition = listDefinition([{ input: 'query.reff', call: 'page', argument: 1, property: 'refs', serialization: 'query-repeated' }]);
    expect(() => defineOperation(definition)).toThrow('query.reff');
  });

  it.each(['body.missing', 'body.groups[].missing', 'body.name[].value', 'body.groups.role_id'])('rejects undeclared or structurally impossible %s', (path) => {
    const body = strictObject({ name: z.string().optional(), groups: z.array(strictObject({ role_id: z.number().int().nullable() })).optional() });
    expect(() => defineOperation(mutationDefinition(body, [path]))).toThrow(path);
  });

  it('accepts optional nested fields and array-item fields', () => {
    const body = strictObject({
      settings: strictObject({ announcement: z.string().optional() }).optional(),
      groups: z.array(strictObject({ role_id: z.number().int().nonnegative().nullable() })).optional(),
    });
    expect(() => defineOperation(mutationDefinition(body, ['body.settings.announcement', 'body.groups[].role_id']))).not.toThrow();
  });

  it('accepts a field declared in one nullable union branch', () => {
    const body = z.union([
      strictObject({ name: z.string() }),
      strictObject({ announcement: z.string().optional() }),
    ]).nullable();
    expect(() => defineOperation(mutationDefinition(body, ['body.name', 'body.announcement']))).not.toThrow();
    expect(() => defineOperation(mutationDefinition(body, ['body.missing']))).toThrow('body.missing');
  });

  it('accepts whole-body mappings for nested payloads', () => {
    const body = strictObject({ groups: z.array(strictObject({ role_id: z.number().nullable() })).optional() });
    expect(() => defineOperation(mutationDefinition(body, ['body']))).not.toThrow();
  });

  it.each([
    { input: 'query.limit', call: 'all' as const, serialization: 'query-scalar' as const },
    { input: '_mcp.page_size', call: 'page' as const, serialization: 'aggregate-control' as const },
  ])('rejects $input when it is unavailable in $call mode', (mapping) => {
    expect(() => defineOperation(listDefinition([{ ...mapping, argument: 1 }]))).toThrow(mapping.input);
  });

  it('accepts each pagination control in its own mode and shared optional filters in both modes', () => {
    const definition = listDefinition([
      { input: 'query.limit', call: 'page', argument: 1, property: 'limit', serialization: 'query-scalar' },
      { input: '_mcp.page_size', call: 'all', argument: 1, property: 'pageSize', serialization: 'aggregate-control' },
      { input: 'query.refs', call: 'page', argument: 1, property: 'refs', serialization: 'query-repeated' },
      { input: 'query.refs', call: 'all', argument: 1, property: 'refs', serialization: 'query-repeated' },
    ]);
    expect(() => defineOperation(definition)).not.toThrow();
  });

  it('respects explicit custom-field names and their open JSON values', () => {
    const body = payloadInput(z.object({ name: z.string().optional() }), { extensions: 'custom' });
    expect(() => defineOperation(mutationDefinition(body, ['body.custom_environment', 'body.custom_environment.details[]']))).not.toThrow();
    expect(() => defineOperation(mutationDefinition(body, ['body.undeclared']))).toThrow('body.undeclared');
  });

  it('accepts named paths inside explicitly open JSON payload fields', () => {
    const body = payloadInput(z.object({ name: z.string().optional() }), { extensions: 'json' });
    expect(() => defineOperation(mutationDefinition(body, ['body.undeclared.details[]']))).not.toThrow();
  });
});
