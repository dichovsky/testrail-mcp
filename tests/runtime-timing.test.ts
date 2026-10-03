import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConfiguration, type Configuration } from '../src/config/environment.js';
import { createConfiguredDriver } from '../src/driver/configuration.js';
import { operationRegistry } from '../src/operations/catalog.js';
import { createRuntime, type Runtime } from '../src/runtime/invocation.js';
import { executeToolCall } from '../src/transport/tool-call.js';

/*
 * Each timing budget a call can meet, told apart on a fake clock. The driver is built
 * with the production options (15-second header and body timeouts, three retries,
 * 1/2/4-second backoff capped at 10 seconds) through the composition root's own seam,
 * and the runtime uses its real 60-second watchdog timer, so these are the budgets a
 * served call meets rather than a test's shortened copies. Each case shows its outcome
 * arriving at its own instant and not a millisecond before.
 */

let directory: string;
let configuration: Configuration;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'testrail-mcp-timing-'));
  // Loaded before the clock is faked: loading probes directories on the real clock.
  configuration = await loadConfiguration({
    TESTRAIL_BASE_URL: 'https://timing.testrail.io',
    TESTRAIL_EMAIL: 'user@example.com',
    TESTRAIL_API_KEY: 'synthetic',
    TESTRAIL_MCP_UPLOAD_ROOTS: '[]',
    TESTRAIL_MCP_DOWNLOAD_DIR: directory,
  });
});
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });
afterEach(() => { vi.useRealTimers(); });

const getProject = operationRegistry.entries.find(({ tool }) => tool === 'testrail_get_project');
if (getProject === undefined) throw new Error('testrail_get_project is not registered');

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

interface Timed {
  readonly runtime: Runtime;
  readonly fetchTimes: number[];
  readonly settled: () => boolean;
  readonly result: Promise<{ structuredContent?: unknown; isError?: boolean }>;
}

/** Start one served call on a fake clock and record when each request left. */
function start(fetch: Fetch, dnsLookup?: () => Promise<{ address: string; family: 4 }[]>): Timed {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const began = Date.now();
  const fetchTimes: number[] = [];
  const client = createConfiguredDriver(configuration, {
    fetch: ((url: string, init: RequestInit) => { fetchTimes.push(Date.now() - began); return fetch(url, init); }) as typeof globalThis.fetch,
    dnsLookup: dnsLookup ?? (() => Promise.resolve([{ address: '203.0.113.10', family: 4 }])),
  });
  const runtime = createRuntime({ client, limits: configuration.limits });
  let done = false;
  const result = executeToolCall(getProject!, { project_id: 1 }, {
    runtime, configuration, stagingDirectory: () => Promise.resolve(directory),
  }).finally(() => { done = true; });
  return { runtime, fetchTimes, settled: () => done, result };
}

const errorOf = (result: { structuredContent?: unknown }) =>
  (result.structuredContent as { error: Record<string, unknown> }).error;

/** A request that never answers and, like fetch, rejects with AbortError when aborted. */
const unanswered: Fetch = (_url, init) => new Promise((_resolve, reject) => {
  init.signal?.addEventListener('abort', () => { reject(new DOMException('aborted', 'AbortError')); });
});

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/** Headers after `headersAt` ms; the body's first bytes at once, the rest after `restAfter` ms, or never. */
function slowBody(headersAt: number, restAfter: number | undefined): Fetch {
  return () => new Promise((resolve) => {
    setTimeout(() => {
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('{"id":1,'));
          if (restAfter !== undefined) {
            setTimeout(() => { controller.enqueue(encoder.encode('"name":"Project"}')); controller.close(); }, restAfter);
          }
        },
      });
      resolve(new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }));
    }, headersAt);
  });
}

describe('timing budgets on a fake clock, with production driver options', () => {
  /*
   * From driver 9.0.0 the 15-second request timeout covers DNS resolution, so a resolver
   * that never answers no longer holds a call open without limit. The lookup cannot be
   * cancelled, though, so the call keeps its slot until the lookup settles, after it has
   * already answered.
   */
  it('counts DNS against the 15-second request timeout, and keeps the slot until the lookup settles', async () => {
    let answer: () => void = () => undefined;
    const lookup = () => new Promise<{ address: string; family: 4 }[]>((resolve) => {
      answer = () => { resolve([{ address: '203.0.113.10', family: 4 }]); };
    });
    const call = start(unanswered, lookup);
    try {
      await vi.advanceTimersByTimeAsync(14_999);
      expect(call.settled()).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(call.settled()).toBe(true);
      // The driver gave up waiting before any request, and TestRail sent no status:
      // TIMEOUT, not a 408 (decided 2026-10-03; docs/results-and-errors.md).
      const error = errorOf(await call.result);
      expect(error).toMatchObject({ code: 'TIMEOUT' });
      expect(error).not.toHaveProperty('http_status');
      expect(call.fetchTimes).toEqual([]);
      // Answered, but the lookup is still running: the slot is still taken.
      expect(call.runtime.stats().active).toBe(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(call.runtime.stats().active).toBe(1);
      answer();
      await vi.advanceTimersByTimeAsync(0);
      expect(call.runtime.stats().active).toBe(0);
      // A late answer starts no request, and nothing retried the timed-out attempt.
      expect(call.fetchTimes).toEqual([]);
    } finally { await call.runtime.shutdown(); }
  });

  it('gives the body its own 15 seconds from the arrival of the headers', async () => {
    const call = start(slowBody(14_000, undefined));
    try {
      // The header timer is cleared at 14 s; a shared timer would have fired at 15 s.
      await vi.advanceTimersByTimeAsync(28_999);
      expect(call.settled()).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(call.settled()).toBe(true);
      // The driver stopped reading: the wait expired, not an unusable response.
      expect(errorOf(await call.result)).toMatchObject({ code: 'TIMEOUT' });
      expect(call.fetchTimes).toEqual([0]);
    } finally { await call.runtime.shutdown(); }
  });

  it('completes a body that finishes inside its own 15 seconds, although 28 seconds have passed', async () => {
    const call = start(slowBody(14_000, 14_000));
    try {
      await vi.advanceTimersByTimeAsync(28_000);
      expect(call.settled()).toBe(true);
      expect((await call.result).isError).toBeFalsy();
    } finally { await call.runtime.shutdown(); }
  });

  it('backs off 1, 2 and 4 seconds between the three retries of a 503', async () => {
    let attempt = 0;
    const call = start(() => { attempt += 1; return Promise.resolve(attempt <= 3 ? json({ error: 'busy' }, 503) : json({ id: 1, name: 'Project' })); });
    try {
      await vi.advanceTimersByTimeAsync(6_999);
      expect(call.fetchTimes).toEqual([0, 1_000, 3_000]);
      await vi.advanceTimersByTimeAsync(1);
      expect(call.fetchTimes).toEqual([0, 1_000, 3_000, 7_000]);
      expect((await call.result).isError).toBeFalsy();
    } finally { await call.runtime.shutdown(); }
  });

  it.each([
    ['5', 5_000],
    ['120', 10_000], // a server's hint is capped at 10 seconds
  ] as const)('waits a Retry-After of %s seconds, as %d ms, before retrying', async (header, wait) => {
    let attempt = 0;
    const call = start(() => { attempt += 1; return Promise.resolve(attempt === 1 ? json({ error: 'busy' }, 503, { 'retry-after': header }) : json({ id: 1, name: 'Project' })); });
    try {
      await vi.advanceTimersByTimeAsync(wait - 1);
      expect(call.fetchTimes).toEqual([0]);
      await vi.advanceTimersByTimeAsync(1);
      expect(call.fetchTimes).toEqual([0, wait]);
      expect((await call.result).isError).toBeFalsy();
    } finally { await call.runtime.shutdown(); }
  });

  it('reports TIMEOUT at 60 seconds while the driver is still retrying, and keeps the slot until it gives up', async () => {
    // Each attempt answers a 503 after 14 s and asks for 10 s: attempts leave at 0, 24, 48 and 72 s.
    const call = start(() => new Promise((resolve) => {
      setTimeout(() => { resolve(json({ error: 'busy' }, 503, { 'retry-after': '10' })); }, 14_000);
    }));
    try {
      await vi.advanceTimersByTimeAsync(59_999);
      expect(call.settled()).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(call.settled()).toBe(true);
      expect(errorOf(await call.result)).toMatchObject({ code: 'TIMEOUT' });
      expect(call.fetchTimes).toEqual([0, 24_000, 48_000]);
      // The watchdog stopped the waiting, not the driver: the slot stays owned.
      expect(call.runtime.stats().active).toBe(1);

      await vi.advanceTimersByTimeAsync(25_999);
      expect(call.fetchTimes).toEqual([0, 24_000, 48_000, 72_000]);
      expect(call.runtime.stats().active).toBe(1);
      // The fourth attempt's 503 at 86 s exhausts the retries and settles the operation.
      await vi.advanceTimersByTimeAsync(1);
      await vi.waitFor(() => { expect(call.runtime.stats().active).toBe(0); });
    } finally { await call.runtime.shutdown(); }
  });
});
