import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TestRailClient } from '@dichovsky/testrail-api-client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConfiguration, type Configuration } from '../../src/config/environment.js';
import { operationRegistry } from '../../src/operations/catalog.js';
import { createRuntime } from '../../src/runtime/invocation.js';
import { executeToolCall } from '../../src/transport/tool-call.js';

let base: string;
let configuration: Configuration;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'testrail-mcp-t09-'));
  configuration = await loadConfiguration({
    TESTRAIL_BASE_URL: 'https://people.testrail.io',
    TESTRAIL_EMAIL: 'user@example.com',
    TESTRAIL_API_KEY: 'synthetic',
    TESTRAIL_MCP_UPLOAD_ROOTS: JSON.stringify([base]),
    TESTRAIL_MCP_DOWNLOAD_DIR: base,
  });
});

afterAll(async () => { await rm(base, { recursive: true, force: true }); });

function operation(tool: string) {
  const found = operationRegistry.get(tool);
  if (found === undefined) throw new Error(`Missing registration: ${tool}`);
  return found;
}

function runtimeFor(fetch: ReturnType<typeof vi.fn>) {
  return createRuntime({
    client: new TestRailClient({
      baseUrl: configuration.baseUrl, email: configuration.email, apiKey: configuration.apiKey,
      registerProcessHandlers: false, maxRetries: 0,
      dnsLookup: () => Promise.resolve([{ address: '203.0.113.10', family: 4 }]),
      fetch: fetch as unknown as typeof globalThis.fetch,
    }),
    limits: configuration.limits,
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function requested(fetch: ReturnType<typeof vi.fn>, index = 0): string {
  return String(fetch.mock.calls[index]?.[0]);
}

function sentBody(fetch: ReturnType<typeof vi.fn>, index = 0): unknown {
  const init = fetch.mock.calls[index]?.[1] as { body?: string } | undefined;
  return JSON.parse(init?.body ?? 'null');
}

function data(result: { structuredContent?: unknown }): unknown {
  return (result.structuredContent as { data: unknown }).data;
}

function errorOf(result: { structuredContent?: unknown }): { code: string; http_status?: number } {
  return (result.structuredContent as { error: { code: string; http_status?: number } }).error;
}

const DATASET = { id: 183, name: 'Default', variables: [{ id: 1171, name: 'age', value: '41' }] };
const VARIABLE = { id: 611, name: 'd' };

function envelope(collection: string, items: readonly unknown[], next: string | null = null): unknown {
  return { offset: 0, limit: 250, size: items.length, _links: { next, prev: null }, [collection]: items };
}

/*
 * A dataset's values are written as a map keyed by variable name, which is the only
 * place in this server where a caller's own strings become object keys of a request
 * body. Every other payload has a fixed field set, so nothing else can be mistaken for
 * a control. These names deliberately collide with this server's own vocabulary.
 */
describe('T09 the variable names a dataset write is allowed to use', () => {
  it('sends a name that collides with a paging control as the variable name it is', async () => {
    const variables = { limit: '250', offset: '0', _mcp: 'all', variables: 'nested', pagination: 'page' };
    const fetch = vi.fn().mockResolvedValue(json(DATASET));
    const runtime = runtimeFor(fetch);
    try {
      const result = await executeToolCall(operation('testrail_add_dataset'),
        { project_id: 7, body: { name: 'Collisions', variables } }, { runtime, configuration });
      expect(result.isError).toBeUndefined();
      expect(sentBody(fetch)).toEqual({ name: 'Collisions', variables });
      // None of them became a query parameter or a second path segment.
      expect(requested(fetch)).toMatch(/\/api\/v2\/add_dataset\/7$/);
    } finally { await runtime.shutdown(); }
  });

  it.each([
    ['a quote and a backslash', 'sa"y\\no'],
    ['a dotted name', 'browser.version'],
    ['a name that is only spaces', '   '],
    ['a non-Latin name', 'браузер'],
    ['an astral symbol', 'browser\u{1F600}'],
  ] as const)('preserves %s byte for byte', async (_label, name) => {
    const fetch = vi.fn().mockResolvedValue(json(DATASET));
    const runtime = runtimeFor(fetch);
    try {
      const result = await executeToolCall(operation('testrail_add_dataset'),
        { project_id: 7, body: { name: 'Odd names', variables: { [name]: 'Chrome' } } },
        { runtime, configuration });
      expect(result.isError).toBeUndefined();
      const sent = sentBody(fetch) as { variables: Record<string, string> };
      expect(Object.keys(sent.variables)).toEqual([name]);
      expect(sent.variables[name]).toBe('Chrome');
    } finally { await runtime.shutdown(); }
  });

  /*
   * An empty map and an absent one are different requests. Dropping either would ask
   * TestRail to do something the caller did not ask for, and neither is this server's
   * to decide, so both are forwarded exactly as written.
   */
  it('keeps an empty map and an absent one apart', async () => {
    // A fresh response per call: a Response body is read once, so a single shared one
    // would leave the second call reading a drained stream and proving nothing.
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(json({ ...DATASET, id: 2 })));
    const runtime = runtimeFor(fetch);
    try {
      const cleared = await executeToolCall(operation('testrail_update_dataset'),
        { dataset_id: 2, body: { variables: {} } }, { runtime, configuration });
      expect(cleared.isError).toBeUndefined();
      expect(sentBody(fetch, 0)).toEqual({ variables: {} });
      const untouched = await executeToolCall(operation('testrail_update_dataset'),
        { dataset_id: 2, body: {} }, { runtime, configuration });
      expect(untouched.isError).toBeUndefined();
      expect(sentBody(fetch, 1)).toEqual({});
    } finally { await runtime.shutdown(); }
  });

  it.each([
    ['testrail_update_dataset', 'dataset_id', 'update_dataset/2'],
    ['testrail_update_variable', 'variable_id', 'update_variable/2'],
  ] as const)('sends %s an empty body rather than no body at all', async (tool, key, endpoint) => {
    const fetch = vi.fn().mockResolvedValue(json(
      tool.endsWith('variable') ? { ...VARIABLE, id: 2 } : { ...DATASET, id: 2 },
    ));
    const runtime = runtimeFor(fetch);
    try {
      const result = await executeToolCall(operation(tool), { [key]: 2, body: {} }, { runtime, configuration });
      expect(result.isError).toBeUndefined();
      expect(requested(fetch)).toContain(endpoint);
      // TestRail documents the empty body as a no-op; the request still carries one.
      expect(sentBody(fetch)).toEqual({});
    } finally { await runtime.shutdown(); }
  });
});

/*
 * The read projection is not the write map: TestRail answers with an array of entries
 * that carry identifiers, and either the value or the whole array may be missing.
 */
describe('T09 what a dataset reply is allowed to leave out', () => {
  it('reports an unset value as null rather than as an absent one', async () => {
    const fetch = vi.fn().mockResolvedValue(json({
      id: 184, name: 'Partly filled', variables: [{ id: 1171, name: 'age', value: null }],
    }));
    const runtime = runtimeFor(fetch);
    try {
      const result = await executeToolCall(operation('testrail_get_dataset'),
        { dataset_id: 184 }, { runtime, configuration });
      expect(result.isError).toBeUndefined();
      expect(data(result)).toEqual({
        id: 184, name: 'Partly filled', variables: [{ id: 1171, name: 'age', value: null }],
      });
    } finally { await runtime.shutdown(); }
  });

  it('does not invent a variables array for a dataset that carries none', async () => {
    const fetch = vi.fn().mockResolvedValue(json({ id: 185, name: 'Empty' }));
    const runtime = runtimeFor(fetch);
    try {
      const result = await executeToolCall(operation('testrail_get_dataset'),
        { dataset_id: 185 }, { runtime, configuration });
      expect(result.isError).toBeUndefined();
      expect(data(result)).toEqual({ id: 185, name: 'Empty' });
      expect(Object.hasOwn(data(result) as object, 'variables')).toBe(false);
    } finally { await runtime.shutdown(); }
  });
});

/*
 * Both lists are paged by the server with no controls of their own, so a caller who
 * wants more cannot ask for the next offset. Saying so is the only honest advice.
 */
describe('T09 continuing a list the server pages itself', () => {
  it.each([
    ['testrail_get_datasets', 'datasets', DATASET],
    ['testrail_get_variables', 'variables', VARIABLE],
  ] as const)('%s offers the bounded aggregate rather than an offset', async (tool, collection, item) => {
    const fetch = vi.fn().mockResolvedValue(json(
      envelope(collection, [item], 'https://people.testrail.io/index.php?/api/v2/x&offset=250'),
    ));
    const runtime = runtimeFor(fetch);
    try {
      const result = await executeToolCall(operation(tool), { project_id: 2 }, { runtime, configuration });
      expect(result.isError).toBeUndefined();
      const { pagination } = result.structuredContent as { pagination: Record<string, unknown> };
      expect(pagination.has_more).toBe(true);
      expect(pagination.manual_continuation).toBe(false);
      expect(pagination.next_action).toBe('all');
      expect(pagination.next_offset).toBeUndefined();
    } finally { await runtime.shutdown(); }
  });
});

/*
 * Datasets and variables are an Enterprise feature, and TestRail's own reference
 * documents the refusal on all nine endpoints. This server cannot know an instance's
 * edition before it calls, so it must call and report what came back. The driver
 * separates that refusal from an ordinary permission denial, and the separation is
 * worth keeping: one is answered by buying a licence and the other by an administrator.
 */
describe('T09 an instance without the Enterprise feature', () => {
  it.each([
    ['testrail_get_datasets', { project_id: 2 }],
    ['testrail_get_variables', { project_id: 2 }],
    ['testrail_get_dataset', { dataset_id: 183 }],
    ['testrail_delete_variable', { variable_id: 611 }],
  ] as const)('reports %s as a licence restriction, after asking', async (tool, input) => {
    const fetch = vi.fn().mockResolvedValue(json({ error: 'Not an Enterprise license/subscription.' }, 403));
    const runtime = runtimeFor(fetch);
    try {
      const result = await executeToolCall(operation(tool), input, { runtime, configuration });
      // Dispatched rather than pre-empted: the edition is instance state, not input.
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(result.isError).toBe(true);
      const error = errorOf(result);
      expect(error.code).toBe('LICENSE_REQUIRED');
      expect(error.http_status).toBe(403);
      // TestRail's own sentence is not echoed back; the message is this server's.
      expect(JSON.stringify(result.structuredContent)).not.toContain('Enterprise');
    } finally { await runtime.shutdown(); }
  });

  it('keeps an ordinary permission denial distinct from the licence one', async () => {
    const fetch = vi.fn().mockResolvedValue(json({ error: 'You do not have permission.' }, 403));
    const runtime = runtimeFor(fetch);
    try {
      const result = await executeToolCall(operation('testrail_get_datasets'),
        { project_id: 2 }, { runtime, configuration });
      expect(result.isError).toBe(true);
      expect(errorOf(result).code).toBe('PERMISSION_DENIED');
    } finally { await runtime.shutdown(); }
  });
});

/*
 * TestRail states that deleting a variable also deletes its values from the project's
 * datasets. That cascade is TestRail's, and this server neither anticipates it by
 * enumerating datasets first nor tidies up after it.
 */
describe('T09 deleting the object a dataset value hangs from', () => {
  it.each([
    ['testrail_delete_variable', { variable_id: 611 }, 'delete_variable/611'],
    ['testrail_delete_dataset', { dataset_id: 183 }, 'delete_dataset/183'],
  ] as const)('%s sends one request and reports no data', async (tool, input, endpoint) => {
    const fetch = vi.fn().mockResolvedValue(json({}));
    const runtime = runtimeFor(fetch);
    try {
      const result = await executeToolCall(operation(tool), input, { runtime, configuration });
      expect(result.isError).toBeUndefined();
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(requested(fetch)).toContain(endpoint);
      expect(data(result)).toBeNull();
    } finally { await runtime.shutdown(); }
  });

  it('publishes both deletions as destructive and neither update as one', () => {
    const destructive = ['testrail_delete_dataset', 'testrail_delete_variable']
      .map((tool) => operation(tool).annotations.destructiveHint);
    expect(destructive).toEqual([true, true]);
    const updates = ['testrail_update_dataset', 'testrail_update_variable']
      .map((tool) => operation(tool).annotations.destructiveHint);
    expect(updates).toEqual([false, false]);
  });
});
