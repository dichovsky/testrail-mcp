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
  base = await mkdtemp(join(tmpdir(), 'testrail-mcp-t05-'));
  configuration = await loadConfiguration({
    TESTRAIL_BASE_URL: 'https://results.testrail.io',
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

const ENTRIES = [
  { test_id: 101, status_id: 5, comment: 'This test failed' },
  { test_id: 102, status_id: 1, comment: 'This test passed' },
];

/*
 * A bulk submission is the one call in this family where a partial answer is possible,
 * and the contracts forbid inventing a recovery for it. What the caller is owed is the
 * truth about how far the call got, after exactly one request.
 */
describe('T05 bulk result submission', () => {
  it('sends one request and never splits the entries', async () => {
    const created = ENTRIES.map((entry, index) => ({ id: index + 1, ...entry }));
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(created), { headers: { 'content-type': 'application/json' } }),
    );
    const runtime = runtimeFor(fetch);
    try {
      const result = await executeToolCall(
        operation('testrail_add_results'),
        { run_id: 1, body: { results: ENTRIES } },
        { runtime, configuration },
      );
      expect(result.isError).toBeUndefined();
      // TestRail answers in the order the entries were sent, and that order is kept.
      expect((result.structuredContent as { data: unknown }).data).toEqual(created);
      expect(fetch).toHaveBeenCalledTimes(1);
      const sent = fetch.mock.calls[0]?.[1] as { body?: string } | undefined;
      expect(JSON.parse(sent?.body ?? 'null')).toEqual({ results: ENTRIES });
    } finally { await runtime.shutdown(); }
  });

  it('reports an unusable reply as acknowledged rather than as a partial success', async () => {
    /*
     * A 200 whose body is not the documented array leaves the caller unable to see
     * which entries were recorded, and it must not be softened into an empty list of
     * created results. The outcome is acknowledged rather than unknown, and the
     * difference is real: response validation here is advisory, so the driver resolves
     * and this adapter is what refuses the body. TestRail did accept the submission,
     * so repeating it would record every entry a second time. The Cases bulk writes
     * report unknown instead, because their driver method fails closed and never
     * resolves at all.
     */
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ recorded: 2 }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const runtime = runtimeFor(fetch);
    try {
      const result = await executeToolCall(
        operation('testrail_add_results_for_cases'),
        { run_id: 1, body: { results: [{ case_id: 1, status_id: 1 }] } },
        { runtime, configuration },
      );
      expect(result.isError).toBe(true);
      const { error } = result.structuredContent as { error: { code: string; write_outcome?: string } };
      expect(error.code).toBe('INVALID_RESPONSE');
      expect(error.write_outcome).toBe('acknowledged');
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally { await runtime.shutdown(); }
  });
});

describe('T05 reads that name a case rather than a test', () => {
  it('puts both identifiers in the path, in the order the endpoint documents', async () => {
    const body = { offset: 0, limit: 50, size: 0, _links: { next: null, prev: null }, results: [] };
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }),
    );
    const runtime = runtimeFor(fetch);
    try {
      const result = await executeToolCall(
        operation('testrail_get_results_for_case'),
        { run_id: 1, case_id: 2, query: { status_id: [4, 5] } },
        { runtime, configuration },
      );
      expect(result.isError).toBeUndefined();
      // The run comes first and the case second: reversing them would read a
      // different case's results without any error to show for it.
      expect(String(fetch.mock.calls[0]?.[0]))
        .toContain('get_results_for_case/1/2&status_id=4%2C5&limit=50&offset=0');
    } finally { await runtime.shutdown(); }
  });

  it('drops no creation filter silently: the per-test list refuses what it cannot send', async () => {
    const runtime = runtimeFor(vi.fn());
    try {
      const result = await executeToolCall(
        operation('testrail_get_results'),
        { test_id: 101, query: { created_by: [1] } },
        { runtime, configuration },
      );
      /*
       * The driver contributes the creation filters for the run-wide list alone and
       * discards them elsewhere. Accepting one here would tell a caller their filter
       * applied when the request never carried it.
       */
      expect(result.isError).toBe(true);
      expect((result.structuredContent as { error: { code: string } }).error.code).toBe('INVALID_ARGUMENT');
    } finally { await runtime.shutdown(); }
  });
});
