import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TestRailClient } from '@dichovsky/testrail-api-client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConfiguration, type Configuration } from '../src/config/environment.js';
import { driverOptions } from '../src/driver/configuration.js';
import { operationRegistry } from '../src/operations/catalog.js';
import type { Operation } from '../src/operations/registry.js';
import { createRuntime } from '../src/runtime/invocation.js';
import { executeToolCall } from '../src/transport/tool-call.js';
import { loadParameterManifests, type ParameterManifest } from './contracts/parameter-manifest.js';

/*
 * R01: all 24 paged lists end to end through `executeToolCall`, the path a client's call
 * takes, rather than through the driver call alone. Page mode must describe the page it
 * returns, all mode must follow a continuation to a second page and join the two, and an
 * aggregate that would pass a configured bound must stop with PAGINATION_LIMIT and no data.
 *
 * The list of paged tools comes from the inventory, and each list's envelope key from the
 * driver source at the pinned commit (the `collectionKey` of each module's page
 * descriptor), so neither is read back from the registry under test.
 */

const inventory = (JSON.parse(await readFile(new URL('../docs/operation-inventory.json', import.meta.url), 'utf8')) as {
  operations: { tool: string; route: string; pagination: { kind: 'none' | 'controlled' | 'response_driven' } }[];
}).operations.filter(({ pagination }) => pagination.kind !== 'none');
const manifests = await loadParameterManifests();

/** From @dichovsky/testrail-api-client cc7751c, src/modules/*.ts page descriptors. */
const COLLECTION: Readonly<Record<string, string>> = {
  testrail_get_projects: 'projects',
  testrail_get_sections: 'sections',
  testrail_get_suites: 'suites',
  testrail_get_cases: 'cases',
  testrail_get_history_for_case: 'history',
  testrail_get_bdds: 'bdd',
  testrail_get_shared_step_history: 'step_history',
  testrail_get_shared_steps: 'shared_steps',
  testrail_get_runs: 'runs',
  testrail_get_tests: 'tests',
  testrail_get_results: 'results',
  testrail_get_results_for_case: 'results',
  testrail_get_results_for_run: 'results',
  testrail_get_plans: 'plans',
  testrail_get_labels: 'labels',
  testrail_get_milestones: 'milestones',
  testrail_get_groups: 'groups',
  testrail_get_roles: 'roles',
  testrail_get_datasets: 'datasets',
  testrail_get_variables: 'variables',
  testrail_get_case_statuses: 'case_statuses',
  testrail_get_attachments_for_case: 'attachments',
  testrail_get_attachments_for_plan: 'attachments',
  testrail_get_attachments_for_run: 'attachments',
};

/**
 * Lists TestRail answers with the envelope inside a one-element array, from the same
 * driver source: the only page descriptor declaring `response: 'nested-envelope'`
 * (src/modules/cases.ts, case history).
 */
const NESTED: ReadonlySet<string> = new Set(['testrail_get_history_for_case']);

/** A page call from the start asks for TestRail's first page of 50 (docs/pagination.md). */
const FIRST_PAGE = { limit: 50, offset: 0 } as const;

/** The reason each caller bound reports when it stops an aggregate (docs/results-and-errors.md). */
const REASON = { max_items: 'max_items', max_pages: 'max_pages', max_bytes: 'max_bytes', max_duration_ms: 'max_duration' } as const;

let base: string;
let configuration: Configuration;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'testrail-mcp-paging-'));
  configuration = await loadConfiguration({
    TESTRAIL_BASE_URL: 'https://paging.testrail.io',
    TESTRAIL_EMAIL: 'user@example.com',
    TESTRAIL_API_KEY: 'synthetic',
    TESTRAIL_MCP_UPLOAD_ROOTS: JSON.stringify([base]),
    TESTRAIL_MCP_DOWNLOAD_DIR: base,
  });
});

afterAll(async () => { await rm(base, { recursive: true, force: true }); });

type Fixture = ParameterManifest['cases'][number];

function isAll(fixture: Fixture): boolean {
  const control = fixture.input._mcp;
  return typeof control === 'object' && control !== null && !Array.isArray(control) && control.pagination === 'all';
}

/** A page-mode call from the start: no offset or limit of its own. */
function pageFixture(manifest: ParameterManifest): Fixture {
  const found = manifest.cases.find((fixture) => fixture.expect.kind === 'accepted' && !isAll(fixture) && (() => {
    const query = fixture.input.query;
    return typeof query !== 'object' || query === null || Array.isArray(query) || (query.offset === undefined && query.limit === undefined);
  })());
  if (found === undefined) throw new Error(`${manifest.endpoint.tool}: no page fixture from the start`);
  return found;
}

/** An all-mode call that names no start offset and no bound of its own. */
function allFixture(manifest: ParameterManifest): Fixture {
  const found = manifest.cases.find((fixture) => {
    if (fixture.expect.kind !== 'accepted' || !isAll(fixture)) return false;
    const control = fixture.input._mcp as Record<string, unknown>;
    return ['start_offset', 'max_items', 'max_pages', 'max_bytes', 'max_duration_ms'].every((key) => control[key] === undefined);
  });
  if (found === undefined) throw new Error(`${manifest.endpoint.tool}: no unbounded all fixture`);
  return found;
}

/** An entity the manifest's own replies carry, so the page holds a realistic item. */
function sampleItem(manifest: ParameterManifest, key: string): Record<string, unknown> {
  for (const fixture of manifest.cases) {
    if (fixture.expect.kind !== 'accepted' || fixture.expect.upstream_response.kind !== 'json') continue;
    const reply: unknown = fixture.expect.upstream_response.body;
    // A nested list's reply is its envelope inside a one-element array; unwrap it so the
    // item is an entry of the collection, never the envelope itself.
    const body = NESTED.has(manifest.endpoint.tool) && Array.isArray(reply) ? reply[0] as unknown : reply;
    const items = Array.isArray(body) ? body : (body as Record<string, unknown> | null)?.[key];
    const first: unknown = Array.isArray(items) ? items[0] : undefined;
    if (typeof first === 'object' && first !== null && !Array.isArray(first)) return first as Record<string, unknown>;
  }
  return { id: 1 };
}

/** The same entity under another identity, so the two pages' items can be told apart. */
function another(item: Record<string, unknown>): Record<string, unknown> {
  const id = item.id;
  return { ...item, id: typeof id === 'number' ? id + 1 : typeof id === 'string' ? `${id}-2` : 2 };
}

/**
 * A two-page list: the first page links on to offset 1 in TestRail's own link form, the
 * second is the last, each in the reply form TestRail uses for that list. Which one is
 * served depends only on the offset the driver asks for, so the tests check the request.
 */
function twoPages(tool: string, route: string, manifest: ParameterManifest) {
  const key = COLLECTION[tool];
  if (key === undefined) throw new Error(`${tool}: no collection key`);
  const token = route.split('/')[0] ?? '';
  const first = sampleItem(manifest, key);
  const second = another(first);
  const next = `/api/v2/${token}&limit=1&offset=1`;
  const pages = {
    first: { offset: 0, limit: 1, size: 1, _links: { next, prev: null }, [key]: [first] },
    second: { offset: 1, limit: 1, size: 1, _links: { next: null, prev: `/api/v2/${token}&limit=1&offset=0` }, [key]: [second] },
  };
  const urls: string[] = [];
  const fetch = vi.fn((target: unknown) => {
    const url = typeof target === 'string' ? target : target instanceof URL ? target.href : (target as Request).url;
    urls.push(url);
    const page = /[?&]offset=1(?:&|$)/u.test(url) ? pages.second : pages.first;
    const body = NESTED.has(tool) ? [page] : page;
    return Promise.resolve(new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }));
  });
  return { first, second, next, fetch, urls };
}

/**
 * A list served as a bare array, which carries no continuation. Alone, every request gets
 * the whole bare array. After an envelope, the first request gets the list's own envelope
 * linking on to offset 1, and the request for offset 1 gets a bare array.
 */
function bareArray(tool: string, route: string, manifest: ParameterManifest, afterEnvelope: boolean) {
  const key = COLLECTION[tool];
  if (key === undefined) throw new Error(`${tool}: no collection key`);
  const token = route.split('/')[0] ?? '';
  const first = sampleItem(manifest, key);
  const second = another(first);
  const envelope = { offset: 0, limit: 1, size: 1, _links: { next: `/api/v2/${token}&limit=1&offset=1`, prev: null }, [key]: [first] };
  const fetch = vi.fn((target: unknown) => {
    const url = typeof target === 'string' ? target : target instanceof URL ? target.href : (target as Request).url;
    const body = !afterEnvelope ? [first, second]
      : /[?&]offset=1(?:&|$)/u.test(url) ? [second]
        : NESTED.has(tool) ? [envelope] : envelope;
    return Promise.resolve(new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }));
  });
  return { first, second, fetch };
}

function runtimeFor(fetch: ReturnType<typeof vi.fn>) {
  const client = new TestRailClient({
    ...driverOptions(configuration),
    dnsLookup: () => Promise.resolve([{ address: '203.0.113.10', family: 4 }]),
    fetch: fetch as unknown as typeof globalThis.fetch,
  });
  return createRuntime({ client, limits: configuration.limits });
}

function registered(tool: string): Operation {
  const operation = operationRegistry.get(tool);
  if (operation === undefined) throw new Error(`${tool} is not registered`);
  return operation;
}

function manifestFor(tool: string): ParameterManifest {
  const manifest = manifests.find(({ endpoint }) => endpoint.tool === tool);
  if (manifest === undefined) throw new Error(`${tool} has no manifest`);
  return manifest;
}

function structured(result: { structuredContent?: unknown }): Record<string, unknown> {
  return result.structuredContent as Record<string, unknown>;
}

function control(url: string | undefined, name: string): string | undefined {
  return new RegExp(`[?&]${name}=([^&]*)`, 'u').exec(url ?? '')?.[1];
}

const rows = inventory.map(({ tool, route, pagination }) => [tool, route, pagination.kind] as const);

describe('every paged list through the tool-call path', () => {
  it('covers the inventory\'s 24 paged lists, each with a known envelope key', () => {
    expect(rows).toHaveLength(24);
    expect(Object.keys(COLLECTION).sort()).toEqual(rows.map(([tool]) => tool).sort());
    expect([...NESTED].every((tool) => tool in COLLECTION)).toBe(true);
  });

  it.each(rows)('%s: page mode returns the first page and describes what follows it', async (tool, route, kind) => {
    const manifest = manifestFor(tool);
    const server = twoPages(tool, route, manifest);
    const runtime = runtimeFor(server.fetch);
    try {
      const result = await executeToolCall(registered(tool), pageFixture(manifest).input, { runtime, configuration });
      expect(result.isError, JSON.stringify(result.structuredContent)).toBeUndefined();
      const { data, pagination, warnings } = structured(result);
      expect(data).toEqual([server.first]);
      // The page is the list's own form with realistic items, so nothing reads as drift.
      expect(warnings).toBeUndefined();
      expect(server.fetch).toHaveBeenCalledTimes(1);
      // A controlled list offers the next page itself; a response-driven one takes no
      // caller offset, so only the bounded aggregate can follow its link.
      const controlled = kind === 'controlled';
      // The stand-in serves its first page to any request, so the request itself must be
      // for the first page: TestRail's default size from offset 0, or, where the server
      // chooses the page, no controls at all.
      expect({ limit: control(server.urls[0], 'limit'), offset: control(server.urls[0], 'offset') }).toEqual(controlled
        ? { limit: String(FIRST_PAGE.limit), offset: String(FIRST_PAGE.offset) }
        : { limit: undefined, offset: undefined });
      expect(pagination).toEqual({
        mode: 'page', source: 'envelope', returned: 1, has_more: true,
        manual_continuation: controlled, next_action: controlled ? 'page' : 'all',
        limit: 1, offset: 0,
        ...(controlled ? { next_offset: 1 } : {}),
        driver: { size: 1, links: { next: server.next, prev: null } },
      });
    } finally { await runtime.shutdown(); }
  });

  it.each(rows)('%s: all mode follows the continuation and returns both pages', async (tool, route, kind) => {
    const manifest = manifestFor(tool);
    const server = twoPages(tool, route, manifest);
    const runtime = runtimeFor(server.fetch);
    try {
      const result = await executeToolCall(registered(tool), allFixture(manifest).input, { runtime, configuration });
      expect(result.isError, JSON.stringify(result.structuredContent)).toBeUndefined();
      const { data, pagination, warnings } = structured(result);
      expect(data).toEqual([server.first, server.second]);
      expect(warnings).toBeUndefined();
      expect(server.fetch).toHaveBeenCalledTimes(2);
      expect(server.urls[1]).toMatch(/[?&]offset=1(?:&|$)/u);
      // Only a controlled list has a caller-chosen start to report.
      expect(pagination).toEqual({ mode: 'all', returned: 2, complete: true, ...(kind === 'controlled' ? { start_offset: 0 } : {}) });
    } finally { await runtime.shutdown(); }
  });

  it.each(rows)('%s: an aggregate that would pass max_items stops with PAGINATION_LIMIT and no data', async (tool, route) => {
    const manifest = manifestFor(tool);
    const server = twoPages(tool, route, manifest);
    const runtime = runtimeFor(server.fetch);
    try {
      const input = { ...allFixture(manifest).input, _mcp: { ...(allFixture(manifest).input._mcp as object), max_items: 1 } };
      const result = await executeToolCall(registered(tool), input, { runtime, configuration });
      expect(result.isError).toBe(true);
      const payload = structured(result);
      // One-item pages stop max_items and max_pages at the same point, so only the reason
      // shows which bound did it.
      expect(payload.error).toMatchObject({ code: 'PAGINATION_LIMIT', reason: REASON.max_items, pages_fetched: 1, items_fetched: 1 });
      expect(payload).not.toHaveProperty('data');
      // A read reports nothing about a write.
      expect(payload.error).not.toHaveProperty('write_outcome');
      // The first page was fetched and then withheld; the second was never asked for.
      expect(server.fetch).toHaveBeenCalledTimes(1);
    } finally { await runtime.shutdown(); }
  });

  /*
   * A bare array carries no continuation, so the driver reads one as the end of the list
   * on every list, the case history's nested decoder included. The page describes only
   * what it holds, inventing no limit or offset, and the aggregate stops after it and
   * reports complete, because it cannot tell the end of the list from a reply that stopped
   * short. Three lists' descriptions say so (tests/pagination-disclosure.test.ts).
   */
  it.each(rows)('%s: a bare first reply is the whole list, in page mode and in all mode', async (tool, route, kind) => {
    const manifest = manifestFor(tool);
    const page = bareArray(tool, route, manifest, false);
    let runtime = runtimeFor(page.fetch);
    try {
      const result = await executeToolCall(registered(tool), pageFixture(manifest).input, { runtime, configuration });
      expect(result.isError, JSON.stringify(result.structuredContent)).toBeUndefined();
      const { data, pagination, warnings } = structured(result);
      expect(data).toEqual([page.first, page.second]);
      expect(warnings).toBeUndefined();
      expect(pagination).toEqual({
        mode: 'page', source: 'legacy_array', returned: 2, has_more: false,
        manual_continuation: false, next_action: 'none', driver: { size: 2 },
      });
    } finally { await runtime.shutdown(); }
    const all = bareArray(tool, route, manifest, false);
    runtime = runtimeFor(all.fetch);
    try {
      const result = await executeToolCall(registered(tool), allFixture(manifest).input, { runtime, configuration });
      expect(result.isError, JSON.stringify(result.structuredContent)).toBeUndefined();
      const { data, pagination, warnings } = structured(result);
      expect(data).toEqual([all.first, all.second]);
      expect(warnings).toBeUndefined();
      expect(pagination).toEqual({ mode: 'all', returned: 2, complete: true, ...(kind === 'controlled' ? { start_offset: 0 } : {}) });
      expect(all.fetch).toHaveBeenCalledTimes(1);
    } finally { await runtime.shutdown(); }
  });

  /*
   * The driver checks the offset only of an envelope, so a bare array after one is joined
   * as the last page without an offset check. This pins what the driver does today, so
   * docs/pagination.md cannot fall out of date; it does not endorse it. A driver that
   * refuses this shape fails these rows, and the docs change with them.
   */
  it.each(rows)('%s: all mode ends at a bare array that follows an envelope and reports it complete', async (tool, route, kind) => {
    const manifest = manifestFor(tool);
    const server = bareArray(tool, route, manifest, true);
    const runtime = runtimeFor(server.fetch);
    try {
      const result = await executeToolCall(registered(tool), allFixture(manifest).input, { runtime, configuration });
      expect(result.isError, JSON.stringify(result.structuredContent)).toBeUndefined();
      const { data, pagination, warnings } = structured(result);
      expect(data).toEqual([server.first, server.second]);
      expect(warnings).toBeUndefined();
      expect(pagination).toEqual({ mode: 'all', returned: 2, complete: true, ...(kind === 'controlled' ? { start_offset: 0 } : {}) });
      expect(server.fetch).toHaveBeenCalledTimes(2);
    } finally { await runtime.shutdown(); }
  });
});

describe('each aggregate bound through a controlled and a response-driven list', () => {
  const bounded = [
    ['testrail_get_projects', 'get_projects'],
    ['testrail_get_groups', 'get_groups'],
  ] as const;

  it.each(bounded.flatMap(([tool, route]) => ([
    [tool, 'max_pages', 1, route],
    [tool, 'max_bytes', 8, route],
  ] as const)))('%s stops at %s %s', async (tool, bound, value, route) => {
    const manifest = manifestFor(tool);
    const server = twoPages(tool, route, manifest);
    const runtime = runtimeFor(server.fetch);
    try {
      const input = { ...allFixture(manifest).input, _mcp: { ...(allFixture(manifest).input._mcp as object), [bound]: value } };
      const result = await executeToolCall(registered(tool), input, { runtime, configuration });
      expect(structured(result).error).toMatchObject({ code: 'PAGINATION_LIMIT', reason: REASON[bound] });
      expect(structured(result)).not.toHaveProperty('data');
    } finally { await runtime.shutdown(); }
  });

  it.each(bounded)('%s stops at max_duration_ms while the first page is still arriving', async (tool, route) => {
    const manifest = manifestFor(tool);
    const server = twoPages(tool, route, manifest);
    // The reply is held past the whole duration, so the deadline passes before any page.
    const slow = vi.fn(async (target: unknown) => {
      await new Promise((resolve) => { setTimeout(resolve, 50); });
      return server.fetch(target);
    });
    const runtime = runtimeFor(slow);
    try {
      const input = { ...allFixture(manifest).input, _mcp: { ...(allFixture(manifest).input._mcp as object), max_duration_ms: 5 } };
      const result = await executeToolCall(registered(tool), input, { runtime, configuration });
      const error = structured(result).error as Record<string, unknown>;
      expect(error).toMatchObject({ code: 'PAGINATION_LIMIT', reason: REASON.max_duration_ms });
      // Stopped by the driver's deadline check, the helper supplies its counts: nothing
      // was fetched (dist/pagination.js, the fetch's catch). Stopped by a request timer,
      // it supplies none and none are added. Either way nothing else is reported.
      expect(Object.keys(error).filter((key) => !['code', 'message', 'reason', 'pages_fetched', 'items_fetched'].includes(key))).toEqual([]);
      if ('pages_fetched' in error) expect([error.pages_fetched, error.items_fetched]).toEqual([0, 0]);
      expect(structured(result)).not.toHaveProperty('data');
    } finally { await runtime.shutdown(); }
  });
});

/*
 * F06 boundaries and continuation through the tool-call path. Every expected value
 * comes from the driver source at the pinned commit (dist/pagination.js,
 * collectAllPages). After every page the aggregate checks its items, then its UTF-8
 * serialized item bytes, with `>`; only when a continuation follows does it check
 * pages, items and bytes with `>=`, so max_pages never applies to the last page. It
 * rebuilds each request from its own prepared endpoint, taking the link's offset, and
 * its limit only on a response-driven list; a controlled list keeps its page size.
 */
describe('F06 boundaries and continuation through the tools', () => {
  const both = [
    ['testrail_get_projects', 'projects'],
    ['testrail_get_groups', 'groups'],
  ] as const;

  /** Serve replies chosen by the request's offset control (absent means the first page). */
  function serve(pages: Readonly<Record<string, unknown>>) {
    const urls: string[] = [];
    const fetch = vi.fn((target: unknown) => {
      const url = typeof target === 'string' ? target : target instanceof URL ? target.href : (target as Request).url;
      urls.push(url);
      const body = pages[control(url, 'offset') ?? '0'];
      if (body === undefined) throw new Error(`unexpected request ${url}`);
      return Promise.resolve(new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }));
    });
    return { fetch, urls };
  }

  function items(tool: string, key: string): [Record<string, unknown>, Record<string, unknown>] {
    // A multi-byte name, so a byte bound measured in UTF-16 code units rather than UTF-8
    // bytes misses the exact boundary.
    const first = { ...sampleItem(manifestFor(tool), key), name: 'é✓😀' };
    return [first, another(first)];
  }

  /** The driver's own byte measure of a page's items. */
  const bytes = (page: unknown[]) => Buffer.byteLength(JSON.stringify(page), 'utf8');

  function linked(key: string, token: string, first: unknown, second: unknown, next = `/api/v2/${token}&limit=1&offset=1`) {
    return {
      '0': { offset: 0, limit: 1, size: 1, _links: { next, prev: null }, [key]: [first] },
      '1': { offset: 1, limit: 1, size: 1, _links: { next: null, prev: null }, [key]: [second] },
    };
  }

  async function all(tool: string, extra: Record<string, unknown>, fetch: ReturnType<typeof vi.fn>, query?: object) {
    const runtime = runtimeFor(fetch);
    try {
      return structured(await executeToolCall(registered(tool), {
        ...allFixture(manifestFor(tool)).input,
        ...(query === undefined ? {} : { query }),
        _mcp: { pagination: 'all', ...extra },
      }, { runtime, configuration }));
    } finally { await runtime.shutdown(); }
  }

  it.each(both)('%s succeeds with every bound set exactly at what the list needs', async (tool, key) => {
    const [first, second] = items(tool, key);
    const token = tool.replace('testrail_', '');
    const exact = bytes([first]) + bytes([second]);
    for (const bound of [{ max_items: 2 }, { max_pages: 2 }, { max_bytes: exact }]) {
      const server = serve(linked(key, token, first, second));
      const payload = await all(tool, bound, server.fetch);
      expect(payload.error, JSON.stringify(bound)).toBeUndefined();
      expect(payload.data).toEqual([first, second]);
    }
    // One byte less, and the last page passes the bound: nothing is returned.
    const server = serve(linked(key, token, first, second));
    const over = await all(tool, { max_bytes: exact - 1 }, server.fetch);
    expect(over.error).toMatchObject({ code: 'PAGINATION_LIMIT', reason: 'max_bytes', pages_fetched: 2, items_fetched: 2 });
    expect(over).not.toHaveProperty('data');
  });

  it.each(both)('%s refuses a single last page that already passes max_items or max_bytes', async (tool, key) => {
    const [first, second] = items(tool, key);
    const lone = { '0': { offset: 0, limit: 2, size: 2, _links: { next: null, prev: null }, [key]: [first, second] } };
    const byItems = await all(tool, { max_items: 1 }, serve(lone).fetch);
    expect(byItems.error).toMatchObject({ code: 'PAGINATION_LIMIT', reason: 'max_items', pages_fetched: 1, items_fetched: 2 });
    expect(byItems).not.toHaveProperty('data');
    const byBytes = await all(tool, { max_bytes: bytes([first, second]) - 1 }, serve(lone).fetch);
    expect(byBytes.error).toMatchObject({ code: 'PAGINATION_LIMIT', reason: 'max_bytes', pages_fetched: 1, items_fetched: 2 });
    expect(byBytes).not.toHaveProperty('data');
  });

  it.each(both)('%s stops before another page once max_bytes is exactly spent', async (tool, key) => {
    const [first, second] = items(tool, key);
    const server = serve(linked(key, tool.replace('testrail_', ''), first, second));
    const payload = await all(tool, { max_bytes: bytes([first]) }, server.fetch);
    expect(payload.error).toMatchObject({ code: 'PAGINATION_LIMIT', reason: 'max_bytes', pages_fetched: 1, items_fetched: 1 });
    expect(payload).not.toHaveProperty('data');
    expect(server.fetch).toHaveBeenCalledTimes(1);
  });

  it.each(both.flatMap(([tool, key]) => [
    [tool, 'a malformed offset', key, `/api/v2/${tool.replace('testrail_', '')}&offset=abc`, 'invalid_continuation'],
    [tool, 'an offset that does not advance', key, `/api/v2/${tool.replace('testrail_', '')}&limit=1&offset=0`, 'non_progress'],
  ] as const))('%s fails an aggregate whose continuation has %s as INVALID_RESPONSE', async (tool, _label, key, next, reason) => {
    const [first, second] = items(tool, key);
    const server = serve(linked(key, tool.replace('testrail_', ''), first, second, next));
    const payload = await all(tool, {}, server.fetch);
    expect(payload.error).toMatchObject({ code: 'INVALID_RESPONSE', reason });
    expect(payload.error).not.toHaveProperty('write_outcome');
    expect(payload).not.toHaveProperty('data');
    expect(server.fetch).toHaveBeenCalledTimes(1);
  });

  it.each(both.flatMap(([tool, key]) => [
    [tool, 'another endpoint and filter', key, '/api/v2/get_cases/999&suite_id=7&limit=1&offset=1'],
    [tool, 'another host', key, 'https://attacker.example/index.php?/api/v2/get_users&limit=1&offset=1'],
  ] as const))('%s follows a link naming %s only for its offset', async (tool, _label, key, next) => {
    const [first, second] = items(tool, key);
    const server = serve(linked(key, tool.replace('testrail_', ''), first, second, next));
    const controlled = tool === 'testrail_get_projects';
    // A stated page size, so a driver falling back to its own default is caught.
    const payload = await all(tool, controlled ? { page_size: 3 } : {}, server.fetch, controlled ? { is_completed: true } : undefined);
    expect(payload.data).toEqual([first, second]);
    expect(server.urls).toHaveLength(2);
    const [one, two] = server.urls.map((url) => new URL(url));
    // Same host and endpoint as the first request, the caller's filter kept, nothing
    // the link encoded beyond its offset.
    expect(two?.host).toBe(new URL(configuration.baseUrl).host);
    expect(two?.search.replace(/&(?:limit|offset)=\d+/gu, '')).toBe(one?.search.replace(/&(?:limit|offset)=\d+/gu, ''));
    expect(control(server.urls[1], 'offset')).toBe('1');
    // A controlled list keeps the caller's page size on every request; a response-driven
    // list takes the link's limit, here 1.
    expect(control(server.urls[1], 'limit')).toBe(controlled ? '3' : '1');
    expect(server.urls[1]).not.toMatch(/suite_id|get_cases|get_users|attacker/u);
    if (controlled) expect(server.urls[1]).toMatch(/[?&]is_completed=1(?:&|$)/u);
  });

  it.each(both)('%s describes an empty last page in page mode, and pages past an empty page in all mode', async (tool, key) => {
    const [first] = items(tool, key);
    const token = tool.replace('testrail_', '');
    const empty = { '0': { offset: 0, limit: 50, size: 0, _links: { next: null, prev: null }, [key]: [] } };
    const runtime = runtimeFor(serve(empty).fetch);
    try {
      const page = structured(await executeToolCall(registered(tool), pageFixture(manifestFor(tool)).input, { runtime, configuration }));
      expect(page.data).toEqual([]);
      expect(page.pagination).toEqual({
        mode: 'page', source: 'envelope', returned: 0, has_more: false, manual_continuation: false, next_action: 'none',
        limit: 50, offset: 0, driver: { size: 0, links: { next: null, prev: null } },
      });
    } finally { await runtime.shutdown(); }
    // An empty page that links on still advances (the link's offset is past the page), so
    // the aggregate follows it and returns what the next page holds.
    const onward = serve({
      '0': { offset: 0, limit: 1, size: 0, _links: { next: `/api/v2/${token}&limit=1&offset=1`, prev: null }, [key]: [] },
      '1': { offset: 1, limit: 1, size: 1, _links: { next: null, prev: null }, [key]: [first] },
    });
    const payload = await all(tool, {}, onward.fetch);
    expect(payload.data).toEqual([first]);
    expect(onward.fetch).toHaveBeenCalledTimes(2);
  });

  it.each(both)('%s fails an aggregate whose page answers an offset it was not asked for, as invalid_page', async (tool, key) => {
    const [first] = items(tool, key);
    // The driver expects the page at the offset it asked for (0) and refuses any other.
    const server = serve({ '0': { offset: 5, limit: 1, size: 1, _links: { next: null, prev: null }, [key]: [first] } });
    const payload = await all(tool, {}, server.fetch);
    expect(payload.error).toMatchObject({ code: 'INVALID_RESPONSE', reason: 'invalid_page' });
    expect(payload).not.toHaveProperty('data');
  });

  it('reports the start offset the caller asked for, and starts there', async () => {
    const [first, second] = items('testrail_get_projects', 'projects');
    const server = serve(linked('projects', 'get_projects', first, second));
    const payload = await all('testrail_get_projects', { start_offset: 1 }, server.fetch);
    expect(control(server.urls[0], 'offset')).toBe('1');
    expect(payload.data).toEqual([second]);
    expect(payload.pagination).toEqual({ mode: 'all', returned: 1, complete: true, start_offset: 1 });
  });

  it('holds an aggregate to the complete-result budget, refusing it whole', async () => {
    const [first, second] = items('testrail_get_projects', 'projects');
    const big = { ...second, name: 'x'.repeat(300) };
    const server = serve(linked('projects', 'get_projects', first, big));
    const runtime = runtimeFor(server.fetch);
    try {
      const result = await executeToolCall(registered('testrail_get_projects'), { _mcp: { pagination: 'all' } }, {
        runtime, configuration: { ...configuration, limits: { ...configuration.limits, max_result_bytes: 400 } },
      });
      expect(structured(result).error).toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
      expect(structured(result)).not.toHaveProperty('data');
      expect(server.fetch).toHaveBeenCalledTimes(2);
    } finally { await runtime.shutdown(); }
  });
});
