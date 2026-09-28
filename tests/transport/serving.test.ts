import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TestRailClient } from '@dichovsky/testrail-api-client';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConfiguration, type Configuration } from '../../src/config/environment.js';
import { operationRegistry } from '../../src/operations/catalog.js';
import { createRuntime } from '../../src/runtime/invocation.js';
import { buildServer } from '../../src/transport/server.js';

/*
 * F08: what the serving layer advertises for the whole catalog, and what it must not
 * do. The tool list comes from the inventory, and the expected protocol codes from the
 * MCP specification, so neither is read back from the code under test.
 */

const inventory = (JSON.parse(await readFile(new URL('../../docs/operation-inventory.json', import.meta.url), 'utf8')) as {
  operations: { tool: string }[];
}).operations.map(({ tool }) => tool);

let directory: string;
let configuration: Configuration;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'testrail-mcp-serving-'));
  configuration = await loadConfiguration({
    TESTRAIL_BASE_URL: 'https://serving.testrail.io',
    TESTRAIL_EMAIL: 'user@example.com',
    TESTRAIL_API_KEY: 'synthetic',
    TESTRAIL_MCP_UPLOAD_ROOTS: '[]',
    TESTRAIL_MCP_DOWNLOAD_DIR: directory,
  });
});

afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

async function connect(negotiation: 'legacy' | { readonly pin: string }, respond: () => Promise<Response> = () => Promise.reject(new Error('no request expected'))) {
  const fetch = vi.fn(respond);
  const runtime = createRuntime({
    client: new TestRailClient({
      baseUrl: configuration.baseUrl, email: configuration.email, apiKey: configuration.apiKey,
      registerProcessHandlers: false, maxRetries: 0,
      dnsLookup: () => Promise.resolve([{ address: '203.0.113.10', family: 4 }]),
      fetch,
    }),
    limits: configuration.limits,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const handle = serveStdio(() => buildServer({
    configuration, runtime, registry: operationRegistry, stagingDirectory: () => Promise.resolve(directory),
  }), { transport: serverTransport });
  const client = new Client({ name: 'serving-test', version: '1.0.0' }, { versionNegotiation: { mode: negotiation } });
  await client.connect(clientTransport);
  return {
    client, fetch,
    close: async () => {
      await client.close().catch(() => undefined);
      await handle.close().catch(() => undefined);
      await runtime.shutdown();
    },
  };
}

const eras = [['legacy', 'legacy'], ['modern', { pin: '2026-07-28' }]] as const;

describe('the advertised catalog', () => {
  it.each(eras)('advertises every registered tool as registered, in a fixed order (%s)', async (_label, negotiation) => {
    const session = await connect(negotiation);
    try {
      const { tools } = await session.client.listTools();
      // Name order, the same in every process: the inventory's tools sorted as the
      // registry documents, not merely the same set.
      expect(tools.map(({ name }) => name)).toEqual([...inventory].sort((left, right) => left.localeCompare(right, 'en')));
      for (const tool of tools) {
        const operation = operationRegistry.get(tool.name);
        if (operation === undefined) throw new Error(`${tool.name} is not registered`);
        // The reviewed schema verbatim, including the 24 top-level anyOf list inputs.
        expect(tool.inputSchema, tool.name).toEqual(operation.jsonSchema);
        expect(tool.description, tool.name).toBe(operation.description);
        expect(Buffer.byteLength(tool.description ?? '', 'utf8'), tool.name).toBeLessThan(2_048);
        expect(tool.annotations, tool.name).toStrictEqual({ ...operation.annotations });
      }
      expect(session.fetch).not.toHaveBeenCalled();
    } finally { await session.close(); }
  });

  it.each(eras)('offers tools only, with no resources or prompts (%s)', async (_label, negotiation) => {
    const session = await connect(negotiation);
    try {
      const capabilities = session.client.getServerCapabilities();
      expect(capabilities?.tools).toEqual({ listChanged: false });
      expect(capabilities).not.toHaveProperty('resources');
      expect(capabilities).not.toHaveProperty('prompts');
      // The SDK client answers resources/list itself when the capability is absent, so
      // the server's own refusal is held over raw stdio in serving-process.test.ts.
    } finally { await session.close(); }
  });

  it.each([
    ['a successful', 200, 'success'],
    ['a failed', 500, 'error'],
  ] as const)('keeps %s call\'s arguments out of every diagnostic', async (_label, status, outcome) => {
    const canary = 'canary-7f3a';
    const session = await connect('legacy', () => Promise.resolve(new Response(JSON.stringify({ id: 9, name: canary }), {
      status, headers: { 'content-type': 'application/json' },
    })));
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const result = await session.client.callTool({ name: 'testrail_add_project', arguments: { body: { name: canary } } });
      expect(Boolean(result.isError)).toBe(outcome === 'error');
      const chunks = write.mock.calls.map(([chunk]) => String(chunk));
      // Not only the tool_call line: no stderr output at all may carry the argument.
      for (const chunk of chunks) expect(chunk).not.toContain(canary);
      const events = chunks.filter((line) => line.includes('"tool_call"'));
      expect(events).toHaveLength(1);
      expect(JSON.parse(events[0] ?? '{}')).toMatchObject({ event: 'tool_call', tool: 'testrail_add_project', outcome });
    } finally {
      write.mockRestore();
      await session.close();
    }
  });
});

describe('what the serving layer is built from', () => {
  const root = fileURLToPath(new URL('../../src/', import.meta.url));

  async function sources(subdirectory: string): Promise<[string, string][]> {
    const base = join(root, subdirectory);
    const files = (await readdir(base, { recursive: true })).filter((file) => file.endsWith('.ts'));
    return Promise.all(files.map(async (file) => [file, await readFile(join(base, file), 'utf8')] as [string, string]));
  }

  it('runs no network service of its own: nothing in src imports an HTTP or socket server', async () => {
    const offending: string[] = [];
    for (const [file, source] of await sources('')) {
      for (const [, specifier] of source.matchAll(/(?:from\s+|import\s*\(?\s*|require\(\s*)['"`]([^'"`]+)['"`]/gu)) {
        if (specifier !== undefined && /^(?:node:)?(?:http|https|http2|net|tls|dgram|cluster)$|modelcontextprotocol\/[^'"`]*http/u.test(specifier)) {
          offending.push(`${file}: ${specifier}`);
        }
      }
    }
    expect(offending).toEqual([]);
  });

  it('keeps transport code free of endpoint logic', async () => {
    const offending: string[] = [];
    for (const [file, source] of await sources('transport')) {
      if (/['"`]testrail_[a-z_]+['"`]/u.test(source)) offending.push(`${file}: a tool name literal`);
      if (/from\s+['"][^'"]*operations\/families\//u.test(source)) offending.push(`${file}: imports an endpoint family`);
    }
    expect(offending).toEqual([]);
  });
});
