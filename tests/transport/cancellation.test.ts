import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TestRailClient } from '@dichovsky/testrail-api-client';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfiguration, type Configuration } from '../../src/config/environment.js';
import type { ToolResult } from '../../src/contracts/results.js';
import { operationRegistry } from '../../src/operations/catalog.js';
import { createRuntime, type Runtime } from '../../src/runtime/invocation.js';
import { buildServer } from '../../src/transport/server.js';
import { executeToolCall } from '../../src/transport/tool-call.js';

/*
 * The SDK suppresses the response to a request it has seen cancelled, so the client never
 * receives what the handler returned. Wrapping the pipeline records that value without
 * changing it, which is the only way to check the classification a cancelled call reached.
 */
vi.mock('../../src/transport/tool-call.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/transport/tool-call.js')>();
  return { ...original, executeToolCall: vi.fn(original.executeToolCall) };
});

let directory: string;
let configuration: Configuration;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'testrail-mcp-cancellation-'));
  configuration = await loadConfiguration({
    TESTRAIL_BASE_URL: 'https://cancellation.testrail.io',
    TESTRAIL_EMAIL: 'user@example.com',
    TESTRAIL_API_KEY: 'synthetic',
    TESTRAIL_MCP_UPLOAD_ROOTS: '[]',
    TESTRAIL_MCP_DOWNLOAD_DIR: directory,
  });
});

afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

beforeEach(() => { vi.mocked(executeToolCall).mockClear(); });

/** Every upstream request is held until the test releases it, and counted. */
function heldUpstream(body: unknown) {
  const releases: (() => void)[] = [];
  let calls = 0;
  let replies = 0;
  const fetch = (async () => {
    calls += 1;
    await new Promise<void>((resolve) => releases.push(resolve));
    replies += 1;
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof globalThis.fetch;
  return {
    fetch,
    get calls() { return calls; },
    get replies() { return replies; },
    releaseAll() { for (const release of releases.splice(0)) release(); },
  };
}

/** Only for asserting that something has *not* happened. */
async function settle(ms = 30): Promise<void> {
  await new Promise((resolve) => { setTimeout(resolve, ms); });
}

async function waitFor(condition: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => { setTimeout(resolve, 5); });
  }
}

interface Session {
  readonly client: Client;
  readonly runtime: Runtime;
  /** Every message the server wrote to the client, in order. */
  readonly sent: { readonly id?: unknown }[];
  /** Every message the client wrote to the server, in order. */
  readonly received: { readonly id?: unknown; readonly method?: unknown }[];
  readonly close: () => Promise<void>;
}

/**
 * The production catalog over a linked in-memory pair: the protocol runs for real.
 *
 * A session discovers before it calls, as a host does, so its tool call is not request
 * id 0; the last test in this file opts out to cancel id 0 itself.
 */
async function connect(
  fetch: typeof globalThis.fetch,
  era: 'legacy' | { readonly pin: string },
  discover = true,
): Promise<Session> {
  const driver = new TestRailClient({
    baseUrl: configuration.baseUrl, email: configuration.email, apiKey: configuration.apiKey,
    registerProcessHandlers: false, maxRetries: 0,
    dnsLookup: () => Promise.resolve([{ address: '203.0.113.10', family: 4 }]),
    fetch,
  });
  const runtime = createRuntime({ client: driver, limits: configuration.limits });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const sent: { id?: unknown }[] = [];
  const send = serverTransport.send.bind(serverTransport);
  serverTransport.send = (message, options) => {
    sent.push(message as { id?: unknown });
    return send(message, options);
  };
  const received: { id?: unknown; method?: unknown }[] = [];
  const receive = clientTransport.send.bind(clientTransport);
  clientTransport.send = (message, options) => {
    received.push(message);
    return receive(message, options);
  };
  const handle = serveStdio(() => buildServer({
    configuration, runtime, registry: operationRegistry,
    stagingDirectory: () => Promise.resolve(directory),
  }), { transport: serverTransport });

  const client = new Client({ name: 'cancellation-test', version: '1.0.0' }, { versionNegotiation: { mode: era } });
  await client.connect(clientTransport);
  if (discover) await client.listTools();
  return {
    client, runtime, sent, received,
    close: async () => {
      await client.close().catch(() => undefined);
      await handle.close().catch(() => undefined);
      await runtime.shutdown();
    },
  };
}

/** The value the tool handler returned for the most recent call, response or not. */
async function lastHandlerResult(): Promise<ToolResult> {
  const results = vi.mocked(executeToolCall).mock.results;
  const last = results.at(-1);
  if (last?.type !== 'return') throw new Error('The tool handler was not invoked');
  return await last.value;
}

function errorOf(result: ToolResult): { code: string; write_outcome?: string } {
  return (result.structuredContent as { error: { code: string; write_outcome?: string } }).error;
}

describe.each([
  ['legacy', 'legacy'],
  ['2026-07-28', { pin: '2026-07-28' }],
] as const)('soft cancellation over the %s protocol', (_label, era) => {
  it('cancels a dispatched registered read, holds its slot until upstream settles and drops the late reply', async () => {
    const upstream = heldUpstream({ id: 7, name: 'Project' });
    const session = await connect(upstream.fetch, era);
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const cancel = new AbortController();
      const call = session.client.callTool(
        { name: 'testrail_get_project', arguments: { project_id: 7 } },
        { signal: cancel.signal },
      );
      await waitFor(() => upstream.calls === 1, 'the dispatched request');
      const sentBeforeCancel = session.sent.length;

      // The client rejects its own request and sends notifications/cancelled, which the
      // server turns into an abort of the handler's signal.
      cancel.abort('caller gave up');
      await expect(call).rejects.toThrow();
      await waitFor(() => vi.mocked(executeToolCall).mock.results.length > 0, 'the handler call');
      const handled = await lastHandlerResult();
      expect(handled.isError).toBe(true);
      expect(errorOf(handled).code).toBe('CANCELLED');
      // A read carries no write outcome.
      expect(errorOf(handled).write_outcome).toBeUndefined();

      // The driver cannot abort the request, so its slot is still owned. The pause lets an
      // early release happen first, so the assertion cannot pass on timing alone.
      await settle();
      expect(session.runtime.stats().active).toBe(1);

      upstream.releaseAll();
      await waitFor(() => upstream.replies === 1, 'the late reply');
      await waitFor(() => session.runtime.stats().active === 0, 'the slot released on settlement');

      // The SDK suppresses the response to a cancelled request: nothing was written for it,
      // neither the CANCELLED result nor the late upstream reply.
      expect(session.sent.slice(sentBeforeCancel)).toEqual([]);
      expect(unhandled).not.toHaveBeenCalled();

      // The connection keeps serving after a cancellation.
      const next = session.client.callTool({ name: 'testrail_get_project', arguments: { project_id: 7 } });
      await waitFor(() => upstream.calls === 2, 'the next request');
      upstream.releaseAll();
      expect((await next).isError).toBeFalsy();
    } finally {
      process.off('unhandledRejection', unhandled);
      upstream.releaseAll();
      await session.close();
    }
  });

  it('keeps all four slots after four dispatched calls are cancelled, refusing a fifth without a request', async () => {
    const upstream = heldUpstream({ id: 7, name: 'Project' });
    const session = await connect(upstream.fetch, era);
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const cancels = Array.from({ length: 4 }, () => new AbortController());
      const calls = cancels.map((cancel, index) => session.client.callTool(
        { name: 'testrail_get_project', arguments: { project_id: index + 1 } },
        { signal: cancel.signal },
      ).catch(() => undefined));
      await waitFor(() => upstream.calls === 4, 'four dispatched requests');
      for (const cancel of cancels) cancel.abort('caller gave up');
      await Promise.all(calls);
      await waitFor(() => vi.mocked(executeToolCall).mock.results.length >= 4, 'four handler calls');
      for (const result of vi.mocked(executeToolCall).mock.results.slice(0, 4)) {
        if (result.type !== 'return') throw new Error('The tool handler threw');
        expect(errorOf(await result.value)).toMatchObject({ code: 'CANCELLED' });
      }
      await settle();
      // Cancelling stopped the waiting, not the requests: every slot is still owned.
      expect(session.runtime.stats().active).toBe(4);
      const refused = await session.client.callTool({ name: 'testrail_get_project', arguments: { project_id: 5 } });
      expect(errorOf(refused as ToolResult)).toMatchObject({ code: 'BUSY' });
      expect(upstream.calls).toBe(4);

      upstream.releaseAll();
      await waitFor(() => session.runtime.stats().active === 0, 'slots released on settlement');
      const next = session.client.callTool({ name: 'testrail_get_project', arguments: { project_id: 6 } });
      await waitFor(() => upstream.calls === 5, 'exactly one new request');
      upstream.releaseAll();
      expect((await next).isError).toBeFalsy();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
      upstream.releaseAll();
      await session.close();
    }
  });

  it('reports a dispatched registered write that is cancelled as of unknown outcome', async () => {
    const upstream = heldUpstream({ id: 9, name: 'Created' });
    const session = await connect(upstream.fetch, era);
    try {
      const cancel = new AbortController();
      const call = session.client.callTool(
        { name: 'testrail_add_project', arguments: { body: { name: 'Created' } } },
        { signal: cancel.signal },
      );
      await waitFor(() => upstream.calls === 1, 'the dispatched write');
      cancel.abort('caller gave up');
      await expect(call).rejects.toThrow();
      await waitFor(() => vi.mocked(executeToolCall).mock.results.length > 0, 'the handler call');

      const handled = await lastHandlerResult();
      // The request was sent and never answered, so the write may already be applied.
      expect(errorOf(handled)).toMatchObject({ code: 'CANCELLED', write_outcome: 'unknown' });
      await settle();
      expect(session.runtime.stats().active).toBe(1);

      upstream.releaseAll();
      await waitFor(() => session.runtime.stats().active === 0, 'the slot released on settlement');
    } finally {
      upstream.releaseAll();
      await session.close();
    }
  });
});

/*
 * Recorded SDK behaviour. Through 2.0.0 the server's cancellation handler began
 * `if (!notification.params.requestId) return;`, so a cancellation naming request id 0 was
 * dropped as if it named none. A legacy connection spends id 0 on initialize, which is
 * never cancelled, but a 2026-07-28 client opens with a string-id discover probe and gives
 * its first ordinary request id 0, so cancelling that request never reached the handler.
 * 2.3.0 tests `requestId === undefined` instead, and id 0 is cancelled like any other.
 * This stays pinned so that an SDK change to it surfaces rather than silently altering
 * what cancellation means.
 */
describe('a cancelled first request on a 2026-07-28 connection', () => {
  it('is delivered to the handler like any other, and its reply is suppressed', async () => {
    const upstream = heldUpstream({ id: 7, name: 'Project' });
    const session = await connect(upstream.fetch, { pin: '2026-07-28' }, false);
    try {
      const cancel = new AbortController();
      const call = session.client.callTool(
        { name: 'testrail_get_project', arguments: { project_id: 7 } },
        { signal: cancel.signal },
      );
      await waitFor(() => upstream.calls === 1, 'the dispatched request');
      // The case under test: the tool call is this connection's request id 0.
      expect(session.received.filter(({ method }) => method === 'tools/call').map(({ id }) => id)).toEqual([0]);
      cancel.abort('caller gave up');
      await expect(call).rejects.toThrow();
      await waitFor(() => vi.mocked(executeToolCall).mock.results.length > 0, 'the handler call');

      const handled = await lastHandlerResult();
      // Before 2.3.0 the cancellation was dropped and this call completed normally.
      expect(errorOf(handled).code).toBe('CANCELLED');
      expect(errorOf(handled).write_outcome).toBeUndefined();

      upstream.releaseAll();
      await waitFor(() => upstream.replies === 1, 'the late reply');
      await waitFor(() => session.runtime.stats().active === 0, 'the slot released on settlement');
      // The SDK suppresses the response to a request it has seen cancelled.
      expect(session.sent.some((message) => message.id === 0)).toBe(false);
    } finally {
      upstream.releaseAll();
      await session.close();
    }
  });
});
