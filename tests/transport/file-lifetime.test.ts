import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TestRailClient } from '@dichovsky/testrail-api-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfiguration, type Configuration } from '../../src/config/environment.js';
import type { ToolResult } from '../../src/contracts/results.js';
import { createStagingArea } from '../../src/files/staging.js';
import { operationRegistry } from '../../src/operations/catalog.js';
import type { Operation } from '../../src/operations/registry.js';
import { createRuntime } from '../../src/runtime/invocation.js';
import { executeToolCall } from '../../src/transport/tool-call.js';

/*
 * File containment and download persistence through the registered attachment tools,
 * and through the packaged executable across a restart. tests/files.test.ts proves the
 * file layer on its own; this proves the tools actually route through it.
 */

let base: string;
let roots: string;
let outside: string;
let downloads: string;
let configuration: Configuration;

beforeAll(async () => {
  // Resolved, so a symlink under a macOS temporary directory is the only variable.
  base = await realpath(await mkdtemp(join(tmpdir(), 'testrail-mcp-file-lifetime-')));
  roots = join(base, 'roots');
  outside = join(base, 'outside');
  downloads = join(base, 'downloads');
  await Promise.all([mkdir(roots), mkdir(outside), mkdir(downloads)]);
  configuration = await loadConfiguration({
    TESTRAIL_BASE_URL: 'https://files.testrail.io',
    TESTRAIL_EMAIL: 'user@example.com',
    TESTRAIL_API_KEY: 'synthetic',
    TESTRAIL_MCP_UPLOAD_ROOTS: JSON.stringify([roots]),
    TESTRAIL_MCP_DOWNLOAD_DIR: downloads,
  });
});

afterAll(async () => { await rm(base, { recursive: true, force: true }); });

function registered(tool: string): Operation {
  const operation = operationRegistry.entries.find((entry) => entry.tool === tool);
  if (operation === undefined) throw new Error(`${tool} is not registered`);
  return operation;
}

const addAttachmentToCase = registered('testrail_add_attachment_to_case');
const getAttachment = registered('testrail_get_attachment');

function error(result: ToolResult): { code: string; write_outcome?: string } | undefined {
  return (result.structuredContent as { error?: { code: string; write_outcome?: string } }).error;
}

/** A driver that counts every lookup and request and records what an upload sent. */
function recordingDriver(reply: () => Response) {
  const counts = { lookups: 0, requests: 0 };
  let sent: string | undefined;
  const client = new TestRailClient({
    baseUrl: configuration.baseUrl, email: configuration.email, apiKey: configuration.apiKey,
    registerProcessHandlers: false, maxRetries: 0,
    dnsLookup: () => { counts.lookups += 1; return Promise.resolve([{ address: '203.0.113.10', family: 4 }]); },
    fetch: (async (_url: unknown, init?: { body?: ConstructorParameters<typeof Response>[0] }) => {
      counts.requests += 1;
      if (init?.body !== undefined) sent = await new Response(init.body).text();
      return reply();
    }),
  });
  return { client, counts, sent: () => sent };
}

async function upload(filePath: string) {
  const upstream = recordingDriver(() => new Response('{"attachment_id":1}', {
    status: 200, headers: { 'content-type': 'application/json' },
  }));
  const runtime = createRuntime({ client: upstream.client, limits: configuration.limits });
  const area = await createStagingArea(base);
  try {
    const result = await executeToolCall(addAttachmentToCase, { case_id: 1, file_path: filePath, filename: 'upload.txt' }, {
      runtime, configuration, stagingDirectory: () => Promise.resolve(area.directory),
    });
    return { result, counts: upstream.counts, sent: upstream.sent(), staged: await readdir(area.directory) };
  } finally {
    await runtime.shutdown();
    await area.dispose();
  }
}

async function waitFor(condition: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }
}

describe('upload containment through a registered tool', () => {
  it('refuses a traversal out of the upload root before any lookup or request', async () => {
    await writeFile(join(outside, 'traversal.txt'), 'must not be sent');
    // Built by hand: join() would normalise the traversal away before the tool saw it.
    const traversal = `${roots}${sep}..${sep}outside${sep}traversal.txt`;

    const { result, counts, staged } = await upload(traversal);
    expect(error(result)).toMatchObject({ code: 'FILE_ACCESS_DENIED', write_outcome: 'not_started' });
    expect(counts).toEqual({ lookups: 0, requests: 0 });
    // Nothing was copied: only the ownership marker is there.
    expect(staged).toEqual(['owner.json']);
  });

  it('refuses a symlink inside the root whose target escapes it, before any lookup or request', async () => {
    const secret = join(outside, 'secret.txt');
    await writeFile(secret, 'must not be sent');
    const link = join(roots, 'escaping-link.txt');
    await symlink(secret, link);

    const { result, counts, staged } = await upload(link);
    expect(error(result)).toMatchObject({ code: 'FILE_ACCESS_DENIED', write_outcome: 'not_started' });
    expect(counts).toEqual({ lookups: 0, requests: 0 });
    expect(staged).toEqual(['owner.json']);
  });

  it('follows a symlink whose target stays inside the root and sends the target content', async () => {
    const target = join(roots, 'real.txt');
    await writeFile(target, 'contained target content');
    const link = join(roots, 'contained-link.txt');
    await symlink(target, link);

    const { result, counts, sent } = await upload(link);
    expect(result.isError).toBeUndefined();
    expect(counts.requests).toBe(1);
    expect(sent).toContain('contained target content');
  });
});

describe('download persistence through a registered tool', () => {
  it('keeps a completed download through runtime shutdown and staging disposal', async () => {
    const upstream = recordingDriver(() => new Response(new Uint8Array([1, 2, 3, 4]), {
      status: 200, headers: { 'content-type': 'application/octet-stream' },
    }));
    const runtime = createRuntime({ client: upstream.client, limits: configuration.limits });
    const area = await createStagingArea(base);

    const result = await executeToolCall(getAttachment, { attachment_id: 5 }, {
      runtime, configuration, stagingDirectory: () => Promise.resolve(area.directory),
    });
    const { data } = result.structuredContent as { data: { file_path: string; bytes: number } };
    expect(data.bytes).toBe(4);

    // The same order the server's own shutdown uses.
    await runtime.shutdown();
    await area.dispose();

    expect([...await readFile(data.file_path)]).toEqual([1, 2, 3, 4]);
  });
});

/*
 * The packaged server against a local stand-in for TestRail. Loopback over plain HTTP is
 * refused unless both allow-flags are set, which they are only here.
 */
describe('packaged server restart', () => {
  const cli = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));
  let testrail: Server;
  let url: string;

  beforeAll(async () => {
    testrail = createServer((request, response) => {
      if (request.url?.includes('get_attachment/') === true) {
        response.writeHead(200, { 'content-type': 'application/octet-stream' });
        response.end(Buffer.from('persisted bytes'));
        return;
      }
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end('{"error":"not found"}');
    });
    await new Promise<void>((resolve) => { testrail.listen(0, '127.0.0.1', resolve); });
    url = `http://127.0.0.1:${(testrail.address() as AddressInfo).port}`;
  });

  afterAll(async () => { await new Promise((resolve) => { testrail.close(resolve); }); });

  interface Running {
    readonly child: ChildProcessWithoutNullStreams;
    readonly request: (id: number, method: string, params: object) => Promise<{ result?: unknown; error?: unknown }>;
    readonly stderr: () => string;
    readonly stop: () => Promise<number | null>;
  }

  async function launch(temporary: string): Promise<Running> {
    const inherited = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith('TESTRAIL')),
    );
    const child = spawn(process.execPath, [cli], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...inherited,
        // Staging lives under the OS temporary directory, which each platform reads from its own variable.
        TMPDIR: temporary, TMP: temporary, TEMP: temporary,
        TESTRAIL_BASE_URL: url,
        TESTRAIL_ALLOW_PRIVATE_HOSTS: 'true',
        TESTRAIL_ALLOW_INSECURE: 'true',
        TESTRAIL_EMAIL: 'user@example.com',
        TESTRAIL_API_KEY: 'synthetic',
        TESTRAIL_MCP_UPLOAD_ROOTS: '[]',
        TESTRAIL_MCP_DOWNLOAD_DIR: downloads,
      },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { err += chunk.toString('utf8'); });
    const exited = new Promise<number | null>((resolve) => { child.on('exit', (code) => { resolve(code); }); });

    const request = async (id: number, method: string, params: object) => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      const deadline = Date.now() + 10_000;
      for (;;) {
        const reply = out.split('\n').filter((line) => line.trim() !== '')
          .map((line) => JSON.parse(line) as { id?: number; result?: unknown; error?: unknown })
          .find((message) => message.id === id);
        if (reply !== undefined) return reply;
        if (Date.now() > deadline) throw new Error(`No reply to ${method}`);
        await new Promise((resolve) => { setTimeout(resolve, 10); });
      }
    };

    await request(0, 'initialize', {
      protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'file-lifetime-test', version: '1.0.0' },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

    return {
      child, request,
      stderr: () => err,
      stop: async () => {
        child.stdin.end();
        const code = await Promise.race([
          exited,
          new Promise<'hung'>((resolve) => { setTimeout(() => { resolve('hung'); }, 10_000); }),
        ]);
        if (code === 'hung') { child.kill('SIGKILL'); throw new Error('Server did not exit after stdin closed'); }
        return code;
      },
    };
  }

  async function download(server: Running, id: number): Promise<string> {
    const reply = await server.request(id, 'tools/call', { name: 'testrail_get_attachment', arguments: { attachment_id: 5 } });
    const result = reply.result as { isError?: boolean; structuredContent: { data: { file_path: string } } };
    expect(result.isError).toBeFalsy();
    return result.structuredContent.data.file_path;
  }

  it('keeps downloads across shutdown and a restart that recovers abandoned staging', async () => {
    const temporary = join(base, 'temporary');
    await mkdir(temporary);

    const first = await launch(temporary);
    const kept = await download(first, 1);
    expect(await first.stop()).toBe(0);
    // Shutdown drains and disposes staging, and never touches a completed download.
    expect(await readFile(kept, 'utf8')).toBe('persisted bytes');

    // A staging directory left by a server that died without shutting down. PID 2^22 is
    // above every platform maximum, so its owner is provably gone.
    const abandoned = join(temporary, 'testrail-mcp-staging-4194303-abandoned');
    await mkdir(abandoned);
    await writeFile(join(abandoned, 'owner.json'), JSON.stringify({ marker: 'testrail-mcp-staging', pid: 4_194_303 }));
    await writeFile(join(abandoned, 'leftover'), 'x');

    const second = await launch(temporary);
    try {
      // Startup recovery removed the abandoned directory and reported it without a path.
      await expect(stat(abandoned)).rejects.toThrow();
      // Separate pipes: the event can be read after the initialize reply that followed it.
      await waitFor(() => second.stderr().includes('"event":"staging_recovered","removed":1'), 'the recovery event');
      expect(second.stderr()).not.toContain(temporary);
      // The earlier download is untouched, and a new one is another distinct file.
      expect(await readFile(kept, 'utf8')).toBe('persisted bytes');
      const again = await download(second, 1);
      expect(again).not.toBe(kept);
      expect(await readFile(again, 'utf8')).toBe('persisted bytes');
    } finally {
      expect(await second.stop()).toBe(0);
    }
    expect((await readdir(downloads)).length).toBeGreaterThanOrEqual(2);
    expect(await readFile(kept, 'utf8')).toBe('persisted bytes');
  }, 60_000);
});
