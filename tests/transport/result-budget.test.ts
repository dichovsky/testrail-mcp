import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TestRailClient } from '@dichovsky/testrail-api-client';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfiguration } from '../../src/config/environment.js';
import { DEFAULT_LIMITS, FIXED_BUDGETS } from '../../src/config/limits.js';
import { driverOptions } from '../../src/driver/configuration.js';
import { getProject, updateProject } from '../../src/operations/families/t01.js';
import { createRegistry } from '../../src/operations/registry.js';
import { createRuntime } from '../../src/runtime/invocation.js';
import { buildServer } from '../../src/transport/server.js';

let directory: string;
beforeAll(async () => { directory = await mkdtemp(join(tmpdir(), 'testrail-mcp-wire-budget-')); });
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

type Revision = 'legacy' | '2026-07-28';
const bytes = (value: object): number => Buffer.byteLength(JSON.stringify(value), 'utf8');

/** Capture the SDK's encoded result before the client normalizes away wire fields. */
async function call(revision: Revision, limit: number, write = false, invalid = false) {
  const configuration = await loadConfiguration({
    TESTRAIL_BASE_URL: 'https://budget.testrail.io', TESTRAIL_EMAIL: 'user@example.com', TESTRAIL_API_KEY: 'synthetic',
    TESTRAIL_MCP_UPLOAD_ROOTS: '[]', TESTRAIL_MCP_DOWNLOAD_DIR: directory,
    TESTRAIL_MCP_LIMITS: JSON.stringify({ max_result_bytes: limit }),
  });
  const testRail = new TestRailClient({
    ...driverOptions(configuration), maxRetries: 0,
    dnsLookup: () => Promise.resolve([{ address: '203.0.113.10', family: 4 }]),
    fetch: () => Promise.resolve(new Response(JSON.stringify({ id: 1, name: 'Project "\\ €' }), {
      headers: { 'content-type': 'application/json' },
    })),
  });
  const runtime = createRuntime({ client: testRail, limits: configuration.limits });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  let wire: object | undefined;
  const send = serverTransport.send.bind(serverTransport);
  serverTransport.send = async (message, options) => {
    if ('result' in message && 'structuredContent' in message.result) wire = message.result;
    await send(message, options);
  };
  const handle = serveStdio(() => buildServer({
    configuration, runtime, registry: createRegistry(getProject, updateProject),
    stagingDirectory: () => Promise.resolve(directory),
  }), { transport: serverTransport });
  const client = new Client({ name: 'wire-budget', version: '1.0.0' }, {
    versionNegotiation: { mode: revision === 'legacy' ? 'legacy' : { pin: revision } },
  });
  try {
    await client.connect(clientTransport);
    const result = await client.callTool({
      name: write ? updateProject.tool : getProject.tool,
      arguments: invalid ? { project_id: -1 } : { project_id: 1, ...(write ? { body: { name: 'Project' } } : {}) },
    });
    if (wire === undefined) throw new Error('No tool result reached the transport');
    return { result, wire, bytes: bytes(wire) };
  } finally {
    await client.close();
    await handle.close();
    await runtime.shutdown();
  }
}

describe.each(['legacy', '2026-07-28'] as const)('%s complete tool-result budget', (revision) => {
  it.each([false, true])('accepts the wire-byte boundary and refuses one byte less (write=%s)', async (write) => {
    const baseline = await call(revision, DEFAULT_LIMITS.max_result_bytes, write);
    expect(baseline.result.isError).toBeUndefined();
    if (revision === 'legacy') {
      expect(baseline.wire).not.toHaveProperty('resultType');
      expect(baseline.wire).not.toHaveProperty('_meta');
    } else {
      expect(baseline.wire).toHaveProperty('resultType', 'complete');
      expect(baseline.wire).toHaveProperty(['_meta', 'io.modelcontextprotocol/serverInfo']);
    }

    const exact = await call(revision, baseline.bytes, write);
    expect(exact.result.isError).toBeUndefined();
    expect(exact.bytes).toBe(baseline.bytes);
    expect(exact.wire).toEqual(baseline.wire);

    const smaller = await call(revision, baseline.bytes - 1, write);
    expect(smaller.result.isError).toBe(true);
    expect(smaller.result.structuredContent).toEqual({ error: {
      code: 'RESPONSE_TOO_LARGE', message: 'The result exceeds the configured size budget; narrow the request.',
      ...(write ? { write_outcome: 'acknowledged' } : {}),
    } });
    expect(smaller.bytes).toBeLessThanOrEqual(FIXED_BUDGETS.max_error_bytes);
  });

  it('uses the separate complete error budget when arguments fail before dispatch', async () => {
    const outcome = await call(revision, 1, false, true);
    expect(outcome.result.isError).toBe(true);
    expect(outcome.result.structuredContent).toMatchObject({ error: { code: 'INVALID_ARGUMENT' } });
    expect(outcome.bytes).toBeLessThanOrEqual(FIXED_BUDGETS.max_error_bytes);
  });
});
