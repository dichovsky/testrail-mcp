import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { TestRailClient } from '@dichovsky/testrail-api-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfiguration, type Configuration } from '../src/config/environment.js';
import { driverOptions } from '../src/driver/configuration.js';
import { operationRegistry } from '../src/operations/catalog.js';
import type { Operation } from '../src/operations/registry.js';
import { createRuntime, type Runtime } from '../src/runtime/invocation.js';
import { executeToolCall } from '../src/transport/tool-call.js';
import { loadParameterManifests, type ParameterManifest } from './contracts/parameter-manifest.js';
import { materializeFiles, substituteTokens } from './contracts/uploads.js';

/*
 * R02: the fixture stand-in for host checks. It is started exactly as a tester starts it,
 * as `node scripts/fixture-testrail.mjs`, and the production server is pointed at it
 * through its ordinary configuration, with the real driver making real HTTP requests.
 * Every one of the 133 tools must work against it, and each reserved ID must produce the
 * outcome the client guide documents. Credentials must never reach its request log.
 */

const manifests = await loadParameterManifests();
const DELAY_SCALE = 0.005;
const PAGES = 3;

interface Started { baseUrl: string; environment: Record<string, string>; reserved: Record<string, number> }

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
  child = spawn(process.execPath, [
    new URL('../scripts/fixture-testrail.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, '$1'),
    '--json', '--pages', String(PAGES), '--delay-scale', String(DELAY_SCALE), '--log', log,
  ], { stdio: ['ignore', 'pipe', 'inherit'] });
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
    // The production limiter allows 100 requests a minute; this sweep makes more.
    client: new TestRailClient({ ...driverOptions(configuration), rateLimiter: { maxRequests: 10_000, windowMs: 60_000 } }),
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

const call = (tool: string, input: unknown) => executeToolCall(registered(tool), input, {
  runtime, configuration, stagingDirectory: () => Promise.resolve(join(base, 'staging')),
});
const payload = (result: { structuredContent?: unknown }) => result.structuredContent as {
  data?: unknown; pagination?: Record<string, unknown>; warnings?: { code: string }[];
  error?: { code: string; write_outcome?: string; http_status?: number };
};

describe('the fixture stand-in serves the whole catalog', () => {
  it('prints the synthetic environment the client needs, and its reserved IDs', () => {
    expect(started.environment).toEqual({
      TESTRAIL_BASE_URL: started.baseUrl,
      TESTRAIL_ALLOW_INSECURE: 'true',
      TESTRAIL_ALLOW_PRIVATE_HOSTS: 'true',
      TESTRAIL_EMAIL: 'fixture@example.invalid',
      TESTRAIL_API_KEY: 'fixture-api-key',
    });
    expect(started.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    expect(Object.keys(started.reserved).sort()).toEqual([
      'drift', 'failed', 'forbidden', 'large', 'notFound', 'oversized', 'rejected', 'slow', 'stalled', 'unauthenticated', 'unusable',
    ]);
  });

  const calls = operationRegistry.entries.map((operation) => {
    const fixture = manifestFor(operation.tool).cases.find(({ expect: outcome }) => outcome.kind === 'accepted');
    if (fixture === undefined) throw new Error(`${operation.tool}: no accepted fixture`);
    return [operation.tool, fixture.id, fixture] as const;
  });

  it('covers all 133 tools', () => { expect(calls).toHaveLength(133); });

  it('serves every path the fixtures show the driver sending', async () => {
    const authorization = `Basic ${Buffer.from(`${started.environment.TESTRAIL_EMAIL ?? ''}:${started.environment.TESTRAIL_API_KEY ?? ''}`).toString('base64')}`;
    const sent = manifests.flatMap(({ cases }) => cases.flatMap(({ expect: outcome }) => (outcome.kind === 'accepted' && outcome.wire !== undefined ? [outcome.wire] : [])));
    expect(sent.length).toBeGreaterThan(133);
    const refused: string[] = [];
    for (const { method, endpoint } of sent) {
      const response = await fetch(`${started.baseUrl}/index.php?/api/v2/${endpoint}`, { method, headers: { authorization } });
      await response.arrayBuffer();
      if (response.status !== 200) refused.push(`${method} ${endpoint}: ${String(response.status)}`);
    }
    expect(refused).toEqual([]);
  });

  it.each(calls)('%s answers its fixture call (%s)', async (tool, _id, fixture) => {
    const paths = await materializeFiles(manifestFor(tool), join(base, 'uploads'));
    const result = await call(tool, substituteTokens(fixture.input, paths));
    expect(result.isError, JSON.stringify(result.structuredContent)).toBeUndefined();
  });
});

describe('the stand-in\'s scenarios', () => {
  it.each([
    ['notFound', 'NOT_FOUND'],
    ['forbidden', 'PERMISSION_DENIED'],
    ['unauthenticated', 'AUTHENTICATION_FAILED'],
    ['rejected', 'UPSTREAM_ERROR'],
    ['unusable', 'INVALID_RESPONSE'],
  ] as const)('reserved %s answers a read with %s and no data', async (name, code) => {
    const result = await call('testrail_get_project', { project_id: started.reserved[name] });
    expect(result.isError).toBe(true);
    expect(payload(result).error?.code).toBe(code);
    expect(payload(result)).not.toHaveProperty('data');
  });

  it('reserved failed answers a write with UPSTREAM_ERROR of unknown outcome', async () => {
    const result = await call('testrail_add_section', { project_id: started.reserved.failed, body: { name: 'Stand-in' } });
    expect(payload(result).error).toMatchObject({ code: 'UPSTREAM_ERROR', write_outcome: 'unknown', http_status: 500 });
  });

  it('reserved drift answers with the data and an advisory warning', async () => {
    const result = await call('testrail_get_project', { project_id: started.reserved.drift });
    expect(result.isError).toBeUndefined();
    expect(payload(result).data).toMatchObject({ id: 7 });
    expect(payload(result).warnings?.map(({ code }) => code)).toContain('SCHEMA_DRIFT');
  });

  it.each([['slow', 20_000], ['stalled', 70_000]] as const)('reserved %s delays its reply by the scaled %i ms', async (name, delay) => {
    const begun = performance.now();
    const result = await call('testrail_get_project', { project_id: started.reserved[name] });
    expect(result.isError).toBeUndefined();
    expect(performance.now() - begun).toBeGreaterThanOrEqual(delay * DELAY_SCALE * 0.9);
  });

  it('reserved rejected carries TestRail\'s 400 as the upstream status', async () => {
    const result = await call('testrail_get_project', { project_id: started.reserved.rejected });
    expect(payload(result).error).toMatchObject({ code: 'UPSTREAM_ERROR', http_status: 400 });
  });

  it('reserved large answers a page within the budgets; oversized exceeds them', async () => {
    const large = await call('testrail_get_cases', { project_id: started.reserved.large });
    expect(large.isError, JSON.stringify(payload(large).error)).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(payload(large).data))).toBeGreaterThan(500 * 1024);
    const oversized = await call('testrail_get_cases', { project_id: started.reserved.oversized });
    expect(payload(oversized).error?.code).toBe('RESPONSE_TOO_LARGE');
  });

  it(`spans every paged list over ${PAGES} pages, followed to the end in all mode`, async () => {
    const first = await call('testrail_get_projects', {});
    expect(payload(first).pagination).toMatchObject({ mode: 'page', has_more: true, next_action: 'page', next_offset: 50 });
    const all = await call('testrail_get_projects', { _mcp: { pagination: 'all' } });
    expect(payload(all).pagination).toMatchObject({ mode: 'all', complete: true });
    const pages = (JSON.parse(`[${(await readFile(log, 'utf8')).trim().split('\n').join(',')}]`) as { tool: string; endpoint: string }[])
      .filter(({ tool, endpoint }) => tool === 'testrail_get_projects' && endpoint.includes('offset='));
    expect(pages.length).toBeGreaterThanOrEqual(PAGES);
    expect((payload(all).data as unknown[]).length).toBe((payload(all).pagination?.returned as number));
    // A response-driven list continues only through all mode.
    const groups = await call('testrail_get_groups', {});
    expect(payload(groups).pagination).toMatchObject({ has_more: true, next_action: 'all', manual_continuation: false });
    const allGroups = await call('testrail_get_groups', { _mcp: { pagination: 'all' } });
    expect(payload(allGroups).pagination).toMatchObject({ mode: 'all', complete: true, returned: 2 * PAGES });
  });

  it('logs every request without credentials', async () => {
    const text = await readFile(log, 'utf8');
    const entries = text.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(entries.length).toBeGreaterThan(133);
    expect(entries.every(({ authorized }) => authorized === true)).toBe(true);
    for (const secret of ['fixture-api-key', 'fixture@example.invalid', 'Basic ', Buffer.from('fixture@example.invalid:fixture-api-key').toString('base64')]) {
      expect(text).not.toContain(secret);
    }
  });
});
