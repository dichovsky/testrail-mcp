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
  base = await mkdtemp(join(tmpdir(), 'testrail-mcp-t02-'));
  configuration = await loadConfiguration({
    TESTRAIL_BASE_URL: 'https://cases.testrail.io',
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

/*
 * The bulk writes are the one place a successful-looking reply can hide an
 * indeterminate outcome: TestRail answered 200, the driver could not recognise the
 * body, and the cases may or may not exist. The issue for this family requires that
 * this reaches the caller as an unknown write outcome with exactly one request and no
 * retry or splitting by the adapter.
 */
describe('T02 bulk writes with an unrecognized successful reply', () => {
  it.each([
    ['testrail_add_cases', { section_id: 5, body: [{ title: 'One' }, { title: 'Two' }] }],
    ['testrail_update_cases', { suite_id: 3, body: { case_ids: [42, 43], priority_id: 1 } }],
  ] as const)('%s reports an unknown outcome and sends one request', async (tool, input) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(JSON.stringify({ added: 2 }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const client = new TestRailClient({
      baseUrl: configuration.baseUrl, email: configuration.email, apiKey: configuration.apiKey,
      registerProcessHandlers: false, maxRetries: 0, fetch,
      dnsLookup: () => Promise.resolve([{ address: '203.0.113.10', family: 4 }]),
    });
    const runtime = createRuntime({ client, limits: configuration.limits });
    try {
      const result = await executeToolCall(operation(tool), input, { runtime, configuration });
      expect(result.isError).toBe(true);
      const { error } = result.structuredContent as { error: { code: string; http_status?: number; write_outcome?: string } };
      expect(error.code).toBe('INVALID_RESPONSE');
      expect(error.http_status).toBe(200);
      expect(error.write_outcome).toBe('unknown');
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally { await runtime.shutdown(); }
  });

  it('testrail_add_cases wraps the array under cases and unwraps the created cases', async () => {
    const created = [{ id: 42, title: 'One', section_id: 5, suite_id: 3, created_by: 1, created_on: 1, updated_by: 1, updated_on: 1 }];
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(JSON.stringify({ cases: created }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const client = new TestRailClient({
      baseUrl: configuration.baseUrl, email: configuration.email, apiKey: configuration.apiKey,
      registerProcessHandlers: false, maxRetries: 0, fetch,
      dnsLookup: () => Promise.resolve([{ address: '203.0.113.10', family: 4 }]),
    });
    const runtime = createRuntime({ client, limits: configuration.limits });
    try {
      const result = await executeToolCall(operation('testrail_add_cases'), { section_id: 5, body: [{ title: 'One' }] }, { runtime, configuration });
      expect(result.isError).toBeUndefined();
      expect((result.structuredContent as { data: unknown }).data).toEqual(created);
      expect(JSON.parse(fetch.mock.calls[0]?.[1]?.body as string)).toEqual({ cases: [{ title: 'One' }] });
    } finally { await runtime.shutdown(); }
  });
});
