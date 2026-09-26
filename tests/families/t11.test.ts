import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TestRailClient } from '@dichovsky/testrail-api-client';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConfiguration, type Configuration } from '../../src/config/environment.js';
import { driverOptions } from '../../src/driver/configuration.js';
import { operationRegistry } from '../../src/operations/catalog.js';
import { createRuntime } from '../../src/runtime/invocation.js';
import { buildServer } from '../../src/transport/server.js';
import { executeToolCall } from '../../src/transport/tool-call.js';

let base: string;
let configuration: Configuration;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'testrail-mcp-t11-'));
  configuration = await loadConfiguration({
    TESTRAIL_BASE_URL: 'https://people.testrail.io',
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

/*
 * The driver is built from this server's own production options, with only fetch and DNS
 * replaced, so what these tests prove about caching, coalescing and retries is what a real
 * call does. A test that wants a different retry budget or the cache turned on says so.
 */
function driverFor(fetch: ReturnType<typeof vi.fn>, overrides: { enableCache?: boolean; maxRetries?: number } = {}) {
  return new TestRailClient({
    ...driverOptions(configuration),
    ...overrides,
    dnsLookup: () => Promise.resolve([{ address: '203.0.113.10', family: 4 }]),
    fetch: fetch as unknown as typeof globalThis.fetch,
  });
}

function runtimeFor(fetch: ReturnType<typeof vi.fn>, overrides: { enableCache?: boolean; maxRetries?: number } = {}) {
  return createRuntime({ client: driverFor(fetch, overrides), limits: configuration.limits });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** A fresh response per call: a body reads once, so a shared one would be drained. */
function replying(body: unknown, status = 200): ReturnType<typeof vi.fn> {
  return vi.fn().mockImplementation(() => Promise.resolve(json(body, status)));
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

// TestRail's documented replies, verbatim.
const REPORT_URLS = {
  report_url: 'https://docs.testrail.com/index.php?/reports/view/383',
  report_html: 'https://docs.testrail.com/index.php?/reports/get_html/383',
  report_pdf: 'https://docs.testrail.com/index.php?/reports/get_pdf/383',
};

const GENERATORS = [
  ['testrail_run_report', 'run_report'],
  ['testrail_run_cross_project_report', 'run_cross_project_report'],
] as const;

/*
 * Running a template is a GET that generates a report and may email it. A cache, a
 * coalesced request or a retry would each turn one call into a different number of
 * reports than the caller asked for, so every one of these counts the requests that
 * actually reached TestRail.
 */
describe('T11 every report run reaches TestRail exactly once', () => {
  it.each(GENERATORS)('%s runs twice when called twice, whether or not the cache is on', async (tool, endpoint) => {
    for (const enableCache of [false, true]) {
      const fetch = replying(REPORT_URLS);
      const runtime = runtimeFor(fetch, { enableCache });
      try {
        const first = await executeToolCall(operation(tool), { report_template_id: 383 }, { runtime, configuration });
        const second = await executeToolCall(operation(tool), { report_template_id: 383 }, { runtime, configuration });
        expect(first.isError, `enableCache ${enableCache}`).toBeUndefined();
        expect(second.isError, `enableCache ${enableCache}`).toBeUndefined();
        expect(fetch, `enableCache ${enableCache}`).toHaveBeenCalledTimes(2);
        for (const index of [0, 1]) expect(requested(fetch, index)).toMatch(new RegExp(`/api/v2/${endpoint}/383$`));
      } finally { await runtime.shutdown(); }
    }
  });

  it.each(GENERATORS)('%s runs three times when three callers ask at once', async (tool) => {
    const fetch = replying(REPORT_URLS);
    const runtime = runtimeFor(fetch);
    try {
      const results = await Promise.all([1, 2, 3].map(() =>
        executeToolCall(operation(tool), { report_template_id: 383 }, { runtime, configuration })));
      expect(results.map(({ isError }) => isError)).toEqual([undefined, undefined, undefined]);
      expect(fetch).toHaveBeenCalledTimes(3);
    } finally { await runtime.shutdown(); }
  });

  /*
   * A network error or a 5xx may come after TestRail has begun generating, so a retry
   * could produce a second report and a second email. The production driver retries
   * ordinary reads three times; a run must still reach TestRail once, and its error must
   * not claim that nothing happened.
   */
  it.each(GENERATORS.flatMap(([tool]) => [
    [tool, 'a network error', () => Promise.reject(new TypeError('fetch failed'))],
    [tool, 'a 500', () => Promise.resolve(json({ error: 'upstream' }, 500))],
    [tool, 'a 503', () => Promise.resolve(json({ error: 'upstream' }, 503))],
  ] as const))('%s is not retried after %s, and its outcome stays unknown', async (tool, _label, respond) => {
    const fetch = vi.fn().mockImplementation(respond);
    const runtime = runtimeFor(fetch);
    try {
      const result = await executeToolCall(operation(tool), { report_template_id: 383 }, { runtime, configuration });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(result.isError).toBe(true);
      expect(errorOf(result).write_outcome).toBe('unknown');
    } finally { await runtime.shutdown(); }
  });

  // The contrast that shows the single request above is the report's own policy, not a cap.
  it('retries an ordinary template read after the same 500', async () => {
    const fetch = replying({ error: 'upstream' }, 500);
    const runtime = runtimeFor(fetch, { maxRetries: 1 });
    try {
      await executeToolCall(operation('testrail_get_reports'), { project_id: 7 }, { runtime, configuration });
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally { await runtime.shutdown(); }
  });

  /*
   * F01 accepted the driver re-sending a rate-limited run: TestRail rejects a 429 before
   * handling the request, so nothing was generated. One retry keeps the backoff short.
   */
  it.each(GENERATORS)('%s is re-sent after a 429, which F01 accepts as safe', async (tool) => {
    const fetch = vi.fn()
      .mockImplementationOnce(() => Promise.resolve(json({ error: 'API rate limit exceeded' }, 429)))
      .mockImplementationOnce(() => Promise.resolve(json(REPORT_URLS)));
    const runtime = runtimeFor(fetch, { maxRetries: 1 });
    try {
      const result = await executeToolCall(operation(tool), { report_template_id: 383 }, { runtime, configuration });
      expect(result.isError).toBeUndefined();
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally { await runtime.shutdown(); }
  });
});

/*
 * TestRail says a report may not be ready when its run returns. The tool hands back the
 * URLs it was given and asks for nothing else: fetching them, or running the template
 * again to see whether it finished, would be a second request the caller never made.
 */
describe('T11 what a run returns', () => {
  it.each(GENERATORS)('%s returns the documented URLs as sent and fetches none of them', async (tool) => {
    const fetch = replying(REPORT_URLS);
    const runtime = runtimeFor(fetch);
    try {
      const result = await executeToolCall(operation(tool), { report_template_id: 383 }, { runtime, configuration });
      expect(data(result)).toEqual(REPORT_URLS);
      expect(warnings(result)).toEqual([]);
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally { await runtime.shutdown(); }
  });

  // A reply without a URL is still the reply to a generation that happened.
  it.each(GENERATORS)('%s returns a reply without report_url as sent, with a warning', async (tool) => {
    const fetch = replying({ report_html: REPORT_URLS.report_html });
    const runtime = runtimeFor(fetch);
    try {
      const result = await executeToolCall(operation(tool), { report_template_id: 383 }, { runtime, configuration });
      expect(result.isError).toBeUndefined();
      expect(data(result)).toEqual({ report_html: REPORT_URLS.report_html });
      expect(warnings(result)).toEqual([{ code: 'SCHEMA_DRIFT', count: 1 }]);
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally { await runtime.shutdown(); }
  });

  // An unusable success is still a success upstream: the report exists even if the reply is useless.
  it.each(GENERATORS)('%s reports an unusable reply as a generation that was acknowledged', async (tool) => {
    const fetch = replying([REPORT_URLS]);
    const runtime = runtimeFor(fetch);
    try {
      const result = await executeToolCall(operation(tool), { report_template_id: 383 }, { runtime, configuration });
      expect(result.isError).toBe(true);
      expect(errorOf(result)).toMatchObject({ code: 'INVALID_RESPONSE', write_outcome: 'acknowledged' });
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally { await runtime.shutdown(); }
  });

  it.each(GENERATORS)('%s is refused before any request when the template id is not an identifier', async (tool) => {
    const fetch = replying(REPORT_URLS);
    const runtime = runtimeFor(fetch);
    try {
      const result = await executeToolCall(operation(tool), { report_template_id: '383' }, { runtime, configuration });
      expect(errorOf(result)).toMatchObject({ code: 'INVALID_ARGUMENT', write_outcome: 'not_started' });
      expect(fetch).not.toHaveBeenCalled();
    } finally { await runtime.shutdown(); }
  });

  it.each(GENERATORS)('%s is published as neither read-only nor safe to repeat, and says why', (tool) => {
    const { annotations, description } = operation(tool);
    expect(annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false });
    expect(description).toContain('template-configured email');
    expect(description).toContain('do not generate the report again to poll');
  });

  it.each([['testrail_get_reports'], ['testrail_get_cross_project_reports']] as const)(
    '%s stays an ordinary read', (tool) => {
      expect(operation(tool).annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true });
    });
});

/*
 * The cross-project endpoints are Enterprise only. The driver calls a 403 a licence
 * restriction only when the message says so in the words it recognises, and TestRail's own
 * reference words the refusal differently. The summary says both codes are possible; these
 * pin that, and that no refusal takes a tool out of the catalog.
 */
describe('T11 an instance or user without cross-project reports', () => {
  it.each([
    ['a licence message the driver recognises', 'Not an Enterprise license/subscription.', 'LICENSE_REQUIRED'],
    ['the wording of TestRail\'s own reference', 'TestRail Enterprise only. Access denied.', 'PERMISSION_DENIED'],
    ['a role that does not grant access', 'User role does not grant access.', 'PERMISSION_DENIED'],
  ] as const)('reports %s as %s', async (_label, message, code) => {
    for (const [tool, input] of [
      ['testrail_get_cross_project_reports', {}],
      ['testrail_run_cross_project_report', { report_template_id: 383 }],
    ] as const) {
      const fetch = replying({ error: message }, 403);
      const runtime = runtimeFor(fetch);
      try {
        const result = await executeToolCall(operation(tool), input, { runtime, configuration });
        expect(fetch, tool).toHaveBeenCalledTimes(1);
        expect(errorOf(result), tool).toMatchObject({ code, http_status: 403 });
      } finally { await runtime.shutdown(); }
    }
  });

  it('keeps both cross-project tools in the catalog after a licence refusal', async () => {
    const fetch = replying({ error: 'Not an Enterprise license/subscription.' }, 403);
    const runtime = runtimeFor(fetch);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const handle = serveStdio(() => buildServer({
      configuration, runtime, registry: operationRegistry, stagingDirectory: () => Promise.resolve(base),
    }), { transport: serverTransport });
    const client = new Client({ name: 't11-licence', version: '1.0.0' });
    await client.connect(clientTransport);
    try {
      const before = (await client.listTools()).tools;
      const refused = await client.callTool({ name: 'testrail_get_cross_project_reports', arguments: {} });
      expect(refused.isError).toBe(true);
      const after = (await client.listTools()).tools;
      expect(after).toEqual(before);
      expect(after.map(({ name }) => name)).toEqual(expect.arrayContaining([
        'testrail_get_cross_project_reports', 'testrail_run_cross_project_report',
      ]));
    } finally {
      await client.close().catch(() => undefined);
      await handle.close().catch(() => undefined);
      await runtime.shutdown();
    }
  });
});

/*
 * The template lists are ordinary one-response reads. Their documented examples must come
 * back unchanged, including the per-report settings beside the documented fields, and
 * without drift.
 */
describe('T11 the template lists', () => {
  it('returns a single-project template with its undocumented settings intact', async () => {
    const template = {
      id: 1, name: 'Activity Summary (Cases) %date%', description: null,
      notify_user: true, notify_link: false, notify_link_recipients: null, notify_attachment: false,
      notify_attachment_recipients: 'person1@example.com\r\nperson2@example.com',
      notify_attachment_html_format: false, notify_attachment_pdf_format: false,
      cases_groupby: 'day', cases_columns: { 'cases:id': 75, 'cases:title': 0 }, cases_limit: 1000,
    };
    const fetch = replying([template]);
    const runtime = runtimeFor(fetch);
    try {
      const result = await executeToolCall(operation('testrail_get_reports'), { project_id: 7 }, { runtime, configuration });
      expect(requested(fetch)).toMatch(/\/api\/v2\/get_reports\/7$/);
      expect(data(result)).toEqual([template]);
      expect(warnings(result)).toEqual([]);
    } finally { await runtime.shutdown(); }
  });

  it('returns both cross-project families without filling in the other\'s fields', async () => {
    const templates = [
      { id: 1, name: 'Test Execution Projects Summary %date%', description: null, project_ids: [],
        include_open_milestones: true, include_completed_milestones: true,
        include_open_runs_and_plans: true, include_completed_runs_and_plans: true,
        report_timeframe: '90 days', included_statuses: 'Passed, Blocked, Untested' },
      { id: 2, name: 'Test Execution User Workload %date%', description: null, user_ids: [], project_ids: [],
        report_timeframe: '90 days', include_open_runs_and_plans: true, include_completed_runs_and_plans: true,
        include_elapsed_test_time: true, include_estimated_test_time: true, sort_by: 'alphabetical' },
    ];
    const fetch = replying(templates);
    const runtime = runtimeFor(fetch);
    try {
      const result = await executeToolCall(operation('testrail_get_cross_project_reports'), {}, { runtime, configuration });
      expect(requested(fetch)).toMatch(/\/api\/v2\/get_cross_project_reports$/);
      expect(data(result)).toEqual(templates);
      expect(warnings(result)).toEqual([]);
    } finally { await runtime.shutdown(); }
  });
});
