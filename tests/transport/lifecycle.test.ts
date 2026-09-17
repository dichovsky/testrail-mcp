import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
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
