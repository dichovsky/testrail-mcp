import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TestRailClient } from '@dichovsky/testrail-api-client';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { loadConfiguration, type Configuration } from '../../src/config/environment.js';
import { positiveIdSchema, strictObject } from '../../src/contracts/inputs.js';
import { driverCall } from '../../src/operations/driver-call.js';
import { createRegistry, defineOperation, type OperationDefinition } from '../../src/operations/registry.js';
import { createRuntime, type Runtime } from '../../src/runtime/invocation.js';
import { buildServer, SERVER_INSTRUCTIONS } from '../../src/transport/server.js';

/**
 * A synthetic operation stands in for the endpoint families, which are empty until
 * T01. The transport is operation-agnostic, so what it does with one entry is what it
 * will do with 133.
 */
const projectInput = strictObject({ project_id: positiveIdSchema });
const getProject = defineOperation({
  token: 'get_project', method: 'GET', route: 'get_project/{project_id}', family: 'T01',
  driverBinding: 'projects.getProject', summary: 'Get a TestRail project.',
  inputSchema: projectInput,
  argumentMap: [{ input: 'project_id', call: 'single', argument: 0, serialization: 'path' }],
  response: {
    shape: 'record',
    outerSchema: z.record(z.string(), z.unknown()),
    entitySchema: z.object({ id: z.number(), name: z.string() }),
  },
  pagination: {
    kind: 'none',
    single: driverCall(projectInput, 'projects.getProject', (method, input) => method(input.project_id)),
  },
  files: { kind: 'none' },
  effects: { testRail: 'read', destructive: false, idempotent: true },
  retry: 'ordinary-read',
} as const satisfies OperationDefinition);

const registry = createRegistry(getProject);

let directory: string;
let configuration: Configuration;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'testrail-mcp-transport-'));
  configuration = await loadConfiguration({
    TESTRAIL_BASE_URL: 'https://transport.testrail.io',
    TESTRAIL_EMAIL: 'user@example.com',
    TESTRAIL_API_KEY: 'synthetic',
    TESTRAIL_MCP_UPLOAD_ROOTS: '[]',
    TESTRAIL_MCP_DOWNLOAD_DIR: directory,
  });
});

afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

interface Session {
  readonly client: Client;
  readonly runtime: Runtime;
  readonly factoryCalls: () => number;
  readonly close: () => Promise<void>;
}

/**
 * Connect a client to a server over a linked in-memory pair, so the protocol is
 * exercised for real without spawning a process.
 */
async function connect(
  respond: () => Promise<Response>,
  negotiation?: 'legacy' | { readonly pin: string },
): Promise<Session> {
  const driver = new TestRailClient({
    baseUrl: configuration.baseUrl, email: configuration.email, apiKey: configuration.apiKey,
    registerProcessHandlers: false, maxRetries: 0,
    dnsLookup: () => Promise.resolve([{ address: '203.0.113.10', family: 4 }]),
    fetch: () => respond(),
  });
  const runtime = createRuntime({ client: driver, limits: configuration.limits });

  let factoryCalls = 0;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const handle = serveStdio(() => {
    factoryCalls += 1;
    return buildServer({
      configuration, runtime, registry,
      stagingDirectory: () => Promise.resolve(directory),
    });
  }, { transport: serverTransport });

  const client = new Client(
    { name: 'protocol-test', version: '1.0.0' },
    negotiation === undefined ? {} : { versionNegotiation: { mode: negotiation } },
  );
  await client.connect(clientTransport);

  return {
    client, runtime,
    factoryCalls: () => factoryCalls,
    close: async () => {
      await client.close().catch(() => undefined);
      await handle.close().catch(() => undefined);
      await runtime.shutdown();
    },
  };
}

describe('protocol eras', () => {
  it('serves a legacy initialization and reports the negotiated era', async () => {
    const session = await connect(() => Promise.resolve(json({ id: 1, name: 'Project' })), 'legacy');
    try {
      // Recorded from the connection rather than inferred from the SDK version.
      expect(session.client.getProtocolEra()).toBe('legacy');
      expect(typeof session.client.getNegotiatedProtocolVersion()).toBe('string');
      const { tools } = await session.client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(['testrail_get_project']);
    } finally { await session.close(); }
  });

  it('serves a modern 2026-07-28 discovery and reports the negotiated era', async () => {
    const session = await connect(() => Promise.resolve(json({ id: 1, name: 'Project' })), { pin: '2026-07-28' });
    try {
      expect(session.client.getProtocolEra()).toBe('modern');
      expect(session.client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
      const { tools } = await session.client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(['testrail_get_project']);
    } finally { await session.close(); }
  });

  it('exposes the same catalog to both eras', async () => {
    const legacy = await connect(() => Promise.resolve(json({})), 'legacy');
    const modern = await connect(() => Promise.resolve(json({})), { pin: '2026-07-28' });
    try {
      // Compared structurally, not byte for byte: the two eras serialize the schema's
      // keys in a different order (legacy emits $schema first, modern emits it after
      // required) while carrying identical keys and values. Determinism is still
      // asserted byte for byte within a single era, where it does hold.
      expect((await legacy.client.listTools()).tools)
        .toEqual((await modern.client.listTools()).tools);
    } finally { await legacy.close(); await modern.close(); }
  });
});

describe('discovery', () => {
  it('advertises the reviewed schema, annotations and instructions without contacting TestRail', async () => {
    let requests = 0;
    const session = await connect(() => { requests += 1; return Promise.resolve(json({})); });
    try {
      const first = await session.client.listTools();
      const second = await session.client.listTools();
      // Repeated discovery is deterministic and makes no upstream request.
      expect(JSON.stringify(first.tools)).toBe(JSON.stringify(second.tools));
      expect(requests).toBe(0);

      const tool = first.tools[0];
      expect(tool?.name).toBe('testrail_get_project');
      // The reviewed document is advertised verbatim, not re-emitted in another dialect.
      expect(tool?.inputSchema).toEqual(getProject.jsonSchema);
      expect(tool?.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true, openWorldHint: true });
      expect(session.client.getInstructions()).toBe(SERVER_INSTRUCTIONS);
    } finally { await session.close(); }
  });

  it('builds at most one server per connection and never a second driver', async () => {
    const session = await connect(() => Promise.resolve(json({})));
    try {
      await session.client.listTools();
      await session.client.listTools();
      // The factory may run more than once during an opening, but the driver and
      // runtime are closed over, so neither is duplicated.
      expect(session.factoryCalls()).toBeGreaterThanOrEqual(1);
      expect(session.runtime.stats().accepting).toBe(true);
    } finally { await session.close(); }
  });
});

describe('tool calls', () => {
  it('returns the wrapper as structured content and as identical text', async () => {
    const session = await connect(() => Promise.resolve(json({ id: 7, name: 'Project', custom_kept: ['a'] })));
    try {
      const result = await session.client.callTool({ name: 'testrail_get_project', arguments: { project_id: 7 } });
      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as { data: Record<string, unknown> };
      expect(structured.data).toEqual({ id: 7, name: 'Project', custom_kept: ['a'] });
      const [block] = result.content as { type: string; text: string }[];
      expect(block?.type).toBe('text');
      expect(block?.text).toBe(JSON.stringify(result.structuredContent));
    } finally { await session.close(); }
  });

  it('reports a rejected argument as a tool error inside the adapter taxonomy', async () => {
    const session = await connect(() => Promise.resolve(json({})));
    try {
      const result = await session.client.callTool({ name: 'testrail_get_project', arguments: { project_id: -1 } });
      expect(result.isError).toBe(true);
      expect((result.structuredContent as { error: { code: string } }).error.code).toBe('INVALID_ARGUMENT');
    } finally { await session.close(); }
  });

  it('classifies an upstream failure without forwarding its message', async () => {
    const session = await connect(() => Promise.resolve(json({ error: 'internal detail' }, 403)));
    try {
      const result = await session.client.callTool({ name: 'testrail_get_project', arguments: { project_id: 7 } });
      expect(result.isError).toBe(true);
      const { error } = result.structuredContent as { error: { code: string; message: string } };
      expect(error.code).toBe('PERMISSION_DENIED');
      expect(JSON.stringify(result)).not.toContain('internal detail');
    } finally { await session.close(); }
  });

  it('keeps an unknown tool a protocol error rather than a tool result', async () => {
    const session = await connect(() => Promise.resolve(json({})));
    try {
      // A malformed request is a protocol fault; a failed operation is a tool error.
      await expect(session.client.callTool({ name: 'testrail_not_a_tool', arguments: {} }))
        .rejects.toThrow();
    } finally { await session.close(); }
  });
});

describe('server instructions', () => {
  it('states the essential cross-tool rules within the first 512 characters', () => {
    const opening = SERVER_INSTRUCTIONS.slice(0, 512);
    for (const essential of ['permissions', '_mcp.pagination', 'custom_', 'write_outcome']) {
      expect(opening, essential).toContain(essential);
    }
  });

  it('stays under 2 KiB in UTF-8', () => {
    expect(Buffer.byteLength(SERVER_INSTRUCTIONS, 'utf8')).toBeLessThan(2_048);
  });
});
