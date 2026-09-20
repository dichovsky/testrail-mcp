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
  base = await mkdtemp(join(tmpdir(), 'testrail-mcp-t04-'));
  configuration = await loadConfiguration({
    TESTRAIL_BASE_URL: 'https://runs.testrail.io',
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

/*
 * A closed run refuses every change. What this family owes the caller is that the
 * refusal arrives as TestRail gave it, with an outcome that does not overstate what
 * happened, and that the adapter does not try to reopen the run or work around the
 * refusal on its own.
 */
describe('T04 changes refused by a closed run', () => {
  it.each([
    ['testrail_update_run', { run_id: 9942, body: { name: 'Renamed' } }],
    ['testrail_close_run', { run_id: 9942 }],
  ] as const)('%s reports the refusal and sends exactly one request', async (tool, input) => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'This test run was closed and cannot be modified.' }), {
        status: 400, headers: { 'content-type': 'application/json' },
      }),
    );
    const runtime = runtimeFor(fetch);
    try {
      const result = await executeToolCall(operation(tool), input, { runtime, configuration });
      expect(result.isError).toBe(true);
      const { error } = result.structuredContent as { error: { code: string; http_status?: number; write_outcome?: string } };
      expect(error.code).toBe('UPSTREAM_ERROR');
      expect(error.http_status).toBe(400);
      // Dispatched and never acknowledged: the caller is told the outcome is unknown
      // rather than that nothing was attempted.
      expect(error.write_outcome).toBe('unknown');
      // No reopen, no retry, no second look: one request is the whole call.
      expect(fetch).toHaveBeenCalledTimes(1);
      // TestRail's own sentence is not echoed back; the message is the adapter's own.
      expect(JSON.stringify(result.structuredContent)).not.toContain('cannot be modified');
    } finally { await runtime.shutdown(); }
  });
});

describe('T04 results that are not the entity they name', () => {
  it('returns the bulk label acknowledgement rather than an empty list of tests', async () => {
    const acknowledgement = { test_ids: [1, 2, 3], labels: [{ id: 1, title: 'label1' }] };
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(acknowledgement), { headers: { 'content-type': 'application/json' } }),
    );
    const runtime = runtimeFor(fetch);
    try {
      const result = await executeToolCall(
        operation('testrail_update_tests'),
        { body: { test_ids: [1, 2, 3], labels: [1] } },
        { runtime, configuration },
      );
      expect(result.isError).toBeUndefined();
      /*
       * This endpoint acknowledges the assignment instead of returning the tests. The
       * driver records that modelling it as a test list made every successful call
       * resolve to an empty array, which would tell a caller nothing was changed.
       */
      expect((result.structuredContent as { data: unknown }).data).toEqual(acknowledgement);
    } finally { await runtime.shutdown(); }
  });

  it('merges a test\'s results and attachments into the record when asked for them', async () => {
    const test = { id: 100, case_id: 1, run_id: 1, status_id: 5, title: 'Verify line spacing' };
    const body = { test, results: [{ id: 1, test_id: 100, status_id: 5 }], attachments: [{ id: 'a1', name: 'shot.png' }] };
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }),
    );
    const runtime = runtimeFor(fetch);
    try {
      const result = await executeToolCall(
        operation('testrail_get_test'),
        { test_id: 100, query: { with_data: '1' } },
        { runtime, configuration },
      );
      expect(result.isError).toBeUndefined();
      // One record, as the driver assembles it: the test's own fields alongside what
      // was asked for, rather than TestRail's three-part envelope.
      expect((result.structuredContent as { data: unknown }).data)
        .toEqual({ ...test, results: body.results, attachments: body.attachments });
      expect(String(fetch.mock.calls[0]?.[0])).toContain('get_test/100&with_data=1');
    } finally { await runtime.shutdown(); }
  });
});
