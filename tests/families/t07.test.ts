import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TestRailClient } from '@dichovsky/testrail-api-client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConfiguration, type Configuration } from '../../src/config/environment.js';
import { operationRegistry } from '../../src/operations/catalog.js';
import { createRuntime } from '../../src/runtime/invocation.js';
import { executeToolCall } from '../../src/transport/tool-call.js';

let base: string;
let configuration: Configuration;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'testrail-mcp-t07-'));
  configuration = await loadConfiguration({
    TESTRAIL_BASE_URL: 'https://labels.testrail.io',
    TESTRAIL_EMAIL: 'user@example.com',
    TESTRAIL_API_KEY: 'synthetic',
    TESTRAIL_MCP_UPLOAD_ROOTS: JSON.stringify([base]),
    TESTRAIL_MCP_DOWNLOAD_DIR: base,
  });
});

afterAll(async () => { await rm(base, { recursive: true, force: true }); });

function operation(tool: string) {
  const found = operationRegistry.get(tool);
  if (found === undefined) throw new Error(`Missing registration: ${tool}`);
  return found;
}

function runtimeFor(fetch: ReturnType<typeof vi.fn>) {
  return createRuntime({
    client: new TestRailClient({
      baseUrl: configuration.baseUrl, email: configuration.email, apiKey: configuration.apiKey,
      registerProcessHandlers: false, maxRetries: 0,
      dnsLookup: () => Promise.resolve([{ address: '203.0.113.10', family: 4 }]),
      fetch: fetch as unknown as typeof globalThis.fetch,
    }),
    limits: configuration.limits,
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function requested(fetch: ReturnType<typeof vi.fn>, index = 0): string {
  return String(fetch.mock.calls[index]?.[0]);
}

function sentBody(fetch: ReturnType<typeof vi.fn>, index = 0): unknown {
  const init = fetch.mock.calls[index]?.[1] as { body?: string } | undefined;
  return JSON.parse(init?.body ?? 'null');
}

const LABEL = { id: 1, title: 'regression', created_by: '2', created_on: 1646058671 };
const MILESTONE = {
  id: 5, name: 'Release 2.0', project_id: 1, is_completed: false, is_started: true,
  url: 'https://labels.testrail.io/index.php?/milestones/view/5',
};

/*
 * TestRail has shipped a label mutation's reply both flat and wrapped under a `label`
 * key, and the official TestRail CLI reads both. A caller of this server must not have
 * to: the shape it gets back cannot depend on which form the server happened to send.
 */
describe('T07 the two shapes of a label mutation reply', () => {
  it.each([
    ['testrail_add_label', { project_id: 1, body: { title: 'regression' } }],
    ['testrail_update_label', { label_id: 1, body: { project_id: 1, title: 'regression' } }],
  ] as const)('%s returns the same label flat or wrapped', async (tool, input) => {
    const results: unknown[] = [];
    for (const reply of [LABEL, { label: LABEL }]) {
      const fetch = vi.fn().mockResolvedValue(json(reply));
      const runtime = runtimeFor(fetch);
      try {
        const result = await executeToolCall(operation(tool), input, { runtime, configuration });
        expect(result.isError).toBeUndefined();
        results.push((result.structuredContent as { data: unknown }).data);
      } finally { await runtime.shutdown(); }
    }
    // Same record both times, and the wrapper is gone rather than passed through.
    expect(results[0]).toEqual(LABEL);
    expect(results[1]).toEqual(LABEL);
  });
});

/*
 * The one endpoint in this server with no path segment at all, and one of only two
 * whose body the driver checks itself. Sending it to the wrong URL, or letting an empty
 * list through, would ask TestRail to delete something other than what was named.
 */
describe('T07 bulk label deletion', () => {
  it('posts the identifiers to the bare endpoint with no trailing segment', async () => {
    const fetch = vi.fn().mockResolvedValue(json({}));
    const runtime = runtimeFor(fetch);
    try {
      const result = await executeToolCall(operation('testrail_delete_labels'),
        { body: { label_ids: [1, 2, 3] } }, { runtime, configuration });
      expect(result.isError).toBeUndefined();
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(requested(fetch)).toMatch(/\/api\/v2\/delete_labels$/);
      expect(sentBody(fetch)).toEqual({ label_ids: [1, 2, 3] });
      // No entity comes back, and none is invented.
      expect((result.structuredContent as { data: unknown }).data).toBeNull();
    } finally { await runtime.shutdown(); }
  });

  it.each([
    ['an empty list', []],
    ['a non-positive member', [1, 0]],
    ['a single identifier that is not a list', 1],
  ] as const)('refuses %s before any request', async (_label, value) => {
    const fetch = vi.fn().mockResolvedValue(json({}));
    const runtime = runtimeFor(fetch);
    try {
      const result = await executeToolCall(operation('testrail_delete_labels'),
        { body: { label_ids: value } }, { runtime, configuration });
      expect(result.isError).toBe(true);
      const { error } = result.structuredContent as { error: { code: string; write_outcome?: string } };
      expect(error.code).toBe('INVALID_ARGUMENT');
      expect(error.write_outcome).toBe('not_started');
      expect(fetch).not.toHaveBeenCalled();
    } finally { await runtime.shutdown(); }
  });
});

/*
 * TestRail caps a label title at 20 characters. The driver deliberately leaves that
 * limit to the server, and this server follows it: a rule copied here would have to be
 * kept in step with a rule TestRail can change on its own, and the copy would start
 * refusing valid titles the day it drifted.
 */
describe('T07 the title cap belongs to TestRail', () => {
  it('sends an over-long title and reports the refusal as TestRail gave it', async () => {
    const title = 'x'.repeat(40);
    const fetch = vi.fn().mockResolvedValue(
      json({ error: 'Field :title is too long (maximum length is 20 characters).' }, 400),
    );
    const runtime = runtimeFor(fetch);
    try {
      const result = await executeToolCall(operation('testrail_add_label'),
        { project_id: 1, body: { title } }, { runtime, configuration });
      // Dispatched rather than refused locally, so the limit stays TestRail's.
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(sentBody(fetch)).toEqual({ title });
      expect(result.isError).toBe(true);
      const { error } = result.structuredContent as { error: { code: string; http_status?: number } };
      expect(error.code).toBe('UPSTREAM_ERROR');
      expect(error.http_status).toBe(400);
      // TestRail's own sentence is not echoed back; the message is this server's.
      expect(JSON.stringify(result.structuredContent)).not.toContain('maximum length');
    } finally { await runtime.shutdown(); }
  });
});

/*
 * Both milestone filters are booleans here and 1 or 0 on the wire. A false dropped as
 * if absent asks for every milestone rather than the open ones, which reads as a
 * working filter returning more than it should.
 */
describe('T07 milestone list filters', () => {
  it('sends false filters as their own values rather than dropping them', async () => {
    const fetch = vi.fn().mockResolvedValue(json({
      offset: 0, limit: 250, size: 1, _links: { next: null, prev: null }, milestones: [MILESTONE],
    }));
    const runtime = runtimeFor(fetch);
    try {
      const result = await executeToolCall(operation('testrail_get_milestones'),
        { project_id: 3, query: { is_completed: false, is_started: false } }, { runtime, configuration });
      expect(result.isError).toBeUndefined();
      const url = requested(fetch);
      expect(url).toContain('is_completed=0');
      expect(url).toContain('is_started=0');
    } finally { await runtime.shutdown(); }
  });

  it('carries the same filters through every page of an aggregate call', async () => {
    const page = (offset: number, next: string | null) => json({
      offset, limit: 1, size: 1, _links: { next, prev: null },
      milestones: [{ ...MILESTONE, id: offset + 1 }],
    });
    const fetch = vi.fn()
      .mockResolvedValueOnce(page(0, '/api/v2/get_milestones/3&is_completed=0&limit=1&offset=1'))
      .mockResolvedValueOnce(page(1, null));
    const runtime = runtimeFor(fetch);
    try {
      const result = await executeToolCall(operation('testrail_get_milestones'), {
        project_id: 3, query: { is_completed: false }, _mcp: { pagination: 'all', page_size: 1 },
      }, { runtime, configuration });
      expect(result.isError).toBeUndefined();
      expect((result.structuredContent as { data: unknown[] }).data).toHaveLength(2);
      expect(fetch).toHaveBeenCalledTimes(2);
      for (const index of [0, 1]) expect(requested(fetch, index)).toContain('is_completed=0');
    } finally { await runtime.shutdown(); }
  });

  it('refuses the numeric spelling TestRail uses on the wire', async () => {
    const fetch = vi.fn().mockResolvedValue(json({ milestones: [] }));
    const runtime = runtimeFor(fetch);
    try {
      const result = await executeToolCall(operation('testrail_get_milestones'),
        { project_id: 3, query: { is_completed: 1 } }, { runtime, configuration });
      expect(result.isError).toBe(true);
      expect((result.structuredContent as { error: { code: string } }).error.code).toBe('INVALID_ARGUMENT');
      expect(fetch).not.toHaveBeenCalled();
    } finally { await runtime.shutdown(); }
  });
});

/*
 * update_label asks for the owning project in the body although the label is already
 * named by its own ID in the path, and the driver checks it before dispatch. Leaving it
 * out must not reach TestRail as a rename of a label in no project.
 */
describe('T07 the project a label update names', () => {
  it('sends the project in the body beside the title', async () => {
    const fetch = vi.fn().mockResolvedValue(json(LABEL));
    const runtime = runtimeFor(fetch);
    try {
      await executeToolCall(operation('testrail_update_label'),
        { label_id: 9, body: { project_id: 4, title: 'renamed' } }, { runtime, configuration });
      expect(requested(fetch)).toContain('update_label/9');
      expect(sentBody(fetch)).toEqual({ project_id: 4, title: 'renamed' });
    } finally { await runtime.shutdown(); }
  });

  it.each([
    ['omitted', {}],
    ['zero', { project_id: 0 }],
  ] as const)('refuses a project that is %s before any request', async (_label, extra) => {
    const fetch = vi.fn().mockResolvedValue(json(LABEL));
    const runtime = runtimeFor(fetch);
    try {
      const result = await executeToolCall(operation('testrail_update_label'),
        { label_id: 9, body: { title: 'renamed', ...extra } }, { runtime, configuration });
      expect(result.isError).toBe(true);
      expect((result.structuredContent as { error: { code: string } }).error.code).toBe('INVALID_ARGUMENT');
      expect(fetch).not.toHaveBeenCalled();
    } finally { await runtime.shutdown(); }
  });
});
