import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TestRailClient } from '@dichovsky/testrail-api-client';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConfiguration, type Configuration } from '../../src/config/environment.js';
import { operationRegistry } from '../../src/operations/catalog.js';
import { createRuntime } from '../../src/runtime/invocation.js';
import { buildServer } from '../../src/transport/server.js';
import { executeToolCall } from '../../src/transport/tool-call.js';

/*
 * F05: a tool call whose pipeline rejects. `executeToolCall` is built never to reject, so
 * this cannot happen today; it is replaced here by one that rejects with a message
 * carrying a key, a host and a path. The SDK answers a rejected handler with the raw
 * message as the result's text, so without the server's own guard that message would
 * reach the client. The replacement is hoisted, so it lives in its own file.
 */
const leaked = vi.hoisted(() => ({ key: 'SECRET-31', host: 'internal.example.test', path: '/Users/someone/private' }));
vi.mock('../../src/transport/tool-call.js', () => ({
  executeToolCall: vi.fn(() => Promise.reject(new Error(`api_key=${leaked.key} at https://${leaked.host} ${leaked.path}`))),
}));

let directory: string;
let configuration: Configuration;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'testrail-mcp-handler-failure-'));
  configuration = await loadConfiguration({
    TESTRAIL_BASE_URL: 'https://handler.testrail.io',
    TESTRAIL_EMAIL: 'user@example.com',
    TESTRAIL_API_KEY: 'synthetic',
    TESTRAIL_MCP_UPLOAD_ROOTS: '[]',
    TESTRAIL_MCP_DOWNLOAD_DIR: directory,
  });
});

afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

async function connect() {
  const runtime = createRuntime({
    client: new TestRailClient({
      baseUrl: configuration.baseUrl, email: configuration.email, apiKey: configuration.apiKey,
      registerProcessHandlers: false, maxRetries: 0,
      dnsLookup: () => Promise.resolve([{ address: '203.0.113.10', family: 4 }]),
      fetch: () => Promise.reject(new Error('no request is expected')),
    }),
    limits: configuration.limits,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const handle = serveStdio(() => buildServer({
    configuration, runtime, registry: operationRegistry, stagingDirectory: () => Promise.resolve(directory),
  }), { transport: serverTransport });
  const client = new Client({ name: 'handler-failure-test', version: '1.0.0' });
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close().catch(() => undefined);
      await handle.close().catch(() => undefined);
      await runtime.shutdown();
    },
  };
}

describe('a tool call whose pipeline rejects', () => {
  it.each([
    ['a write', 'testrail_add_project', { body: { name: 'Gate' } }, { write_outcome: 'unknown' }],
    ['a report run', 'testrail_run_report', { report_template_id: 383 }, { write_outcome: 'unknown' }],
    ['a read', 'testrail_get_project', { project_id: 7 }, {}],
  ] as const)('answers %s as INTERNAL_ERROR with one diagnostic, and never the raw message', async (_label, tool, args, outcome) => {
    const session = await connect();
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      vi.mocked(executeToolCall).mockClear();
      const result = await session.client.callTool({ name: tool, arguments: args });
      // The replacement really ran, so nothing below can pass because the real pipeline did.
      expect(vi.mocked(executeToolCall)).toHaveBeenCalledTimes(1);

      // An internal fault like any other: the fixed message, and for a write or a report
      // run the conservative outcome, since whether the driver was entered is not known.
      const error = { code: 'INTERNAL_ERROR', message: 'The server failed to complete the call.', ...outcome };
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual({ error });
      expect(result.content).toEqual([{ type: 'text', text: JSON.stringify({ error }) }]);

      const lines = write.mock.calls.map(([chunk]) => String(chunk));
      const events = lines.filter((line) => line.startsWith('{"event"')).map((line) => JSON.parse(line) as unknown);
      expect(events).toEqual([{
        event: 'tool_call', correlation: expect.stringMatching(/^[0-9a-f-]{36}$/u) as unknown, tool,
        outcome: 'error', code: 'INTERNAL_ERROR', duration_ms: expect.any(Number) as unknown, ...outcome,
      }]);
      for (const text of [leaked.key, leaked.host, leaked.path]) {
        expect(JSON.stringify(result)).not.toContain(text);
        for (const line of lines) expect(line).not.toContain(text);
      }
    } finally {
      write.mockRestore();
      await session.close();
    }
  });
});
