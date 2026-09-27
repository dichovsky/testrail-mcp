import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TestRailClient } from '@dichovsky/testrail-api-client';
import { Client, InMemoryTransport, type Tool } from '@modelcontextprotocol/client';
import type { JsonSchemaType } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/server/validators/ajv';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
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

  /*
   * The advertised schema is itself the machine-readable contract, so it is held to the
   * documented wrapper rather than trusted: `data` required, `pagination` an object,
   * `warnings` an array of objects, and entity fields unconstrained. Validating results
   * against it alone would only catch a schema that grew stricter.
   */
  it('advertises the documented wrapper as every tool\'s output schema', () => {
    const verdicts = [...advertised.values()].map(({ name, outputSchema }) => {
      const valid = validator.getValidator(outputSchema as unknown as JsonSchemaType);
      return {
        name,
        accepts: [{ data: null }, { data: [] }, { data: { custom_x: 1 } }, { data: 1, pagination: {}, warnings: [{}] }].every((value) => valid(value).valid),
        rejects: [{}, { warnings: [] }, { data: 1, pagination: 'page' }, { data: 1, warnings: {} }, { data: 1, warnings: [1] }, []].every((value) => !valid(value).valid),
      };
    });
    expect(verdicts).toHaveLength(133);
    expect(verdicts.filter(({ accepts, rejects }) => !accepts || !rejects)).toEqual([]);
  });

  it.each(calls)('%s (%s, fixture %s) validates against its advertised output schema and preserves its data', async (tool, _mode, _id, operation, fixture) => {
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
    // The SDK client validates as well; this check does not depend on it doing so.
    const verdict = validator.getValidator(outputSchema as unknown as JsonSchemaType)(result.structuredContent);
    expect(verdict.valid, JSON.stringify(verdict)).toBe(true);
    // One text block carrying exactly the structured wrapper, byte for byte: its compact
    // serialization, in the same key order.
    const content = result.content as { type: string; text: string }[];
    expect(content).toHaveLength(1);
    expect(content[0]?.type).toBe('text');
    expect(content[0]?.text).toBe(JSON.stringify(result.structuredContent));
    // A paged list says how much of the dataset it returned; nothing else claims to.
    expect(Object.hasOwn(result.structuredContent ?? {}, 'pagination')).toBe(operation.pagination.kind !== 'none');
    // The data is what the driver returned, unchanged: the manifest's hand-written driver
    // result, its items for a page, and null for a void method. A download returns the
    // written file's description instead, whose path cannot be known in advance.
    if (operation.files.kind !== 'download') {
      const expected = fixture.expect.driver_result;
      const data = (result.structuredContent as { data: unknown }).data;
      if (expected.kind === 'void') expect(data).toBeNull();
      else if (expected.kind === 'json') {
        expect(data).toEqual(operation.pagination.kind !== 'none' && _mode === 'page'
          ? (expected.value as { items: unknown }).items
          : expected.value);
      }
    }
  });

  it.each([
    ['a refused argument', 'testrail_get_project', { project_id: 'seven' }, json({}), 'INVALID_ARGUMENT', undefined],
    ['an upstream 404', 'testrail_get_project', { project_id: 7 }, json({ error: 'Field :project_id is not a valid or accessible project.' }, 404), 'NOT_FOUND', undefined],
    ['a write TestRail refused with 500', 'testrail_add_project', { body: { name: 'Gate' } }, json({ error: 'Internal error' }, 500), 'UPSTREAM_ERROR', 'unknown'],
    ['an aggregate past max_items', 'testrail_get_projects', { _mcp: { pagination: 'all', max_items: 1 } },
      json({ offset: 0, limit: 1, size: 1, _links: { next: '/api/v2/get_projects&limit=1&offset=1', prev: null }, projects: [{ id: 1, name: 'One' }] }),
      'PAGINATION_LIMIT', undefined, 'max_items'],
  ] as const)('keeps the error wrapper identical in text and structure for %s', async (_label, tool, args, upstream, code, outcome, reason?: string) => {
    next = upstream;
    const result = await client.callTool({ name: tool, arguments: args });
    expect(result.isError).toBe(true);
    const content = result.content as { type: string; text: string }[];
    expect(content).toHaveLength(1);
    expect(content[0]?.text).toBe(JSON.stringify(result.structuredContent));
    const payload = result.structuredContent as { error: { code: string; write_outcome?: string; reason?: string } };
    expect(payload).not.toHaveProperty('data');
    expect(payload.error.code).toBe(code);
    expect(payload.error.write_outcome).toBe(outcome);
    expect(payload.error.reason).toBe(reason);
  });
});

describe('a read whose success reply cannot be used', () => {
  it.each([
    ['a record read', 'testrail_get_project', { project_id: 7 }, { status: 200, body: 'not json at all', type: 'application/json' }],
    ['a record read', 'testrail_get_project', { project_id: 7 }, json([{ id: 7 }])],
    ['an array read', 'testrail_get_case_types', {}, json({ case_types: [] })],
    ['a page read', 'testrail_get_projects', {}, json('a string where the envelope belongs')],
    ['an aggregate read', 'testrail_get_projects', { _mcp: { pagination: 'all' } }, { status: 200, body: 'not json at all', type: 'application/json' }],
    ['an aggregate read', 'testrail_get_projects', { _mcp: { pagination: 'all' } }, json({ offset: 0, limit: 1, size: 1, _links: { next: null, prev: null } })],
    // A well-formed envelope for a page the aggregate did not ask for.
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

  it('gives joined identical calls one set of warnings each, and a concurrent or later clean call none', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let drifting = true;
    const { client, fetch } = driver(configuration, async (url) => {
      await gate;
      return /get_project\/7$/u.test(url) ? json(drifting ? drifted : { ...entity, id: 7 }) : json({ ...entity, id: 8 });
    });
    const runtime = createRuntime({ client, limits: configuration.limits });
    try {
      const call = (id: number) => executeToolCall(registered('testrail_get_project'), { project_id: id }, { runtime, configuration });
      const pending = [call(7), call(7), call(7), call(8)];
      // The three identical reads share one request; the fourth has its own.
      await vi.waitFor(() => { expect(fetch).toHaveBeenCalledTimes(2); });
      release();
      const [first, second, third, other] = await Promise.all(pending);
      const warnings = (result: { structuredContent?: unknown } | undefined) => (result?.structuredContent as { warnings?: unknown[] } | undefined)?.warnings;
      // One field drifted (a number where the name belongs): each joiner gets exactly that.
      for (const joined of [first, second, third]) expect(warnings(joined)).toEqual([{ code: 'SCHEMA_DRIFT', count: 1 }]);
      expect(warnings(other)).toBeUndefined();
      expect(fetch).toHaveBeenCalledTimes(2);
      // Nothing carries over to a later identical call whose reply is clean.
      drifting = false;
      const later = await executeToolCall(registered('testrail_get_project'), { project_id: 7 }, { runtime, configuration });
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(later.isError).toBeUndefined();
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

/*
 * F05's acceptance evidence that the sweep above cannot give: behaviour at the adapter's
 * own checks, which the driver usually pre-empts, and the claims that need a hostile
 * schema or a reply that goes missing. Every call runs through a registered tool.
 */
describe('F05 result evidence through registered tools', () => {
  type Result = { isError?: boolean; structuredContent?: unknown };
  const payloadOf = (result: Result) => result.structuredContent as { data?: unknown; warnings?: unknown; error?: Record<string, unknown> };
  const withEntity = (operation: Operation, entitySchema: z.ZodType) =>
    ({ ...operation, response: { ...operation.response, entitySchema } }) as unknown as Operation;

  it('gives two different drifting operations running at once their own exact counts, and a later drift its own', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { client } = driver(configuration, async (url) => {
      await gate;
      if (/get_project\/1$/u.test(url)) return json({ a: 'x' });
      if (/get_project\/2$/u.test(url)) return json({ a: 'x', b: 'y' });
      return json({ a: 'x', b: 'y', c: 'z' });
    });
    const runtime = createRuntime({ client, limits: configuration.limits });
    const one = withEntity(registered('testrail_get_project'), z.object({ a: z.number(), b: z.number().optional() }));
    const three = withEntity(registered('testrail_get_suite'), z.object({ a: z.number(), b: z.number(), c: z.number() }));
    try {
      const pending = [
        executeToolCall(one, { project_id: 1 }, { runtime, configuration }),
        executeToolCall(three, { suite_id: 3 }, { runtime, configuration }),
      ];
      release();
      const [first, second] = await Promise.all(pending);
      expect(payloadOf(first!).warnings).toEqual([{ code: 'SCHEMA_DRIFT', count: 1 }]);
      expect(payloadOf(second!).warnings).toEqual([{ code: 'SCHEMA_DRIFT', count: 3 }]);
      // A second drifted call of the first operation reports its own count, not a reused one.
      const later = await executeToolCall(one, { project_id: 2 }, { runtime, configuration });
      expect(payloadOf(later).warnings).toEqual([{ code: 'SCHEMA_DRIFT', count: 2 }]);
    } finally {
      release();
      await runtime.shutdown();
    }
  });

  it.each([
    ['a read', 'testrail_get_project', { project_id: 7 }, { id: 7, name: 'Kept' }],
    ['a write TestRail accepted', 'testrail_add_project', { body: { name: 'Kept' } }, { id: 9, name: 'Kept' }],
  ] as const)('returns %s whose advisory schema throws, with its data and one drift warning', async (_label, tool, args, body) => {
    const { client } = driver(configuration, () => json(body));
    const runtime = createRuntime({ client, limits: configuration.limits });
    const throwing = z.record(z.string(), z.unknown()).refine(() => { throw new Error('advisory hook failed'); });
    try {
      const result = await executeToolCall(withEntity(registered(tool), throwing), args, { runtime, configuration });
      expect(result.isError).toBeUndefined();
      expect(payloadOf(result)).toEqual({ data: body, warnings: [{ code: 'SCHEMA_DRIFT', count: 1 }] });
    } finally { await runtime.shutdown(); }
  });

  const rewritten = { id: '7', custom_x: 1 };
  const projectPage = { offset: 0, limit: 250, size: 1, _links: { next: null, prev: null }, projects: [rewritten] };
  it.each([
    ['a record', 'testrail_get_project', { project_id: 7 }, rewritten, rewritten],
    ['a list', 'testrail_get_case_titles', { query: { case_ids: [7] } }, [rewritten], [rewritten]],
    ['a page', 'testrail_get_projects', {}, projectPage, [rewritten]],
    ['an aggregate', 'testrail_get_projects', { _mcp: { pagination: 'all' } }, projectPage, [rewritten]],
  ] as const)('returns %s reply unchanged when the advisory schema coerces, defaults and transforms', async (_label, tool, args, reply, expected) => {
    const { client } = driver(configuration, () => json(structuredClone(reply)));
    const runtime = createRuntime({ client, limits: configuration.limits });
    const rewriting = z.object({ id: z.coerce.number(), status: z.string().default('active') })
      .transform((value) => ({ ...value, extra: 1 }));
    try {
      const result = await executeToolCall(withEntity(registered(tool), rewriting), args, { runtime, configuration });
      expect(payloadOf(result).data).toEqual(expected);
      expect(payloadOf(result).warnings).toBeUndefined();
    } finally { await runtime.shutdown(); }
  });

  /*
   * The driver validates a page before the adapter sees it, so the adapter's own checks
   * are reached here by a driver call that returns the malformed value directly.
   */
  it.each([
    ['a page whose kind is unknown', 'page', { kind: 'bogus', items: [] }],
    ['a page without items', 'page', { kind: 'envelope' }],
    ['an aggregate that is not an array', 'all', { projects: [] }],
    ['an aggregate that is a string', 'all', 'x'],
  ] as const)('fails %s at the adapter as INVALID_RESPONSE', async (_label, mode, value) => {
    const base = registered('testrail_get_projects');
    if (base.pagination.kind === 'none') throw new Error('testrail_get_projects must page');
    const call = mode === 'page' ? base.pagination.page : base.pagination.all;
    const operation = { ...base, pagination: { ...base.pagination, [mode]: { ...call, invoke: () => Promise.resolve(value) } } } as unknown as Operation;
    const { client } = driver(configuration, () => json({}));
    const runtime = createRuntime({ client, limits: configuration.limits });
    try {
      const args = mode === 'all' ? { _mcp: { pagination: 'all' } } : {};
      const result = await executeToolCall(operation, args, { runtime, configuration });
      expect(payloadOf(result).error).toMatchObject({ code: 'INVALID_RESPONSE' });
      expect(payloadOf(result)).not.toHaveProperty('data');
    } finally { await runtime.shutdown(); }
  });

  it('reports a 404 only as a missing resource, and an unknown-method reply as TestRail\'s own error', async () => {
    const replies: Reply[] = [
      json({ error: 'Field :project_id is not a valid or accessible project.' }, 404),
      // What a TestRail too old for an endpoint answers: nothing may infer a version from it.
      json({ error: 'Unknown method \'get_project\'' }, 400),
    ];
    const { client } = driver(configuration, () => replies.shift() ?? json({}));
    const runtime = createRuntime({ client, limits: configuration.limits });
    try {
      const missing = payloadOf(await executeToolCall(registered('testrail_get_project'), { project_id: 7 }, { runtime, configuration })).error;
      expect(missing).toEqual({ code: 'NOT_FOUND', message: 'TestRail reported that the requested resource does not exist.', http_status: 404 });
      expect(JSON.stringify(missing)).not.toMatch(/version|support/iu);
      const unknownMethod = payloadOf(await executeToolCall(registered('testrail_get_project'), { project_id: 7 }, { runtime, configuration })).error;
      expect(unknownMethod).toEqual({ code: 'UPSTREAM_ERROR', message: 'TestRail returned an error.', http_status: 400 });
    } finally { await runtime.shutdown(); }
  });

  /* Production retry settings: the driver re-sends a write after nothing but a 429. */
  it.each([
    ['a network error', () => Promise.reject(new TypeError('fetch failed')), { code: 'INVALID_RESPONSE' }],
    ['a 500 reply', () => Promise.resolve(new Response('{"error":"x"}', { status: 500, headers: { 'content-type': 'application/json' } })), { code: 'UPSTREAM_ERROR', http_status: 500 }],
    ['a 200 reply that is not JSON', () => Promise.resolve(new Response('<html>ok</html>', { status: 200, headers: { 'content-type': 'application/json' } })), { code: 'INVALID_RESPONSE' }],
  ] as const)('reports a JSON write whose reply is lost to %s as unknown, sent once', async (_label, respond, error) => {
    const fetch = vi.fn(respond);
    const client = new TestRailClient({
      ...driverOptions(configuration),
      dnsLookup: () => Promise.resolve([{ address: '203.0.113.10', family: 4 }]),
      fetch,
    });
    const runtime = createRuntime({ client, limits: configuration.limits });
    try {
      for (const [tool, args] of [
        ['testrail_add_project', { body: { name: 'Lost' } }],
        ['testrail_add_results_for_cases', { run_id: 1, body: { results: [{ case_id: 1, status_id: 1 }] } }],
      ] as const) {
        fetch.mockClear();
        const result = await executeToolCall(registered(tool), args, { runtime, configuration });
        expect(payloadOf(result).error, tool).toMatchObject({ ...error, write_outcome: 'unknown' });
        expect(payloadOf(result), tool).not.toHaveProperty('data');
        expect(fetch, tool).toHaveBeenCalledTimes(1);
      }
    } finally { await runtime.shutdown(); }
  });

  it('enforces the configured data budget through a tool, never truncating', async () => {
    const small = await loadConfiguration({
      TESTRAIL_BASE_URL: 'https://results.testrail.io', TESTRAIL_EMAIL: 'user@example.com', TESTRAIL_API_KEY: 'synthetic',
      TESTRAIL_MCP_UPLOAD_ROOTS: JSON.stringify([base]), TESTRAIL_MCP_DOWNLOAD_DIR: base,
      TESTRAIL_MCP_LIMITS: JSON.stringify({ max_data_bytes: 200, max_all_bytes: 200 }),
    });
    const { client } = driver(small, () => json({ id: 7, name: 'n'.repeat(300) }));
    const runtime = createRuntime({ client, limits: small.limits });
    try {
      const result = await executeToolCall(registered('testrail_get_project'), { project_id: 7 }, { runtime, configuration: small });
      expect(payloadOf(result).error).toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
      expect(payloadOf(result)).not.toHaveProperty('data');
    } finally { await runtime.shutdown(); }
  });

  it('keeps arguments, response bodies, paths and hosts out of every tool_call diagnostic', async () => {
    const marker = 'argument-marker-6f1c';
    const secretBody = JSON.stringify({ error: 'api_key=SECRET-9d2 at https://internal.example.test /Users/someone/private' });
    const replies: Reply[] = [{ status: 500, body: secretBody, type: 'application/json' }, json({ id: 7, name: 'data-marker-3b8e' })];
    const { client } = driver(configuration, () => replies.shift() ?? json({}));
    const runtime = createRuntime({ client, limits: configuration.limits });
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await executeToolCall(registered('testrail_add_project'), { body: { name: marker } }, { runtime, configuration });
      await executeToolCall(registered('testrail_get_project'), { project_id: 7 }, { runtime, configuration });
      const outside = join(tmpdir(), `outside-${marker}`, 'secret.txt');
      await executeToolCall(registered('testrail_add_attachment_to_case'), { case_id: 1, file_path: outside, filename: 'x.txt' }, {
        runtime, configuration, stagingDirectory: () => Promise.resolve(base),
      });
      const lines = write.mock.calls.map(([chunk]) => String(chunk));
      // One event per call, in call order, each carrying only its fixed code.
      expect(lines.map((line) => {
        const { tool, outcome, code } = JSON.parse(line) as Record<string, unknown>;
        return [tool, outcome, code];
      })).toEqual([
        ['testrail_add_project', 'error', 'UPSTREAM_ERROR'],
        ['testrail_get_project', 'success', undefined],
        ['testrail_add_attachment_to_case', 'error', 'FILE_ACCESS_DENIED'],
      ]);
      // Only these fields may ever appear.
      const allowed = new Set(['event', 'correlation', 'tool', 'outcome', 'code', 'duration_ms', 'warnings']);
      for (const line of lines) {
        const event = JSON.parse(line) as Record<string, unknown>;
        expect(event.event).toBe('tool_call');
        expect(Object.keys(event).filter((key) => !allowed.has(key))).toEqual([]);
        for (const leaked of [marker, 'SECRET-9d2', 'internal.example.test', '/Users/someone', 'data-marker-3b8e', outside, configuration.baseUrl, new URL(configuration.baseUrl).host, configuration.apiKey]) {
          expect(line).not.toContain(leaked);
        }
      }
    } finally {
      write.mockRestore();
      await runtime.shutdown();
    }
  });

  it('never puts a local path in a FILE_ACCESS_DENIED error', async () => {
    const { client } = driver(configuration, () => json({ attachment_id: 1 }));
    const runtime = createRuntime({ client, limits: configuration.limits });
    const outside = join(tmpdir(), 'outside-path-marker-51a0', 'secret.txt');
    try {
      const result = await executeToolCall(registered('testrail_add_attachment_to_case'), { case_id: 1, file_path: outside, filename: 'x.txt' }, {
        runtime, configuration, stagingDirectory: () => Promise.resolve(base),
      });
      expect(payloadOf(result).error).toMatchObject({ code: 'FILE_ACCESS_DENIED', write_outcome: 'not_started' });
      expect(JSON.stringify(result)).not.toContain('outside-path-marker-51a0');
      expect(JSON.stringify(result)).not.toContain(tmpdir());
    } finally { await runtime.shutdown(); }
  });
});
