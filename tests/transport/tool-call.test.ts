import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TestRailClient } from '@dichovsky/testrail-api-client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { loadConfiguration, type Configuration } from '../../src/config/environment.js';
import { attachmentIdSchema, filePathSchema, strictObject } from '../../src/contracts/inputs.js';
import { createStagingArea } from '../../src/files/staging.js';
import { operationRegistry } from '../../src/operations/catalog.js';
import { driverCall } from '../../src/operations/driver-call.js';
import { defineOperation, type Operation, type OperationDefinition } from '../../src/operations/registry.js';
import { createRuntime, type Runtime } from '../../src/runtime/invocation.js';
import { executeToolCall } from '../../src/transport/tool-call.js';

let base: string;
let roots: string;
let configuration: Configuration;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'testrail-mcp-toolcall-'));
  roots = join(base, 'roots');
  await mkdir(roots);
  configuration = await loadConfiguration({
    TESTRAIL_BASE_URL: 'https://toolcall.testrail.io',
    TESTRAIL_EMAIL: 'user@example.com',
    TESTRAIL_API_KEY: 'synthetic',
    TESTRAIL_MCP_UPLOAD_ROOTS: JSON.stringify([roots]),
    TESTRAIL_MCP_DOWNLOAD_DIR: base,
  });
});

afterAll(async () => { await rm(base, { recursive: true, force: true }); });

function driver(respond: () => Promise<Response>): TestRailClient {
  return new TestRailClient({
    baseUrl: configuration.baseUrl, email: configuration.email, apiKey: configuration.apiKey,
    registerProcessHandlers: false, maxRetries: 0,
    dnsLookup: () => Promise.resolve([{ address: '203.0.113.10', family: 4 }]),
    fetch: () => respond(),
  });
}

/** A download operation whose identifier may be a number or a UUID, as TestRail allows. */
const downloadInput = strictObject({ attachment_id: attachmentIdSchema });
const getAttachment = defineOperation({
  token: 'get_attachment', method: 'GET', route: 'get_attachment/{attachment_id}', family: 'T12',
  driverBinding: 'attachments.getAttachment', summary: 'Download an attachment.',
  inputSchema: downloadInput,
  argumentMap: [{ input: 'attachment_id', call: 'single', argument: 0, serialization: 'path' }],
  response: { shape: 'binary', outerSchema: z.instanceof(ArrayBuffer), entitySchema: null },
  pagination: {
    kind: 'none',
    single: driverCall(downloadInput, 'attachments.getAttachment', (method, input) => method(input.attachment_id)),
  },
  files: { kind: 'download' },
  effects: { testRail: 'read', destructive: false, idempotent: false },
  retry: 'ordinary-read',
} as const satisfies OperationDefinition) as Operation;

/** An upload operation, used to prove the staged copy never outlives a refused call. */
// The registry reserves these flat names for upload operations.
const uploadInput = strictObject({
  case_id: z.int().positive(),
  file_path: filePathSchema,
  filename: z.string().min(1),
});
const addAttachment = defineOperation({
  token: 'add_attachment_to_case', method: 'POST', route: 'add_attachment_to_case/{case_id}', family: 'T12',
  driverBinding: 'attachments.addAttachmentToCase', summary: 'Attach a file to a case.',
  inputSchema: uploadInput,
  argumentMap: [{ input: 'case_id', call: 'single', argument: 0, serialization: 'path' }],
  response: { shape: 'record', outerSchema: z.record(z.string(), z.unknown()), entitySchema: null },
  pagination: {
    kind: 'none',
    single: driverCall(uploadInput, 'attachments.addAttachmentToCase', (method, input, context) =>
      method(input.case_id, context.upload ?? { path: '' }, input.filename)),
  },
  files: { kind: 'upload', featureFilename: false },
  effects: { testRail: 'write', destructive: false, idempotent: false },
  // The registry requires this: a multipart upload is never retried.
  retry: 'never',
} as const satisfies OperationDefinition) as Operation;

/** A plain read, used to occupy execution slots: a download would take the one
 * binary slot instead and the rest would be refused before filling capacity. */
const projectInput = strictObject({ project_id: z.int().positive() });
const getProject = defineOperation({
  token: 'get_project', method: 'GET', route: 'get_project/{project_id}', family: 'T01',
  driverBinding: 'projects.getProject', summary: 'Get a TestRail project.',
  inputSchema: projectInput,
  argumentMap: [{ input: 'project_id', call: 'single', argument: 0, serialization: 'path' }],
  response: { shape: 'record', outerSchema: z.record(z.string(), z.unknown()), entitySchema: null },
  pagination: {
    kind: 'none',
    single: driverCall(projectInput, 'projects.getProject', (method, input) => method(input.project_id)),
  },
  files: { kind: 'none' },
  effects: { testRail: 'read', destructive: false, idempotent: true },
  retry: 'ordinary-read',
} as const satisfies OperationDefinition) as Operation;

function binary(bytes: Uint8Array): Response {
  return new Response(bytes, { status: 200, headers: { 'content-type': 'application/octet-stream' } });
}

describe('aggregate bounds above the configured limit', () => {
  /*
   * The list schemas cap each bound at the built-in default, because they are built
   * before the configuration is read. Each configured limit here sits below that default,
   * so a value between the two passes the schema and only the transport can refuse it.
   */
  const configured = { max_all_items: 200, max_all_pages: 5, max_all_bytes: 4096, max_all_duration_ms: 9000 };
  const cases = [
    ['max_items', 'max_all_items', 'maxItems'],
    ['max_pages', 'max_all_pages', 'maxPages'],
    ['max_bytes', 'max_all_bytes', 'maxBytes'],
    ['max_duration_ms', 'max_all_duration_ms', 'maxDurationMs'],
  ] as const;
  const getProjects = operationRegistry.entries.find(({ tool }) => tool === 'testrail_get_projects');

  async function call(bound: string, value: number) {
    if (getProjects === undefined) throw new Error('testrail_get_projects is not registered');
    const limited = await loadConfiguration({
      TESTRAIL_BASE_URL: 'https://toolcall.testrail.io',
      TESTRAIL_EMAIL: 'user@example.com',
      TESTRAIL_API_KEY: 'synthetic',
      TESTRAIL_MCP_UPLOAD_ROOTS: JSON.stringify([roots]),
      TESTRAIL_MCP_DOWNLOAD_DIR: base,
      TESTRAIL_MCP_LIMITS: JSON.stringify(configured),
    });
    const requests = vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      offset: 0, limit: 250, size: 0, _links: { next: null, prev: null }, projects: [],
    }), { headers: { 'content-type': 'application/json' } })));
    const client = driver(requests);
    const aggregate = vi.spyOn(client.projects, 'getAllProjects');
    const runtime = createRuntime({ client, limits: limited.limits });
    try {
      const result = await executeToolCall(getProjects, { _mcp: { pagination: 'all', [bound]: value } }, {
        runtime, configuration: limited,
      });
      return { result, requests, aggregate };
    } finally { await runtime.shutdown(); }
  }

  it.each(cases)('refuses %s above the configured %s before dispatch', async (bound, limit) => {
    const { result, requests, aggregate } = await call(bound, configured[limit] + 1);
    expect(result.isError).toBe(true);
    expect((result.structuredContent as { error: { code: string } }).error.code).toBe('INVALID_ARGUMENT');
    expect(aggregate).not.toHaveBeenCalled();
    expect(requests).not.toHaveBeenCalled();
  });

  // Below the limit as well as at it: a value equal to the limit reaches the driver
  // whether the caller's bound or the configured one is forwarded, so alone it cannot
  // tell the two apart.
  it.each(cases.flatMap((entry) => [[...entry, 0], [...entry, 1]] as const))(
    'forwards %s up to the configured %s unchanged, as %s %i below it',
    async (bound, limit, option, below) => {
      const value = configured[limit] - below;
      const { result, aggregate } = await call(bound, value);
      expect(result.isError).toBeUndefined();
      expect(aggregate).toHaveBeenCalledTimes(1);
      expect(aggregate.mock.calls[0]?.[0]).toMatchObject({ [option]: value });
    },
  );
});

describe('download diagnostics', () => {
  it('logs a successful download without its local path', async () => {
    const runtime = createRuntime({
      client: driver(() => Promise.resolve(binary(new Uint8Array([1, 2, 3])))),
      limits: configuration.limits,
    });
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const result = await executeToolCall(getAttachment, { attachment_id: 9 }, { runtime, configuration });
      const path = (result.structuredContent as { data: { file_path: string } }).data.file_path;
      const lines = write.mock.calls.map(([chunk]) => String(chunk));
      expect(lines).toHaveLength(1);
      // The path goes to the caller in the result, never into diagnostics. Checked raw
      // and JSON-escaped, since a Windows path's backslashes double in the log line.
      for (const text of [path, base]) {
        expect(lines[0]).not.toContain(text);
        expect(lines[0]).not.toContain(JSON.stringify(text).slice(1, -1));
      }
    } finally {
      write.mockRestore();
      await runtime.shutdown();
    }
  });
});

describe('download identifiers', () => {
  it.each([
    ['numeric', 7],
    ['UUID', '4f1b2c3d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'],
  ])('returns the caller %s identifier unchanged', async (_label, identifier) => {
    const runtime = createRuntime({
      client: driver(() => Promise.resolve(binary(new Uint8Array([1, 2, 3])))),
      limits: configuration.limits,
    });
    try {
      const result = await executeToolCall(getAttachment, { attachment_id: identifier }, {
        runtime, configuration,
      });
      expect(result.isError).toBeUndefined();
      const { data } = result.structuredContent as { data: { attachment_id: unknown; bytes: number } };
      // Coercing a UUID to a placeholder would break any caller matching a batch of
      // downloads back to what it requested.
      expect(data.attachment_id).toBe(identifier);
      expect(data.bytes).toBe(3);
    } finally { await runtime.shutdown(); }
  });
});

describe('staged uploads', () => {
  it('leaves no staged copy behind when the call is refused at admission', async () => {
    const source = join(roots, 'upload.txt');
    await writeFile(source, 'approved content');
    const area = await createStagingArea(base);

    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const runtime: Runtime = createRuntime({
      client: driver(async () => {
        await gate;
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      }),
      limits: configuration.limits,
    });

    const dependencies = {
      runtime, configuration,
      stagingDirectory: () => Promise.resolve(area.directory),
    };

    try {
      // Fill every slot so the next call is refused before the driver is ever entered.
      const inflight = Array.from({ length: configuration.limits.max_active_calls }, (_unused, index) =>
        executeToolCall(getProject, { project_id: index + 1 }, dependencies));
      await new Promise((resolve) => { setTimeout(resolve, 120); });
      expect(runtime.stats().active).toBe(configuration.limits.max_active_calls);

      const refused = await executeToolCall(
        addAttachment,
        { case_id: 1, file_path: source, filename: 'upload.txt' },
        dependencies,
      );
      expect(refused.isError).toBe(true);
      expect((refused.structuredContent as { error: { code: string } }).error.code).toBe('BUSY');

      /*
       * The runtime rejects BUSY before it creates the slot that runs cleanup, so
       * without an explicit disposal the copy would sit in the staging directory for
       * the life of the process. Only the ownership marker may remain.
       */
      expect(await readdir(area.directory)).toEqual(['owner.json']);

      release();
      await Promise.all(inflight);
    } finally {
      release();
      await runtime.shutdown();
      await area.dispose();
    }
  }, 20_000);

  it('disposes the staged copy and frees the slot when name resolution fails before any request', async () => {
    const source = join(roots, 'dns-fails.txt');
    await writeFile(source, 'approved content');
    const area = await createStagingArea(base);
    const fetch = vi.fn(() => Promise.resolve(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })));
    const runtime = createRuntime({
      client: new TestRailClient({
        baseUrl: configuration.baseUrl, email: configuration.email, apiKey: configuration.apiKey,
        registerProcessHandlers: false, maxRetries: 0,
        dnsLookup: () => Promise.reject(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' })),
        fetch,
      }),
      limits: configuration.limits,
    });
    try {
      const result = await executeToolCall(addAttachment, { case_id: 1, file_path: source, filename: 'dns.txt' }, {
        runtime, configuration, stagingDirectory: () => Promise.resolve(area.directory),
      });
      // Today's behaviour, pinned so any change is deliberate: the driver raises a
      // validation error for the failed lookup, which maps to an internal fault with an
      // unknown write outcome although nothing was sent. Whether it should is an open
      // question on the F05 error contract.
      expect(result.structuredContent).toEqual({
        error: { code: 'INTERNAL_ERROR', message: 'The server failed to complete the call.', write_outcome: 'unknown' },
      });
      expect(fetch).not.toHaveBeenCalled();
      await vi.waitFor(() => { expect(runtime.stats().active).toBe(0); });
      expect(await readdir(area.directory)).toEqual(['owner.json']);
    } finally {
      await runtime.shutdown();
      await area.dispose();
    }
  });

  /*
   * Cancellation stops the wait, not the request: the driver may still be reading the
   * staged copy into the multipart body. The copy must outlive the call until the request
   * settles, or the upload fails part-way against a file that has gone.
   */
  it('keeps the staged copy until a cancelled upload settles', async () => {
    const source = join(roots, 'cancelled.txt');
    await writeFile(source, 'streamed after cancel');
    const area = await createStagingArea(base);

    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let sent: string | undefined;
    const fetch = vi.fn().mockImplementation(async (_url: unknown, init?: { body?: ConstructorParameters<typeof Response>[0] }) => {
      await gate;
      // Read the body only now, as a slow connection would.
      sent = await new Response(init?.body).text();
      return new Response('{"attachment_id":1}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const runtime = createRuntime({
      client: new TestRailClient({
        baseUrl: configuration.baseUrl, email: configuration.email, apiKey: configuration.apiKey,
        registerProcessHandlers: false, maxRetries: 0,
        dnsLookup: () => Promise.resolve([{ address: '203.0.113.10', family: 4 }]),
        fetch,
      }),
      limits: configuration.limits,
    });
    const cancel = new AbortController();

    try {
      const call = executeToolCall(
        addAttachment,
        { case_id: 1, file_path: source, filename: 'cancelled.txt' },
        { runtime, configuration, signal: cancel.signal, stagingDirectory: () => Promise.resolve(area.directory) },
      );
      await vi.waitFor(() => { expect(fetch).toHaveBeenCalledTimes(1); });
      cancel.abort();
      const cancelled = await call;
      expect((cancelled.structuredContent as { error: { code: string } }).error.code).toBe('CANCELLED');
      // The request is still running, so its staged copy is still there.
      expect(await readdir(area.directory)).toHaveLength(2);

      release();
      await vi.waitFor(() => { expect(runtime.stats().active).toBe(0); });
      expect(sent).toContain('streamed after cancel');
      // Settlement disposes it: only the ownership marker remains.
      expect(await readdir(area.directory)).toEqual(['owner.json']);
    } finally {
      release();
      await runtime.shutdown();
      await area.dispose();
    }
  });
});

describe('work that never reaches TestRail', () => {
  /** A driver that counts every lookup and request, and answers each with a created project. */
  function counted() {
    let lookups = 0;
    let requests = 0;
    const client = new TestRailClient({
      baseUrl: configuration.baseUrl, email: configuration.email, apiKey: configuration.apiKey,
      registerProcessHandlers: false, maxRetries: 0,
      dnsLookup: () => { lookups += 1; return Promise.resolve([{ address: '203.0.113.10', family: 4 as const }]); },
      fetch: () => {
        requests += 1;
        return Promise.resolve(new Response(JSON.stringify({ id: 9, name: 'Created' }), {
          status: 200, headers: { 'content-type': 'application/json' },
        }));
      },
    });
    return { client, get lookups() { return lookups; }, get requests() { return requests; } };
  }

  const addProject = operationRegistry.entries.find(({ tool }) => tool === 'testrail_add_project');
  if (addProject === undefined) throw new Error('testrail_add_project is not registered');

  it('reports a write cancelled before dispatch as not started, with no lookup or request', async () => {
    const upstream = counted();
    const runtime = createRuntime({ client: upstream.client, limits: configuration.limits });
    try {
      const result = await executeToolCall(addProject, { body: { name: 'Never sent' } }, {
        runtime, configuration, signal: AbortSignal.abort(), stagingDirectory: () => Promise.resolve(base),
      });
      expect((result.structuredContent as { error: object }).error)
        .toMatchObject({ code: 'CANCELLED', write_outcome: 'not_started' });
      await new Promise((resolve) => { setTimeout(resolve, 30); });
      expect({ lookups: upstream.lookups, requests: upstream.requests }).toEqual({ lookups: 0, requests: 0 });
      expect(runtime.stats().active).toBe(0);
    } finally { await runtime.shutdown(); }
  });

  it('accepts no transport override from a tool argument', async () => {
    const upstream = counted();
    const runtime = createRuntime({ client: upstream.client, limits: configuration.limits });
    try {
      // The only fetch and resolver seams are the composition root's; a caller naming one is refused whole.
      for (const input of [
        { body: { name: 'x' }, fetch: 'https://attacker.example' },
        { body: { name: 'x' }, _mcp: { dnsLookup: '127.0.0.1' } },
      ]) {
        const result = await executeToolCall(addProject, input, {
          runtime, configuration, stagingDirectory: () => Promise.resolve(base),
        });
        expect((result.structuredContent as { error: object }).error)
          .toMatchObject({ code: 'INVALID_ARGUMENT', write_outcome: 'not_started' });
      }
      expect({ lookups: upstream.lookups, requests: upstream.requests }).toEqual({ lookups: 0, requests: 0 });
    } finally { await runtime.shutdown(); }
  });
});
