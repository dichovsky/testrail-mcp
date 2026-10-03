import { mkdir, mkdtemp, open, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TestRailClient } from '@dichovsky/testrail-api-client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConfiguration, type Configuration } from '../../src/config/environment.js';
import type { ToolResult } from '../../src/contracts/results.js';
import { createStagingArea, stageUpload } from '../../src/files/staging.js';
import { operationRegistry } from '../../src/operations/catalog.js';
import { createRuntime, type Delay } from '../../src/runtime/invocation.js';
import { executeToolCall } from '../../src/transport/tool-call.js';

/*
 * Upload staging runs inside the call's slot: admitted like the request, bounded by the
 * response watchdog and stopped by cancellation. Driven through the production
 * registration of testrail_add_attachment_to_case. The staging module and the
 * filesystem are spied so a copy can be paused mid-read and its own outcome observed.
 */
vi.mock('node:fs/promises', { spy: true });
vi.mock('../../src/files/staging.js', { spy: true });
const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
const actualStaging = await vi.importActual<typeof import('../../src/files/staging.js')>('../../src/files/staging.js');

let base: string;
let roots: string;
let configuration: Configuration;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'testrail-mcp-upload-staging-'));
  roots = join(base, 'roots');
  await mkdir(roots);
  configuration = await loadConfiguration({
    TESTRAIL_BASE_URL: 'https://staging.testrail.io',
    TESTRAIL_EMAIL: 'user@example.com',
    TESTRAIL_API_KEY: 'synthetic',
    TESTRAIL_MCP_UPLOAD_ROOTS: JSON.stringify([roots]),
    TESTRAIL_MCP_DOWNLOAD_DIR: base,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  // A module spy's fake survives restoreAllMocks; reset returns each to the real export.
  vi.resetAllMocks();
});
afterAll(async () => { await rm(base, { recursive: true, force: true }); });

const addAttachmentToCase = operationRegistry.entries.find(({ tool }) => tool === 'testrail_add_attachment_to_case');
if (addAttachmentToCase === undefined) throw new Error('testrail_add_attachment_to_case is not registered');

/** A driver that counts every lookup and request, and reads each upload body in full. */
function counted() {
  const seen = { lookups: 0, requests: 0 };
  const client = new TestRailClient({
    baseUrl: configuration.baseUrl, email: configuration.email, apiKey: configuration.apiKey,
    registerProcessHandlers: false, maxRetries: 0,
    dnsLookup: () => { seen.lookups += 1; return Promise.resolve([{ address: '203.0.113.10', family: 4 as const }]); },
    fetch: async (_url: unknown, init?: { body?: ConstructorParameters<typeof Response>[0] }) => {
      seen.requests += 1;
      await new Response(init?.body).arrayBuffer();
      return new Response('{"attachment_id":1}', { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  return { client, seen };
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
  return { delay, watchdogs: () => live().length, fire: () => { for (const entry of live()) entry.fire(); } };
}

function error(result: ToolResult): object | undefined {
  return (result.structuredContent as { error?: object }).error;
}

describe('upload staging inside the call slot', () => {
  it('holds a slot while staging, ends the wait at the watchdog, and sends nothing afterwards', async () => {
    const source = join(roots, 'slow-stage.bin');
    // Four 64 KiB chunks, so a copy that went on after the watchdog would read past the first.
    await writeFile(source, Buffer.alloc(200 * 1024, 7));
    const area = await createStagingArea(base);

    // The source's first read is held, as a slow disk or network mount would hold it.
    let reads = 0;
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(open).mockImplementationOnce(async (...args: Parameters<typeof actualFs.open>) => {
      const handle = await actualFs.open(...args);
      const originalRead = handle.read.bind(handle) as (...a: unknown[]) => Promise<unknown>;
      handle.read = (async (...a: unknown[]) => {
        reads += 1;
        if (reads === 1) await held;
        return originalRead(...a);
      }) as unknown as typeof handle.read;
      return handle;
    });

    const { client, seen } = counted();
    const watchdog = manualDelay();
    const runtime = createRuntime({ client, limits: configuration.limits, delay: watchdog.delay });
    try {
      const pending = executeToolCall(addAttachmentToCase, { case_id: 1, file_path: source, filename: 'slow.bin' }, {
        runtime, configuration, stagingDirectory: () => Promise.resolve(area.directory),
      });
      // The copy is under way and the watchdog is already running: staging is inside the slot.
      await vi.waitFor(() => { expect({ reads, watchdogs: watchdog.watchdogs() }).toEqual({ reads: 1, watchdogs: 1 }); });
      expect(runtime.stats().active).toBe(1);

      watchdog.fire();
      expect(error(await pending)).toMatchObject({ code: 'TIMEOUT', write_outcome: 'not_started' });
      // The paused read still belongs to this call, so its slot is still held.
      await new Promise((resolve) => { setTimeout(resolve, 30); });
      expect(runtime.stats().active).toBe(1);

      release();
      await vi.waitFor(() => { expect(runtime.stats().active).toBe(0); });
      // The copy stopped at the next chunk rather than running on to the end, and its
      // own promise says so: it was stopped, not merely left unsent.
      expect(reads).toBe(1);
      await expect(vi.mocked(stageUpload).mock.results[0]?.value).rejects.toMatchObject({ code: 'CANCELLED' });
      expect(seen).toEqual({ lookups: 0, requests: 0 });
      expect(await readdir(area.directory)).toEqual(['owner.json']);
    } finally {
      release();
      await runtime.shutdown();
      await area.dispose();
    }
  });

  it('sends nothing when the caller cancels as staging completes', async () => {
    const source = join(roots, 'late-cancel.txt');
    await writeFile(source, 'staged, then cancelled');
    const area = await createStagingArea(base);
    const cancel = new AbortController();
    // The real copy runs to completion; the caller cancels in the moment before dispatch.
    vi.mocked(stageUpload).mockImplementationOnce(async (...args: Parameters<typeof stageUpload>) => {
      const staged = await actualStaging.stageUpload(...args);
      cancel.abort();
      return staged;
    });

    const { client, seen } = counted();
    const runtime = createRuntime({ client, limits: configuration.limits });
    try {
      const result = await executeToolCall(addAttachmentToCase, { case_id: 1, file_path: source, filename: 'late.txt' }, {
        runtime, configuration, signal: cancel.signal, stagingDirectory: () => Promise.resolve(area.directory),
      });
      expect(error(result)).toMatchObject({ code: 'CANCELLED', write_outcome: 'not_started' });
      await vi.waitFor(() => { expect(runtime.stats().active).toBe(0); });
      expect(vi.mocked(stageUpload)).toHaveBeenCalledTimes(1);
      expect(seen).toEqual({ lookups: 0, requests: 0 });
      // Settlement disposed the finished copy: only the ownership marker remains.
      expect(await readdir(area.directory)).toEqual(['owner.json']);
    } finally {
      await runtime.shutdown();
      await area.dispose();
    }
  });
});
