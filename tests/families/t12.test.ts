import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TestRailClient } from '@dichovsky/testrail-api-client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConfiguration, type Configuration } from '../../src/config/environment.js';
import { LIMIT_CEILINGS } from '../../src/config/limits.js';
import { driverOptions } from '../../src/driver/configuration.js';
import { createStagingArea } from '../../src/files/staging.js';
import { operationRegistry } from '../../src/operations/catalog.js';
import { createRuntime } from '../../src/runtime/invocation.js';
import { executeToolCall } from '../../src/transport/tool-call.js';
import { describeBody } from '../contracts/uploads.js';

let base: string;

beforeAll(async () => { base = await mkdtemp(join(tmpdir(), 'testrail-mcp-t12-')); });
afterAll(async () => { await rm(base, { recursive: true, force: true }); });

const UUID = '3933d74b-4282-44de-82ae-a6412808369d';
const LOG = 'Build 412 console output\nAll 36 checks passed.\n';
const MiB = 1_048_576;

// TestRail's documented list entities, verbatim.
const LEGACY_CASE_ENTITY = {
  id: 1773, name: 'image.jpg', size: 21995, created_on: 1585560521,
  project_id: 33, case_id: 57333, user_id: 1, result_id: null,
};
const CLOUD_ENTITY = {
  client_id: 614308, project_id: 2, entity_type: 'case', id: '2ec27be4-812f-4806-9a5d-d39130d1691a',
  created_on: 1631722975, data_id: '63c82867-526d-43be-b1a5-9ddfcf581cf5', entity_id: '3',
  filename: 'msdia80.dll', filetype: 'dll', legacy_id: 0, name: 'msdia80.dll', size: 904704,
  user_id: 1, is_image: false, icon: 'other',
};
const PLAN_ENTITY = {
  id: 1900, name: 'TR-2104.gif', size: 3838070, created_on: 1602178189, project_id: 15,
  case_id: null, user_id: 1, entity_attachments_id: 360, icon_name: 'Gif Image', result_id: null,
};

/**
 * A fresh configuration with its own upload root and download directory, so what a test
 * finds in either afterwards was put there by that test alone.
 */
async function environment(limits?: Record<string, number>) {
  const directory = await mkdtemp(join(base, 'case-'));
  const roots = join(directory, 'roots');
  const outside = join(directory, 'outside');
  const downloads = join(directory, 'downloads');
  await Promise.all([mkdir(roots), mkdir(outside), mkdir(downloads)]);
  const source = join(roots, 'console.log');
  await writeFile(source, LOG, 'utf8');
  await writeFile(join(outside, 'console.log'), LOG, 'utf8');
  const configuration = await loadConfiguration({
    TESTRAIL_BASE_URL: 'https://people.testrail.io',
    TESTRAIL_EMAIL: 'user@example.com',
    TESTRAIL_API_KEY: 'synthetic',
    TESTRAIL_MCP_UPLOAD_ROOTS: JSON.stringify([roots]),
    TESTRAIL_MCP_DOWNLOAD_DIR: downloads,
    ...(limits === undefined ? {} : { TESTRAIL_MCP_LIMITS: JSON.stringify(limits) }),
  });
  const staging = await createStagingArea(directory);
  return { directory, roots, outside, downloads, source, configuration, staging };
}

type DriverOverrides = { maxRetries?: number };

/*
 * The driver is built from this server's own production options, with only fetch and DNS
 * replaced, so what these tests prove about retries and limits is what a real call does.
 */
function driverFor(configuration: Configuration, fetch: ReturnType<typeof vi.fn>, overrides: DriverOverrides = {}) {
  return new TestRailClient({
    ...driverOptions(configuration),
    ...overrides,
    dnsLookup: () => Promise.resolve([{ address: '203.0.113.10', family: 4 }]),
    fetch: fetch as unknown as typeof globalThis.fetch,
  });
}

function operation(tool: string) {
  const found = operationRegistry.get(tool);
  if (found === undefined) throw new Error(`Missing registration: ${tool}`);
  return found;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function bytes(content: string, status = 200): Response {
  return new Response(content, { status, headers: { 'content-type': 'application/octet-stream' } });
}

/** A fresh response per call: a body reads once, so a shared one would be drained. */
function replying(respond: () => Response): ReturnType<typeof vi.fn> {
  return vi.fn().mockImplementation(() => Promise.resolve(respond()));
}

function requested(fetch: ReturnType<typeof vi.fn>, index = 0): string {
  return String(fetch.mock.calls[index]?.[0]);
}

function data(result: { structuredContent?: unknown }): unknown {
  return (result.structuredContent as { data: unknown }).data;
}

/** The wrapper carries warnings only when there are some, so none reads as an empty list. */
function warnings(result: { structuredContent?: unknown }): unknown {
  return (result.structuredContent as { warnings?: unknown }).warnings ?? [];
}

function errorOf(result: { structuredContent?: unknown }): { code: string; http_status?: number; write_outcome?: string } {
  return (result.structuredContent as { error: { code: string; http_status?: number; write_outcome?: string } }).error;
}

// ------------------------------------------------------------------ download

describe('T12 get_attachment writes a new local file on every call', () => {
  it('is published as neither read-only nor idempotent, and says why', () => {
    const { annotations, description } = operation('testrail_get_attachment');
    expect(annotations).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true });
    expect(description).toContain('Each call downloads the attachment again and writes another file, even for the same ID');
    expect(description).toContain('Creates a unique persistent local file in the configured download directory on each call');
    expect(description).toContain('the result carries no original filename or media type');
    expect(description).toContain('One download runs at a time: a call made while another is in progress is refused as BUSY before anything is sent');
    expect(operation('testrail_get_attachment').retry).toBe('ordinary-read');
  });

  it.each([[17], [UUID]] as const)('downloads %s twice into two complete files with identical bytes', async (id) => {
    const env = await environment();
    const fetch = replying(() => bytes('PNG fixture bytes\n'));
    const runtime = createRuntime({ client: driverFor(env.configuration, fetch), limits: env.configuration.limits });
    try {
      const first = await executeToolCall(operation('testrail_get_attachment'), { attachment_id: id }, { runtime, configuration: env.configuration });
      const second = await executeToolCall(operation('testrail_get_attachment'), { attachment_id: id }, { runtime, configuration: env.configuration });
      expect(first.isError).toBeUndefined();
      expect(second.isError).toBeUndefined();
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(requested(fetch)).toBe(`https://people.testrail.io/index.php?/api/v2/get_attachment/${id}`);
      const results = [data(first), data(second)] as { attachment_id: unknown; file_path: string; bytes: number }[];
      for (const result of results) {
        // The ID as the caller gave it, the path of the written file and its size, and nothing invented.
        expect(Object.keys(result).sort()).toEqual(['attachment_id', 'bytes', 'file_path']);
        expect(result.attachment_id).toBe(id);
        expect(result.bytes).toBe(Buffer.byteLength('PNG fixture bytes\n'));
        expect(result.file_path.startsWith(env.downloads)).toBe(true);
        expect(await readFile(result.file_path, 'utf8')).toBe('PNG fixture bytes\n');
      }
      expect(results[0]?.file_path).not.toBe(results[1]?.file_path);
      expect((await readdir(env.downloads)).sort()).toEqual(results.map(({ file_path }) => file_path.slice(env.downloads.length + 1)).sort());
    } finally { await runtime.shutdown(); }
  });

  it.each([
    [400, 'UPSTREAM_ERROR'], [403, 'PERMISSION_DENIED'], [404, 'NOT_FOUND'],
  ] as const)('reports a %i download failure without a write_outcome and writes nothing', async (status, code) => {
    const env = await environment();
    const fetch = replying(() => json({ error: 'Field :attachment_id is not a valid attachment.' }, status));
    const runtime = createRuntime({ client: driverFor(env.configuration, fetch), limits: env.configuration.limits });
    try {
      const result = await executeToolCall(operation('testrail_get_attachment'), { attachment_id: 17 }, { runtime, configuration: env.configuration });
      expect(errorOf(result)).toEqual(expect.objectContaining({ code, http_status: status }));
      // A download only reads TestRail, so its failure says nothing about a write.
      expect(errorOf(result).write_outcome).toBeUndefined();
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(await readdir(env.downloads)).toEqual([]);
    } finally { await runtime.shutdown(); }
  });

  it('retries a download as an ordinary read and still writes one file', async () => {
    const env = await environment();
    const fetch = vi.fn()
      .mockImplementationOnce(() => Promise.resolve(json({ error: 'upstream' }, 503, { 'retry-after': '0' })))
      .mockImplementationOnce(() => Promise.resolve(bytes('after a retry\n')));
    const runtime = createRuntime({ client: driverFor(env.configuration, fetch), limits: env.configuration.limits });
    try {
      const result = await executeToolCall(operation('testrail_get_attachment'), { attachment_id: 17 }, { runtime, configuration: env.configuration });
      expect(result.isError).toBeUndefined();
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(await readdir(env.downloads)).toHaveLength(1);
      expect(await readFile((data(result) as { file_path: string }).file_path, 'utf8')).toBe('after a retry\n');
    } finally { await runtime.shutdown(); }
  });

  it('refuses a reply over the configured file limit and writes nothing', async () => {
    const env = await environment({ max_file_bytes: 1024 });
    const fetch = replying(() => bytes('x'.repeat(2048)));
    const runtime = createRuntime({ client: driverFor(env.configuration, fetch), limits: env.configuration.limits });
    try {
      const result = await executeToolCall(operation('testrail_get_attachment'), { attachment_id: 17 }, { runtime, configuration: env.configuration });
      expect(result.isError).toBe(true);
      expect(errorOf(result).code).toBe('INVALID_RESPONSE');
      expect(errorOf(result).write_outcome).toBeUndefined();
      expect(await readdir(env.downloads)).toEqual([]);
    } finally { await runtime.shutdown(); }
  });

  it('refuses a second download while one is in progress, before any request', async () => {
    const env = await environment();
    let release: (response: Response) => void = () => undefined;
    const fetch = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { release = resolve; }))
      .mockImplementation(() => Promise.resolve(bytes('second\n')));
    const runtime = createRuntime({ client: driverFor(env.configuration, fetch), limits: env.configuration.limits });
    try {
      const first = executeToolCall(operation('testrail_get_attachment'), { attachment_id: 17 }, { runtime, configuration: env.configuration });
      await vi.waitFor(() => { expect(fetch).toHaveBeenCalledTimes(1); });
      const second = await executeToolCall(operation('testrail_get_attachment'), { attachment_id: 18 }, { runtime, configuration: env.configuration });
      expect(errorOf(second).code).toBe('BUSY');
      expect(errorOf(second).write_outcome).toBeUndefined();
      expect(fetch).toHaveBeenCalledTimes(1);
      release(bytes('first\n'));
      expect((await first).isError).toBeUndefined();
      expect(await readdir(env.downloads)).toHaveLength(1);
    } finally { await runtime.shutdown(); }
  });

  it('refuses a caller-chosen destination before any request', async () => {
    const env = await environment();
    const fetch = replying(() => bytes('never\n'));
    const runtime = createRuntime({ client: driverFor(env.configuration, fetch), limits: env.configuration.limits });
    try {
      const result = await executeToolCall(operation('testrail_get_attachment'),
        { attachment_id: 17, download_path: join(env.directory, 'chosen.bin') }, { runtime, configuration: env.configuration });
      expect(errorOf(result).code).toBe('INVALID_ARGUMENT');
      expect(fetch).not.toHaveBeenCalled();
      expect(await readdir(env.downloads)).toEqual([]);
    } finally { await runtime.shutdown(); }
  });
});

// --------------------------------------------------------------------- lists

describe('T12 attachment lists', () => {
  it('returns every documented entity shape without drift', async () => {
    const env = await environment();
    const fetch = replying(() => json({
      offset: 0, limit: 50, size: 3, _links: { next: null, prev: null },
      attachments: [LEGACY_CASE_ENTITY, CLOUD_ENTITY, PLAN_ENTITY],
    }));
    const runtime = createRuntime({ client: driverFor(env.configuration, fetch), limits: env.configuration.limits });
    try {
      const result = await executeToolCall(operation('testrail_get_attachments_for_case'), { case_id: 42 }, { runtime, configuration: env.configuration });
      expect(data(result)).toEqual([LEGACY_CASE_ENTITY, CLOUD_ENTITY, PLAN_ENTITY]);
      expect(warnings(result)).toEqual([]);
      expect(requested(fetch)).toBe('https://people.testrail.io/index.php?/api/v2/get_attachments_for_case/42&limit=50&offset=0');
    } finally { await runtime.shutdown(); }
  });

  it('reports a drifted entity as a warning and returns it as sent', async () => {
    const env = await environment();
    const drifted = { ...PLAN_ENTITY, size: 'large' };
    const fetch = replying(() => json([drifted]));
    const runtime = createRuntime({ client: driverFor(env.configuration, fetch), limits: env.configuration.limits });
    try {
      const result = await executeToolCall(operation('testrail_get_attachments_for_plan'), { plan_id: 7 }, { runtime, configuration: env.configuration });
      expect(data(result)).toEqual([drifted]);
      expect(warnings(result)).toEqual([{ code: 'SCHEMA_DRIFT', count: 1 }]);
    } finally { await runtime.shutdown(); }
  });

  it.each([
    ['testrail_get_attachments_for_plan', { plan_id: 7 }, 'get_attachments_for_plan/7'],
    ['testrail_get_attachments_for_run', { run_id: 81 }, 'get_attachments_for_run/81'],
  ] as const)('%s reads the documented bare array as a terminal page', async (tool, input, route) => {
    const env = await environment();
    const fetch = replying(() => json([PLAN_ENTITY]));
    const runtime = createRuntime({ client: driverFor(env.configuration, fetch), limits: env.configuration.limits });
    try {
      const result = await executeToolCall(operation(tool), input, { runtime, configuration: env.configuration });
      expect(data(result)).toEqual([PLAN_ENTITY]);
      expect((result.structuredContent as { pagination: unknown }).pagination)
        .toMatchObject({ source: 'legacy_array', has_more: false });
      expect(requested(fetch)).toBe(`https://people.testrail.io/index.php?/api/v2/${route}&limit=50&offset=0`);
    } finally { await runtime.shutdown(); }
  });

  it.each([
    ['testrail_get_attachments_for_case', { case_id: 42 }, 'get_attachments_for_case/42'],
    ['testrail_get_attachments_for_plan', { plan_id: 7 }, 'get_attachments_for_plan/7'],
    ['testrail_get_attachments_for_run', { run_id: 81 }, 'get_attachments_for_run/81'],
  ] as const)('%s follows the continuation link in all mode', async (tool, input, route) => {
    const env = await environment();
    const fetch = vi.fn()
      .mockImplementationOnce(() => Promise.resolve(json({
        offset: 0, limit: 1, size: 1, _links: { next: `/api/v2/${route}&limit=1&offset=1`, prev: null }, attachments: [LEGACY_CASE_ENTITY],
      })))
      .mockImplementationOnce(() => Promise.resolve(json({
        offset: 1, limit: 1, size: 1, _links: { next: null, prev: `/api/v2/${route}&limit=1&offset=0` }, attachments: [CLOUD_ENTITY],
      })));
    const runtime = createRuntime({ client: driverFor(env.configuration, fetch), limits: env.configuration.limits });
    try {
      const result = await executeToolCall(operation(tool), { ...input, _mcp: { pagination: 'all', page_size: 1 } }, { runtime, configuration: env.configuration });
      expect(data(result)).toEqual([LEGACY_CASE_ENTITY, CLOUD_ENTITY]);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(requested(fetch, 1)).toBe(`https://people.testrail.io/index.php?/api/v2/${route}&limit=1&offset=1`);
    } finally { await runtime.shutdown(); }
  });

  /*
   * TestRail documents no paging for the test list but gives its reply the format of the
   * case list, which is paged. The driver method returns the list alone, so a
   * continuation, if TestRail sends one, never reaches this server. The summary says so;
   * this pins what that means for a caller.
   */
  it('returns only the first reply of a paged test list, with nothing that says more exist', async () => {
    const env = await environment();
    const fetch = replying(() => json({
      offset: 0, limit: 250, size: 1,
      _links: { next: '/api/v2/get_attachments_for_test/21&limit=250&offset=250', prev: null },
      attachments: [CLOUD_ENTITY],
    }));
    const runtime = createRuntime({ client: driverFor(env.configuration, fetch), limits: env.configuration.limits });
    try {
      const result = await executeToolCall(operation('testrail_get_attachments_for_test'), { test_id: 21 }, { runtime, configuration: env.configuration });
      expect(data(result)).toEqual([CLOUD_ENTITY]);
      expect(result.structuredContent).not.toHaveProperty('pagination');
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(requested(fetch)).toBe('https://people.testrail.io/index.php?/api/v2/get_attachments_for_test/21');
      expect(operation('testrail_get_attachments_for_test').description).toContain(
        'If TestRail pages it, only the attachments in that one reply are returned, with no sign that more exist, because the driver method returns the list alone.');
    } finally { await runtime.shutdown(); }
  });

  it('refuses a numeric plan entry before any request and sends a UUID as given', async () => {
    const env = await environment();
    const fetch = replying(() => json([PLAN_ENTITY]));
    const runtime = createRuntime({ client: driverFor(env.configuration, fetch), limits: env.configuration.limits });
    try {
      const numeric = await executeToolCall(operation('testrail_get_attachments_for_plan_entry'), { plan_id: 7, entry_id: 12 }, { runtime, configuration: env.configuration });
      expect(errorOf(numeric).code).toBe('INVALID_ARGUMENT');
      expect(fetch).not.toHaveBeenCalled();
      const upper = UUID.toUpperCase();
      const result = await executeToolCall(operation('testrail_get_attachments_for_plan_entry'), { plan_id: 7, entry_id: upper }, { runtime, configuration: env.configuration });
      expect(data(result)).toEqual([PLAN_ENTITY]);
      expect(requested(fetch)).toBe(`https://people.testrail.io/index.php?/api/v2/get_attachments_for_plan_entry/7/${upper}`);
    } finally { await runtime.shutdown(); }
  });

  it.each([
    ['testrail_get_attachments_for_plan_entry'], ['testrail_add_attachment_to_plan_entry'],
  ] as const)('%s says the entry is a UUID although TestRail labels it an integer', (tool) => {
    const { description } = operation(tool);
    expect(description).toContain('entry_id is the entry\'s UUID, as testrail_get_plan returns it in entries[].id');
    expect(description).toContain('TestRail\'s reference labels it an integer, but the driver accepts only a UUID');
  });
});

// ------------------------------------------------------------------- uploads

const UPLOADS = [
  ['testrail_add_attachment_to_case', { case_id: 57333 }, 'add_attachment_to_case/57333', 'addAttachmentToCase'],
  ['testrail_add_attachment_to_plan', { plan_id: 7 }, 'add_attachment_to_plan/7', 'addAttachmentToPlan'],
  ['testrail_add_attachment_to_plan_entry', { plan_id: 7, entry_id: UUID }, `add_attachment_to_plan_entry/7/${UUID}`, 'addAttachmentToPlanEntry'],
  ['testrail_add_attachment_to_result', { result_id: 11 }, 'add_attachment_to_result/11', 'addAttachmentToResult'],
  ['testrail_add_attachment_to_run', { run_id: 81 }, 'add_attachment_to_run/81', 'addAttachmentToRun'],
] as const;


describe('T12 uploads', () => {
  it.each(UPLOADS)('%s sends one multipart request of the staged copy and removes it afterwards', async (tool, ids, route, method) => {
    const env = await environment();
    const bodies: unknown[] = [];
    const fetch = vi.fn().mockImplementation(async (_url: unknown, init?: { body?: unknown }) => {
      bodies.push(await describeBody(init?.body));
      return json({ attachment_id: 443 });
    });
    const driver = driverFor(env.configuration, fetch);
    const invoked = vi.spyOn(driver.attachments, method);
    const runtime = createRuntime({ client: driver, limits: env.configuration.limits });
    try {
      const result = await executeToolCall(operation(tool), {
        ...ids, file_path: env.source, filename: 'console.log', content_type: 'text/plain',
      }, { runtime, configuration: env.configuration, stagingDirectory: () => Promise.resolve(env.staging.directory) });
      expect(result.isError).toBeUndefined();
      expect(data(result)).toEqual({ attachment_id: 443 });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(requested(fetch)).toBe(`https://people.testrail.io/index.php?/api/v2/${route}`);
      expect(bodies).toEqual([[{ name: 'attachment', filename: 'console.log', content_type: 'text/plain', utf8: LOG }]]);
      // The driver was handed the staged copy, never the caller's own path.
      const file = invoked.mock.calls[0]?.find((argument): argument is { path: string } =>
        typeof argument === 'object' && argument !== null && 'path' in argument);
      expect(file?.path.startsWith(env.staging.directory)).toBe(true);
      expect(file?.path).not.toBe(env.source);
      await runtime.shutdown();
      expect(await readdir(env.staging.directory)).toEqual(['owner.json']);
    } finally { await runtime.shutdown(); await env.staging.dispose(); }
  });

  /*
   * The multipart body is a consumed stream and an upload adds a new attachment each
   * time, so neither this server nor its driver sends it twice. A 429 is included on
   * purpose: the driver's JSON writes re-send one, but its uploads do not.
   */
  it.each(UPLOADS.flatMap(([tool, ids, , method]) => [
    [tool, 'a network error', ids, method, () => Promise.reject(new TypeError('fetch failed'))],
    ...[429, 500, 502, 503].map((status) =>
      [tool, `a ${status}`, ids, method, () => Promise.resolve(json({ error: 'upstream' }, status, { 'retry-after': '0' }))] as const),
  ] as const))('%s is not retried after %s, and its outcome stays unknown', async (tool, _label, ids, method, respond) => {
    const env = await environment();
    const fetch = vi.fn().mockImplementation(respond);
    const driver = driverFor(env.configuration, fetch);
    const invoked = vi.spyOn(driver.attachments, method);
    const runtime = createRuntime({ client: driver, limits: env.configuration.limits });
    try {
      const result = await executeToolCall(operation(tool), { ...ids, file_path: env.source, filename: 'console.log' },
        { runtime, configuration: env.configuration, stagingDirectory: () => Promise.resolve(env.staging.directory) });
      expect(result.isError).toBe(true);
      expect(errorOf(result).write_outcome).toBe('unknown');
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(invoked).toHaveBeenCalledTimes(1);
      await runtime.shutdown();
      expect(await readdir(env.staging.directory)).toEqual(['owner.json']);
    } finally { await runtime.shutdown(); await env.staging.dispose(); }
  });

  it.each(UPLOADS)('%s refuses a file above the configured limit before anything is sent', async (tool, ids) => {
    const env = await environment({ max_file_bytes: 16 });
    const fetch = replying(() => json({ attachment_id: 443 }));
    const runtime = createRuntime({ client: driverFor(env.configuration, fetch), limits: env.configuration.limits });
    try {
      const result = await executeToolCall(operation(tool), { ...ids, file_path: env.source, filename: 'console.log' },
        { runtime, configuration: env.configuration, stagingDirectory: () => Promise.resolve(env.staging.directory) });
      expect(errorOf(result)).toEqual(expect.objectContaining({ code: 'FILE_TOO_LARGE', write_outcome: 'not_started' }));
      expect(fetch).not.toHaveBeenCalled();
      expect(await readdir(env.staging.directory)).toEqual(['owner.json']);
    } finally { await runtime.shutdown(); await env.staging.dispose(); }
  });

  it.each(UPLOADS)('%s refuses a file outside the upload roots before anything is sent', async (tool, ids) => {
    const env = await environment();
    const fetch = replying(() => json({ attachment_id: 443 }));
    const runtime = createRuntime({ client: driverFor(env.configuration, fetch), limits: env.configuration.limits });
    try {
      const result = await executeToolCall(operation(tool), { ...ids, file_path: join(env.directory, 'outside', 'console.log'), filename: 'console.log' },
        { runtime, configuration: env.configuration, stagingDirectory: () => Promise.resolve(env.staging.directory) });
      expect(errorOf(result)).toEqual(expect.objectContaining({ code: 'FILE_ACCESS_DENIED', write_outcome: 'not_started' }));
      expect(fetch).not.toHaveBeenCalled();
    } finally { await runtime.shutdown(); await env.staging.dispose(); }
  });

  it.each(UPLOADS)('%s sends the same file twice when called twice', async (tool, ids) => {
    const env = await environment();
    const fetch = replying(() => json({ attachment_id: 443 }));
    const runtime = createRuntime({ client: driverFor(env.configuration, fetch), limits: env.configuration.limits });
    try {
      const call = () => executeToolCall(operation(tool), { ...ids, file_path: env.source, filename: 'console.log' },
        { runtime, configuration: env.configuration, stagingDirectory: () => Promise.resolve(env.staging.directory) });
      const results = await Promise.all([call(), call()]);
      expect(results.map(({ isError }) => Boolean(isError))).toEqual([false, false]);
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally { await runtime.shutdown(); await env.staging.dispose(); }
  });

  // The driver's schema types an upload's attachment_id as a number; anything else is TestRail's answer, returned as sent.
  it('returns a non-numeric attachment_id as sent, with a drift warning', async () => {
    const env = await environment();
    const fetch = replying(() => json({ attachment_id: UUID }));
    const runtime = createRuntime({ client: driverFor(env.configuration, fetch), limits: env.configuration.limits });
    try {
      const result = await executeToolCall(operation('testrail_add_attachment_to_run'), { run_id: 81, file_path: env.source, filename: 'console.log' },
        { runtime, configuration: env.configuration, stagingDirectory: () => Promise.resolve(env.staging.directory) });
      expect(data(result)).toEqual({ attachment_id: UUID });
      expect(warnings(result)).toEqual([{ code: 'SCHEMA_DRIFT', count: 1 }]);
    } finally { await runtime.shutdown(); await env.staging.dispose(); }
  });

  it.each(UPLOADS)('%s is published as a repeatable-unsafe write and says why', (tool) => {
    const { annotations, description, retry } = operation(tool);
    expect(annotations).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true });
    expect(retry).toBe('never');
    expect(description).toContain('Each call adds another attachment, even for the same file');
    expect(description).toContain('TestRail accepts files up to 256 MB, but this server refuses a file above its configured file limit, at most 100 MiB, before anything is sent');
    expect(description).toContain('Neither this server nor its driver retries an upload, not even after a 429');
    expect(description).not.toMatch(/safe to (call|run|retry|repeat)/iu);
  });

  it('states the file limit ceiling the upload summaries quote', () => {
    expect(LIMIT_CEILINGS.max_file_bytes).toBe(100 * MiB);
  });

  it('says add_attachment_to_result needs result editing enabled', () => {
    expect(operation('testrail_add_attachment_to_result').description)
      .toContain('TestRail requires the ability to edit test results to be enabled under Site Settings');
  });
});

// -------------------------------------------------------------------- delete

describe('T12 delete_attachment', () => {
  it.each([[17], [UUID]] as const)('deletes %s with one POST and reports no data', async (id) => {
    const env = await environment();
    const fetch = replying(() => new Response('', { status: 200 }));
    const runtime = createRuntime({ client: driverFor(env.configuration, fetch), limits: env.configuration.limits });
    try {
      const result = await executeToolCall(operation('testrail_delete_attachment'), { attachment_id: id }, { runtime, configuration: env.configuration });
      expect(result.isError).toBeUndefined();
      expect(data(result)).toBeNull();
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(requested(fetch)).toBe(`https://people.testrail.io/index.php?/api/v2/delete_attachment/${id}`);
      expect((fetch.mock.calls[0]?.[1] as { method?: string }).method).toBe('POST');
    } finally { await runtime.shutdown(); }
  });

  it('is published as destructive and not idempotent', () => {
    const { annotations, retry } = operation('testrail_delete_attachment');
    expect(annotations).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
    expect(retry).toBe('json-write');
  });

  // json-write: the driver re-sends a POST that TestRail rate-limited, and nothing else.
  it('is re-sent after a 429 and not after a 500', async () => {
    const env = await environment();
    const limited = vi.fn()
      .mockImplementationOnce(() => Promise.resolve(json({ error: 'slow down' }, 429, { 'retry-after': '0' })))
      .mockImplementationOnce(() => Promise.resolve(new Response('', { status: 200 })));
    const failing = replying(() => json({ error: 'upstream' }, 500, { 'retry-after': '0' }));
    for (const [fetch, calls, outcome] of [[limited, 2, undefined], [failing, 1, 'unknown']] as const) {
      const runtime = createRuntime({ client: driverFor(env.configuration, fetch), limits: env.configuration.limits });
      try {
        const result = await executeToolCall(operation('testrail_delete_attachment'), { attachment_id: 17 }, { runtime, configuration: env.configuration });
        expect(fetch).toHaveBeenCalledTimes(calls);
        if (outcome === undefined) expect(result.isError).toBeUndefined();
        else expect(errorOf(result).write_outcome).toBe(outcome);
      } finally { await runtime.shutdown(); }
    }
  });

  it('reports a refusal with its status and an unknown outcome', async () => {
    const env = await environment();
    const fetch = replying(() => json({ error: 'Field :attachment_id is not a valid attachment.' }, 400));
    const runtime = createRuntime({ client: driverFor(env.configuration, fetch), limits: env.configuration.limits });
    try {
      const result = await executeToolCall(operation('testrail_delete_attachment'), { attachment_id: 17 }, { runtime, configuration: env.configuration });
      expect(errorOf(result)).toEqual(expect.objectContaining({ code: 'UPSTREAM_ERROR', http_status: 400, write_outcome: 'unknown' }));
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally { await runtime.shutdown(); }
  });
});
