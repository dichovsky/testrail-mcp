import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TestRailClient } from '@dichovsky/testrail-api-client';
import { Client, InMemoryTransport, type Tool } from '@modelcontextprotocol/client';
import type { JsonSchemaType } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/server/validators/ajv';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConfiguration, type Configuration } from '../src/config/environment.js';
import { driverOptions } from '../src/driver/configuration.js';
import { operationRegistry } from '../src/operations/catalog.js';
import type { Operation } from '../src/operations/registry.js';
import { createRuntime, type Runtime } from '../src/runtime/invocation.js';
import { buildServer } from '../src/transport/server.js';
import { executeToolCall } from '../src/transport/tool-call.js';
import { loadParameterManifests, type ParameterManifest } from './contracts/parameter-manifest.js';
import { materializeFiles, substituteTokens } from './contracts/uploads.js';

/*
 * R01: the result contract through registered tools. Every tool's result, as a connected
 * client receives it, must validate against the output schema that tool advertises and
 * carry the same wrapper in its text as in its structured content; errors must keep that
 * parity; a read whose success reply cannot be used must fail as INVALID_RESPONSE; drift
 * warnings must belong to the call that received the drifted reply, even when the driver
 * joins identical requests; and the complete-result budget must hold through a tool.
 */

const manifests = await loadParameterManifests();

type Fixture = ParameterManifest['cases'][number];
type Reply = { status: number; body: string; type: string };

function json(body: unknown, status = 200): Reply {
  return { status, body: JSON.stringify(body), type: 'application/json' };
}

function reply(response: Extract<Fixture['expect'], { kind: 'accepted' }>['upstream_response']): Reply {
  if (response.kind === 'json') return json(response.body);
  if (response.kind === 'text') return { status: 200, body: response.text, type: 'text/plain' };
  return { status: 200, body: response.utf8, type: 'application/octet-stream' };
}

function isAll(fixture: Fixture): boolean {
  const control = fixture.input._mcp;
  return typeof control === 'object' && control !== null && !Array.isArray(control) && control.pagination === 'all';
}

function manifestFor(tool: string): ParameterManifest {
  const manifest = manifests.find(({ endpoint }) => endpoint.tool === tool);
  if (manifest === undefined) throw new Error(`${tool} has no manifest`);
  return manifest;
}

function registered(tool: string): Operation {
  const operation = operationRegistry.get(tool);
  if (operation === undefined) throw new Error(`${tool} is not registered`);
  return operation;
}

/** One accepted fixture per call mode the tool has: single or page, and all where it pages. */
function callsFor(operation: Operation): { mode: string; fixture: Fixture }[] {
  const accepted = manifestFor(operation.tool).cases.filter((fixture) => fixture.expect.kind === 'accepted');
  const first = accepted.find((fixture) => !isAll(fixture));
  if (first === undefined) throw new Error(`${operation.tool}: no accepted fixture`);
  const calls = [{ mode: operation.pagination.kind === 'none' ? 'single' : 'page', fixture: first }];
  if (operation.pagination.kind !== 'none') {
    const all = accepted.find(isAll);
    if (all === undefined) throw new Error(`${operation.tool}: no accepted all fixture`);
    calls.push({ mode: 'all', fixture: all });
  }
  return calls;
}

let base: string;
let configuration: Configuration;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'testrail-mcp-results-'));
  configuration = await loadConfiguration({
    TESTRAIL_BASE_URL: 'https://results.testrail.io',
    TESTRAIL_EMAIL: 'user@example.com',
    TESTRAIL_API_KEY: 'synthetic',
    TESTRAIL_MCP_UPLOAD_ROOTS: JSON.stringify([base]),
    TESTRAIL_MCP_DOWNLOAD_DIR: base,
  });
});

afterAll(async () => { await rm(base, { recursive: true, force: true }); });

function driver(configured: Configuration, respond: (url: string) => Reply | Promise<Reply>, fetch = vi.fn()) {
  fetch.mockImplementation(async (target: unknown) => {
    const url = typeof target === 'string' ? target : target instanceof URL ? target.href : (target as Request).url;
    const { status, body, type } = await respond(url);
    return new Response(body, { status, headers: { 'content-type': type } });
  });
  return {
    fetch,
    client: new TestRailClient({
      ...driverOptions(configured),
      // No retry: a refused reply here is the outcome under test, not a transient.
      maxRetries: 0,
      // The production limiter allows 100 requests a minute; the catalog-wide sweep below
      // makes more than that in one session, against a stand-in rather than TestRail.
      rateLimiter: { maxRequests: 10_000, windowMs: 60_000 },
      dnsLookup: () => Promise.resolve([{ address: '203.0.113.10', family: 4 }]),
      fetch,
    }),
  };
}

describe('every tool\'s result, as a connected client receives it', () => {
  let client: Client;
  let runtime: Runtime;
  let close: () => Promise<void>;
  let next: Reply = json({});
  const advertised = new Map<string, Tool>();
  const validator = new AjvJsonSchemaValidator();

  beforeAll(async () => {
    const staging = join(base, 'staging');
    await mkdir(staging);
    const { client: testRail } = driver(configuration, () => next);
    runtime = createRuntime({ client: testRail, limits: configuration.limits });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const handle = serveStdio(() => buildServer({
      configuration, runtime, registry: operationRegistry, stagingDirectory: () => Promise.resolve(staging),
    }), { transport: serverTransport });
    client = new Client({ name: 'result-contract', version: '1.0.0' });
    await client.connect(clientTransport);
    for (const tool of (await client.listTools()).tools) advertised.set(tool.name, tool);
    close = async () => {
      await client.close().catch(() => undefined);
      await handle.close().catch(() => undefined);
      await runtime.shutdown();
    };
  });

  afterAll(async () => { await close(); });

  const calls = operationRegistry.entries.flatMap((operation) =>
    callsFor(operation).map(({ mode, fixture }) => [operation.tool, mode, fixture.id, operation, fixture] as const));

  it('covers every registered tool, and the 24 paged ones in both modes', () => {
    expect(new Set(calls.map(([tool]) => tool)).size).toBe(133);
    expect(calls.filter(([, mode]) => mode === 'all')).toHaveLength(24);
  });

  it.each(calls)('%s (%s, fixture %s) validates against its advertised output schema', async (tool, _mode, _id, operation, fixture) => {
    if (fixture.expect.kind !== 'accepted') throw new Error('accepted fixtures only');
    const manifest = manifestFor(tool);
    const directory = join(base, tool);
    await mkdir(directory, { recursive: true });
    const paths = await materializeFiles(manifest, directory);
    next = reply(fixture.expect.upstream_response);
    const result = await client.callTool({ name: tool, arguments: substituteTokens(fixture.input, paths) });
    expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(true);
    const outputSchema = advertised.get(tool)?.outputSchema;
    expect(outputSchema, `${tool} advertises no output schema`).toBeDefined();
    const verdict = validator.getValidator(outputSchema as unknown as JsonSchemaType)(result.structuredContent);
    expect(verdict.valid, JSON.stringify(verdict)).toBe(true);
    // One text block carrying exactly the structured wrapper.
    const content = result.content as { type: string; text: string }[];
    expect(content).toHaveLength(1);
    expect(content[0]?.type).toBe('text');
    expect(JSON.parse(content[0]?.text ?? 'null')).toEqual(result.structuredContent);
    // A paged list says how much of the dataset it returned; nothing else claims to.
    expect(Object.hasOwn(result.structuredContent ?? {}, 'pagination')).toBe(operation.pagination.kind !== 'none');
  });

  it.each([
    ['a refused argument', 'testrail_get_project', { project_id: 'seven' }, json({}), 'INVALID_ARGUMENT', undefined],
    ['an upstream 404', 'testrail_get_project', { project_id: 7 }, json({ error: 'Field :project_id is not a valid or accessible project.' }, 404), 'NOT_FOUND', undefined],
    ['a write TestRail refused with 500', 'testrail_add_project', { body: { name: 'Gate' } }, json({ error: 'Internal error' }, 500), 'UPSTREAM_ERROR', 'unknown'],
    ['an aggregate past max_items', 'testrail_get_projects', { _mcp: { pagination: 'all', max_items: 1 } },
      json({ offset: 0, limit: 1, size: 1, _links: { next: '/api/v2/get_projects&limit=1&offset=1', prev: null }, projects: [{ id: 1, name: 'One' }] }),
      'PAGINATION_LIMIT', undefined],
  ] as const)('keeps the error wrapper identical in text and structure for %s', async (_label, tool, args, upstream, code, outcome) => {
    next = upstream;
    const result = await client.callTool({ name: tool, arguments: args });
    expect(result.isError).toBe(true);
    const content = result.content as { type: string; text: string }[];
    expect(content).toHaveLength(1);
    expect(JSON.parse(content[0]?.text ?? 'null')).toEqual(result.structuredContent);
    const payload = result.structuredContent as { error: { code: string; write_outcome?: string } };
    expect(payload).not.toHaveProperty('data');
    expect(payload.error.code).toBe(code);
    expect(payload.error.write_outcome).toBe(outcome);
  });
});

describe('a read whose success reply cannot be used', () => {
  it.each([
    ['a record read', 'testrail_get_project', { project_id: 7 }, { status: 200, body: 'not json at all', type: 'application/json' }],
    ['a record read', 'testrail_get_project', { project_id: 7 }, json([{ id: 7 }])],
    ['an array read', 'testrail_get_case_types', {}, json({ case_types: [] })],
    ['a page read', 'testrail_get_projects', {}, json('a string where the envelope belongs')],
    ['an aggregate read', 'testrail_get_projects', { _mcp: { pagination: 'all' } },
      json({ offset: 5, limit: 1, size: 1, _links: { next: null, prev: null }, projects: [{ id: 1 }] })],
  ] as const)('fails %s as INVALID_RESPONSE with no data and no write outcome (%#)', async (_label, tool, args, upstream) => {
    const { client } = driver(configuration, () => upstream);
    const runtime = createRuntime({ client, limits: configuration.limits });
    try {
      const result = await executeToolCall(registered(tool), args, { runtime, configuration });
      expect(result.isError).toBe(true);
      const payload = result.structuredContent as { error: { code: string; write_outcome?: string } };
      expect(payload.error.code).toBe('INVALID_RESPONSE');
      expect(payload.error).not.toHaveProperty('write_outcome');
      expect(payload).not.toHaveProperty('data');
    } finally { await runtime.shutdown(); }
  });

  it('checks the shapes this block relies on', () => {
    expect(registered('testrail_get_project').response.shape).toBe('record');
    expect(registered('testrail_get_case_types').response.shape).toBe('array');
    expect(registered('testrail_get_projects').response.shape).toBe('page');
  });
});

describe('drift warnings belong to the call that received the drifted reply', () => {
  const clean = manifestFor('testrail_get_project').cases.find(({ id }) => id === 'representative-id');
  if (clean?.expect.kind !== 'accepted' || clean.expect.upstream_response.kind !== 'json') throw new Error('Missing get_project entity');
  const entity = clean.expect.upstream_response.body as Record<string, unknown>;
  // The same entity with a name TestRail would never send: a number where text belongs.
  const drifted = { ...entity, id: 7, name: 42 };

  it('gives joined identical calls one set of warnings each, and a concurrent clean call none', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { client, fetch } = driver(configuration, async (url) => {
      await gate;
      return /get_project\/7$/u.test(url) ? json(drifted) : json({ ...entity, id: 8 });
    });
    const runtime = createRuntime({ client, limits: configuration.limits });
    try {
      const call = (id: number) => executeToolCall(registered('testrail_get_project'), { project_id: id }, { runtime, configuration });
      const pending = [call(7), call(7), call(8)];
      // The two identical reads share one request; the third has its own.
      await vi.waitFor(() => { expect(fetch).toHaveBeenCalledTimes(2); });
      release();
      const [first, second, other] = await Promise.all(pending);
      const warnings = (result: { structuredContent?: unknown } | undefined) => (result?.structuredContent as { warnings?: unknown[] } | undefined)?.warnings;
      expect(warnings(first)?.length).toBeGreaterThan(0);
      expect(warnings(second)).toEqual(warnings(first));
      expect(warnings(other)).toBeUndefined();
      expect(fetch).toHaveBeenCalledTimes(2);
      // Nothing carries over to a later call whose reply is clean.
      const later = await executeToolCall(registered('testrail_get_project'), { project_id: 8 }, { runtime, configuration });
      expect(warnings(later)).toBeUndefined();
    } finally {
      release();
      await runtime.shutdown();
    }
  });
});

describe('the complete-result budget through a tool', () => {
  let small: Configuration;
  beforeAll(async () => {
    small = await loadConfiguration({
      TESTRAIL_BASE_URL: 'https://results.testrail.io',
      TESTRAIL_EMAIL: 'user@example.com',
      TESTRAIL_API_KEY: 'synthetic',
      TESTRAIL_MCP_UPLOAD_ROOTS: JSON.stringify([base]),
      TESTRAIL_MCP_DOWNLOAD_DIR: base,
      TESTRAIL_MCP_LIMITS: JSON.stringify({ max_result_bytes: 400 }),
    });
  });

  // Data within its own budget whose complete result, text and structure together, is not.
  const long = { id: 7, name: 'x'.repeat(300) };

  it.each([
    ['a read', 'testrail_get_project', { project_id: 7 }, undefined],
    ['a write TestRail accepted', 'testrail_add_project', { body: { name: 'Gate' } }, 'acknowledged'],
  ] as const)('reports %s over max_result_bytes as RESPONSE_TOO_LARGE, never truncated', async (_label, tool, args, outcome) => {
    const { client, fetch } = driver(small, () => json(long));
    const runtime = createRuntime({ client, limits: small.limits });
    try {
      const result = await executeToolCall(registered(tool), args, { runtime, configuration: small });
      const payload = result.structuredContent as { error: { code: string; write_outcome?: string } };
      expect(payload.error.code).toBe('RESPONSE_TOO_LARGE');
      expect(payload.error.write_outcome).toBe(outcome);
      expect(payload).not.toHaveProperty('data');
      expect(fetch).toHaveBeenCalledTimes(1);
      // The same reply fits the default budget: the refusal is the configured bound's.
      const roomy = createRuntime({ client: driver(configuration, () => json(long)).client, limits: configuration.limits });
      try {
        const fits = await executeToolCall(registered(tool), args, { runtime: roomy, configuration });
        expect(fits.isError).toBeUndefined();
      } finally { await roomy.shutdown(); }
    } finally { await runtime.shutdown(); }
  });
});
