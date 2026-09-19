import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TestRailClient } from '@dichovsky/testrail-api-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfiguration, type Configuration } from '../../src/config/environment.js';
import { createStagingArea, type StagingArea } from '../../src/files/staging.js';
import { operationRegistry } from '../../src/operations/catalog.js';
import { createRuntime } from '../../src/runtime/invocation.js';
import { executeToolCall } from '../../src/transport/tool-call.js';
import { describeBody } from '../contracts/uploads.js';

const FEATURE = '@APP-1\nFeature: Users cannot login with invalid credentials\n';
const CASE = {
  id: 2136, title: 'Users cannot login with invalid credentials', section_id: 188,
  created_by: 1, created_on: 1653052591, updated_by: 1, updated_on: 1653052591, suite_id: 12,
};

let base: string;
let roots: string;
let outside: string;
let configuration: Configuration;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'testrail-mcp-t03-'));
  roots = join(base, 'roots');
  outside = join(base, 'outside');
  await mkdir(roots);
  await mkdir(outside);
  await writeFile(join(roots, 'login.feature'), FEATURE, 'utf8');
  await writeFile(join(outside, 'login.feature'), FEATURE, 'utf8');
  configuration = await loadConfiguration({
    TESTRAIL_BASE_URL: 'https://bdd.testrail.io',
    TESTRAIL_EMAIL: 'user@example.com',
    TESTRAIL_API_KEY: 'synthetic',
    TESTRAIL_MCP_UPLOAD_ROOTS: JSON.stringify([roots]),
    TESTRAIL_MCP_DOWNLOAD_DIR: base,
  });
});

afterAll(async () => { await rm(base, { recursive: true, force: true }); });

function operation(tool: string) {
  const found = operationRegistry.get(tool);
  if (found === undefined) throw new Error(`Missing registration: ${tool}`);
  return found;
}

function client(respond: () => Promise<Response>, calls: { body: unknown }[] = []) {
  return new TestRailClient({
    baseUrl: configuration.baseUrl, email: configuration.email, apiKey: configuration.apiKey,
    registerProcessHandlers: false, maxRetries: 0,
    dnsLookup: () => Promise.resolve([{ address: '203.0.113.10', family: 4 }]),
    fetch: (_target, init) => { calls.push({ body: init?.body }); return respond(); },
  });
}

async function staging(): Promise<StagingArea> {
  return createStagingArea(base);
}

/*
 * The fixtures drive the registration with a staged copy already in hand. What is left
 * to prove is the half the transport owns: that the copy comes from inside the
 * configured roots, that its bytes are what reaches the wire, and that it never
 * outlives the call, on the failing path as much as the succeeding one.
 */
describe('T03 feature-file uploads through the transport', () => {
  it('stages a file inside an allowed root, uploads its bytes and leaves nothing behind', async () => {
    const calls: { body: unknown }[] = [];
    const area = await staging();
    const runtime = createRuntime({
      client: client(() => Promise.resolve(new Response(JSON.stringify(CASE), { headers: { 'content-type': 'application/json' } })), calls),
      limits: configuration.limits,
    });
    try {
      const result = await executeToolCall(operation('testrail_add_bdd'), {
        section_id: 188, file_path: join(roots, 'login.feature'), filename: 'login.feature', content_type: 'text/plain',
      }, { runtime, configuration, stagingDirectory: () => Promise.resolve(area.directory) });

      expect(result.isError).toBeUndefined();
      expect((result.structuredContent as { data: unknown }).data).toEqual(CASE);
      // The part carries the caller's filename and media type, and the file's bytes.
      expect(await describeBody(calls[0]?.body)).toEqual([
        { name: 'attachment', filename: 'login.feature', content_type: 'text/plain', utf8: FEATURE },
      ]);
      // Capacity, and with it the staged copy, is held until the call settles rather
      // than until its result is returned, so the drain is what proves disposal.
      await runtime.shutdown();
      expect(await readdir(area.directory)).toEqual(['owner.json']);
    } finally {
      await runtime.shutdown();
      await area.dispose();
    }
  });

  it('refuses a file outside the configured upload roots without dispatching', async () => {
    const calls: { body: unknown }[] = [];
    const area = await staging();
    const runtime = createRuntime({
      client: client(() => Promise.resolve(new Response('{}', { headers: { 'content-type': 'application/json' } })), calls),
      limits: configuration.limits,
    });
    try {
      const result = await executeToolCall(operation('testrail_add_bdd'), {
        section_id: 188, file_path: join(outside, 'login.feature'), filename: 'login.feature',
      }, { runtime, configuration, stagingDirectory: () => Promise.resolve(area.directory) });

      expect(result.isError).toBe(true);
      const { error } = result.structuredContent as { error: { code: string; write_outcome?: string } };
      expect(error.code).toBe('FILE_ACCESS_DENIED');
      // Nothing was sent, so the caller can be told the write never started.
      expect(error.write_outcome).toBe('not_started');
      expect(calls).toEqual([]);
      expect(await readdir(area.directory)).toEqual(['owner.json']);
    } finally {
      await runtime.shutdown();
      await area.dispose();
    }
  });

  it('disposes the staged copy when the upload itself fails', async () => {
    const area = await staging();
    const runtime = createRuntime({
      client: client(() => Promise.resolve(new Response('upstream failure', { status: 500 }))),
      limits: configuration.limits,
    });
    try {
      const result = await executeToolCall(operation('testrail_update_bdd'), {
        case_id: 2133, file_path: join(roots, 'login.feature'), filename: 'login.feature',
      }, { runtime, configuration, stagingDirectory: () => Promise.resolve(area.directory) });

      expect(result.isError).toBe(true);
      const { error } = result.structuredContent as { error: { code: string; write_outcome?: string } };
      expect(error.code).toBe('UPSTREAM_ERROR');
      // The request was sent and no usable answer came back, so the outcome is unknown.
      expect(error.write_outcome).toBe('unknown');
      await runtime.shutdown();
      expect(await readdir(area.directory)).toEqual(['owner.json']);
    } finally {
      await runtime.shutdown();
      await area.dispose();
    }
  });
});

describe('T03 reads that are not JSON objects', () => {
  it('returns a BDD scenario as the text it is, empty string included', async () => {
    for (const text of [FEATURE, '']) {
      const runtime = createRuntime({
        client: client(() => Promise.resolve(new Response(text, { headers: { 'content-type': 'text/plain' } }))),
        limits: configuration.limits,
      });
      try {
        const result = await executeToolCall(operation('testrail_get_bdd'), { case_id: 2133 }, { runtime, configuration });
        expect(result.isError).toBeUndefined();
        expect((result.structuredContent as { data: unknown }).data).toBe(text);
      } finally { await runtime.shutdown(); }
    }
  });

  it('tells the caller a shared-step history page cannot be continued by offset', async () => {
    const body = {
      offset: 0, limit: 250, size: 1,
      _links: { next: '/api/v2/get_shared_step_history/1&limit=250&offset=250', prev: null },
      step_history: [{ id: '1', timestamp: 1389968184, user_id: '4', title: 'Shared Steps 1' }],
    };
    const runtime = createRuntime({
      client: client(() => Promise.resolve(new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }))),
      limits: configuration.limits,
    });
    try {
      const result = await executeToolCall(operation('testrail_get_shared_step_history'), { shared_step_id: 1 }, { runtime, configuration });
      expect(result.isError).toBeUndefined();
      const { pagination } = result.structuredContent as { pagination: Record<string, unknown> };
      expect(pagination.has_more).toBe(true);
      /*
       * The endpoint takes no request controls, so even a link that parses cannot be
       * replayed as an offset the caller chose. Saying so, and pointing at the bounded
       * aggregate, is the only honest continuation advice here.
       */
      expect(pagination.manual_continuation).toBe(false);
      expect(pagination.next_action).toBe('all');
      expect(pagination.next_offset).toBeUndefined();
    } finally { await runtime.shutdown(); }
  });
});
