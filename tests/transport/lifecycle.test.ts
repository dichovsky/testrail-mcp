import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const cli = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));
let directory: string;

beforeAll(async () => { directory = await mkdtemp(join(tmpdir(), 'testrail-mcp-lifecycle-')); });
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

function launch(): ChildProcessWithoutNullStreams {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith('TESTRAIL')),
  );
  return spawn(process.execPath, [cli], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...inherited,
      TESTRAIL_BASE_URL: 'https://lifecycle.testrail.io',
      TESTRAIL_EMAIL: 'user@example.com',
      TESTRAIL_API_KEY: 'synthetic-secret-must-not-appear',
      TESTRAIL_MCP_UPLOAD_ROOTS: '[]',
      TESTRAIL_MCP_DOWNLOAD_DIR: directory,
    },
  });
}

async function waitFor(condition: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => { setTimeout(resolve, 20); });
  }
}

const OPENING = `${JSON.stringify({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: {
    protocolVersion: '2025-11-25', capabilities: {},
    clientInfo: { name: 'lifecycle-test', version: '1.0.0' },
  },
})}\n`;

describe('packaged server lifecycle', () => {
  it('keeps stdout protocol-only, routes diagnostics to stderr and exits on stdin closure', async () => {
    const child = launch();
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { err += chunk.toString('utf8'); });
    const exited = new Promise<number | null>((resolve) => { child.on('exit', (code) => { resolve(code); }); });

    child.stdin.write(OPENING);
    await waitFor(() => out.includes('"id":1'), 'the initialize response');

    // Every stdout line must be a protocol message. A stray log line here would
    // corrupt the stream for the host, which is why diagnostics never go to stdout.
    const lines = out.split('\n').filter((line) => line.trim() !== '');
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(JSON.parse(line)).toMatchObject({ jsonrpc: '2.0' });
    }

    // Startup diagnostics are on stderr, and carry no configured value.
    expect(err).toContain('"event":"server_started"');
    expect(err).not.toContain('synthetic-secret');
    expect(out).not.toContain('synthetic-secret');

    // Closing stdin ends the session: the host owns the subprocess lifetime.
    child.stdin.end();
    const code = await Promise.race([
      exited,
      new Promise<'hung'>((resolve) => { setTimeout(() => { resolve('hung'); }, 10_000); }),
    ]);
    if (code === 'hung') { child.kill('SIGKILL'); throw new Error('Server did not exit after stdin closed'); }
    expect(code).toBe(0);
  }, 30_000);

  it('skips a malformed line instead of answering it, and keeps serving', async () => {
    const child = launch();
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString('utf8'); });
    const exited = new Promise<void>((resolve) => { child.on('exit', () => { resolve(); }); });

    child.stdin.write(OPENING);
    await waitFor(() => out.includes('"id":1'), 'the initialize response');
    const afterOpening = out.length;

    child.stdin.write('this is not json at all\n');
    await new Promise((resolve) => { setTimeout(resolve, 300); });

    /*
     * Recorded behaviour, not an endorsement. The contract says malformed protocol
     * messages stay protocol errors, but the SDK's stdio transport drops a line it
     * cannot parse without emitting -32700 and without an error callback, and there is
     * no id to answer. Producing one would mean replacing the transport, which is a
     * large change to correct a host-side fault. This pins what actually happens so a
     * future SDK change surfaces here rather than in a release claim.
     */
    expect(out.slice(afterOpening)).toBe('');

    // The connection survives, which is the part that matters for the host.
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'ping', params: {} })}\n`);
    await waitFor(() => out.includes('"id":3'), 'a response after the malformed line');

    child.stdin.end();
    await exited;
  }, 30_000);

  it('answers an unknown method with a protocol error rather than a tool result', async () => {
    const child = launch();
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString('utf8'); });
    const exited = new Promise<void>((resolve) => { child.on('exit', () => { resolve(); }); });

    child.stdin.write(OPENING);
    await waitFor(() => out.includes('"id":1'), 'the initialize response');

    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'no/such/method', params: {} })}\n`);
    await waitFor(() => out.includes('"id":2'), 'the unknown-method response');

    const reply = out.split('\n').filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as { id?: number; error?: { code: number } })
      .find((message) => message.id === 2);
    // -32601 Method not found: a protocol fault, not a tool error.
    expect(reply?.error?.code).toBe(-32_601);

    child.stdin.end();
    await exited;
  }, 30_000);
});

/**
 * A TestRail stand-in on the loopback interface that counts every request and answers
 * none, so a call it receives stays in flight for as long as the test wants.
 */
async function silentTestRail(): Promise<{ url: string; requests: IncomingMessage[]; close: () => Promise<void> }> {
  const requests: IncomingMessage[] = [];
  const server: Server = createServer((request) => { requests.push(request); });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('No loopback port');
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    requests,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => { resolve(); });
    }),
  };
}

const SECRET = 'synthetic-secret-must-not-appear';
const EMAIL = 'lifecycle-user@example.com';

function launchAgainst(url: string): ChildProcessWithoutNullStreams {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith('TESTRAIL')),
  );
  // Node's own warnings are not this server's diagnostics; the insecure opt-in makes the
  // driver emit one, so they are silenced to keep every stderr line a JSON event.
  return spawn(process.execPath, ['--no-warnings', cli], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...inherited,
      TESTRAIL_BASE_URL: url,
      TESTRAIL_EMAIL: EMAIL,
      TESTRAIL_API_KEY: SECRET,
      TESTRAIL_ALLOW_INSECURE: 'true',
      TESTRAIL_ALLOW_PRIVATE_HOSTS: 'true',
      TESTRAIL_MCP_UPLOAD_ROOTS: '[]',
      TESTRAIL_MCP_DOWNLOAD_DIR: directory,
    },
  });
}

interface Running {
  readonly child: ChildProcessWithoutNullStreams;
  readonly out: () => string;
  readonly err: () => string;
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null; at: number }>;
  readonly send: (message: object) => void;
}

function run(child: ChildProcessWithoutNullStreams): Running {
  let out = '';
  let err = '';
  child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk: Buffer) => { err += chunk.toString('utf8'); });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null; at: number }>((resolve) => {
    child.on('exit', (code, signal) => { resolve({ code, signal, at: Date.now() }); });
  });
  return {
    child, exited, out: () => out, err: () => err,
    send: (message) => { child.stdin.write(`${JSON.stringify(message)}\n`); },
  };
}

async function openSession(session: Running): Promise<void> {
  session.child.stdin.write(OPENING);
  await waitFor(() => session.out().includes('"id":1'), 'the initialize response');
  session.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
}

const eventNames = (stderr: string): string[] => stderr.split('\n').filter((line) => line.trim() !== '')
  .map((line) => (JSON.parse(line) as { event: string }).event);

/*
 * Windows has no signal delivery to a child: `kill('SIGINT')` and `kill('SIGTERM')`
 * terminate it unconditionally, so there is no handler to test there. Closing stdin,
 * which is how hosts end a stdio server, runs on every platform.
 */
const windows = process.platform === 'win32';
type Ending = readonly [string, (child: ChildProcessWithoutNullStreams) => void];
const STDIN: Ending[] = [['stdin closure', (child) => { child.stdin.end(); }]];
const SIGNALS: Ending[] = [
  ['SIGINT', (child) => { child.kill('SIGINT'); }],
  ['SIGTERM', (child) => { child.kill('SIGTERM'); }],
];

describe('packaged server shutdown against a TestRail that never answers', () => {
  it('makes no request at startup or discovery, and exactly one for a call', async () => {
    const testRail = await silentTestRail();
    const session = run(launchAgainst(testRail.url));
    try {
      await openSession(session);
      session.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
      await waitFor(() => session.out().includes('"id":2'), 'the tool list');
      await new Promise((resolve) => { setTimeout(resolve, 200); });
      expect(testRail.requests).toHaveLength(0);

      // The stand-in is reachable, so the zero above is not a stand-in nobody could hit.
      session.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'testrail_get_project', arguments: { project_id: 1 } } });
      await waitFor(() => testRail.requests.length === 1, 'the call to reach TestRail');
      expect(testRail.requests[0]?.url).toContain('get_project/1');
    } finally {
      session.child.kill('SIGKILL');
      await session.exited;
      await testRail.close();
    }
  }, 30_000);

  const exitsWithinTheDrain = async (_label: string, end: Ending[1]) => {
    const testRail = await silentTestRail();
    const session = run(launchAgainst(testRail.url));
    try {
      await openSession(session);
      session.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'testrail_get_project', arguments: { project_id: 1 } } });
      await waitFor(() => testRail.requests.length === 1, 'the request to be in flight');

      const ended = Date.now();
      end(session.child);
      const { code, signal, at } = await session.exited;
      // The drain is five seconds. Without the forced exit the driver's own 15-second
      // request timer kept the process alive until it fired.
      expect({ code, signal }).toEqual({ code: 0, signal: null });
      expect(at - ended).toBeGreaterThanOrEqual(4_900);
      expect(at - ended).toBeLessThan(10_000);
      const names = eventNames(session.err());
      expect(names.filter((name) => name === 'server_stopping')).toHaveLength(1);
      expect(names.filter((name) => name === 'server_stopped')).toHaveLength(1);
      for (const stream of [session.out(), session.err()]) {
        expect(stream).not.toContain(SECRET);
        expect(stream).not.toContain(EMAIL);
        expect(stream).not.toContain(Buffer.from(`${EMAIL}:${SECRET}`).toString('base64'));
        expect(stream).not.toContain(testRail.url.replace('http://', ''));
      }
    } finally {
      session.child.kill('SIGKILL');
      await testRail.close();
    }
  };
  it.each(STDIN)('exits within the drain window after %s with a request still in flight', exitsWithinTheDrain, 30_000);
  it.skipIf(windows).each(SIGNALS)('exits within the drain window after %s with a request still in flight', exitsWithinTheDrain, 30_000);

  it.skipIf(windows)('finishes its shutdown when a second signal arrives during the drain', async () => {
    const testRail = await silentTestRail();
    const session = run(launchAgainst(testRail.url));
    try {
      await openSession(session);
      session.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'testrail_get_project', arguments: { project_id: 1 } } });
      await waitFor(() => testRail.requests.length === 1, 'the request to be in flight');

      session.child.kill('SIGTERM');
      await waitFor(() => session.err().includes('server_stopping'), 'the drain to begin');
      session.child.kill('SIGTERM');
      // With `once` handlers the second signal took the default action and killed the
      // process mid-drain, before the client was destroyed or the stop was logged.
      const { code, signal } = await session.exited;
      expect({ code, signal }).toEqual({ code: 0, signal: null });
      expect(eventNames(session.err()).filter((name) => name === 'server_stopped')).toHaveLength(1);
    } finally {
      session.child.kill('SIGKILL');
      await testRail.close();
    }
  }, 30_000);
});
