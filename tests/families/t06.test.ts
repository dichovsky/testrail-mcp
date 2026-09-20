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
  base = await mkdtemp(join(tmpdir(), 'testrail-mcp-t06-'));
  configuration = await loadConfiguration({
    TESTRAIL_BASE_URL: 'https://plans.testrail.io',
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

const ENTRY_ID = '3933d74b-4282-44de-82ae-a6412808369d';
const UPPER_ENTRY_ID = '3933D74B-4282-44DE-82AE-A6412808369D';

const PLAN = {
  id: 10, name: 'Release 1.0', is_completed: false, passed_count: 0, blocked_count: 0, untested_count: 0,
  retest_count: 0, failed_count: 0, project_id: 1, created_on: 1646058671, created_by: 1,
  url: 'https://plans.testrail.io/index.php?/plans/view/10',
};
const RUN = {
  id: 13, suite_id: 1, name: 'Chrome, Windows 8', include_all: true, is_completed: false, passed_count: 0,
  blocked_count: 0, untested_count: 8, retest_count: 0, failed_count: 0, project_id: 1, plan_id: 10,
  created_on: 1646058671, created_by: 1, url: 'https://plans.testrail.io/index.php?/runs/view/13',
};
const PLAN_ENTRY = { id: ENTRY_ID, suite_id: 1, name: 'Browser test', include_all: true, runs: [RUN] };

/*
 * A plan entry is the one identifier in this server that is not a number. It reaches the
 * request as a path segment, so anything the adapter does to it on the way, normalising
 * its case or re-encoding it, addresses a different entry than the caller named.
 */
describe('T06 entry identifiers in the request path', () => {
  it.each([
    ['testrail_update_plan_entry', { plan_id: 10, entry_id: UPPER_ENTRY_ID, body: { name: 'Renamed' } },
      `update_plan_entry/10/${UPPER_ENTRY_ID}`],
    ['testrail_delete_plan_entry', { plan_id: 10, entry_id: UPPER_ENTRY_ID },
      `delete_plan_entry/10/${UPPER_ENTRY_ID}`],
    ['testrail_add_run_to_plan_entry', { plan_id: 10, entry_id: UPPER_ENTRY_ID, body: { config_ids: [1, 5] } },
      `add_run_to_plan_entry/10/${UPPER_ENTRY_ID}`],
  ] as const)('%s sends the identifier verbatim', async (tool, input, endpoint) => {
    const fetch = vi.fn().mockResolvedValue(json(tool === 'testrail_add_run_to_plan_entry' ? RUN : PLAN_ENTRY));
    const runtime = runtimeFor(fetch);
    try {
      const result = await executeToolCall(operation(tool), input, { runtime, configuration });
      expect(result.isError).toBeUndefined();
      expect(fetch).toHaveBeenCalledTimes(1);
      // The case the caller gave, not a lower-cased or percent-encoded rewrite of it.
      expect(requested(fetch)).toContain(endpoint);
    } finally { await runtime.shutdown(); }
  });

  /*
   * Two neighbouring tools delete different things: one removes the whole entry with
   * every run it generated, the other removes a single run. They take different
   * identifiers, and a crossed route would destroy far more than the caller asked for
   * while answering exactly as a success does.
   */
  it('routes an entry deletion and a run deletion to their own endpoints', async () => {
    const fetch = vi.fn().mockResolvedValue(json({}));
    const runtime = runtimeFor(fetch);
    try {
      await executeToolCall(operation('testrail_delete_plan_entry'),
        { plan_id: 10, entry_id: ENTRY_ID }, { runtime, configuration });
      await executeToolCall(operation('testrail_delete_run_from_plan_entry'),
        { run_id: 13 }, { runtime, configuration });
      expect(requested(fetch, 0)).toContain(`delete_plan_entry/10/${ENTRY_ID}`);
      expect(requested(fetch, 1)).toContain('delete_run_from_plan_entry/13');
      expect(requested(fetch, 1)).not.toContain('delete_plan_entry');
    } finally { await runtime.shutdown(); }
  });
});

/*
 * TestRail's reference states that config_ids and runs are not supported on
 * update_plan_entry. Forwarding either would be accepted by the server and silently
 * ignored, so the caller would be told a configuration change succeeded when nothing
 * about the entry's configurations had changed.
 */
describe('T06 fields an entry update cannot carry', () => {
  it.each([
    ['config_ids', { config_ids: [1, 5] }],
    ['runs', { runs: [] }],
    ['suite_id', { suite_id: 1 }],
  ] as const)('refuses %s before any request is sent', async (_name, extra) => {
    const fetch = vi.fn().mockResolvedValue(json(PLAN_ENTRY));
    const runtime = runtimeFor(fetch);
    try {
      const result = await executeToolCall(operation('testrail_update_plan_entry'),
        { plan_id: 10, entry_id: ENTRY_ID, body: extra }, { runtime, configuration });
      expect(result.isError).toBe(true);
      const { error } = result.structuredContent as { error: { code: string; write_outcome?: string } };
      expect(error.code).toBe('INVALID_ARGUMENT');
      // Refused at the boundary, so nothing was written and the caller is told so.
      expect(error.write_outcome).toBe('not_started');
      expect(fetch).not.toHaveBeenCalled();
    } finally { await runtime.shutdown(); }
  });
});

/*
 * A plan's entries and their runs are created in the same call that creates the plan.
 * The nesting is the request, so an adapter that flattened, reordered or resent any of
 * it would build a different plan from the one described.
 */
describe('T06 nested plan creation', () => {
  it('sends the entries and their runs in one request, unchanged', async () => {
    const body = {
      name: 'Release 1.0',
      entries: [{
        suite_id: 1, include_all: false, case_ids: [101, 102], config_ids: [1, 2, 5, 6],
        runs: [
          { include_all: false, case_ids: [101], config_ids: [1, 5] },
          { include_all: false, case_ids: [102], config_ids: [2, 6] },
        ],
      }],
    };
    const fetch = vi.fn().mockResolvedValue(json({ ...PLAN, entries: [PLAN_ENTRY] }));
    const runtime = runtimeFor(fetch);
    try {
      const result = await executeToolCall(operation('testrail_add_plan'),
        { project_id: 1, body }, { runtime, configuration });
      expect(result.isError).toBeUndefined();
      expect(fetch).toHaveBeenCalledTimes(1);
      const sent = fetch.mock.calls[0]?.[1] as { body?: string } | undefined;
      // Order included: the combinations are matched to runs by position on TestRail's side.
      expect(JSON.parse(sent?.body ?? 'null')).toEqual(body);
    } finally { await runtime.shutdown(); }
  });
});

/*
 * Plan filters are the only place in this family where a caller's value is rewritten on
 * the way to the wire. A false that is treated as absent asks for every plan rather than
 * the open ones, which reads as a working filter returning more than it should.
 */
describe('T06 plan list filters', () => {
  it('sends a false completion filter as its own value rather than dropping it', async () => {
    const fetch = vi.fn().mockResolvedValue(json({
      offset: 0, limit: 250, size: 1, _links: { next: null, prev: null }, plans: [PLAN],
    }));
    const runtime = runtimeFor(fetch);
    try {
      const result = await executeToolCall(operation('testrail_get_plans'), {
        project_id: 3,
        query: { is_completed: false, created_by: [1, 2], milestone_id: [7], created_after: 100, refs: 'TR-1' },
      }, { runtime, configuration });
      expect(result.isError).toBeUndefined();
      const url = requested(fetch);
      // TestRail spells a boolean filter as 1 or 0, and the open plans are is_completed=0.
      expect(url).toContain('is_completed=0');
      expect(url).toContain('created_by=1%2C2');
      expect(url).toContain('milestone_id=7');
      expect(url).toContain('created_after=100');
      expect(url).toContain('refs=TR-1');
    } finally { await runtime.shutdown(); }
  });

  it('carries the same filters through every page of an aggregate call', async () => {
    const page = (offset: number, next: string | null) => json({
      offset, limit: 1, size: 1, _links: { next, prev: null }, plans: [{ ...PLAN, id: offset + 1 }],
    });
    const fetch = vi.fn()
      .mockResolvedValueOnce(page(0, '/api/v2/get_plans/3&is_completed=0&limit=1&offset=1'))
      .mockResolvedValueOnce(page(1, null));
    const runtime = runtimeFor(fetch);
    try {
      const result = await executeToolCall(operation('testrail_get_plans'), {
        project_id: 3, query: { is_completed: false }, _mcp: { pagination: 'all', page_size: 1 },
      }, { runtime, configuration });
      expect(result.isError).toBeUndefined();
      expect((result.structuredContent as { data: unknown[] }).data).toHaveLength(2);
      expect(fetch).toHaveBeenCalledTimes(2);
      // A filter that survives the first request and not the continuation would return
      // the right first page and the wrong rest of the list.
      for (const index of [0, 1]) expect(requested(fetch, index)).toContain('is_completed=0');
    } finally { await runtime.shutdown(); }
  });
});
