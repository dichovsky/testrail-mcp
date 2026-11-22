import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { describe, expect, it, vi } from 'vitest';
import { operationRegistry } from '../../src/operations/catalog.js';
import type { OperationExecutor } from '../../src/execution/executor.js';
import { buildServer } from '../../src/transport/server.js';

/* The transport's defensive guard must sanitize an unexpected executor rejection. */
const leaked = { key: 'SECRET-31', host: 'internal.example.test', path: '/Users/someone/private' };

async function connect() {
  const execute = vi.fn<OperationExecutor['execute']>(() =>
    Promise.reject(new Error(`api_key=${leaked.key} at https://${leaked.host} ${leaked.path}`)));
  const executor: OperationExecutor = { execute, shutdown: () => Promise.resolve() };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const handle = serveStdio(() => buildServer({
    executor, registry: operationRegistry,
  }), { transport: serverTransport });
  const client = new Client({ name: 'handler-failure-test', version: '1.0.0' });
  await client.connect(clientTransport);
  return {
    client, execute,
    close: async () => {
      await client.close().catch(() => undefined);
      await handle.close().catch(() => undefined);
      await executor.shutdown();
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
      const result = await session.client.callTool({ name: tool, arguments: args });
      // The replacement really ran, so nothing below can pass because the real pipeline did.
      expect(session.execute).toHaveBeenCalledTimes(1);

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
