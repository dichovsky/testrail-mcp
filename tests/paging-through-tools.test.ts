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
    const body: unknown = fixture.expect.upstream_response.body;
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
 * second is the last. Which one is served depends only on the offset the driver asks for.
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
    const body = /[?&]offset=1(?:&|$)/u.test(url) ? pages.second : pages.first;
    return Promise.resolve(new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }));
  });
  return { first, second, next, fetch, urls };
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

const rows = inventory.map(({ tool, route, pagination }) => [tool, route, pagination.kind] as const);

describe('every paged list through the tool-call path', () => {
  it('covers the inventory\'s 24 paged lists, each with a known envelope key', () => {
    expect(rows).toHaveLength(24);
    expect(Object.keys(COLLECTION).sort()).toEqual(rows.map(([tool]) => tool).sort());
  });

  it.each(rows)('%s: page mode returns the first page and describes what follows it', async (tool, route, kind) => {
    const manifest = manifestFor(tool);
    const server = twoPages(tool, route, manifest);
    const runtime = runtimeFor(server.fetch);
    try {
      const result = await executeToolCall(registered(tool), pageFixture(manifest).input, { runtime, configuration });
      expect(result.isError, JSON.stringify(result.structuredContent)).toBeUndefined();
      const { data, pagination } = structured(result);
      expect(data).toEqual([server.first]);
      expect(server.fetch).toHaveBeenCalledTimes(1);
      // A controlled list offers the next page itself; a response-driven one takes no
      // caller offset, so only the bounded aggregate can follow its link.
      const controlled = kind === 'controlled';
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
      const { data, pagination } = structured(result);
      expect(data).toEqual([server.first, server.second]);
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
      expect(payload.error).toMatchObject({ code: 'PAGINATION_LIMIT' });
      expect(payload).not.toHaveProperty('data');
      // A read reports nothing about a write.
      expect(payload.error).not.toHaveProperty('write_outcome');
      // The first page was fetched and then withheld; the second was never asked for.
      expect(server.fetch).toHaveBeenCalledTimes(1);
    } finally { await runtime.shutdown(); }
  });
});

describe('each aggregate bound through a controlled and a response-driven list', () => {
  const bounded = [
    ['testrail_get_projects', 'get_projects'],
    ['testrail_get_groups', 'get_groups'],
  ] as const;

  it.each(bounded.flatMap(([tool, route]) => ([
    [tool, route, 'max_pages', 1],
    [tool, route, 'max_bytes', 8],
  ] as const)))('%s stops at %s', async (tool, route, bound, value) => {
    const manifest = manifestFor(tool);
    const server = twoPages(tool, route, manifest);
    const runtime = runtimeFor(server.fetch);
    try {
      const input = { ...allFixture(manifest).input, _mcp: { ...(allFixture(manifest).input._mcp as object), [bound]: value } };
      const result = await executeToolCall(registered(tool), input, { runtime, configuration });
      expect(structured(result).error).toMatchObject({ code: 'PAGINATION_LIMIT' });
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
      expect(structured(result).error).toMatchObject({ code: 'PAGINATION_LIMIT' });
      expect(structured(result)).not.toHaveProperty('data');
    } finally { await runtime.shutdown(); }
  });
});
