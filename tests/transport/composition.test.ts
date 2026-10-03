import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TestRailClient } from '@dichovsky/testrail-api-client';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { EXIT_GRACE_MS, exitAfterGrace, startServer, type StartedServer } from '../../src/transport/server.js';

/*
 * The composition root, `startServer`, run in-process. Its test-only seams replace the
 * driver's network and resolver and the stdio entry; everything between them is what the
 * CLI runs: configuration, the one driver, the one runtime, the full catalog and the
 * server factory. Other suites build their own driver and runtime around `buildServer`,
 * so they cannot see a composition that made a second driver, contacted TestRail at
 * startup or tied the shared runtime to one connection.
 */

let directory: string;
beforeAll(async () => { directory = await mkdtemp(join(tmpdir(), 'testrail-mcp-composition-')); });
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });
afterEach(() => { vi.restoreAllMocks(); });

const environment = () => ({
  TESTRAIL_BASE_URL: 'https://composition.testrail.io',
  TESTRAIL_EMAIL: 'user@example.com',
  TESTRAIL_API_KEY: 'synthetic',
  TESTRAIL_MCP_UPLOAD_ROOTS: '[]',
  TESTRAIL_MCP_DOWNLOAD_DIR: directory,
});

/** TestRail and its resolver, counted; each request is held until the test answers or fails it. */
function upstream() {
  const held: { resolve: (response: Response) => void; reject: (error: Error) => void }[] = [];
  const authorizations: string[] = [];
  let lookups = 0;
  const fetch = vi.fn((_url: unknown, init?: RequestInit) => {
    authorizations.push(new Headers(init?.headers).get('authorization') ?? '');
    return new Promise<Response>((resolve, reject) => { held.push({ resolve, reject }); });
  });
  const dnsLookup = () => { lookups += 1; return Promise.resolve([{ address: '203.0.113.10', family: 4 as const }]); };
  return {
    fetch: fetch as unknown as typeof globalThis.fetch,
    dnsLookup,
    authorizations,
    get calls() { return fetch.mock.calls.length; },
    get lookups() { return lookups; },
    answerAll(body: unknown = { id: 1, name: 'Project' }) {
      for (const request of held.splice(0)) {
        request.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
      }
    },
    failAll() { for (const request of held.splice(0)) request.reject(new TypeError('socket hang up')); },
  };
}

type Negotiation = 'legacy' | { readonly pin: string };

interface Composed {
  readonly started: StartedServer;
  readonly connect: (negotiation?: Negotiation) => Promise<{ client: Client; close: () => Promise<void> }>;
}

/**
 * Start the real composition with the stdio entry pointed at an in-memory pair, then
 * serve its own factory on as many further pairs as the test asks for. Each pair is a
 * separate protocol consumer of the one process.
 */
async function compose(fake: ReturnType<typeof upstream>): Promise<Composed> {
  let factory: Parameters<typeof serveStdio>[0] | undefined;
  const pending: InMemoryTransport[] = [];
  const serve = ((serverFactory: Parameters<typeof serveStdio>[0], options: Parameters<typeof serveStdio>[1]) => {
    factory = serverFactory;
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    pending.push(clientSide);
    return serveStdio(serverFactory, { ...options, transport: serverSide });
  }) as typeof serveStdio;
  const started = await startServer(environment(), {
    registerSignals: false, serve, driver: { fetch: fake.fetch, dnsLookup: fake.dnsLookup },
  });
  const connect = async (negotiation?: Negotiation) => {
    let transport = pending.shift();
    let handle: { close: () => Promise<void> } | undefined;
    if (transport === undefined) {
      if (factory === undefined) throw new Error('startServer never reached the stdio entry');
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      transport = clientSide;
      handle = serveStdio(factory, { transport: serverSide });
    }
    const client = new Client(
      { name: 'composition-test', version: '1.0.0' },
      negotiation === undefined ? {} : { versionNegotiation: { mode: negotiation } },
    );
    await client.connect(transport);
    return {
      client,
      close: async () => {
        await client.close().catch(() => undefined);
        await handle?.close().catch(() => undefined);
      },
    };
  };
  return { started, connect };
}

function events(write: { mock: { calls: unknown[][] } }): Record<string, unknown>[] {
  return write.mock.calls
    .map(([chunk]) => String(chunk))
    .filter((line) => line.startsWith('{"event"'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function waitFor(condition: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => { setTimeout(resolve, 5); });
  }
}

const errorOf = (result: unknown) => (result as { structuredContent: { error: { code: string } } }).structuredContent.error;

describe('the composition root', () => {
  it('makes no TestRail request or lookup at startup or discovery, then one per call', async () => {
    const fake = upstream();
    const { started, connect } = await compose(fake);
    const first = await connect();
    const second = await connect();
    try {
      expect((await first.client.listTools()).tools).toHaveLength(133);
      expect((await second.client.listTools()).tools).toHaveLength(133);
      expect(fake.calls).toBe(0);
      expect(fake.lookups).toBe(0);

      // The seam is live, so the zero above is a real zero and not an unused fake.
      const call = first.client.callTool({ name: 'testrail_get_project', arguments: { project_id: 1 } });
      await waitFor(() => fake.calls === 1, 'the one request');
      fake.answerAll();
      expect((await call).isError).toBeFalsy();
      expect(fake.lookups).toBe(1);
    } finally {
      await first.close();
      await second.close();
      await started.shutdown();
    }
  });

  it('gives two protocol consumers one driver identity and one budget of four calls', async () => {
    const fake = upstream();
    const { started, connect } = await compose(fake);
    const first = await connect();
    const second = await connect();
    try {
      const call = (session: typeof first, id: number) =>
        session.client.callTool({ name: 'testrail_get_project', arguments: { project_id: id } });
      // Record which client instance serves each call: the Basic header alone could not
      // tell one driver from two built from the same configuration.
      const instances = new Set<TestRailClient>();
      // eslint-disable-next-line @typescript-eslint/unbound-method -- re-bound to each instance with apply below.
      const track = TestRailClient.prototype.trackOperation;
      vi.spyOn(TestRailClient.prototype, 'trackOperation').mockImplementation(function (this: TestRailClient, ...args) {
        instances.add(this);
        return track.apply(this, args);
      });
      const inflight = [call(first, 1), call(first, 2), call(second, 3), call(second, 4)];
      await waitFor(() => fake.calls === 4, 'four requests from two consumers');

      // A second driver or runtime per connection would give each consumer its own four.
      expect(errorOf(await call(first, 5))).toMatchObject({ code: 'BUSY' });
      expect(errorOf(await call(second, 6))).toMatchObject({ code: 'BUSY' });
      expect(fake.calls).toBe(4);
      expect(instances.size).toBe(1);

      fake.answerAll();
      for (const result of await Promise.all(inflight)) expect(result.isError).toBeFalsy();
    } finally {
      await first.close();
      await second.close();
      await started.shutdown();
    }
  });

  it('gives a legacy and a 2026-07-28 consumer one driver identity and one budget of four calls', async () => {
    const fake = upstream();
    const { started, connect } = await compose(fake);
    // serveStdio passes the negotiated era to the factory, so a composition could build
    // a driver per era. Each consumer here runs the factory in a different era.
    const legacy = await connect('legacy');
    const modern = await connect({ pin: '2026-07-28' });
    try {
      expect(legacy.client.getProtocolEra()).toBe('legacy');
      expect(modern.client.getProtocolEra()).toBe('modern');
      const call = (session: typeof legacy, id: number) =>
        session.client.callTool({ name: 'testrail_get_project', arguments: { project_id: id } });
      const instances = new Set<TestRailClient>();
      // eslint-disable-next-line @typescript-eslint/unbound-method -- re-bound to each instance with apply below.
      const track = TestRailClient.prototype.trackOperation;
      vi.spyOn(TestRailClient.prototype, 'trackOperation').mockImplementation(function (this: TestRailClient, ...args) {
        instances.add(this);
        return track.apply(this, args);
      });
      const inflight = [call(legacy, 1), call(legacy, 2), call(modern, 3), call(modern, 4)];
      await waitFor(() => fake.calls === 4, 'four requests from two eras');

      expect(errorOf(await call(legacy, 5))).toMatchObject({ code: 'BUSY' });
      expect(errorOf(await call(modern, 6))).toMatchObject({ code: 'BUSY' });
      expect(fake.calls).toBe(4);
      expect(instances.size).toBe(1);

      fake.answerAll();
      for (const result of await Promise.all(inflight)) expect(result.isError).toBeFalsy();
    } finally {
      await legacy.close();
      await modern.close();
      await started.shutdown();
    }
  });

  it('keeps serving one consumer after another disconnects, and destroys the driver only at shutdown', async () => {
    const destroy = vi.spyOn(TestRailClient.prototype, 'destroy');
    const fake = upstream();
    const { started, connect } = await compose(fake);
    // The configuration probe is destroyed at load; the served driver is not.
    expect(destroy).toHaveBeenCalledTimes(1);
    const first = await connect();
    const second = await connect();
    try {
      await first.close();
      const call = second.client.callTool({ name: 'testrail_get_project', arguments: { project_id: 1 } });
      await waitFor(() => fake.calls === 1, 'a request from the remaining consumer');
      fake.answerAll();
      expect((await call).isError).toBeFalsy();
      expect(destroy).toHaveBeenCalledTimes(1);
    } finally {
      await second.close();
      await started.shutdown();
    }
    expect(destroy).toHaveBeenCalledTimes(2);
  });

  it('shares one shutdown between concurrent callers: one stop pair, one destroy', async () => {
    const destroy = vi.spyOn(TestRailClient.prototype, 'destroy');
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const fake = upstream();
    const { started, connect } = await compose(fake);
    const session = await connect();
    // Shutdown closes the connection under this call, so the client's own promise rejects; observed here.
    const call = session.client.callTool({ name: 'testrail_get_project', arguments: { project_id: 1 } })
      .catch(() => undefined);
    await waitFor(() => fake.calls === 1, 'the in-flight request');

    const stops = [started.shutdown(), started.shutdown()];
    await waitFor(() => events(write).some(({ event }) => event === 'server_stopping'), 'the stop to begin');
    // The second caller must not return before the drain the first one started.
    let settled = 0;
    for (const stop of stops) void stop.then(() => { settled += 1; });
    await new Promise((resolve) => { setTimeout(resolve, 50); });
    expect(settled).toBe(0);

    fake.answerAll();
    await Promise.all(stops);
    await call;
    expect(settled).toBe(2);
    const names = events(write).map(({ event }) => event);
    expect(names.filter((name) => name === 'server_stopping')).toHaveLength(1);
    expect(names.filter((name) => name === 'server_stopped')).toHaveLength(1);
    expect(destroy).toHaveBeenCalledTimes(2); // the probe at load, then the served driver once
    await session.close();
  });

  it('records a write pending at shutdown as unknown, and stops cleanly when it fails during the drain', async () => {
    const destroy = vi.spyOn(TestRailClient.prototype, 'destroy');
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    const fake = upstream();
    const { started, connect } = await compose(fake);
    const session = await connect();
    try {
      // The caller's own promise rejects when the connection closes; that is the client's
      // error, observed here, and not one the server leaked.
      const call = session.client.callTool({ name: 'testrail_add_project', arguments: { body: { name: 'Pending' } } })
        .catch(() => undefined);
      await waitFor(() => fake.calls === 1, 'the dispatched write');

      const stop = started.shutdown();
      // Shutdown closes the connection, so the caller never sees a result; the
      // diagnostic line is the only record that the write may already be applied.
      await waitFor(() => events(write).some(({ event }) => event === 'tool_call'), 'the write to be recorded');
      expect(events(write).find(({ event }) => event === 'tool_call')).toMatchObject({
        tool: 'testrail_add_project', outcome: 'error', code: 'CANCELLED', write_outcome: 'unknown',
      });

      fake.failAll();
      await stop;
      await call;
      await new Promise((resolve) => { setTimeout(resolve, 20); });
      expect(unhandled).not.toHaveBeenCalled();
      expect(destroy).toHaveBeenCalledTimes(2);
      expect(events(write).map(({ event }) => event)).toContain('server_stopped');
    } finally {
      process.off('unhandledRejection', unhandled);
      await session.close();
    }
  });
});

describe('a shutdown step that fails', () => {
  it('still completes the shutdown and logs its stop when destroying the driver throws', async () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const fake = upstream();
    const { started } = await compose(fake);
    // Only the served driver's destroy fails; the probe was destroyed at load, before this.
    vi.spyOn(TestRailClient.prototype, 'destroy').mockImplementation(() => { throw new Error('destroy failed'); });
    await expect(started.shutdown()).resolves.toBeUndefined();
    expect(events(write).map(({ event }) => event)).toContain('server_stopped');
  });

  it('still drains, destroys the driver and logs its stop when closing the connection fails', async () => {
    const destroy = vi.spyOn(TestRailClient.prototype, 'destroy');
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const fake = upstream();
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    // A real connection whose close then rejects. The SDK's own close absorbs the
    // failures of the steps it awaits, so this stands in for whatever still escapes it:
    // the claim is only that the composition root absorbs a rejecting close.
    const serve = ((factory: Parameters<typeof serveStdio>[0], options: Parameters<typeof serveStdio>[1]) => {
      const real = serveStdio(factory, { ...options, transport: serverSide });
      return { close: async () => { await real.close(); throw new Error('close failed'); } };
    }) as typeof serveStdio;
    const started = await startServer(environment(), {
      registerSignals: false, serve, driver: { fetch: fake.fetch, dnsLookup: fake.dnsLookup },
    });
    const client = new Client({ name: 'composition-test', version: '1.0.0' });
    await client.connect(clientSide);
    try {
      // Shutdown closes the connection under this call, so the client's own promise rejects; observed here.
      const call = client.callTool({ name: 'testrail_get_project', arguments: { project_id: 1 } })
        .catch(() => undefined);
      await waitFor(() => fake.calls === 1, 'the in-flight request');

      let outcome: unknown = 'pending';
      const stop = started.shutdown().then(() => { outcome = 'stopped'; }, (error: unknown) => { outcome = error; });
      await waitFor(() => events(write).some(({ event }) => event === 'server_stopping'), 'the stop to begin');
      await new Promise((resolve) => { setTimeout(resolve, 50); });
      // The failed close neither failed the shutdown nor ended it early: the drain still
      // waits for the call, and the driver is not yet destroyed under it.
      expect(outcome).toBe('pending');
      expect(destroy).toHaveBeenCalledTimes(1); // the probe at load

      fake.answerAll();
      await stop;
      await call;
      expect(outcome).toBe('stopped');
      expect(destroy).toHaveBeenCalledTimes(2);
      expect(events(write).map(({ event }) => event)).toContain('server_stopped');
    } finally {
      fake.answerAll();
      await client.close().catch(() => undefined);
    }
  });
});

describe('the forced exit after shutdown', () => {
  const flushedAtOnce = (done: () => void): void => { done(); };

  it('fires after the grace and not before', () => {
    vi.useFakeTimers();
    try {
      const exit = vi.fn();
      void exitAfterGrace(exit, flushedAtOnce);
      vi.advanceTimersByTime(EXIT_GRACE_MS - 1);
      expect(exit).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(exit).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it('waits for stdout to flush before the grace starts', () => {
    vi.useFakeTimers();
    try {
      const exit = vi.fn();
      let flush: () => void = () => undefined;
      void exitAfterGrace(exit, (done) => { flush = done; });
      // A host still reading a large response: however long it takes, nothing is cut off.
      vi.advanceTimersByTime(60_000);
      expect(exit).not.toHaveBeenCalled();
      flush();
      vi.advanceTimersByTime(EXIT_GRACE_MS - 1);
      expect(exit).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(exit).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it('never keeps the process alive by itself', async () => {
    const exit = vi.fn();
    const timer = await exitAfterGrace(exit, flushedAtOnce);
    try {
      // An idle process exits on its own first; only lingering work lets this fire.
      expect(timer.hasRef()).toBe(false);
    } finally { clearTimeout(timer); }
    expect(EXIT_GRACE_MS).toBe(250);
  });

  it('flushes the real stdout by default', async () => {
    const exit = vi.fn();
    const timer = await exitAfterGrace(exit);
    clearTimeout(timer);
    expect(exit).not.toHaveBeenCalled();
  });
});
