import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/*
 * F08 over raw stdio against the built executable (dist/cli.js): what a host sees byte
 * for byte. The packed-and-installed tarball is exercised separately by test:package.
 * Expected protocol behaviour comes from JSON-RPC 2.0, the MCP specification and the
 * SDK client's own opening messages, never from the server under test.
 */

const cli = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));
let directory: string;
let upstream: Server;
let requests = 0;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'testrail-mcp-serving-process-'));
  // A loopback stand-in for TestRail: every request gets one project.
  upstream = createServer((_request, response) => {
    requests += 1;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ id: 1, name: 'Project' }));
  });
  await new Promise<void>((resolve) => { upstream.listen(0, '127.0.0.1', resolve); });
});

afterAll(async () => {
  await new Promise<void>((resolve) => { upstream.close(() => { resolve(); }); });
  await rm(directory, { recursive: true, force: true });
});

interface Message { readonly jsonrpc?: string; readonly id?: number | string; readonly method?: string; readonly result?: Record<string, unknown>; readonly error?: { code: number } }

function launch() {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith('TESTRAIL')));
  const child = spawn(process.execPath, [cli], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...inherited,
      TESTRAIL_BASE_URL: `http://127.0.0.1:${String((upstream.address() as AddressInfo).port)}`,
      TESTRAIL_ALLOW_INSECURE: 'true',
      TESTRAIL_ALLOW_PRIVATE_HOSTS: 'true',
      TESTRAIL_EMAIL: 'user@example.com',
      TESTRAIL_API_KEY: 'synthetic-secret-must-not-appear',
      TESTRAIL_MCP_UPLOAD_ROOTS: '[]',
      TESTRAIL_MCP_DOWNLOAD_DIR: directory,
    },
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk: Buffer) => { err += chunk.toString('utf8'); });
  // 'close', not 'exit': it fires only after the child's stdio streams have ended, so
  // nothing written during shutdown is missed.
  const exited = new Promise<number | null>((resolve) => { child.on('close', (code) => { resolve(code); }); });
  // Every line, a final unterminated one included, for the check after exit.
  const lines = () => out.split('\n').filter((line) => line !== '');
  // Only complete lines while the child runs: a large reply arrives in several chunks.
  const complete = () => out.slice(0, out.lastIndexOf('\n') + 1).split('\n').filter((line) => line !== '');
  const replies = () => complete().map((line) => JSON.parse(line) as Message);
  const until = async (condition: () => boolean, label: string, timeoutMs = 10_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}; stdout: ${out}; stderr: ${err}`);
      await new Promise((resolve) => { setTimeout(resolve, 20); });
    }
  };
  return {
    send: (message: unknown) => { child.stdin.write(`${typeof message === 'string' ? message : JSON.stringify(message)}\n`); },
    reply: async (id: number | string, timeoutMs = 10_000): Promise<Message> => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = replies().find((message) => message.id === id);
        if (found !== undefined) return found;
        if (Date.now() > deadline) throw new Error(`no reply for ${String(id)}; stdout: ${out}; stderr: ${err}`);
        await new Promise((resolve) => { setTimeout(resolve, 20); });
      }
    },
    replies, lines, until,
    err: () => err,
    end: async () => { child.stdin.end(); return exited; },
  };
}

const INITIALIZE = (id: number) => ({
  jsonrpc: '2.0', id, method: 'initialize',
  params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'serving-process-test', version: '1.0.0' } },
});
const INITIALIZED = { jsonrpc: '2.0', method: 'notifications/initialized' };

/** Every stdout line must be a JSON-RPC message: a host parses the stream as one. */
function expectProtocolOnly(lines: readonly string[]): void {
  for (const line of lines) {
    const message = JSON.parse(line) as Message;
    expect(message.jsonrpc).toBe('2.0');
    expect('method' in message || 'result' in message || 'error' in message).toBe(true);
  }
}

describe('a legacy session over raw stdio against the built executable', () => {
  it('negotiates, lists, calls, refuses what it must, and writes only protocol messages to stdout', async () => {
    const session = launch();
    try {
      session.send(INITIALIZE(1));
      const initialized = await session.reply(1);
      expect(initialized.error).toBeUndefined();
      expect(initialized.result?.protocolVersion).toBe('2025-11-25');
      session.send(INITIALIZED);

      session.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
      expect(((await session.reply(2)).result?.tools as unknown[]).length).toBe(133);

      // A business failure is a tool error, not a protocol error.
      session.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'testrail_get_project', arguments: { project_id: -1 } } });
      const refused = await session.reply(3);
      expect(refused.result?.isError).toBe(true);
      expect(refused.result?.structuredContent).toMatchObject({ error: { code: 'INVALID_ARGUMENT' } });

      // Protocol errors, with the codes JSON-RPC and MCP assign: no such method, and
      // invalid parameters for a malformed call or an unknown tool.
      session.send({ jsonrpc: '2.0', id: 4, method: 'resources/list' });
      session.send({ jsonrpc: '2.0', id: 5, method: 'prompts/list' });
      session.send({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { arguments: {} } });
      session.send({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'testrail_get_project', arguments: 'x' } });
      session.send({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'testrail_not_a_tool', arguments: {} } });
      expect((await session.reply(4)).error?.code).toBe(-32601);
      expect((await session.reply(5)).error?.code).toBe(-32601);
      expect((await session.reply(6)).error?.code).toBe(-32602);
      expect((await session.reply(7)).error?.code).toBe(-32602);
      expect((await session.reply(8)).error?.code).toBe(-32602);

      /*
       * A message that is valid JSON but not a valid JSON-RPC message gets no reply,
       * even with an id: JSON-RPC 2.0 asks for -32600, but the SDK's stdio transport
       * drops it and reports it through onerror. Recorded, not endorsed. The server
       * logs only the error's name and keeps serving.
       */
      session.send({ jsonrpc: '2.0', id: 9 });
      session.send({ jsonrpc: '2.0', id: 10, method: 'ping' });
      await session.reply(10);
      expect(session.replies().some((message) => message.id === 9)).toBe(false);
      // Stderr is a separate pipe with no ordering against stdout, so wait for it.
      await session.until(() => session.err().includes('{"event":"transport_error","code":"ZodError"}'), 'the transport_error event');

      expect(await session.end()).toBe(0);
      expectProtocolOnly(session.lines());
      expect(session.err()).not.toContain('synthetic-secret-must-not-appear');
    } finally { await session.end(); }
  });
});

describe('an initialize after a modern discover probe', () => {
  it('re-creates its server without disposing the shared runtime, and keeps serving calls', async () => {
    // The SDK client's own modern probe, recorded rather than written by hand.
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    let probe: unknown;
    const send = clientTransport.send.bind(clientTransport);
    clientTransport.send = async (message, options) => { probe ??= message; return send(message, options); };
    serverTransport.onmessage = () => undefined;
    await serverTransport.start();
    const client = new Client({ name: 'serving-process-test', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
    void client.connect(clientTransport).catch(() => undefined);
    for (let waited = 0; probe === undefined && waited < 2_000; waited += 20) await new Promise((resolve) => { setTimeout(resolve, 20); });
    await client.close().catch(() => undefined);
    const discover = probe as { id: number | string; method: string };
    expect(discover.method).toBe('server/discover');

    const session = launch();
    try {
      session.send(discover);
      const offered = await session.reply(discover.id);
      expect(offered.error).toBeUndefined();

      // A host that sends a legacy initialize after the probe: serveStdio discards the
      // probe's server and calls the factory again. (The SDK's own client would stay
      // modern after a successful discover; this is the server-side path it supports.)
      session.send(INITIALIZE(101));
      expect((await session.reply(101)).result?.protocolVersion).toBe('2025-11-25');
      session.send(INITIALIZED);
      session.send({ jsonrpc: '2.0', id: 102, method: 'tools/list' });
      expect(((await session.reply(102)).result?.tools as unknown[]).length).toBe(133);

      // A real call reaches TestRail: discarding the probe's server did not dispose the
      // shared runtime. (That the factory builds no second driver is held by #76.)
      const before = requests;
      session.send({ jsonrpc: '2.0', id: 103, method: 'tools/call', params: { name: 'testrail_get_project', arguments: { project_id: 1 } } });
      const call = await session.reply(103);
      expect(call.result?.isError).toBeFalsy();
      expect(call.result?.structuredContent).toMatchObject({ data: { id: 1, name: 'Project' } });
      expect(requests).toBe(before + 1);

      expect(await session.end()).toBe(0);
      expectProtocolOnly(session.lines());
    } finally { await session.end(); }
  }, 30_000);
});
