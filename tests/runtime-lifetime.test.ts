import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TestRailApiError, TestRailClient } from '@dichovsky/testrail-api-client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConfiguration, type Configuration } from '../src/config/environment.js';
import { classifyError } from '../src/contracts/errors.js';
import type { ToolResult } from '../src/contracts/results.js';
import { createStagingArea } from '../src/files/staging.js';
import { operationRegistry } from '../src/operations/catalog.js';
import type { Operation } from '../src/operations/registry.js';
import { createRuntime, type Delay, type Runtime } from '../src/runtime/invocation.js';
import { executeToolCall } from '../src/transport/tool-call.js';

/*
 * Runtime lifetime through registered tools. tests/runtime-invocation.test.ts proves these
 * rules on `runtime.invoke`; this file drives the production registrations through the
 * tool pipeline, so a registration or pipeline stage that released capacity early, or
 * started work the runtime did not own, would fail here even with the runtime intact.
 *
 * No test waits for a real deadline. The 60-second watchdog is fired by hand, and the
 * driver's aggregate deadline is set to a few milliseconds.
 */

let base: string;
let roots: string;
let configuration: Configuration;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'testrail-mcp-lifetime-'));
  roots = join(base, 'roots');
  await mkdir(roots);
  configuration = await loadConfiguration({
    TESTRAIL_BASE_URL: 'https://lifetime.testrail.io',
    TESTRAIL_EMAIL: 'user@example.com',
    TESTRAIL_API_KEY: 'synthetic',
    TESTRAIL_MCP_UPLOAD_ROOTS: JSON.stringify([roots]),
    TESTRAIL_MCP_DOWNLOAD_DIR: base,
  });
});

afterAll(async () => { await rm(base, { recursive: true, force: true }); });

function registered(tool: string): Operation {
  const operation = operationRegistry.entries.find((entry) => entry.tool === tool);
  if (operation === undefined) throw new Error(`${tool} is not registered`);
  return operation;
}

const getProject = registered('testrail_get_project');
const getProjects = registered('testrail_get_projects');
const addAttachmentToCase = registered('testrail_add_attachment_to_case');

const PROJECT = { id: 1, name: 'Project' };
const EMPTY_PROJECTS = { offset: 0, limit: 250, size: 0, _links: { next: null, prev: null }, projects: [] };

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

/** A gate per call: each call is counted and held until the test releases it. */
function gate<T>(value: (index: number) => T) {
  const releases: (() => void)[] = [];
  let calls = 0;
  let settled = 0;
  const hold = async (): Promise<T> => {
    const index = calls;
    calls += 1;
    await new Promise<void>((resolve) => releases.push(resolve));
    settled += 1;
    return value(index);
  };
  return {
    hold,
    get calls() { return calls; },
    get settled() { return settled; },
    releaseAll() { for (const release of releases.splice(0)) release(); },
  };
}

const PUBLIC_ADDRESS = [{ address: '203.0.113.10', family: 4 as const }];

function driver(options: {
  readonly fetch: typeof globalThis.fetch;
  readonly dnsLookup?: () => Promise<{ address: string; family: 4 | 6 }[]>;
}): TestRailClient {
  return new TestRailClient({
    baseUrl: configuration.baseUrl, email: configuration.email, apiKey: configuration.apiKey,
    registerProcessHandlers: false, maxRetries: 0,
    dnsLookup: options.dnsLookup ?? (() => Promise.resolve(PUBLIC_ADDRESS)),
    fetch: options.fetch,
  });
}

/** The runtime's waits, fired by hand. Only the 60-second response watchdog is fired. */
function manualDelay() {
  const pending: { ms: number; fire: () => void; cancelled: boolean }[] = [];
  const delay = (ms: number): Delay => {
    const entry = { ms, fire: () => undefined as void, cancelled: false };
    const promise = new Promise<void>((resolve) => { entry.fire = resolve; });
    pending.push(entry);
    return { promise, cancel: () => { entry.cancelled = true; } };
  };
  const live = () => pending.filter((entry) => !entry.cancelled && entry.ms === 60_000);
  return {
    delay,
    watchdogs: () => live().length,
    fireWatchdogs: () => { for (const entry of live()) entry.fire(); },
  };
}

async function waitFor(condition: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => { setTimeout(resolve, 5); });
  }
}

/** Only for asserting that something has *not* happened. */
async function settle(ms = 30): Promise<void> {
  await new Promise((resolve) => { setTimeout(resolve, ms); });
}

function error(result: ToolResult): { code: string } | undefined {
  return (result.structuredContent as { error?: { code: string } }).error;
}

function code(result: ToolResult): string | undefined {
  return error(result)?.code;
}

function call(runtime: Runtime, operation: Operation, input: unknown, stagingDirectory?: string): Promise<ToolResult> {
  return executeToolCall(operation, input, {
    runtime, configuration,
    ...(stagingDirectory === undefined ? {} : { stagingDirectory: () => Promise.resolve(stagingDirectory) }),
  });
}

const SLOTS = 4;
/** An aggregate whose own deadline passes long before anything is released. */
const allProjects = { _mcp: { pagination: 'all', max_duration_ms: 20 } };
/*
 * For a test that needs its aggregates to reach the network: an aggregate whose deadline
 * passes before its lookup or request starts never starts it, so nothing is left holding
 * its slot. The deadline is real time, so 20 ms is too little on a slow runner: a macOS
 * CI run once dispatched one of four in time.
 */
const allProjectsReachingNetwork = { _mcp: { pagination: 'all', max_duration_ms: 1_000 } };
/** How the driver's aggregate deadline reaches a caller: a bound, never the watchdog's TIMEOUT. */
const DURATION_STOP = { code: 'PAGINATION_LIMIT', reason: 'max_duration' };

describe('capacity after the adapter watchdog', () => {
  it('keeps every slot of a timed-out registered read until upstream settles', async () => {
    const upstream = gate(() => json(PROJECT));
    const watchdog = manualDelay();
    const runtime = createRuntime({
      client: driver({ fetch: upstream.hold }),
      limits: configuration.limits, delay: watchdog.delay,
    });
    try {
      expect(configuration.limits.max_active_calls).toBe(SLOTS);
      const calls = Array.from({ length: SLOTS }, (_unused, index) => call(runtime, getProject, { project_id: index + 1 }));
      await waitFor(() => upstream.calls === SLOTS && watchdog.watchdogs() === SLOTS, 'four dispatched reads');

      watchdog.fireWatchdogs();
      for (const result of await Promise.all(calls)) expect(code(result)).toBe('TIMEOUT');

      // Every caller has its answer, but every request is still open upstream. The pause
      // lets an early release happen first, so the assertion cannot pass on timing alone.
      await settle();
      expect(runtime.stats().active).toBe(SLOTS);
      expect(code(await call(runtime, getProject, { project_id: 9 }))).toBe('BUSY');
      expect(upstream.calls).toBe(SLOTS);

      upstream.releaseAll();
      await waitFor(() => runtime.stats().active === 0, 'capacity released on settlement');
      const next = call(runtime, getProject, { project_id: 9 });
      await waitFor(() => upstream.calls === SLOTS + 1, 'the next call dispatched');
      upstream.releaseAll();
      expect((await next).isError).toBeUndefined();
    } finally {
      upstream.releaseAll();
      await runtime.shutdown();
    }
  });
});

describe('capacity after the driver aggregate deadline', () => {
  it('keeps every slot of an aggregate that rejected at its own deadline until its fetch settles', async () => {
    const upstream = gate(() => json(EMPTY_PROJECTS));
    const watchdog = manualDelay();
    const runtime = createRuntime({
      client: driver({ fetch: upstream.hold }),
      limits: configuration.limits, delay: watchdog.delay,
    });
    try {
      // The watchdog is never fired: every rejection here is the driver's own deadline.
      const results = await Promise.all(Array.from({ length: SLOTS }, () => call(runtime, getProjects, allProjectsReachingNetwork)));
      expect(upstream.calls).toBe(SLOTS);
      for (const result of results) expect(error(result)).toMatchObject(DURATION_STOP);

      await settle();
      expect(runtime.stats().active).toBe(SLOTS);
      expect(code(await call(runtime, getProject, { project_id: 1 }))).toBe('BUSY');
      expect(upstream.calls).toBe(SLOTS);

      upstream.releaseAll();
      await waitFor(() => runtime.stats().active === 0, 'capacity released on settlement');
      const next = call(runtime, getProject, { project_id: 1 });
      await waitFor(() => upstream.calls === SLOTS + 1, 'the next call dispatched');
      upstream.releaseAll();
      expect((await next).isError).toBeUndefined();
    } finally {
      upstream.releaseAll();
      await runtime.shutdown();
    }
  });
});

/*
 * The driver bounds each request inside an aggregate with timers set to the budget that
 * remains: the request's abort timer, a race against the deadline, and the body read.
 * Any of them can fire a moment before the wall clock reaches the deadline, and the
 * aggregate then rethrows that timer's own error instead of its duration stop. In local
 * loops that happened in a few percent of runs. Freezing the clock makes the ordering
 * certain: the timers still fire, and the clock never reaches the deadline.
 */
describe('the aggregate deadline, however the driver raises it', () => {
  async function frozen(fetch: typeof globalThis.fetch) {
    const runtime = createRuntime({ client: driver({ fetch }), limits: configuration.limits, delay: manualDelay().delay });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    try {
      return { result: await call(runtime, getProjects, allProjects), runtime };
    } finally {
      clock.mockRestore();
    }
  }

  it('on a request that ignores its abort signal', async () => {
    const upstream = gate(() => json(EMPTY_PROJECTS));
    const { result, runtime } = await frozen(upstream.hold);
    try {
      // No response arrived, so nothing may claim TestRail answered 408.
      expect(error(result)).toMatchObject(DURATION_STOP);
      expect(error(result)).not.toHaveProperty('http_status');
    } finally {
      upstream.releaseAll();
      await runtime.shutdown();
    }
  });

  it('on a request that honours its abort signal', async () => {
    // As a real fetch does: the request's own timer aborts it.
    const fetch = ((_url: unknown, init?: { signal?: AbortSignal }) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { reject(new DOMException('aborted', 'AbortError')); }, { once: true });
    })) as typeof globalThis.fetch;
    const { result, runtime } = await frozen(fetch);
    try {
      expect(error(result)).toMatchObject(DURATION_STOP);
      expect(error(result)).not.toHaveProperty('http_status');
    } finally {
      await runtime.shutdown();
    }
  });

  it('on a response body still being read', async () => {
    const body = heldBody(EMPTY_PROJECTS);
    const { result, runtime } = await frozen((() => Promise.resolve(body.response)));
    try {
      expect(error(result)).toMatchObject(DURATION_STOP);
    } finally {
      body.finish();
      body.finishCancel();
      await runtime.shutdown();
    }
  });
});

describe('classifying a timeout inside an aggregate', () => {
  const aggregate = { mutates: false, dispatched: true, acknowledged: false, aggregate: true };
  const single = { ...aggregate, aggregate: false };

  // Constructed exactly as the pinned driver constructs them: no response argument.
  const deadlineSpellings = [
    ['the deadline race', new TestRailApiError(408, 'Aggregate request deadline exceeded')],
    ['a request timeout clipped to the budget', new TestRailApiError(408, 'Request timeout after 20ms')],
    ['a body timeout clipped to the budget', new TestRailApiError(0, 'Body read timeout', 'body read exceeded 20ms before the response body finished streaming')],
  ] as const;

  it.each(deadlineSpellings)('reports %s as the duration bound', (_label, raised) => {
    const safe = classifyError(raised, aggregate);
    expect(safe).toMatchObject(DURATION_STOP);
    expect(safe).not.toHaveProperty('http_status');
  });

  it.each(deadlineSpellings)('leaves %s alone outside an aggregate', (_label, raised) => {
    expect(classifyError(raised, single).code).not.toBe('PAGINATION_LIMIT');
  });

  it.each([
    // The driver's full timeouts were not clipped, so the budget did not end them.
    ['an unclipped request timeout', new TestRailApiError(408, 'Request timeout after 15000ms'), 'UPSTREAM_ERROR'],
    ['an unclipped body timeout', new TestRailApiError(0, 'Body read timeout', 'body read exceeded 15000ms before the response body finished streaming'), 'INVALID_RESPONSE'],
    // A response did arrive: an upstream may send any reason phrase, and its status stands.
    ['a real 408 carrying the deadline phrase', new TestRailApiError(408, 'Aggregate request deadline exceeded', ''), 'UPSTREAM_ERROR'],
    ['a real 408 carrying a timeout phrase', new TestRailApiError(408, 'Request timeout after 20ms', '{"error":"slow"}'), 'UPSTREAM_ERROR'],
  ] as const)('does not report %s as the duration bound', (_label, raised, expected) => {
    expect(classifyError(raised, aggregate).code).toBe(expected);
  });
});

describe('deferred DNS', () => {
  it('holds capacity for a lookup outliving the aggregate deadline, and a late answer starts no fetch', async () => {
    const lookups = gate(() => PUBLIC_ADDRESS);
    let fetches = 0;
    const runtime = createRuntime({
      client: driver({
        dnsLookup: lookups.hold,
        fetch: (() => { fetches += 1; return Promise.resolve(json(EMPTY_PROJECTS)); }),
      }),
      limits: configuration.limits, delay: manualDelay().delay,
    });
    try {
      const results = await Promise.all(Array.from({ length: SLOTS }, () => call(runtime, getProjects, allProjectsReachingNetwork)));
      for (const result of results) expect(error(result)).toMatchObject(DURATION_STOP);
      expect(lookups.calls).toBe(SLOTS);
      expect(lookups.settled).toBe(0);

      await settle();
      // Each lookup is still outstanding, so each slot is still owned.
      expect(runtime.stats().active).toBe(SLOTS);
      expect(code(await call(runtime, getProject, { project_id: 1 }))).toBe('BUSY');
      // A refused call starts no lookup of its own.
      expect(lookups.calls).toBe(SLOTS);

      lookups.releaseAll();
      await waitFor(() => runtime.stats().active === 0, 'capacity released once DNS settles');
      // The deadline already passed, so resolving the host must not lead to a request.
      await settle();
      expect(fetches).toBe(0);
    } finally {
      lookups.releaseAll();
      await runtime.shutdown();
    }
  });

  /*
   * The watchdog only stops the adapter waiting: the driver never learns the caller has
   * gone, so a lookup answered after it still goes on to send the request. The slot has
   * to cover that request as well, and does.
   */
  it('holds capacity past the watchdog through the request a late lookup still starts', async () => {
    const lookups = gate(() => PUBLIC_ADDRESS);
    const upstream = gate(() => json(PROJECT));
    const watchdog = manualDelay();
    const runtime = createRuntime({
      client: driver({ dnsLookup: lookups.hold, fetch: upstream.hold }),
      limits: configuration.limits, delay: watchdog.delay,
    });
    try {
      const pending = call(runtime, getProject, { project_id: 1 });
      await waitFor(() => lookups.calls === 1 && watchdog.watchdogs() === 1, 'the lookup');
      watchdog.fireWatchdogs();
      expect(code(await pending)).toBe('TIMEOUT');
      await settle();
      expect(runtime.stats().active).toBe(1);

      lookups.releaseAll();
      await waitFor(() => upstream.calls === 1, 'the request the late lookup started');
      expect(runtime.stats().active).toBe(1);

      upstream.releaseAll();
      await waitFor(() => runtime.stats().active === 0, 'capacity released once the request settles');
    } finally {
      lookups.releaseAll();
      upstream.releaseAll();
      await runtime.shutdown();
    }
  });
});

/** A 200 whose body sends its first bytes and then waits for the test. */
function heldBody(body: unknown) {
  const text = JSON.stringify(body);
  let finish: () => void = () => undefined;
  let cancelled = false;
  let finishCancel: () => void = () => undefined;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(new TextEncoder().encode(text.slice(0, 5)));
      await new Promise<void>((resolve) => { finish = resolve; });
      if (cancelled) return;
      controller.enqueue(new TextEncoder().encode(text.slice(5)));
      controller.close();
    },
    // Cancellation completes only when the test says so, as a slow socket teardown would.
    cancel() {
      cancelled = true;
      return new Promise<void>((resolve) => { finishCancel = resolve; });
    },
  });
  return {
    response: new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } }),
    get cancelled() { return cancelled; },
    finish: () => { finish(); },
    finishCancel: () => { finishCancel(); },
  };
}

describe('deferred body settlement', () => {
  it('holds capacity past the watchdog while response bodies are still being read', async () => {
    const bodies: ReturnType<typeof heldBody>[] = [];
    const watchdog = manualDelay();
    const runtime = createRuntime({
      client: driver({
        fetch: (() => {
          const body = heldBody(PROJECT);
          bodies.push(body);
          return Promise.resolve(body.response);
        }),
      }),
      limits: configuration.limits, delay: watchdog.delay,
    });
    try {
      const calls = Array.from({ length: SLOTS }, (_unused, index) => call(runtime, getProject, { project_id: index + 1 }));
      await waitFor(() => bodies.length === SLOTS && watchdog.watchdogs() === SLOTS, 'four response headers');
      watchdog.fireWatchdogs();
      for (const result of await Promise.all(calls)) expect(code(result)).toBe('TIMEOUT');

      await settle();
      expect(runtime.stats().active).toBe(SLOTS);
      expect(code(await call(runtime, getProject, { project_id: 9 }))).toBe('BUSY');
      expect(bodies).toHaveLength(SLOTS);

      for (const body of bodies) body.finish();
      await waitFor(() => runtime.stats().active === 0, 'capacity released once the bodies are read');
    } finally {
      for (const body of bodies) body.finish();
      await runtime.shutdown();
    }
  });

  it('holds capacity past the aggregate deadline until the body read is cancelled to completion', async () => {
    const body = heldBody(EMPTY_PROJECTS);
    let requests = 0;
    const runtime = createRuntime({
      client: driver({ fetch: (() => { requests += 1; return Promise.resolve(body.response); }) }),
      limits: configuration.limits, delay: manualDelay().delay,
    });
    try {
      expect(error(await call(runtime, getProjects, allProjectsReachingNetwork))).toMatchObject(DURATION_STOP);
      expect(requests).toBe(1);
      // The driver gave up on the body and asked for its cancellation, which has not finished.
      await waitFor(() => body.cancelled, 'the body cancellation request');
      await settle();
      expect(runtime.stats().active).toBe(1);

      body.finishCancel();
      await waitFor(() => runtime.stats().active === 0, 'capacity released once cancellation completes');
    } finally {
      body.finish();
      body.finishCancel();
      await runtime.shutdown();
    }
  });
  it('fills every slot with aggregates whose body cancellation is still pending, and admits nothing until each completes', async () => {
    const bodies = Array.from({ length: SLOTS }, () => heldBody(EMPTY_PROJECTS));
    let requests = 0;
    const fetch = () => {
      const body = bodies[requests];
      requests += 1;
      if (body === undefined) throw new Error('A request was issued past the filled slots');
      return Promise.resolve(body.response);
    };
    const runtime = createRuntime({ client: driver({ fetch }), limits: configuration.limits, delay: manualDelay().delay });
    try {
      const outcomes = await Promise.all(bodies.map(() => call(runtime, getProjects, allProjectsReachingNetwork)));
      for (const outcome of outcomes) expect(error(outcome)).toMatchObject(DURATION_STOP);
      expect(requests).toBe(SLOTS);
      await waitFor(() => bodies.every((body) => body.cancelled), 'every body cancellation request');
      await settle();
      expect(runtime.stats().active).toBe(SLOTS);
      expect(code(await call(runtime, getProject, { project_id: 9 }))).toBe('BUSY');
      expect(requests).toBe(SLOTS);

      // One cancellation completing frees exactly one slot, not all four.
      bodies[0]?.finishCancel();
      await waitFor(() => runtime.stats().active === SLOTS - 1, 'one slot released');
      for (const body of bodies) body.finishCancel();
      await waitFor(() => runtime.stats().active === 0, 'capacity released once every cancellation completes');
      expect(requests).toBe(SLOTS);
    } finally {
      for (const body of bodies) { body.finish(); body.finishCancel(); }
      await runtime.shutdown();
    }
  });
});

describe('coalesced identical reads', () => {
  it('keeps one slot per caller of a joined request after the watchdog, until that request settles', async () => {
    const upstream = gate(() => json(PROJECT));
    const watchdog = manualDelay();
    const runtime = createRuntime({
      client: driver({ fetch: upstream.hold }),
      limits: configuration.limits, delay: watchdog.delay,
    });
    try {
      const calls = Array.from({ length: SLOTS }, () => call(runtime, getProject, { project_id: 7 }));
      await waitFor(() => upstream.calls === 1 && watchdog.watchdogs() === SLOTS, 'the joined request');
      await settle();
      // Four callers, one request: the driver joins identical in-flight GETs.
      expect(upstream.calls).toBe(1);

      watchdog.fireWatchdogs();
      for (const result of await Promise.all(calls)) expect(code(result)).toBe('TIMEOUT');
      await settle();
      expect(runtime.stats().active).toBe(SLOTS);
      expect(code(await call(runtime, getProject, { project_id: 8 }))).toBe('BUSY');
      expect(upstream.calls).toBe(1);

      upstream.releaseAll();
      await waitFor(() => runtime.stats().active === 0, 'every joined slot released');
    } finally {
      upstream.releaseAll();
      await runtime.shutdown();
    }
  });
});

describe('multipart upload cleanup', () => {
  it('keeps the staged copy and the slot of a timed-out upload until its request settles', async () => {
    const source = join(roots, 'lifetime.txt');
    await writeFile(source, 'uploaded after the watchdog');
    const area = await createStagingArea(base);
    const lookups = gate(() => PUBLIC_ADDRESS);
    let sent: string | undefined;
    const upstream = gate(() => json({ attachment_id: 1 }));
    const fetch = (async (_url: unknown, init?: { body?: ConstructorParameters<typeof Response>[0] }) => {
      // Read the multipart body the way a connection would, from the staged file.
      sent = await new Response(init?.body).text();
      return upstream.hold();
    }) as typeof globalThis.fetch;
    const watchdog = manualDelay();
    const runtime = createRuntime({
      client: driver({ dnsLookup: lookups.hold, fetch }), limits: configuration.limits, delay: watchdog.delay,
    });
    try {
      const pending = call(runtime, addAttachmentToCase, { case_id: 1, file_path: source, filename: 'lifetime.txt' }, area.directory);
      await waitFor(() => lookups.calls === 1 && watchdog.watchdogs() === 1, 'the upload lookup');
      watchdog.fireWatchdogs();
      const result = await pending;
      expect((result.structuredContent as { error: object }).error)
        .toMatchObject({ code: 'TIMEOUT', write_outcome: 'unknown' });

      // The request has not even been sent yet, so its staged copy must survive.
      await settle();
      expect(await readdir(area.directory)).toHaveLength(2);
      expect(runtime.stats().active).toBe(1);

      lookups.releaseAll();
      await waitFor(() => upstream.calls === 1, 'the upload request');
      expect(sent).toContain('uploaded after the watchdog');
      expect(await readdir(area.directory)).toHaveLength(2);

      upstream.releaseAll();
      await waitFor(() => runtime.stats().active === 0, 'the slot released on settlement');
      // Settlement disposed the copy: only the ownership marker remains.
      expect(await readdir(area.directory)).toEqual(['owner.json']);
    } finally {
      lookups.releaseAll();
      upstream.releaseAll();
      await runtime.shutdown();
      await area.dispose();
    }
  });
});
