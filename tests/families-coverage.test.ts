import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TestRailClient } from '@dichovsky/testrail-api-client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConfiguration, type Configuration } from '../src/config/environment.js';
import { DEFAULT_LIMITS } from '../src/config/limits.js';
import { AdapterError } from '../src/contracts/errors.js';
import { operationRegistry } from '../src/operations/catalog.js';
import { staged } from '../src/operations/families/common.js';
import { createRuntime } from '../src/runtime/invocation.js';
import { executeToolCall } from '../src/transport/tool-call.js';

let base: string;
let configuration: Configuration;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'testrail-mcp-families-coverage-'));
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

function clientFor(fetch: ReturnType<typeof vi.fn>): TestRailClient {
  return new TestRailClient({
    baseUrl: configuration.baseUrl, email: configuration.email, apiKey: configuration.apiKey,
    registerProcessHandlers: false, maxRetries: 0,
    dnsLookup: () => Promise.resolve([{ address: '203.0.113.10', family: 4 }]),
    fetch: fetch as unknown as typeof globalThis.fetch,
  });
}

describe('staged upload', () => {
  it('returns the staged copy the adapter supplied', () => {
    const upload = { path: '/staged/copy.feature', type: 'text/plain' };
    expect(staged({ limits: DEFAULT_LIMITS, upload })).toBe(upload);
  });

  it('is an internal error, not a caller error, when nothing was staged', () => {
    let thrown: unknown;
    try { staged({ limits: DEFAULT_LIMITS }); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(AdapterError);
    expect((thrown as AdapterError).code).toBe('INTERNAL_ERROR');
  });

  it('stops an upload driver call before any request when the copy is missing', async () => {
    const fetch = vi.fn();
    const client = clientFor(fetch);
    try {
      const { pagination } = operation('testrail_update_bdd');
      if (pagination.kind !== 'none') throw new Error('update_bdd is a single call');
      await expect(pagination.single.invoke(
        client,
        { case_id: 1, file_path: join(base, 'scenario.feature'), filename: 'scenario.feature' },
        { limits: DEFAULT_LIMITS },
      )).rejects.toMatchObject({ name: 'AdapterError', code: 'INTERNAL_ERROR' });
      expect(fetch).not.toHaveBeenCalled();
    } finally { client.destroy(); }
  });
});

describe('T04 get_test with data, when TestRail refuses', () => {
  it('passes an upstream error through rather than blaming the reply', async () => {
    // Only a TypeError from assembling the parts means the reply was malformed; an
    // ordinary API error must keep its own classification and status.
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'Field :test_id is not a valid test.' }), {
        status: 404, headers: { 'content-type': 'application/json' },
      }),
    );
    const runtime = createRuntime({ client: clientFor(fetch), limits: configuration.limits });
    try {
      const result = await executeToolCall(
        operation('testrail_get_test'),
        { test_id: 100, query: { with_data: '1' } },
        { runtime, configuration },
      );
      expect(result.isError).toBe(true);
      const { error } = result.structuredContent as { error: { code: string; http_status?: number } };
      expect(error.code).toBe('NOT_FOUND');
      expect(error.http_status).toBe(404);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(String(fetch.mock.calls[0]?.[0])).toContain('get_test/100&with_data=1');
    } finally { await runtime.shutdown(); }
  });
});
