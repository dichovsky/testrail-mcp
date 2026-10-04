import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStagingArea, type StagingArea } from '../../src/files/staging.js';
import { FIXED_BUDGETS } from '../../src/config/limits.js';
import { startServer } from '../../src/transport/server.js';

/*
 * Staging creation is the one shutdown step whose failure the process tests cannot
 * reach: once a creation has failed it is forgotten, so shutdown only meets a failing
 * one while it is still in flight. Creation is replaced here, in its own file, so the
 * tests can hold creation or disposal open past shutdown's deadline.
 */
vi.mock('../../src/files/staging.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/files/staging.js')>();
  return { ...original, createStagingArea: vi.fn(original.createStagingArea) };
});

let base: string;
let roots: string;
beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'testrail-mcp-composition-staging-'));
  roots = join(base, 'roots');
  await mkdir(roots);
  await writeFile(join(roots, 'evidence.txt'), 'evidence');
});
afterAll(async () => { await rm(base, { recursive: true, force: true }); });
beforeEach(() => { vi.mocked(createStagingArea).mockClear(); });
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function connect() {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const fetch = vi.fn(() => Promise.reject(new Error('no request is expected')));
  const started = await startServer({
    TESTRAIL_BASE_URL: 'https://staging.testrail.io',
    TESTRAIL_EMAIL: 'user@example.com',
    TESTRAIL_API_KEY: 'synthetic',
    TESTRAIL_MCP_UPLOAD_ROOTS: JSON.stringify([roots]),
    TESTRAIL_MCP_DOWNLOAD_DIR: base,
  }, {
    registerSignals: false,
    driver: {
      fetch,
      dnsLookup: () => Promise.resolve([{ address: '203.0.113.10', family: 4 }]),
    },
    serve: (factory, options) => serveStdio(factory, { ...options, transport: serverSide }),
  });
  const client = new Client({ name: 'composition-staging-test', version: '1.0.0' });
  await client.connect(clientSide);
  return { started, client, fetch };
}

describe('a staging area still being created at shutdown', () => {
  it('fails without failing the shutdown, which logs its stop and leaves nothing unhandled', async () => {
    let fail: (error: Error) => void = () => undefined;
    vi.mocked(createStagingArea).mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);

    const { started, client } = await connect();
    try {
      const upload = client.callTool({
        name: 'testrail_add_attachment_to_case',
        arguments: { case_id: 1, file_path: join(roots, 'evidence.txt'), filename: 'evidence.txt' },
      }).catch(() => undefined);
      await vi.waitFor(() => { expect(vi.mocked(createStagingArea)).toHaveBeenCalledTimes(1); });

      let stopped = false;
      const stop = started.shutdown().then(() => { stopped = true; });
      await vi.waitFor(() => { expect(String(write.mock.calls.at(-1)?.[0])).toContain('server_stopping'); });
      // Shutdown waits for the creation it would otherwise leave behind.
      await new Promise((resolve) => { setTimeout(resolve, 30); });
      expect(stopped).toBe(false);

      fail(new Error('ENOENT: staging parent vanished'));
      await expect(stop).resolves.toBeUndefined();
      await upload;
      await new Promise((resolve) => { setTimeout(resolve, 20); });
      expect(write.mock.calls.map(([chunk]) => String(chunk)).some((line) => line.includes('"event":"server_stopped"'))).toBe(true);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
      write.mockRestore();
      await client.close().catch(() => undefined);
    }
  });

  it.each(['resolve', 'reject'] as const)('finishes within the drain budget when creation hangs, then handles a late %s', async (settlement) => {
    let finish: (area: StagingArea) => void = () => undefined;
    let fail: (error: Error) => void = () => undefined;
    vi.mocked(createStagingArea).mockImplementationOnce(() => new Promise((resolve, reject) => {
      finish = resolve;
      fail = reject;
    }));
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    const { started, client, fetch } = await connect();
    vi.useFakeTimers();
    const dispose = vi.fn(() => Promise.resolve());
    try {
      const upload = client.callTool({
        name: 'testrail_add_attachment_to_case',
        arguments: { case_id: 1, file_path: join(roots, 'evidence.txt'), filename: 'evidence.txt' },
      }).catch(() => undefined);
      await vi.waitFor(() => { expect(vi.mocked(createStagingArea)).toHaveBeenCalledTimes(1); });

      let stopped = false;
      const stop = started.shutdown().then(() => { stopped = true; });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(FIXED_BUDGETS.shutdown_drain_ms - 1);
      expect(stopped).toBe(false);
      // A zero-delay timer after the drain may need one final timer tick.
      await vi.advanceTimersByTimeAsync(2);
      expect(stopped).toBe(true);
      await stop;
      expect(write.mock.calls.some(([line]) => String(line).includes('"event":"server_stopped"'))).toBe(true);

      if (settlement === 'resolve') finish({ directory: base, dispose });
      else fail(new Error('late staging creation failure'));
      await vi.advanceTimersByTimeAsync(1);
      await upload;
      expect(dispose).toHaveBeenCalledTimes(settlement === 'resolve' ? 1 : 0);
      expect(fetch).not.toHaveBeenCalled();
      expect(unhandled).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      fail(new Error('test cleanup'));
      process.off('unhandledRejection', unhandled);
      await client.close().catch(() => undefined);
    }
  });
});

describe('a staging area whose disposal hangs at shutdown', () => {
  it('bounds removal and observes its rejection after shutdown has completed', async () => {
    let fail: (error: Error) => void = () => undefined;
    const dispose = vi.fn(() => new Promise<void>((_resolve, reject) => { fail = reject; }));
    vi.mocked(createStagingArea).mockResolvedValueOnce({ directory: base, dispose });
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    const { started, client, fetch } = await connect();
    vi.useFakeTimers();
    try {
      // Create the area, but refuse the missing source before staging or dispatch.
      const result = await client.callTool({
        name: 'testrail_add_attachment_to_case',
        arguments: { case_id: 1, file_path: join(roots, 'missing.txt'), filename: 'evidence.txt' },
      });
      expect(result.isError).toBe(true);

      let stopped = false;
      const stop = started.shutdown().then(() => { stopped = true; });
      await vi.advanceTimersByTimeAsync(0);
      expect(dispose).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(FIXED_BUDGETS.shutdown_drain_ms - 1);
      expect(stopped).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(stopped).toBe(true);
      await stop;

      fail(new Error('late staging removal failure'));
      await vi.advanceTimersByTimeAsync(1);
      expect(write.mock.calls.some(([line]) => String(line).includes('"event":"server_stopped"'))).toBe(true);
      expect(fetch).not.toHaveBeenCalled();
      expect(unhandled).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      fail(new Error('test cleanup'));
      process.off('unhandledRejection', unhandled);
      await client.close().catch(() => undefined);
    }
  });
});
