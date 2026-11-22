import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TestRailClient } from '@dichovsky/testrail-api-client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConfiguration, type Configuration } from '../src/config/environment.js';
import { FIXED_BUDGETS } from '../src/config/limits.js';
import { operationRegistry } from '../src/operations/catalog.js';
import { createTestExecutor } from './support/executor.js';

let directory: string;
let configuration: Configuration;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'testrail-mcp-executor-'));
  configuration = await loadConfiguration({
    TESTRAIL_BASE_URL: 'https://executor.testrail.io',
    TESTRAIL_EMAIL: 'user@example.com',
    TESTRAIL_API_KEY: 'synthetic',
    TESTRAIL_MCP_UPLOAD_ROOTS: '[]',
    TESTRAIL_MCP_DOWNLOAD_DIR: directory,
  });
});
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

describe('the process-owned executor', () => {
  it('shares one drain between direct shutdown callers and stops admission before settling work', async () => {
    const operation = operationRegistry.get('testrail_get_project');
    if (operation === undefined) throw new Error('Missing project operation');
    let finish: (response: Response) => void = () => undefined;
    const fetch = vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; }));
    const client = new TestRailClient({
      baseUrl: configuration.baseUrl, email: configuration.email, apiKey: configuration.apiKey,
      registerProcessHandlers: false, maxRetries: 0,
      dnsLookup: () => Promise.resolve([{ address: '203.0.113.10', family: 4 }]),
      fetch,
    });
    const destroy = vi.spyOn(client, 'destroy');
    const delay = vi.fn(() => ({ promise: new Promise<void>(() => undefined), cancel: vi.fn() }));
    const executor = createTestExecutor({ configuration, client, delay });
    const answer = () => { finish(new Response(JSON.stringify({ id: 1, name: 'Project' }), { headers: { 'content-type': 'application/json' } })); };
    try {
      const pending = executor.execute(operation, { project_id: 1 });
      await vi.waitFor(() => { expect(fetch).toHaveBeenCalledTimes(1); });

      const first = executor.shutdown();
      expect(executor.shutdown()).toBe(first);
      expect(executor.stats()).toMatchObject({ accepting: false, active: 1 });
      expect(destroy).not.toHaveBeenCalled();
      expect(delay.mock.calls).toEqual([[FIXED_BUDGETS.response_wait_ms], [FIXED_BUDGETS.shutdown_drain_ms]]);
      const refused = await executor.execute(operation, { project_id: 2 });
      expect(refused.structuredContent).toMatchObject({ error: { code: 'BUSY' } });
      expect(fetch).toHaveBeenCalledTimes(1);

      answer();
      expect((await pending).isError).toBeUndefined();
      await first;
      expect(executor.shutdown()).toBe(first);
      expect(destroy).toHaveBeenCalledTimes(1);
      expect(executor.stats().active).toBe(0);
      for (const result of delay.mock.results) {
        if (result.type === 'return') expect(result.value.cancel).toHaveBeenCalledTimes(1);
      }
    } finally {
      answer();
      await executor.shutdown();
      destroy.mockRestore();
    }
  });
});
