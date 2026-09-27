import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TestRailClient } from '@dichovsky/testrail-api-client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConfiguration, type Configuration } from '../src/config/environment.js';
import { operationRegistry } from '../src/operations/catalog.js';
import { createRuntime } from '../src/runtime/invocation.js';
import { executeToolCall } from '../src/transport/tool-call.js';

let base: string;
let configuration: Configuration;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'testrail-mcp-preview-'));
  configuration = await loadConfiguration({
    TESTRAIL_BASE_URL: 'https://preview.testrail.io',
    TESTRAIL_EMAIL: 'user@example.com',
    TESTRAIL_API_KEY: 'synthetic',
    TESTRAIL_MCP_UPLOAD_ROOTS: JSON.stringify([base]),
    TESTRAIL_MCP_DOWNLOAD_DIR: base,
  });
});

afterAll(async () => { await rm(base, { recursive: true, force: true }); });

/** The five deletes whose soft flag asks TestRail for a preview, with a preview and a hard input each. */
const deletes = [
  ['testrail_delete_case', { case_id: 42 }, 'delete_case/42'],
  ['testrail_delete_cases', { suite_id: 3, query: { project_id: 7 }, body: { case_ids: [42, 43] } }, 'delete_cases/3&project_id=7'],
  ['testrail_delete_section', { section_id: 5 }, 'delete_section/5'],
  ['testrail_delete_suite', { suite_id: 3 }, 'delete_suite/3'],
  ['testrail_delete_run', { run_id: 42 }, 'delete_run/42'],
] as const;

function soft(input: object, value: boolean): object {
  const { query } = input as { query?: object };
  return { ...input, query: { ...query, soft: value } };
}

interface Outcome {
  readonly isError: boolean;
  readonly structured: Record<string, unknown>;
  readonly urls: readonly string[];
}

/** Call a tool against one synthetic reply, counting what reaches the wire. */
async function call(tool: string, input: object, reply: () => Response): Promise<Outcome> {
  const operation = operationRegistry.get(tool);
  if (operation === undefined) throw new Error(`Missing registration: ${tool}`);
  const urls: string[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>((request) => {
    urls.push(typeof request === 'string' ? request : request instanceof URL ? request.href : request.url);
    return Promise.resolve(reply());
  });
  const client = new TestRailClient({
    baseUrl: configuration.baseUrl, email: configuration.email, apiKey: configuration.apiKey,
    registerProcessHandlers: false, maxRetries: 0, fetch,
    dnsLookup: () => Promise.resolve([{ address: '203.0.113.10', family: 4 }]),
  });
  const runtime = createRuntime({ client, limits: configuration.limits });
  try {
    const result = await executeToolCall(operation, input, { runtime, configuration });
    return { isError: result.isError === true, structured: result.structuredContent, urls };
  } finally {
    await runtime.shutdown();
  }
}

const json = (body: unknown) => () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const empty = () => new Response('', { status: 200, headers: { 'content-type': 'application/json' } });

describe('soft-delete previews', () => {
  it('declares a preview on exactly the five deletes that take a soft flag', () => {
    const declared = operationRegistry.entries.filter(({ response }) => response.preview !== undefined).map(({ tool }) => tool);
    expect(declared.sort()).toEqual(deletes.map(([tool]) => tool).sort());
  });

  describe.each(deletes)('%s', (tool, input, endpoint) => {
    const previewUrl = `https://preview.testrail.io/index.php?/api/v2/${endpoint}&soft=1`;
    const hardUrl = `https://preview.testrail.io/index.php?/api/v2/${endpoint}`;

    it('returns counted previews as sent, with no warning', async () => {
      const counts = { affected_tests: 4, affected_cases: 2, affected_sections: 0, affected_runs: 1, affected_milestones: 0, affected_plans: 0, affected_suites: 1 };
      const outcome = await call(tool, soft(input, true), json(counts));
      expect(outcome).toEqual({ isError: false, structured: { data: counts }, urls: [previewUrl] });
      // A counter TestRail adds later is passed through without a warning.
      const extended = await call(tool, soft(input, true), json({ affected_tests: 4, affected_attachments: 9 }));
      expect(extended.structured).toEqual({ data: { affected_tests: 4, affected_attachments: 9 } });
    });

    it.each([
      'affected_tests', 'affected_cases', 'affected_sections', 'affected_runs',
      'affected_milestones', 'affected_plans', 'affected_suites',
    ])('answers a preview that carries only %s', async (counter) => {
      // TestRail sends a subset of the counts that depends on the target, so any one is an answer.
      const outcome = await call(tool, soft(input, true), json({ [counter]: 0 }));
      expect(outcome).toEqual({ isError: false, structured: { data: { [counter]: 0 } }, urls: [previewUrl] });
    });

    it('reports a counter of the wrong type as drift, not as a failure', async () => {
      const outcome = await call(tool, soft(input, true), json({ affected_tests: '4', affected_cases: 2 }));
      expect(outcome.isError).toBe(false);
      expect(outcome.structured).toEqual({
        data: { affected_tests: '4', affected_cases: 2 },
        warnings: [{ code: 'SCHEMA_DRIFT', count: 1 }],
      });
      // A count sent in the wrong type is still a count: the preview answered, so it is drift.
      const alone = await call(tool, soft(input, true), json({ affected_tests: '4' }));
      expect(alone).toEqual({
        isError: false, structured: { data: { affected_tests: '4' }, warnings: [{ code: 'SCHEMA_DRIFT', count: 1 }] }, urls: [previewUrl],
      });
    });

    it.each([
      ['an empty body', empty],
      ['an empty object', json({})],
      ['only renamed counters', json({ tests: 4, cases: 2 })],
      ['only null counters', json({ affected_tests: null })],
    ])('reports a preview reply with %s as an unknown outcome after one request', async (_, reply) => {
      const outcome = await call(tool, soft(input, true), reply);
      expect(outcome.isError).toBe(true);
      expect(outcome.structured).toEqual({ error: {
        code: 'INVALID_RESPONSE', message: 'The TestRail response could not be used.', write_outcome: 'unknown',
      } });
      expect(outcome.urls).toEqual([previewUrl]);
    });

    it('leaves a hard delete void and unchecked, whatever TestRail answers', async () => {
      for (const request of [input, soft(input, false)]) {
        for (const reply of [empty, json({}), json({ tests: 4 })]) {
          const outcome = await call(tool, request, reply);
          expect(outcome).toEqual({ isError: false, structured: { data: null }, urls: [hardUrl] });
        }
      }
    });
  });
});
