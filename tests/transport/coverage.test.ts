import * as fs from 'node:fs';
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TestRailClient } from '@dichovsky/testrail-api-client';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConfiguration, type Configuration } from '../../src/config/environment.js';
import { createStagingArea } from '../../src/files/staging.js';
import { operationRegistry } from '../../src/operations/catalog.js';
import { createRuntime } from '../../src/runtime/invocation.js';
import { buildServer, EXIT_GRACE_MS, exitAfterGrace, startServer } from '../../src/transport/server.js';

/*
 * The server module's process wiring, run in-process.
 *
 * The CLI owns real signals, stdin and stdio, and the process suites reach those only in
 * a subprocess. Here each process-facing hook is replaced at its boundary instead: the
 * stdio entry, the package metadata read and staging creation by passthrough module
 * mocks, and `process.on`, `process.stdin.once`, `process.stdout.write` and
 * `process.exit` by spies that capture rather than install. No real handler or listener
 * outlives a test, and each test checks that.
 */

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  return { ...original, readFileSync: vi.fn(original.readFileSync) };
});
vi.mock('@modelcontextprotocol/server/stdio', async (importOriginal) => {
  const original = await importOriginal<typeof import('@modelcontextprotocol/server/stdio')>();
  return { ...original, serveStdio: vi.fn(original.serveStdio) };
});
vi.mock('../../src/files/staging.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/files/staging.js')>();
  return { ...original, createStagingArea: vi.fn(original.createStagingArea) };
});

const actual = {
  fs: await vi.importActual<typeof import('node:fs')>('node:fs'),
  stdio: await vi.importActual<typeof import('@modelcontextprotocol/server/stdio')>('@modelcontextprotocol/server/stdio'),
  staging: await vi.importActual<typeof import('../../src/files/staging.js')>('../../src/files/staging.js'),
};

let base: string;
let temporary: string;
let roots: string;
let configuration: Configuration;

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'testrail-mcp-server-coverage-')));
  temporary = join(base, 'tmp');
  roots = join(base, 'roots');
  await mkdir(temporary);
  await mkdir(roots);
  await writeFile(join(roots, 'evidence.txt'), 'evidence');
  configuration = await loadConfiguration(environment());
});
afterAll(async () => { await rm(base, { recursive: true, force: true }); });
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.mocked(fs.readFileSync).mockImplementation(actual.fs.readFileSync);
  vi.mocked(serveStdio).mockImplementation(actual.stdio.serveStdio);
  vi.mocked(createStagingArea).mockImplementation(actual.staging.createStagingArea);
});

function environment() {
  return {
    TESTRAIL_BASE_URL: 'https://server-coverage.testrail.io',
    TESTRAIL_EMAIL: 'user@example.com',
    TESTRAIL_API_KEY: 'synthetic',
    TESTRAIL_MCP_UPLOAD_ROOTS: JSON.stringify([roots]),
    TESTRAIL_MCP_DOWNLOAD_DIR: base,
  };
}

const driver = {
  fetch: () => Promise.resolve(new Response(JSON.stringify({ attachment_id: 'a1' }), {
    status: 200, headers: { 'content-type': 'application/json' },
  })),
  dnsLookup: () => Promise.resolve([{ address: '203.0.113.10', family: 4 as const }]),
};

function silenceStderr() {
  return vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
}

function events(write: { mock: { calls: unknown[][] } }): Record<string, unknown>[] {
  return write.mock.calls
    .map(([chunk]) => String(chunk))
    .filter((line) => line.startsWith('{"event"'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** A stdio entry that serves on an in-memory pair, as the real one would on stdio. */
function inMemory() {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  let onerror: ((error: Error) => void) | undefined;
  const serve = ((factory: Parameters<typeof serveStdio>[0], options: Parameters<typeof serveStdio>[1]) => {
    onerror = options?.onerror;
    return actual.stdio.serveStdio(factory, { ...options, transport: serverSide });
  }) as typeof serveStdio;
  return {
    serve,
    clientSide,
    reportError: (error: unknown) => {
      if (onerror === undefined) throw new Error('startServer gave the stdio entry no error callback');
      onerror(error as Error);
    },
  };
}

async function connected(transport: InMemoryTransport): Promise<Client> {
  const client = new Client({ name: 'server-coverage-test', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

interface StandardSchema {
  readonly '~standard': {
    readonly jsonSchema: { readonly input: () => unknown; readonly output: () => unknown };
    readonly validate: (value: unknown) => unknown;
  };
}

/** The schemas the server handed the SDK for one tool, read back from its registration. */
function registered(server: McpServer, tool: string) {
  const tools = (server as unknown as {
    _registeredTools: Record<string, { inputSchema: StandardSchema; outputSchema: StandardSchema }>;
  })._registeredTools;
  const entry = tools[tool];
  if (entry === undefined) throw new Error(`${tool} was not registered`);
  return entry;
}

function build(): McpServer {
  return buildServer({
    configuration,
    runtime: createRuntime({
      client: new TestRailClient({
        baseUrl: configuration.baseUrl, email: configuration.email, apiKey: configuration.apiKey,
        registerProcessHandlers: false, maxRetries: 0,
        dnsLookup: driver.dnsLookup, fetch: () => Promise.reject(new Error('no request is expected')),
      }),
      limits: configuration.limits,
    }),
    registry: operationRegistry,
    stagingDirectory: () => Promise.resolve(base),
  });
}

describe('the schemas each tool advertises', () => {
  it('hands the SDK the reviewed input schema in both directions and accepts every value unchanged', () => {
    const operation = operationRegistry.get('testrail_get_project');
    if (operation === undefined) throw new Error('testrail_get_project is not registered');
    const { inputSchema } = registered(build(), operation.tool);
    const standard = inputSchema['~standard'];

    expect(standard.jsonSchema.input()).toBe(operation.jsonSchema);
    expect(standard.jsonSchema.output()).toBe(operation.jsonSchema);
    // The adapter validates, so the SDK never rejects an argument on its own.
    const invalid = { project_id: 'not-a-number', extra: true };
    expect(standard.validate(invalid)).toEqual({ value: invalid });
    expect((standard.validate(invalid) as { value: unknown }).value).toBe(invalid);
  });

  it('describes only the result wrapper, and requires nothing of it but data', () => {
    const { outputSchema } = registered(build(), 'testrail_get_project');
    const standard = outputSchema['~standard'];
    const wrapper = {
      type: 'object',
      properties: {
        data: {},
        pagination: { type: 'object' },
        warnings: { type: 'array', items: { type: 'object' } },
      },
      required: ['data'],
    };

    expect(standard.jsonSchema.input()).toEqual(wrapper);
    expect(standard.jsonSchema.output()).toBe(standard.jsonSchema.input());
    const drifted = { data: { unexpected: [1, 'two'] } };
    expect(standard.validate(drifted)).toEqual({ value: drifted });
    expect(standard.validate({ data: null })).toEqual({ value: { data: null } });

    const refused = { issues: [{ message: 'Result wrapper requires data' }] };
    expect(standard.validate({ pagination: {} })).toEqual(refused);
    expect(standard.validate(Object.create({ data: 1 }) as unknown)).toEqual(refused);
    expect(standard.validate(null)).toEqual(refused);
    expect(standard.validate('data')).toEqual(refused);
  });
});

describe('the version the server reports', () => {
  async function reportedVersion(): Promise<string | undefined> {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const handle = actual.stdio.serveStdio(() => build(), { transport: serverSide });
    const client = await connected(clientSide);
    try {
      return client.getServerVersion()?.version;
    } finally {
      await client.close().catch(() => undefined);
      await handle.close().catch(() => undefined);
    }
  }

  const isPackageJson = (path: unknown) => path instanceof URL && path.pathname.endsWith('/package.json');

  it('is the package version when its metadata reads', async () => {
    const metadata = JSON.parse(actual.fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(await reportedVersion()).toBe(metadata.version);
    expect(vi.mocked(fs.readFileSync).mock.calls.some(([path]) => isPackageJson(path))).toBe(true);
  });

  it.each([
    ['cannot be read', () => { throw new Error('EACCES: package.json'); }],
    ['is not JSON', () => 'not json'],
    ['is not an object', () => '"1.2.3"'],
    ['has no version', () => '{"name":"testrail-mcp"}'],
    ['has a numeric version', () => '{"version":3}'],
  ])('is the 0.0.0 placeholder when the metadata %s', async (_label, read) => {
    vi.mocked(fs.readFileSync).mockImplementation(((path: fs.PathOrFileDescriptor, ...rest: never[]) =>
      isPackageJson(path) ? read() : (actual.fs.readFileSync as (...args: unknown[]) => unknown)(path, ...rest)) as typeof fs.readFileSync);
    expect(await reportedVersion()).toBe('0.0.0');
  });
});

describe('the stdio entry startServer uses by default', () => {
  it('is the SDK stdio entry, given the server factory and an error reporter', async () => {
    const write = silenceStderr();
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    // The real entry, pointed at an in-memory pair rather than the process's own stdio.
    vi.mocked(serveStdio).mockImplementationOnce((factory, options) =>
      actual.stdio.serveStdio(factory, { ...options, transport: serverSide }));
    const started = await startServer(environment(), { registerSignals: false, driver });
    const client = await connected(clientSide);
    try {
      expect(vi.mocked(serveStdio)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(serveStdio).mock.calls[0]?.[1]).toEqual({ onerror: expect.any(Function) as unknown });
      expect((await client.listTools()).tools).toHaveLength(operationRegistry.entries.length);
    } finally {
      await client.close().catch(() => undefined);
      await started.shutdown();
    }
    expect(events(write).map(({ event }) => event)).toEqual(['server_started', 'server_stopping', 'server_stopped']);
  });
});

describe('a transport error that is not an object', () => {
  it.each([
    ['a string', 'SyntaxError'],
    ['null', null],
    ['a number', 42],
  ])('is logged under the plain Error class when it is %s', async (_label, thrown) => {
    const write = silenceStderr();
    const stdio = inMemory();
    const started = await startServer(environment(), { registerSignals: false, serve: stdio.serve, driver });
    try {
      stdio.reportError(thrown);
      expect(events(write).filter(({ event }) => event === 'transport_error')).toEqual([
        { event: 'transport_error', code: 'Error' },
      ]);
    } finally {
      await started.shutdown();
    }
  });
});

describe('the staging area at shutdown', () => {
  async function uploadThenStop(): Promise<{ write: ReturnType<typeof silenceStderr>; before: string[]; after: string[] }> {
    vi.stubEnv('TMPDIR', temporary);
    vi.stubEnv('TEMP', temporary);
    vi.stubEnv('TMP', temporary);
    const write = silenceStderr();
    const stdio = inMemory();
    const started = await startServer(environment(), { registerSignals: false, serve: stdio.serve, driver });
    const client = await connected(stdio.clientSide);
    try {
      const result = await client.callTool({
        name: 'testrail_add_attachment_to_case',
        arguments: { case_id: 1, file_path: join(roots, 'evidence.txt'), filename: 'evidence.txt' },
      });
      expect(result.isError).toBeFalsy();
      expect(vi.mocked(createStagingArea)).toHaveBeenCalledTimes(1);
      const before = await readdir(temporary);
      await client.close().catch(() => undefined);
      await started.shutdown();
      return { write, before, after: await readdir(temporary) };
    } finally {
      // Shutdown is shared, so this only waits for the one above, or stops after a failure.
      await client.close().catch(() => undefined);
      await started.shutdown();
    }
  }

  it('is created by the first upload and removed by the shutdown', async () => {
    vi.mocked(createStagingArea).mockClear();
    const { before, after } = await uploadThenStop();
    expect(before).toEqual([expect.stringMatching(/^testrail-mcp-staging-/u)]);
    expect(after).toEqual([]);
  });

  it('does not fail the shutdown when removing it fails', async () => {
    vi.mocked(createStagingArea).mockClear();
    const dispose = vi.fn();
    vi.mocked(createStagingArea).mockImplementationOnce(async (parent) => {
      const area = await actual.staging.createStagingArea(parent);
      return {
        directory: area.directory,
        dispose: async () => { dispose(); await area.dispose(); throw new Error(`EBUSY: ${area.directory}`); },
      };
    });
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const { write } = await uploadThenStop();
      expect(dispose).toHaveBeenCalledTimes(1);
      await new Promise((resolve) => { setTimeout(resolve, 20); });
      expect(unhandled).not.toHaveBeenCalled();
      const names = events(write).map(({ event }) => event);
      expect(names.slice(-2)).toEqual(['server_stopping', 'server_stopped']);
      // The failure's message, with its local path, is never logged.
      for (const [chunk] of write.mock.calls) expect(String(chunk)).not.toContain(temporary);
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});

describe('the forced exit, with the process defaults', () => {
  it('exits the process once stdout has flushed and the grace has passed', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const flush = vi.spyOn(process.stdout, 'write');
    const timer = await exitAfterGrace();
    // The flush is an empty write whose callback starts the grace.
    expect(flush).toHaveBeenCalledWith('', expect.any(Function));
    expect(exit).not.toHaveBeenCalled();
    expect(timer.hasRef()).toBe(false);
    await vi.waitFor(() => { expect(exit).toHaveBeenCalledTimes(1); }, { timeout: EXIT_GRACE_MS * 8 });
    expect(exit).toHaveBeenCalledWith();
  });

  it('still schedules the exit when writing to stdout throws', async () => {
    const exit = vi.fn();
    const flush = vi.spyOn(process.stdout, 'write').mockImplementation(() => { throw new Error('EPIPE'); });
    const timer = await exitAfterGrace(exit);
    flush.mockRestore();
    try {
      expect(exit).not.toHaveBeenCalled();
      await vi.waitFor(() => { expect(exit).toHaveBeenCalledTimes(1); }, { timeout: EXIT_GRACE_MS * 8 });
    } finally { clearTimeout(timer); }
  });
});

describe('the process signals and stdin closure startServer owns by default', () => {
  it('stops once on SIGINT, SIGTERM or stdin closing, then exits after the grace', async () => {
    const write = silenceStderr();
    // Record, at each exit, whether the stop had already finished.
    const stoppedAtExit: boolean[] = [];
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      stoppedAtExit.push(events(write).some(({ event }) => event === 'server_stopped'));
    }) as never);
    const signals = { SIGINT: process.listenerCount('SIGINT'), SIGTERM: process.listenerCount('SIGTERM') };
    const stdin = { end: process.stdin.listenerCount('end'), close: process.stdin.listenerCount('close') };

    // Capture what the server would install; pass anything else through untouched.
    const captured = new Map<string, () => void>();
    const on = process.on.bind(process);
    vi.spyOn(process, 'on').mockImplementation(((event: string | symbol, listener: () => void) => {
      if (event === 'SIGINT' || event === 'SIGTERM') { captured.set(event, listener); return process; }
      return on(event as 'exit', listener);
    }) as typeof process.on);
    const once = process.stdin.once.bind(process.stdin);
    vi.spyOn(process.stdin, 'once').mockImplementation(((event: string | symbol, listener: () => void) => {
      if (event === 'end' || event === 'close') { captured.set(`stdin:${event}`, listener); return process.stdin; }
      return once(event as 'data', listener);
    }));

    const destroy = vi.spyOn(TestRailClient.prototype, 'destroy');
    const stdio = inMemory();
    const started = await startServer(environment(), { serve: stdio.serve, driver });
    // Stop the server even when an assertion fails, so it never outlives this test.
    let stopped = false;
    try {
      expect([...captured.keys()].sort()).toEqual(['SIGINT', 'SIGTERM', 'stdin:close', 'stdin:end']);
      // One stop for every ending, so however the host ends the session it drains once.
      expect(new Set(captured.values()).size).toBe(1);
      expect(destroy).toHaveBeenCalledTimes(1); // the configuration probe at load

      const stop = captured.get('SIGTERM');
      if (stop === undefined) throw new Error('no SIGTERM handler was registered');
      stop();
      captured.get('stdin:end')?.();
      await vi.waitFor(() => { expect(exit).toHaveBeenCalledTimes(2); }, { timeout: EXIT_GRACE_MS * 8 });

      const names = events(write).map(({ event }) => event);
      expect(names.filter((name) => name === 'server_stopping')).toHaveLength(1);
      expect(names.filter((name) => name === 'server_stopped')).toHaveLength(1);
      expect(destroy).toHaveBeenCalledTimes(2);
      // Each exit waited for the one shared stop, so nothing was cut off mid-drain.
      expect(stoppedAtExit).toEqual([true, true]);
      await expect(started.shutdown()).resolves.toBeUndefined();
      stopped = true;
    } finally {
      if (!stopped) await started.shutdown().catch(() => undefined);
    }

    vi.restoreAllMocks();
    expect({ SIGINT: process.listenerCount('SIGINT'), SIGTERM: process.listenerCount('SIGTERM') }).toEqual(signals);
    expect({ end: process.stdin.listenerCount('end'), close: process.stdin.listenerCount('close') }).toEqual(stdin);
  });

  it('installs nothing when the caller owns the process', async () => {
    silenceStderr();
    const on = vi.spyOn(process, 'on');
    const once = vi.spyOn(process.stdin, 'once');
    const stdio = inMemory();
    const started = await startServer(environment(), { registerSignals: false, serve: stdio.serve, driver });
    try {
      expect(on.mock.calls.filter(([event]) => event === 'SIGINT' || event === 'SIGTERM')).toEqual([]);
      expect(once.mock.calls.filter(([event]) => String(event) === 'end' || String(event) === 'close')).toEqual([]);
    } finally {
      await started.shutdown();
    }
  });
});
