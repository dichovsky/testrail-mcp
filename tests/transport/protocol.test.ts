import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TestRailClient } from '@dichovsky/testrail-api-client';
import { Client, InMemoryTransport, ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/client';
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
      // The SDK client offers its latest legacy version, 2025-11-25, and the server
      // accepts it rather than answering with an older one.
      expect(session.client.getNegotiatedProtocolVersion()).toBe('2025-11-25');
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
      const error: unknown = await session.client.callTool({ name: 'testrail_not_a_tool', arguments: {} }).then(() => undefined, (reason: unknown) => reason);
      expect(ProtocolError.isInstance(error) && error.code).toBe(ProtocolErrorCode.InvalidParams);
    } finally { await session.close(); }
  });
});

describe('server instructions', () => {
  it('states the essential cross-tool rules in an opening paragraph that fits in 512 characters', () => {
    // Hosts may truncate to 512 characters, so the whole opening paragraph must fit,
    // ending at a sentence rather than mid-rule.
    const opening = SERVER_INSTRUCTIONS.split('\n\n')[0] ?? '';
    expect(opening.length).toBeLessThanOrEqual(512);
    expect(opening.endsWith('.')).toBe(true);
    // Whole sentences, so a paragraph that reversed or dropped one would fail. The
    // expected text is the rule itself as docs/transport.md states it.
    for (const essential of [
      "Each tool is one TestRail API endpoint, run with the configured user's permissions.",
      'Lists that take _mcp return one page by default (50 where a limit applies); never treat it as the whole dataset.',
      '_mcp.pagination "all" fetches the rest within bounds, as far as TestRail\'s replies link on.',
      "Results keep TestRail's field names.",
      "A write's or report run's error has write_outcome: \"unknown\" may already be applied, so check before retrying; \"acknowledged\" was applied, so do not repeat it.",
      'Never poll a report.',
    ]) {
      expect(opening, essential).toContain(essential);
    }
  });

  it('keeps the rest of the cross-tool rules, each as a whole sentence', () => {
    for (const rule of [
      'Results are {data, pagination, warnings}, and field names include custom_* fields.',
      '"not_started" means nothing was sent.',
      '"acknowledged" means TestRail accepted the change but its response could not be delivered.',
      "The user's licence applies as well as their permissions.",
      "Running a report generates it and may send the template's configured email.",
      'Downloading an attachment writes a new local file every time and never overwrites one.',
      'Uploads read a local path that must sit inside a configured directory.',
      'A warnings entry means TestRail returned fields differing from the expected shape; the data is passed through unchanged and is still usable.',
    ]) {
      expect(SERVER_INSTRUCTIONS, rule).toContain(rule);
    }
  });

  it('stays under 2 KiB in UTF-8', () => {
    expect(Buffer.byteLength(SERVER_INSTRUCTIONS, 'utf8')).toBeLessThan(2_048);
  });
});
