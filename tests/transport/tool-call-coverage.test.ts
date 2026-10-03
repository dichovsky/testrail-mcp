import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TestRailClient } from '@dichovsky/testrail-api-client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { loadConfiguration, type Configuration } from '../../src/config/environment.js';
import { strictObject } from '../../src/contracts/inputs.js';
import type { ToolResult } from '../../src/contracts/results.js';
import { operationRegistry } from '../../src/operations/catalog.js';
import type { CallContext, DriverCall } from '../../src/operations/driver-call.js';
import type { Operation } from '../../src/operations/registry.js';
import { createRuntime, type Runtime } from '../../src/runtime/invocation.js';
import { executeToolCall } from '../../src/transport/tool-call.js';

/*
 * The parts of `executeToolCall` that the catalog's own operations never exercise.
 *
 * Every registered input schema is a strict object and every upload requires a filename,
 * so the pipeline's handling of a non-object input, a missing upload path or filename and
 * a download without an identifier is reached here through operations derived from real
 * catalog entries with a looser schema or a stand-in driver call. The soft-delete preview
 * and the missing staging directory are reached with the catalog operations unchanged.
 */

let base: string;
let roots: string;
let staging: string;
let configuration: Configuration;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'testrail-mcp-toolcall-coverage-'));
  roots = join(base, 'roots');
  staging = join(base, 'staging');
  await mkdir(roots);
  await mkdir(staging);
  await writeFile(join(roots, 'evidence.txt'), 'evidence');
  configuration = await loadConfiguration({
    TESTRAIL_BASE_URL: 'https://toolcall-coverage.testrail.io',
    TESTRAIL_EMAIL: 'user@example.com',
    TESTRAIL_API_KEY: 'synthetic',
    TESTRAIL_MCP_UPLOAD_ROOTS: JSON.stringify([roots]),
    TESTRAIL_MCP_DOWNLOAD_DIR: base,
  });
});

afterAll(async () => { await rm(base, { recursive: true, force: true }); });

// Each call logs one diagnostic line; keep it off the test output.
beforeEach(() => { vi.spyOn(process.stderr, 'write').mockImplementation(() => true); });
afterEach(() => { vi.restoreAllMocks(); });

function catalog(tool: string): Operation {
  const operation = operationRegistry.get(tool);
  if (operation === undefined) throw new Error(`${tool} is not registered`);
  return operation;
}

/** A driver that fails the test if the pipeline ever reaches the network. */
function quietDriver(): TestRailClient {
  return new TestRailClient({
    baseUrl: configuration.baseUrl, email: configuration.email, apiKey: configuration.apiKey,
    registerProcessHandlers: false, maxRetries: 0,
    dnsLookup: () => Promise.resolve([{ address: '203.0.113.10', family: 4 }]),
    fetch: () => Promise.reject(new Error('no request is expected')),
  });
}

async function withRuntime<T>(client: TestRailClient, body: (runtime: Runtime) => Promise<T>): Promise<T> {
  const runtime = createRuntime({ client, limits: configuration.limits });
  try { return await body(runtime); } finally { await runtime.shutdown(); }
}

/** A stand-in driver call, recording what the pipeline handed it. */
function standIn(binding: DriverCall['binding'], reply: (input: unknown, context: CallContext) => unknown) {
  const invoke = vi.fn((_client: TestRailClient, input: unknown, context: CallContext) =>
    Promise.resolve(reply(input, context)));
  const call: DriverCall = { binding, inputSchema: z.object({}), invoke };
  return { call, invoke };
}

/** A real catalog operation with some of its parts replaced. */
function derive(operation: Operation, parts: Record<string, unknown>): Operation {
  return { ...operation, ...parts };
}

const errorOf = (result: ToolResult) =>
  (result.structuredContent as { error: { code: string; write_outcome?: string } }).error;
const dataOf = (result: ToolResult) =>
  (result.structuredContent as { data: unknown; pagination?: Record<string, unknown> });

describe('a list input that is not an object, or whose _mcp is not an object', () => {
  const getProjects = catalog('testrail_get_projects');
  const page = { kind: 'legacy-array', items: [{ id: 1, name: 'Project' }], size: 1 };

  it.each([
    ['a string input', 'not-an-object'],
    ['a null input', null],
    ['an _mcp array', { _mcp: ['all'] }],
    ['an _mcp string', { _mcp: 'all' }],
    ['a null _mcp', { _mcp: null }],
  ])('is served as the one default page for %s, never as an aggregate', async (_label, input) => {
    const pageCall = standIn('projects.getProjectsPage', () => page);
    const allCall = standIn('projects.getAllProjects', () => []);
    const operation = derive(getProjects, {
      inputSchema: z.unknown(),
      pagination: { ...getProjects.pagination, page: pageCall.call, all: allCall.call },
    });
    const result = await withRuntime(quietDriver(), (runtime) =>
      executeToolCall(operation, input, { runtime, configuration }));

    expect(result.isError).toBeUndefined();
    expect(pageCall.invoke).toHaveBeenCalledTimes(1);
    // The caller's value is forwarded as it was given, not replaced by a parsed clone.
    expect(pageCall.invoke.mock.calls[0]?.[1]).toBe(input);
    expect(allCall.invoke).not.toHaveBeenCalled();
    expect(dataOf(result)).toMatchObject({
      data: page.items,
      pagination: { mode: 'page', source: 'legacy_array', returned: 1, has_more: false },
    });
  });

  it.each([
    ['an array of items', [{ id: 1 }]],
    ['an envelope whose items are not an array', { kind: 'envelope', items: 'none' }],
    ['nothing at all', undefined],
  ])('refuses a page reply that is %s as INVALID_RESPONSE, even when the outer schema admits it', async (_label, reply) => {
    const pageCall = standIn('projects.getProjectsPage', () => reply);
    const operation = derive(getProjects, {
      response: { ...getProjects.response, outerSchema: z.any() },
      pagination: { ...getProjects.pagination, page: pageCall.call },
    });
    const result = await withRuntime(quietDriver(), (runtime) =>
      executeToolCall(operation, {}, { runtime, configuration }));

    expect(pageCall.invoke).toHaveBeenCalledTimes(1);
    expect(result.isError).toBe(true);
    expect(errorOf(result)).toMatchObject({ code: 'INVALID_RESPONSE' });
    // A read: there is no write whose outcome the caller needs.
    expect(errorOf(result).write_outcome).toBeUndefined();
  });
});

describe('an upload whose request cannot be staged', () => {
  const addAttachment = catalog('testrail_add_attachment_to_case');

  it.each([
    ['a string input', 'evidence.txt'],
    ['a null input', null],
    ['a numeric file_path', { case_id: 1, file_path: 5, filename: 'evidence.txt' }],
    ['no file_path at all', { case_id: 1, filename: 'evidence.txt' }],
  ])('is refused as FILE_ACCESS_DENIED before staging or dispatch for %s', async (_label, input) => {
    const client = quietDriver();
    const upload = vi.spyOn(client.attachments, 'addAttachmentToCase');
    const stagingDirectory = vi.fn(() => Promise.resolve(staging));
    const operation = derive(addAttachment, { inputSchema: z.unknown() });
    const result = await withRuntime(client, (runtime) =>
      executeToolCall(operation, input, { runtime, configuration, stagingDirectory }));

    expect(result.isError).toBe(true);
    expect(errorOf(result)).toMatchObject({ code: 'FILE_ACCESS_DENIED', write_outcome: 'not_started' });
    expect(stagingDirectory).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
    expect(await readdir(staging)).toEqual([]);
  });

  it('is refused as FILE_ACCESS_DENIED when the server offers no staging directory', async () => {
    const client = quietDriver();
    const upload = vi.spyOn(client.attachments, 'addAttachmentToCase');
    const result = await withRuntime(client, (runtime) => executeToolCall(addAttachment, {
      case_id: 1, file_path: join(roots, 'evidence.txt'), filename: 'evidence.txt',
    }, { runtime, configuration }));

    expect(result.isError).toBe(true);
    expect(errorOf(result)).toMatchObject({ code: 'FILE_ACCESS_DENIED', write_outcome: 'not_started' });
    expect(upload).not.toHaveBeenCalled();
  });
});

describe('an upload whose input names no filename', () => {
  const addAttachment = catalog('testrail_add_attachment_to_case');
  const input = strictObject({
    case_id: z.int().positive(),
    file_path: z.string(),
    content_type: z.string().optional(),
  });

  it.each([
    ['without a media type', {}, {}],
    ['with a media type', { content_type: 'text/plain' }, { type: 'text/plain' }],
  ])('still stages and sends the copy %s, and disposes of it at settlement', async (_label, extra, type) => {
    let staged: string | undefined;
    const single = standIn('attachments.addAttachmentToCase', (_input, context) => {
      staged = context.upload?.path;
      return { attachment_id: 'a1' };
    });
    const operation = derive(addAttachment, {
      inputSchema: input,
      pagination: { kind: 'none', single: single.call },
    });
    const result = await withRuntime(quietDriver(), (runtime) => executeToolCall(operation, {
      case_id: 1, file_path: join(roots, 'evidence.txt'), ...extra,
    }, { runtime, configuration, stagingDirectory: () => Promise.resolve(staging) }));

    expect(result.isError).toBeUndefined();
    expect(dataOf(result).data).toEqual({ attachment_id: 'a1' });
    expect(single.invoke).toHaveBeenCalledTimes(1);
    // The driver is handed the staged copy, never the caller's own path.
    expect(single.invoke.mock.calls[0]?.[2]).toEqual({ upload: { path: staged, ...type }, limits: configuration.limits });
    expect(staged?.startsWith(staging)).toBe(true);
    expect(await readdir(staging)).toEqual([]);
  });
});

describe('a download whose input carries no usable identifier', () => {
  const getAttachment = catalog('testrail_get_attachment');

  it.each([
    ['a null input', null],
    ['a string input', '7'],
    ['a boolean identifier', { attachment_id: true }],
    ['no identifier', {}],
  ])('is an INTERNAL_ERROR registration fault, raised before dispatch, for %s', async (_label, input) => {
    const client = quietDriver();
    const download = vi.spyOn(client.attachments, 'getAttachment');
    const operation = derive(getAttachment, { inputSchema: z.unknown() });
    const result = await withRuntime(client, (runtime) =>
      executeToolCall(operation, input, { runtime, configuration }));

    expect(result.isError).toBe(true);
    expect(errorOf(result)).toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(download).not.toHaveBeenCalled();
    expect(await readdir(base)).toEqual(['roots', 'staging']);
  });
});

describe('a soft-delete preview reply', () => {
  const deleteSection = catalog('testrail_delete_section');
  const preview = { section_id: 4, query: { soft: true } };

  async function call(reply: unknown, input: unknown = preview) {
    const client = quietDriver();
    const remove = vi.spyOn(client.sections, 'deleteSection').mockResolvedValue(reply as never);
    const result = await withRuntime(client, (runtime) =>
      executeToolCall(deleteSection, input, { runtime, configuration }));
    return { result, remove };
  }

  it.each([
    ['nothing, as after a real delete', undefined],
    ['null', null],
    ['an array', [{ affected_cases: 3 }]],
    ['an object with no counter', { deleted: true }],
    ['counters that are all null', { affected_cases: null, affected_tests: null }],
  ])('is an unknown outcome, not an empty preview, when it carries %s', async (_label, reply) => {
    const { result, remove } = await call(reply);
    expect(remove).toHaveBeenCalledWith(4, { soft: true });
    expect(result.isError).toBe(true);
    expect(errorOf(result)).toMatchObject({ code: 'INVALID_RESPONSE', write_outcome: 'unknown' });
  });

  it('is returned as data when one counter has a value, even zero', async () => {
    const { result } = await call({ affected_cases: 0, affected_tests: null });
    expect(result.isError).toBeUndefined();
    expect(dataOf(result).data).toEqual({ affected_cases: 0, affected_tests: null });
  });

  it('is not demanded of a delete that asked for no preview', async () => {
    const { result, remove } = await call(undefined, { section_id: 4 });
    expect(remove).toHaveBeenCalledWith(4);
    expect(result.isError).toBeUndefined();
  });
});

describe('an aggregate reply', () => {
  const getProjects = catalog('testrail_get_projects');
  const getCaseStatuses = catalog('testrail_get_case_statuses');

  async function aggregate(operation: Operation, reply: unknown, controls: Record<string, unknown> = {}) {
    const allCall = standIn('projects.getAllProjects', () => reply);
    const derived = derive(operation, { pagination: { ...operation.pagination, all: allCall.call } });
    const result = await withRuntime(quietDriver(), (runtime) =>
      executeToolCall(derived, { _mcp: { pagination: 'all', ...controls } }, { runtime, configuration }));
    expect(allCall.invoke).toHaveBeenCalledTimes(1);
    return result;
  }

  it('is refused as INVALID_RESPONSE when it is not a plain array', async () => {
    const result = await aggregate(getProjects, { kind: 'envelope', items: [{ id: 1 }] });
    expect(result.isError).toBe(true);
    expect(errorOf(result)).toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it.each([
    ['the caller start', { start_offset: 5 }, 5],
    ['zero when the caller named none', {}, 0],
  ])('reports %s as the start of an offset-controlled list', async (_label, controls, start) => {
    const result = await aggregate(getProjects, [{ id: 1, name: 'A' }, { id: 2, name: 'B' }], controls);
    expect(result.isError).toBeUndefined();
    expect(dataOf(result).pagination).toEqual({ mode: 'all', returned: 2, complete: true, start_offset: start });
  });

  it('reports no start for a response-driven list, which has none a caller controls', async () => {
    expect(getCaseStatuses.pagination.kind).toBe('response_driven');
    const result = await aggregate(getCaseStatuses, []);
    expect(result.isError).toBeUndefined();
    expect(dataOf(result).pagination).toEqual({ mode: 'all', returned: 0, complete: true });
  });
});

describe('a download reply that arrives after the call was answered', () => {
  it('writes no file once the call has been cancelled', async () => {
    const getAttachment = catalog('testrail_get_attachment');
    let deliver: (bytes: ArrayBuffer) => void = () => undefined;
    const held = new Promise<ArrayBuffer>((resolve) => { deliver = resolve; });
    const single = standIn('attachments.getAttachment', () => held);
    const operation = derive(getAttachment, { pagination: { kind: 'none', single: single.call } });
    const cancel = new AbortController();
    const before = await readdir(base);

    const runtime = createRuntime({ client: quietDriver(), limits: configuration.limits });
    try {
      const pending = executeToolCall(operation, { attachment_id: 11 }, { runtime, configuration, signal: cancel.signal });
      await vi.waitFor(() => { expect(single.invoke).toHaveBeenCalledTimes(1); });
      cancel.abort();
      const result = await pending;
      expect(result.isError).toBe(true);
      expect(errorOf(result)).toMatchObject({ code: 'CANCELLED' });

      // TestRail answers after all: the bytes are dropped rather than written.
      deliver(new Uint8Array([1, 2, 3]).buffer);
      await held;
      // The slot is released only once the tracked call, including any file write, has
      // settled, so the directory is final once nothing is active.
      await vi.waitFor(() => { expect(runtime.stats().active).toBe(0); });
      expect(await readdir(base)).toEqual(before);
    } finally {
      await runtime.shutdown();
    }
  });
});
