import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { TestRailClient } from '@dichovsky/testrail-api-client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConfiguration, type Configuration } from '../src/config/environment.js';
import { DEFAULT_LIMITS } from '../src/config/limits.js';
import { driverOptions, REQUEST_TIMEOUT_MS } from '../src/driver/configuration.js';
import { operationRegistry } from '../src/operations/catalog.js';
import type { Operation } from '../src/operations/registry.js';
import { createRuntime, type Runtime } from '../src/runtime/invocation.js';
import { executeToolCall } from '../src/transport/tool-call.js';
import { loadParameterManifests, type ParameterManifest } from './contracts/parameter-manifest.js';
import { materializeFiles, substituteTokens } from './contracts/uploads.js';

/*
 * R02: the fixture stand-in for host checks. It is started exactly as a tester starts it,
 * as `node scripts/fixture-testrail.mjs`, and the production tool pipeline is pointed at
 * it through its ordinary configuration, in-process, with the real driver making real
 * HTTP requests. The driver's rate limit is raised for these sweeps; its timeouts are not.
 * Every one of the 133 tools must get its fixture's reply, each reserved ID must produce
 * the outcome the client guide documents on every route the guide says it applies to,
 * every paged list must span the pages asked for, and credentials must never reach the
 * request log.
 */

const manifests = await loadParameterManifests();
const inventory = JSON.parse(await readFile(new URL('../docs/operation-inventory.json', import.meta.url), 'utf8')) as {
  operations: { tool: string; http_method: string; route: string; pagination: { kind: string } }[];
};
// Windows checkouts may carry CRLF line endings.
const guide = (await readFile(new URL('../docs/client-compatibility.md', import.meta.url), 'utf8')).replace(/\r\n/gu, '\n');
const DELAY_SCALE = 0.005;
const PAGES = 3;
const script = fileURLToPath(new URL('../scripts/fixture-testrail.mjs', import.meta.url));

/**
 * What each reserved ID must produce, written here rather than read from the stand-in:
 * the stand-in's table and the guide's are both held to it. `reply` starts the guide's
 * stand-in reply, `routes` names the routes it covers, and `outcome` lists what the
 * guide's outcome must say.
 */
const EXPECTED = [
  { id: 990404, name: 'notFound', code: 'NOT_FOUND', reply: '404', routes: 'pathId', outcome: ['`NOT_FOUND`'] },
  { id: 990400, name: 'rejected', code: 'UPSTREAM_ERROR', http: 400, reply: '400', routes: 'pathId', outcome: ['`UPSTREAM_ERROR`', '`http_status` 400'] },
  { id: 990401, name: 'unauthenticated', code: 'AUTHENTICATION_FAILED', reply: '401', routes: 'pathId', outcome: ['`AUTHENTICATION_FAILED`'] },
  { id: 990403, name: 'forbidden', code: 'PERMISSION_DENIED', reply: '403', routes: 'pathId', outcome: ['`PERMISSION_DENIED`'] },
  { id: 990500, name: 'failed', code: 'UPSTREAM_ERROR', http: 500, reply: '500', routes: 'sideEffects', outcome: ['`UPSTREAM_ERROR`', '`http_status` 500', '`write_outcome: "unknown"`'] },
  { id: 990001, name: 'drift', code: 'SCHEMA_DRIFT', reply: 'The entity', routes: 'driftable', outcome: ['`SCHEMA_DRIFT`'] },
  { id: 990002, name: 'unusable', code: 'INVALID_RESPONSE', reply: 'A JSON string', routes: 'jsonReads', outcome: ['`INVALID_RESPONSE`'] },
  { id: 990020, name: 'slow', code: 'UPSTREAM_ERROR', http: 408, reply: 'The reply after 20 seconds', routes: 'any', outcome: ['`UPSTREAM_ERROR`', '`http_status` 408', '`BUSY`'] },
  { id: 990045, name: 'slowPages', code: 'PAGINATION_LIMIT', reply: 'Each reply after 14 seconds, and a paged list of ten pages', routes: 'any', outcome: ['`PAGINATION_LIMIT`', '`max_duration`'] },
  { id: 990900, name: 'large', code: undefined, reply: 'A single list page of about 700 KB', routes: 'paged', outcome: ['within the default budgets'] },
  { id: 990901, name: 'oversized', code: 'RESPONSE_TOO_LARGE', reply: 'A single list page of about 3 MB', routes: 'paged', outcome: ['`RESPONSE_TOO_LARGE`', '`PAGINATION_LIMIT`', '`max_bytes`'] },
] as const;
const ID = Object.fromEntries(EXPECTED.map(({ name, id }) => [name, id])) as Record<(typeof EXPECTED)[number]['name'], number>;

interface Started { baseUrl: string; environment: Record<string, string>; reserved: Record<string, number> }
interface Logged { method: string; endpoint: string; tool: string | null; status: number; authorized: boolean; bytes: number; abandoned: boolean }
interface StandIn { baseUrl: string; environment: Record<string, string>; requests: Logged[]; close: () => Promise<void> }
const { startFixtureTestRail, DELAYS_MS, SLOW_PAGES } = (await import(new URL('../scripts/fixture-testrail.mjs', import.meta.url).href)) as {
  startFixtureTestRail: (options: { delayScale?: number; log?: string; onLogError?: (error: unknown) => void }) => Promise<StandIn>;
  DELAYS_MS: Record<number, number>;
  SLOW_PAGES: number;
};

let child: ChildProcess;
let started: Started;
let base: string;
let log: string;
let configuration: Configuration;
let runtime: Runtime;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'testrail-mcp-stand-in-'));
  log = join(base, 'requests.jsonl');
  await mkdir(join(base, 'uploads'));
  await mkdir(join(base, 'downloads'));
  await mkdir(join(base, 'staging'));
  child = spawn(process.execPath, [script, '--json', '--pages', String(PAGES), '--delay-scale', String(DELAY_SCALE), '--log', log],
    { stdio: ['ignore', 'pipe', 'inherit'] });
  const first = await new Promise<string>((resolve, reject) => {
    const lines = createInterface({ input: child.stdout ?? process.stdin });
    lines.once('line', resolve);
    child.once('exit', (code) => { reject(new Error(`stand-in exited with ${String(code)}`)); });
  });
  started = JSON.parse(first) as Started;
  configuration = await loadConfiguration({
    ...started.environment,
    TESTRAIL_MCP_UPLOAD_ROOTS: JSON.stringify([join(base, 'uploads')]),
    TESTRAIL_MCP_DOWNLOAD_DIR: join(base, 'downloads'),
  });
  runtime = createRuntime({
    // The production limiter allows 100 requests a minute; these sweeps make more.
    client: new TestRailClient({ ...driverOptions(configuration), rateLimiter: { maxRequests: 100_000, windowMs: 60_000 } }),
    limits: configuration.limits,
  });
});

afterAll(async () => {
  await runtime.shutdown();
  child.kill();
  await rm(base, { recursive: true, force: true });
});

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

function acceptedFor(tool: string) {
  const fixture = manifestFor(tool).cases.find(({ expect: outcome }) => outcome.kind === 'accepted');
  if (fixture?.expect.kind !== 'accepted') throw new Error(`${tool}: no accepted fixture`);
  return { ...fixture, expect: fixture.expect };
}

const call = (tool: string, input: unknown, on: Runtime = runtime, with_: Configuration = configuration) =>
  executeToolCall(registered(tool), input, { runtime: on, configuration: with_, stagingDirectory: () => Promise.resolve(join(base, 'staging')) });
const payload = (result: { structuredContent?: unknown }) => result.structuredContent as {
  data?: unknown; pagination?: Record<string, unknown>; warnings?: { code: string }[];
  error?: { code: string; write_outcome?: string; http_status?: number; reason?: string };
};

/** The names of a route's numeric path IDs, in path order. A plan entry's ID is a GUID. */
const pathIds = (tool: string): string[] =>
  [...(inventory.operations.find((candidate) => candidate.tool === tool)?.route ?? '').matchAll(/\{([a-z_]+)\}/gu)]
    .map(([, name = '']) => name).filter((name) => name !== 'entry_id');

/** The tool's accepted fixture input, with the path ID in `slot` set to `id`, and its files made. */
async function inputWith(tool: string, id: number, slot = 0): Promise<unknown> {
  const param = pathIds(tool)[slot];
  if (param === undefined) throw new Error(`${tool} has no path ID ${String(slot)}`);
  const paths = await materializeFiles(manifestFor(tool), join(base, 'uploads'));
  const input = structuredClone(substituteTokens(acceptedFor(tool).input, paths)) as Record<string, unknown>;
  input[param] = id;
  return input;
}

/** Each route with each of its numeric path IDs: a reserved ID works in any of them. */
const slots = (routes: { tool: string }[]): [string, string, number][] =>
  routes.flatMap(({ tool }) => pathIds(tool).map((param, slot): [string, string, number] => [tool, param, slot]));

const replyKind = (tool: string) => acceptedFor(tool).expect.upstream_response.kind;
const withPathId = inventory.operations.filter(({ route }) => route.includes('{'));
const reads = withPathId.filter(({ http_method: method }) => method === 'GET');
const writes = withPathId.filter(({ http_method: method }) => method === 'POST');
const jsonReads = reads.filter(({ tool }) => replyKind(tool) === 'json');
// A get_bdds row is an open record, so no field of it can drift.
const driftable = jsonReads.filter(({ tool }) => tool !== 'testrail_get_bdds');
const pagedWithPathId = withPathId.filter(({ pagination }) => pagination.kind !== 'none');
const paged = inventory.operations.filter(({ pagination }) => pagination.kind !== 'none');
// The routes that change TestRail or start a report: every write, and the two report runs.
const sideEffects = withPathId.filter(({ tool }) => registered(tool).effects.testRail !== 'read');
const reportRuns = sideEffects.filter(({ http_method: method }) => method === 'GET');

/** How the guide names each set of routes, counted from the inventory. */
const ROUTES = {
  pathId: `the ${String(withPathId.length)} routes that take a path ID`,
  sideEffects: `the ${String(sideEffects.length)} among them that change TestRail or start a report: ${String(writes.length)} writes and ${String(reportRuns.length)} report runs`,
  driftable: `the ${String(driftable.length)} GET routes that return JSON records`,
  jsonReads: `all ${String(jsonReads.length)} GET routes that return JSON`,
  any: 'any route with a path ID',
  paged: `the ${String(pagedWithPathId.length)} paged lists that take a path ID`,
} as const;

describe('the stand-in\'s reserved IDs', () => {
  it('are the IDs the guide documents, each with its reply, its routes and the outcome it names', () => {
    expect(started.reserved).toEqual(ID);
    expect(inventory.operations).toHaveLength(133);
    expect(sideEffects.length).toBe(writes.length + reportRuns.length);
    expect(guide).toContain(`Reserved IDs work as any numeric path ID of ${ROUTES.pathId}.`);
    const rows = new Map([...guide.matchAll(/^\| `(99\d{4})` \|(.*)\|$/gmu)].map(([, id = '', cells = '']) => [Number(id), cells.split('|').map((cell) => cell.trim())]));
    expect([...rows.keys()].sort()).toEqual(EXPECTED.map(({ id }) => id).sort());
    for (const { id, reply, routes, outcome } of EXPECTED) {
      const [replyCell = '', routesCell = '', outcomeCell = ''] = rows.get(id) ?? [];
      expect(replyCell.startsWith(reply), `${String(id)} reply: ${replyCell}`).toBe(true);
      expect(routesCell.startsWith(ROUTES[routes]), `${String(id)} routes: ${routesCell}`).toBe(true);
      for (const fragment of outcome) expect(outcomeCell, `${String(id)} outcome`).toContain(fragment);
    }
  });

  it.each(slots(withPathId))('turn %s into each error through its %s, with no data', async (tool, _param, slot) => {
    for (const expected of EXPECTED.filter(({ name: candidate }) => ['notFound', 'rejected', 'unauthenticated', 'forbidden'].includes(candidate))) {
      const result = await call(tool, await inputWith(tool, ID[expected.name], slot));
      const status = 'http' in expected ? { http_status: expected.http } : {};
      expect(payload(result).error, `${tool} ${expected.name}`).toMatchObject({ code: expected.code, ...status });
      expect(payload(result)).not.toHaveProperty('data');
    }
  });

  it.each(slots(sideEffects))('fails %s through its %s as UPSTREAM_ERROR of unknown outcome on a 500', async (tool, _param, slot) => {
    const result = await call(tool, await inputWith(tool, ID.failed, slot));
    expect(payload(result).error).toMatchObject({ code: 'UPSTREAM_ERROR', write_outcome: 'unknown', http_status: 500 });
  });

  it.each(slots(driftable))('drifts %s through its %s: the data, with a SCHEMA_DRIFT warning', async (tool, _param, slot) => {
    const result = await call(tool, await inputWith(tool, ID.drift, slot));
    expect(result.isError, JSON.stringify(payload(result).error)).toBeUndefined();
    expect(payload(result).warnings?.map(({ code }) => code)).toContain('SCHEMA_DRIFT');
    expect(payload(result).data).toBeDefined();
  });

  it.each(slots(jsonReads))('makes %s unusable through its %s: INVALID_RESPONSE with no data', async (tool, _param, slot) => {
    const result = await call(tool, await inputWith(tool, ID.unusable, slot));
    expect(payload(result).error?.code).toBe('INVALID_RESPONSE');
    expect(payload(result)).not.toHaveProperty('data');
  });

  it.each(slots(pagedWithPathId))('sizes %s through its %s: a large result within the budgets; an oversized one refused whole', async (tool, _param, slot) => {
    const all = (input: unknown) => ({ ...(input as object), _mcp: { pagination: 'all' } });
    for (const input of [await inputWith(tool, ID.large, slot), all(await inputWith(tool, ID.large, slot))]) {
      const large = await call(tool, input);
      expect(large.isError, JSON.stringify(payload(large).error)).toBeUndefined();
      expect(Buffer.byteLength(JSON.stringify(payload(large).data))).toBeGreaterThan(500 * 1024);
    }
    // A page is refused as too large; "all" stops at its byte budget first.
    const oversized = await call(tool, await inputWith(tool, ID.oversized, slot));
    expect(payload(oversized).error?.code).toBe('RESPONSE_TOO_LARGE');
    expect(payload(oversized)).not.toHaveProperty('data');
    const oversizedAll = await call(tool, all(await inputWith(tool, ID.oversized, slot)));
    expect(payload(oversizedAll).error).toMatchObject({ code: 'PAGINATION_LIMIT', reason: 'max_bytes' });
    expect(payload(oversizedAll)).not.toHaveProperty('data');
  });

  it('holds each delay where the driver\'s limits give the outcome the guide names', async () => {
    // The guide's numbers, written here: a 20-second reply, and ten pages of 14 seconds.
    expect(DELAYS_MS).toEqual({ [ID.slow]: 20_000, [ID.slowPages]: 14_000 });
    expect(SLOW_PAGES).toBe(10);
    const slow = DELAYS_MS[ID.slow] ?? 0;
    const slowPage = DELAYS_MS[ID.slowPages] ?? Infinity;
    // A 20-second reply outlasts the request timeout; a 14-second page does not.
    expect(slow).toBeGreaterThan(REQUEST_TIMEOUT_MS);
    expect(slowPage).toBeLessThan(REQUEST_TIMEOUT_MS);
    // "all" passes the 45-second budget on the fourth page, well before the last.
    const budget = DEFAULT_LIMITS.max_all_duration_ms;
    expect(3 * slowPage).toBeLessThan(budget);
    expect(4 * slowPage).toBeGreaterThan(budget);
    // And the list really spans ten pages, of any size.
    for (const size of [1, 7]) {
      const last = await call('testrail_get_cases', { project_id: ID.slowPages, query: { limit: size, offset: 9 * size } });
      expect(payload(last).pagination, `size ${String(size)}`).toMatchObject({ returned: size, has_more: false });
      const before = await call('testrail_get_cases', { project_id: ID.slowPages, query: { limit: size, offset: 8 * size } });
      expect(payload(before).pagination, `size ${String(size)}`).toMatchObject({ returned: size, has_more: true });
    }
  });

  it('delays a slow reply, and each page of a slow-pages list, by the scaled delay', async () => {
    let begun = performance.now();
    expect((await call('testrail_get_project', { project_id: ID.slow })).isError).toBeUndefined();
    expect(performance.now() - begun).toBeGreaterThanOrEqual(20_000 * DELAY_SCALE * 0.9);
    begun = performance.now();
    const page = await call('testrail_get_cases', { project_id: ID.slowPages });
    expect(page.isError).toBeUndefined();
    expect(performance.now() - begun).toBeGreaterThanOrEqual(14_000 * DELAY_SCALE * 0.9);
    expect(payload(page).pagination).toMatchObject({ has_more: true });
  });

  it('stops a complete read of a slow-pages list at its duration budget, with no partial data', async () => {
    // The default budget is 45 seconds, which the fourth 14-second page passes; the same
    // budget, scaled like the delays, stops the scaled list the same way.
    const result = await call('testrail_get_cases', {
      project_id: ID.slowPages, _mcp: { pagination: 'all', max_duration_ms: Math.round(45_000 * DELAY_SCALE) },
    });
    expect(payload(result).error).toMatchObject({ code: 'PAGINATION_LIMIT', reason: 'max_duration' });
    expect(payload(result)).not.toHaveProperty('data');
  });

  it('turns a 20-second reply into the driver\'s 15-second timeout, while four such calls hold every slot', async () => {
    const realTime = await startFixtureTestRail({ delayScale: 1 });
    const settings = await loadConfiguration({ ...realTime.environment, TESTRAIL_MCP_UPLOAD_ROOTS: '[]', TESTRAIL_MCP_DOWNLOAD_DIR: join(base, 'downloads') });
    const production = createRuntime({ client: new TestRailClient(driverOptions(settings)), limits: settings.limits });
    try {
      const begun = performance.now();
      const timed = (promise: Promise<{ structuredContent?: unknown }>) => promise.then((result) => ({ error: payload(result).error, after: performance.now() - begun }));
      const results = await Promise.all(Array.from({ length: 5 }, () => timed(call('testrail_get_project', { project_id: ID.slow }, production, settings))));
      const busy = results.filter(({ error }) => error?.code === 'BUSY');
      const timeouts = results.filter(({ error }) => error?.code === 'UPSTREAM_ERROR' && error.http_status === 408);
      expect(busy).toHaveLength(1);
      expect(busy[0]?.after).toBeLessThan(5_000);
      expect(timeouts).toHaveLength(4);
      for (const { after } of timeouts) expect(after).toBeGreaterThanOrEqual(14_900);
    } finally {
      await production.shutdown();
      await realTime.close();
    }
  }, 60_000);
});

describe('the fixture stand-in serves the whole catalog', () => {
  it('prints the synthetic environment the client needs', () => {
    expect(started.environment).toEqual({
      TESTRAIL_BASE_URL: started.baseUrl,
      TESTRAIL_ALLOW_INSECURE: 'true',
      TESTRAIL_ALLOW_PRIVATE_HOSTS: 'true',
      TESTRAIL_EMAIL: 'fixture@example.invalid',
      TESTRAIL_API_KEY: 'fixture-api-key',
    });
    expect(started.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
  });

  it('is launched, per the guide, with every variable it prints that the examples do not forward', () => {
    const step = /^2\. \*\*Launch the client with those variables\.\*\*(.*)$/mu.exec(guide)?.[1] ?? '';
    // The examples forward the five required variables; the stand-in also needs its opt-ins.
    for (const key of [...Object.keys(started.environment).filter((name) => name.startsWith('TESTRAIL_ALLOW_')), 'TESTRAIL_MCP_UPLOAD_ROOTS', 'TESTRAIL_MCP_DOWNLOAD_DIR']) {
      expect(step, key).toContain(`\`${key}\``);
    }
    expect(Object.keys(started.environment).filter((name) => name.startsWith('TESTRAIL_ALLOW_')).sort()).toEqual(['TESTRAIL_ALLOW_INSECURE', 'TESTRAIL_ALLOW_PRIVATE_HOSTS']);
  });

  it('serves every path the fixtures show the driver sending', async () => {
    const authorization = `Basic ${Buffer.from(`${started.environment.TESTRAIL_EMAIL ?? ''}:${started.environment.TESTRAIL_API_KEY ?? ''}`).toString('base64')}`;
    const sent = manifests.flatMap(({ cases }) => cases.flatMap(({ expect: outcome }) => (outcome.kind === 'accepted' ? [outcome.wire] : [])));
    expect(sent.length).toBeGreaterThan(133);
    const refused: string[] = [];
    for (const { method, endpoint } of sent) {
      const response = await fetch(`${started.baseUrl}/index.php?/api/v2/${endpoint}`, { method, headers: { authorization } });
      await response.arrayBuffer();
      if (response.status !== 200) refused.push(`${method} ${endpoint}: ${String(response.status)}`);
    }
    expect(refused).toEqual([]);
  });

  const calls = operationRegistry.entries.map(({ tool }) => [tool] as const);
  it('covers all 133 tools', () => { expect(calls).toHaveLength(133); });

  it.each(calls)('%s answers with its fixture\'s reply, and no warning', async (tool) => {
    const fixture = acceptedFor(tool);
    const paths = await materializeFiles(manifestFor(tool), join(base, 'uploads'));
    const result = await call(tool, substituteTokens(fixture.input, paths));
    expect(result.isError, JSON.stringify(payload(result).error)).toBeUndefined();
    expect(payload(result).warnings).toBeUndefined();
    const { driver_result: driven } = fixture.expect;
    const kind = inventory.operations.find((operation) => operation.tool === tool)?.pagination.kind;
    if (kind === 'none' && driven.kind === 'json') expect(payload(result).data).toEqual(driven.value);
    if (kind !== 'none') {
      // A generated page repeats the fixture's first item under new IDs.
      const withoutId = (item: unknown) => Object.fromEntries(Object.entries(item as object).filter(([key]) => key !== 'id'));
      const first = driven.kind === 'json' ? (driven.value as { items?: unknown[] }).items?.[0] : undefined;
      expect(first, 'the fixture\'s first item').toBeDefined();
      const items = payload(result).data as unknown[];
      expect(items.length).toBeGreaterThan(0);
      for (const item of items) expect(withoutId(item)).toEqual(withoutId(first));
    }
    // A download holds exactly the fixture's bytes.
    if (driven.kind === 'binary') expect(await readFile((payload(result).data as { file_path: string }).file_path, 'utf8')).toBe(driven.utf8);
  });
});

describe('the stand-in\'s paged lists', () => {
  /** The tool's accepted fixture input without its paging or aggregate controls. */
  const plain = (tool: string): Record<string, unknown> => {
    const input = structuredClone(acceptedFor(tool).input) as Record<string, unknown>;
    delete input._mcp;
    if (typeof input.query === 'object' && input.query !== null) {
      input.query = Object.fromEntries(Object.entries(input.query).filter(([key]) => key !== 'limit' && key !== 'offset'));
    }
    return input;
  };

  it.each(paged.map(({ tool, pagination }) => [tool, pagination.kind]))(`spans %s (%s) over ${String(PAGES)} pages, of a length no page size changes`, async (tool, kind) => {
    const controlled = kind === 'controlled';
    const first = await call(tool, plain(tool));
    expect(first.isError, JSON.stringify(payload(first).error)).toBeUndefined();
    expect(payload(first).pagination).toMatchObject(controlled
      ? { mode: 'page', has_more: true, next_action: 'page', next_offset: 50 }
      : { mode: 'page', has_more: true, next_action: 'all', manual_continuation: false });
    const all = await call(tool, { ...plain(tool), _mcp: { pagination: 'all' } });
    expect(all.isError, JSON.stringify(payload(all).error)).toBeUndefined();
    expect(payload(all).pagination).toMatchObject({ mode: 'all', complete: true, returned: (controlled ? 50 : 2) * PAGES });
    if (controlled) {
      // Read in one large page, the same list is no longer.
      const whole = await call(tool, { ...plain(tool), query: { ...(plain(tool).query as object | undefined), limit: 250 } });
      expect(payload(whole).pagination).toMatchObject({ returned: 50 * PAGES, has_more: false });
    }
  });

  it('logs every request, with its method, endpoint and status, without credentials', async () => {
    const text = await readFile(log, 'utf8');
    const entries = text.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(entries.length).toBeGreaterThan(133);
    expect(entries.every(({ authorized }) => authorized === true)).toBe(true);
    for (const entry of entries) expect(Object.keys(entry).sort()).toEqual(['abandoned', 'authorized', 'bytes', 'endpoint', 'method', 'status', 'tool']);
    expect(entries).toContainEqual(expect.objectContaining({ method: 'GET', endpoint: `get_project/${String(ID.notFound)}`, tool: 'testrail_get_project', status: 404, abandoned: false }));
    expect(entries).toContainEqual(expect.objectContaining({ method: 'POST', endpoint: `add_case/${String(ID.failed)}`, tool: 'testrail_add_case', status: 500, abandoned: false }));
    for (const secret of ['fixture-api-key', 'fixture@example.invalid', 'Basic ', Buffer.from('fixture@example.invalid:fixture-api-key').toString('base64')]) {
      expect(text).not.toContain(secret);
    }
  });

  it('logs a request whose client gave up before the reply as abandoned', async () => {
    const scaled = await startFixtureTestRail({ delayScale: 0.01 });
    try {
      const endpoint = `${scaled.baseUrl}/index.php?/api/v2/get_project/`;
      await expect(fetch(`${endpoint}${String(ID.slow)}`, { signal: AbortSignal.timeout(50) })).rejects.toThrow();
      await (await fetch(`${endpoint}1`)).arrayBuffer();
      await vi.waitFor(() => { expect(scaled.requests).toHaveLength(2); }, { timeout: 5_000 });
      expect(scaled.requests.map(({ endpoint: path, status, abandoned }) => [path, status, abandoned])).toEqual(expect.arrayContaining([
        [`get_project/${String(ID.slow)}`, 200, true],
        ['get_project/1', 200, false],
      ]));
    } finally {
      await scaled.close();
    }
  });

  it.skipIf(process.platform !== 'linux')('still answers when a log write fails once serving, then stops and says why', async () => {
    // /dev/full takes the empty write the start check makes, and refuses every line.
    const failures: unknown[] = [];
    const inProcess = await startFixtureTestRail({ log: '/dev/full', onLogError: (error) => { failures.push(error); } });
    const upstream = acceptedFor('testrail_get_project').expect.upstream_response;
    try {
      const response = await fetch(`${inProcess.baseUrl}/index.php?/api/v2/get_project/1`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(upstream.kind === 'json' ? upstream.body : undefined);
      await vi.waitFor(() => { expect(failures).toHaveLength(1); });
      expect(failures[0]).toMatchObject({ code: 'ENOSPC' });
    } finally {
      await inProcess.close();
    }
    const cli = spawn(process.execPath, [script, '--json', '--log', '/dev/full'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    cli.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    const exited = new Promise<number | null>((resolve) => { cli.once('exit', resolve); });
    const line = await new Promise<string>((resolve) => { createInterface({ input: cli.stdout ?? process.stdin }).once('line', resolve); });
    const answered = await fetch(`${(JSON.parse(line) as Started).baseUrl}/index.php?/api/v2/get_project/1`);
    expect(answered.status).toBe(200);
    await answered.arrayBuffer();
    expect(await exited).toBe(1);
    expect(stderr).toContain('Cannot write the request log /dev/full');
  });

  it('refuses a request log it cannot write, before serving', async () => {
    const missing = join(base, 'missing', 'requests.jsonl');
    await expect(startFixtureTestRail({ log: missing })).rejects.toThrow(/Cannot write the request log/u);
    await expect(promisify(execFile)(process.execPath, [script, '--log', missing])).rejects.toMatchObject({
      code: 1, stderr: expect.stringContaining('Cannot write the request log') as unknown,
    });
  });
});
