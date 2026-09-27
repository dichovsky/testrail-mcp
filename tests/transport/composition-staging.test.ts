import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createStagingArea } from '../../src/files/staging.js';
import { startServer } from '../../src/transport/server.js';

/*
 * Staging creation is the one shutdown step whose failure the process tests cannot
 * reach: once a creation has failed it is forgotten, so shutdown only meets a failing
 * one while it is still in flight. Creation is replaced here, in its own file, so the
 * test can hold it open across the start of shutdown and then fail it.
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

describe('a staging area still being created at shutdown', () => {
  it('fails without failing the shutdown, which logs its stop and leaves nothing unhandled', async () => {
    let fail: (error: Error) => void = () => undefined;
    vi.mocked(createStagingArea).mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);

    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const started = await startServer({
      TESTRAIL_BASE_URL: 'https://staging.testrail.io',
      TESTRAIL_EMAIL: 'user@example.com',
      TESTRAIL_API_KEY: 'synthetic',
      TESTRAIL_MCP_UPLOAD_ROOTS: JSON.stringify([roots]),
      TESTRAIL_MCP_DOWNLOAD_DIR: base,
    }, {
      registerSignals: false,
      driver: {
        fetch: () => Promise.reject(new Error('no request is expected')),
        dnsLookup: () => Promise.resolve([{ address: '203.0.113.10', family: 4 }]),
      },
      serve: (factory, options) => serveStdio(factory, { ...options, transport: serverSide }),
    });
    const client = new Client({ name: 'composition-staging-test', version: '1.0.0' });
    await client.connect(clientSide);
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
});
