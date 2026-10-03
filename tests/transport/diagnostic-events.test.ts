import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryTransport } from '@modelcontextprotocol/client';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { operationRegistry } from '../../src/operations/catalog.js';
import type { EventCode } from '../../src/transport/diagnostics.js';
import { startServer } from '../../src/transport/server.js';

/*
 * F05: the server's lifecycle diagnostics, field by field. `DiagnosticFields` fixes which
 * keys an event may have, but not what they carry, and other suites check these events
 * by name or by substring. So the composition root is run in-process through one whole
 * lifetime, recovering an abandoned staging directory, reporting two transport errors and
 * shutting down, and every event must carry exactly its fixed fields and values, and no
 * path, credential, host or error message.
 */

/**
 * Each event's fields besides `event`. Keyed by every event code, so a new code does not
 * typecheck until it is listed here, and the test below then requires it to be observed.
 */
const FIELDS = {
  server_started: ['tools'],
  server_stopping: [],
  server_stopped: [],
  staging_recovered: ['removed'],
  transport_error: ['code'],
  // Logged per call, and held by tests/result-contract.test.ts rather than here.
  tool_call: ['correlation', 'tool', 'outcome', 'code', 'duration_ms', 'warnings', 'write_outcome'],
} as const satisfies Record<EventCode, readonly string[]>;

/** A staging directory left by a server that died, owned by a PID no process can hold. */
const ABANDONED = 'testrail-mcp-staging-2147483647-abandoned';

const credentials = {
  host: 'diagnostics.testrail.io',
  email: 'diagnostics-user@example.com',
  apiKey: 'diagnostics-key-5e1c',
};
/** What each reported error carries in its message, and in the second one's name. */
const hostile = { key: 'SECRET-77', host: 'internal.example.test', path: '/Users/someone/private' };

let base: string;
beforeAll(async () => { base = await realpath(await mkdtemp(join(tmpdir(), 'testrail-mcp-diagnostics-'))); });
afterAll(async () => { await rm(base, { recursive: true, force: true }); });

describe('the server lifecycle diagnostics', () => {
  it('logs each lifecycle event with exactly its fixed fields, and no path, host, key or message', async () => {
    const temporary = join(base, 'tmp');
    const downloads = join(base, 'downloads');
    await mkdir(join(temporary, ABANDONED), { recursive: true });
    await mkdir(downloads);
    await writeFile(join(temporary, ABANDONED, 'owner.json'), JSON.stringify({ marker: 'testrail-mcp-staging', pid: 2_147_483_647 }));
    await writeFile(join(temporary, ABANDONED, 'leftover'), 'x');

    // os.tmpdir() reads these when called, so startup recovery and staging look here.
    vi.stubEnv('TMPDIR', temporary);
    vi.stubEnv('TEMP', temporary);
    vi.stubEnv('TMP', temporary);
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      let onerror: ((error: Error) => void) | undefined;
      const [, serverSide] = InMemoryTransport.createLinkedPair();
      const started = await startServer({
        TESTRAIL_BASE_URL: `https://${credentials.host}`,
        TESTRAIL_EMAIL: credentials.email,
        TESTRAIL_API_KEY: credentials.apiKey,
        TESTRAIL_MCP_UPLOAD_ROOTS: JSON.stringify([base]),
        TESTRAIL_MCP_DOWNLOAD_DIR: downloads,
      }, {
        registerSignals: false,
        driver: {
          fetch: () => Promise.reject(new Error('no request is expected')),
          dnsLookup: () => Promise.resolve([{ address: '203.0.113.10', family: 4 }]),
        },
        serve: (factory, options) => {
          onerror = options?.onerror;
          return serveStdio(factory, { ...options, transport: serverSide });
        },
      });
      if (onerror === undefined) throw new Error('startServer gave the stdio entry no error callback');
      const message = `api_key=${hostile.key} at https://${hostile.host} ${hostile.path}`;
      // A plain class name is logged as it is.
      onerror(Object.assign(new Error(message), { name: 'SyntaxError' }));
      // A name is whatever the thrower set; one that is not an identifier is not logged.
      onerror(Object.assign(new Error(message), { name: `https://${hostile.host}${hostile.path}` }));
      await started.shutdown();

      const chunks = write.mock.calls.map(([chunk]) => String(chunk));
      const events = chunks.filter((chunk) => chunk.startsWith('{"event"')).map((chunk) => JSON.parse(chunk) as Record<string, unknown>);
      expect(events).toEqual([
        { event: 'staging_recovered', removed: 1 },
        { event: 'server_started', tools: operationRegistry.entries.length },
        { event: 'transport_error', code: 'SyntaxError' },
        { event: 'transport_error', code: 'Error' },
        { event: 'server_stopping' },
        { event: 'server_stopped' },
      ]);
      for (const { event, ...fields } of events) {
        const allowed: readonly string[] = FIELDS[event as EventCode];
        expect(Object.keys(fields).filter((key) => !allowed.includes(key)), String(event)).toEqual([]);
      }
      // Every lifecycle event was reached, so none is exempt from the checks above.
      expect([...new Set(events.map(({ event }) => event))].sort())
        .toEqual(Object.keys(FIELDS).filter((event) => event !== 'tool_call').sort());

      // Every chunk, not only the event lines, so a stray line cannot leak either. JSON
      // doubles a Windows path's backslashes, so each path is checked in both spellings.
      const paths = [base, downloads, temporary, join(temporary, ABANDONED)];
      const forbidden = [
        ...paths, ...paths.map((path) => JSON.stringify(path).slice(1, -1)), ABANDONED,
        credentials.host, credentials.email, credentials.apiKey,
        hostile.key, hostile.host, hostile.path, '/Users/someone',
      ];
      for (const chunk of chunks) {
        for (const text of forbidden) expect(chunk).not.toContain(text);
      }
    } finally {
      write.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});
