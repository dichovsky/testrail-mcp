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
type DriverOverrides = {
  enableCache?: boolean; maxRetries?: number; timeout?: number; bodyTimeout?: number;
  rateLimiter?: { maxRequests: number; windowMs: number };
};

function driverFor(fetch: ReturnType<typeof vi.fn>, overrides: DriverOverrides = {}) {
  return new TestRailClient({
    ...driverOptions(configuration),
    ...overrides,
    dnsLookup: () => Promise.resolve([{ address: '203.0.113.10', family: 4 }]),
    fetch: fetch as unknown as typeof globalThis.fetch,
  });
}

function runtimeFor(fetch: ReturnType<typeof vi.fn>, overrides: DriverOverrides = {}) {
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

// TestRail's documented reply for each run endpoint, verbatim.
const REPORT_URLS = {
  report_url: 'https://docs.testrail.com/index.php?/reports/view/383',
  report_html: 'https://docs.testrail.com/index.php?/reports/get_html/383',
  report_pdf: 'https://docs.testrail.com/index.php?/reports/get_pdf/383',
};

const CROSS_PROJECT_URLS = {
  report_url: 'https://docs.testrail.com/index.php?/cross_project_reports/view/383',
  report_html: 'https://docs.testrail.com/index.php?/cross_project_reports/get_html/383',
  report_pdf: 'https://docs.testrail.com/index.php?/cross_project_reports/get_pdf/383',
};

const GENERATORS = [
  ['testrail_run_report', 'run_report', REPORT_URLS, 'runReport'],
  ['testrail_run_cross_project_report', 'run_cross_project_report', CROSS_PROJECT_URLS, 'runCrossProjectReport'],
] as const;

/**
 * A client connected to a server over the full registry, so a call takes the same path a
 * host's call does: through the MCP tool handler, not straight into executeToolCall.
 */
async function connect(fetch: ReturnType<typeof vi.fn>) {
  const runtime = runtimeFor(fetch);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const handle = serveStdio(() => buildServer({
    configuration, runtime, registry: operationRegistry, stagingDirectory: () => Promise.resolve(base),
  }), { transport: serverTransport });
  const client = new Client({ name: 't11', version: '1.0.0' });
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close().catch(() => undefined);
      await handle.close().catch(() => undefined);
      await runtime.shutdown();
    },
  };
}

/*
 * Running a template is a GET that generates a report and may email it. A cache, a
 * coalesced request or a retry would each turn one call into a different number of
 * reports than the caller asked for, so every one of these counts the requests that
 * actually reached TestRail.
 */
describe('T11 every report run reaches TestRail exactly once', () => {
  it.each(GENERATORS)('%s runs twice when called twice, whether or not the cache is on', async (tool, endpoint, urls) => {
    for (const enableCache of [false, true]) {
      const fetch = replying(urls);
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

  it.each(GENERATORS)('%s runs three times when three callers ask at once', async (tool, _endpoint, urls) => {
    const fetch = replying(urls);
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
  it.each(GENERATORS.flatMap(([tool, , , method]) => [
    [tool, 'a network error', method, () => Promise.reject(new TypeError('fetch failed'))],
    ...[408, 500, 501, 502, 503, 504, 505, 599].map((status) =>
      [tool, `a ${status}`, method, () => Promise.resolve(json({ error: 'upstream' }, status))] as const),
  ] as const))('%s is not retried after %s, and its outcome stays unknown', async (tool, _label, method, respond) => {
    const fetch = vi.fn().mockImplementation(respond);
    const driver = driverFor(fetch);
    // Counted at the driver method too, so a re-invocation above the wire cannot hide.
    const invoked = vi.spyOn(driver.reports, method);
    const runtime = createRuntime({ client: driver, limits: configuration.limits });
    try {
      const result = await executeToolCall(operation(tool), { report_template_id: 383 }, { runtime, configuration });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(invoked).toHaveBeenCalledTimes(1);
      expect(result.isError).toBe(true);
      expect(errorOf(result).write_outcome).toBe('unknown');
    } finally { await runtime.shutdown(); }
  });

  /*
   * The driver's own request timeout is not an HTTP 408 reply: it aborts the fetch and
   * reports a timeout of its own. A run that times out may still be generating upstream,
   * so it must not be sent again either.
   */
  it.each(GENERATORS)('%s is not retried after the driver\'s own timeout', async (tool, _endpoint, _urls, method) => {
    const fetch = vi.fn().mockImplementation((_url: unknown, init?: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const reason: unknown = init.signal?.reason;
        reject(reason instanceof Error ? reason : new DOMException('aborted', 'AbortError'));
      });
    }));
    const driver = driverFor(fetch, { timeout: 100 });
    const invoked = vi.spyOn(driver.reports, method);
    const runtime = createRuntime({ client: driver, limits: configuration.limits });
    try {
      const result = await executeToolCall(operation(tool), { report_template_id: 383 }, { runtime, configuration });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(invoked).toHaveBeenCalledTimes(1);
      expect(result.isError).toBe(true);
      expect(errorOf(result).write_outcome).toBe('unknown');
    } finally { await runtime.shutdown(); }
  });

  // A refusal is TestRail's answer, but it still carries unknown; its code and status say what TestRail answered.
  it.each(GENERATORS.flatMap(([tool]) => [
    [tool, 400, 'UPSTREAM_ERROR'],
    [tool, 403, 'PERMISSION_DENIED'],
  ] as const))('%s reports a %i refusal with its status and an unknown outcome', async (tool, status, code) => {
    const fetch = replying({ error: 'refused' }, status);
    const runtime = runtimeFor(fetch);
    try {
      const result = await executeToolCall(operation(tool), { report_template_id: 383 }, { runtime, configuration });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(errorOf(result)).toMatchObject({ code, http_status: status, write_outcome: 'unknown' });
    } finally { await runtime.shutdown(); }
  });

  /*
   * The driver's own rate limiter refuses a run before sending it, with the same 429 a
   * rate-limited TestRail returns, so the code and status cannot say which one answered.
   */
  it.each(GENERATORS)('%s reports a run the driver\'s own rate limiter refused as a 429 that was never sent', async (tool, _endpoint, urls) => {
    const fetch = replying(urls);
    const runtime = runtimeFor(fetch, { rateLimiter: { maxRequests: 1, windowMs: 60_000 } });
    try {
      const first = await executeToolCall(operation(tool), { report_template_id: 383 }, { runtime, configuration });
      expect(first.isError).toBeFalsy();
      const refused = await executeToolCall(operation(tool), { report_template_id: 383 }, { runtime, configuration });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(errorOf(refused)).toMatchObject({ code: 'RATE_LIMITED', http_status: 429, write_outcome: 'unknown' });
    } finally { await runtime.shutdown(); }
  });

  /*
   * The counts above call the transport's entry point directly. A host's call arrives
   * through the MCP tool handler instead, which could share one in-flight run between
   * identical callers, so the same counts are taken through a connected client.
   */
  it.each(GENERATORS)('%s reaches TestRail once per call through a connected client', async (tool, _endpoint, urls) => {
    const fetch = replying(urls);
    const session = await connect(fetch);
    try {
      await session.client.callTool({ name: tool, arguments: { report_template_id: 383 } });
      await session.client.callTool({ name: tool, arguments: { report_template_id: 383 } });
      expect(fetch).toHaveBeenCalledTimes(2);
      const concurrent = await Promise.all([1, 2, 3].map(() =>
        session.client.callTool({ name: tool, arguments: { report_template_id: 383 } })));
      expect(concurrent.map(({ isError }) => Boolean(isError))).toEqual([false, false, false]);
      expect(fetch).toHaveBeenCalledTimes(5);
    } finally { await session.close(); }
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
   * The declared retry policy is published to clients, so it is held to what the driver
   * does: under the production budget a run TestRail keeps rate-limiting is sent once and
   * re-sent up to maxRetries times, and never more.
   */
  it.each(GENERATORS)('%s declares the 429-only policy and exhausts exactly the production budget', async (tool) => {
    expect(operation(tool).retry).toBe('rate-limit-only');
    const budget = driverOptions(configuration).maxRetries ?? 0;
    expect(budget).toBeGreaterThan(0);
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(new Response(
      JSON.stringify({ error: 'API rate limit exceeded' }),
      { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '0' } },
    )));
    const runtime = runtimeFor(fetch);
    try {
      const result = await executeToolCall(operation(tool), { report_template_id: 383 }, { runtime, configuration });
      expect(fetch).toHaveBeenCalledTimes(1 + budget);
      expect(errorOf(result)).toMatchObject({ code: 'RATE_LIMITED', http_status: 429, write_outcome: 'unknown' });
    } finally { await runtime.shutdown(); }
  }, 30_000);

  /*
   * F01 accepted the driver re-sending a rate-limited run: TestRail rejects a 429 before
   * handling the request, so nothing was generated. One retry keeps the backoff short.
   */
  it.each(GENERATORS)('%s is re-sent after a 429, which F01 accepts as safe', async (tool, _endpoint, urls) => {
    const fetch = vi.fn()
      .mockImplementationOnce(() => Promise.resolve(json({ error: 'API rate limit exceeded' }, 429)))
      .mockImplementationOnce(() => Promise.resolve(json(urls)));
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
  it.each(GENERATORS)('%s returns its documented URLs as sent and fetches none of them', async (tool, _endpoint, urls) => {
    const fetch = replying(urls);
    const runtime = runtimeFor(fetch);
    // The URLs are not API endpoints, so the driver could not fetch them; anything else would
    // have to use the global fetch, which is watched here as well.
    const globalFetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no request expected'));
    try {
      const result = await executeToolCall(operation(tool), { report_template_id: 383 }, { runtime, configuration });
      expect(data(result)).toEqual(urls);
      expect(warnings(result)).toEqual([]);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(globalFetch).not.toHaveBeenCalled();
    } finally {
      globalFetch.mockRestore();
      await runtime.shutdown();
    }
  });

  // A reply without a usable URL is still TestRail's answer to the run, whatever its shape.
  it.each(GENERATORS.flatMap(([tool, , urls]) => [
    [tool, 'an empty object', {}],
    [tool, 'report_html alone', { report_html: urls.report_html }],
    [tool, 'the legacy user_report_url alone', { user_report_url: 'https://docs.testrail.com/index.php?/reports/view/383' }],
    [tool, 'a null report_url', { report_url: null }],
  ] as const))('%s returns %s as sent, with a warning, and does not run again', async (tool, _label, reply) => {
    const fetch = replying(reply);
    const runtime = runtimeFor(fetch);
    try {
      const result = await executeToolCall(operation(tool), { report_template_id: 383 }, { runtime, configuration });
      expect(result.isError).toBeUndefined();
      expect(data(result)).toEqual(reply);
      expect(warnings(result)).toEqual([{ code: 'SCHEMA_DRIFT', count: 1 }]);
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally { await runtime.shutdown(); }
  });

  // TestRail answered the run even though this server cannot use the reply, so it is not "not started".
  it.each(GENERATORS)('%s reports an unusable JSON reply as a run TestRail answered', async (tool, _endpoint, urls) => {
    const fetch = replying([urls]);
    const runtime = runtimeFor(fetch);
    try {
      const result = await executeToolCall(operation(tool), { report_template_id: 383 }, { runtime, configuration });
      expect(result.isError).toBe(true);
      expect(errorOf(result)).toMatchObject({ code: 'INVALID_RESPONSE', write_outcome: 'acknowledged' });
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally { await runtime.shutdown(); }
  });

  /*
   * The configured data budget is this server's, applied after the driver resolved, so a
   * reply over it is still one TestRail answered. A reply over the driver's own JSON limit
   * is never read, so this server cannot tell it from a failed exchange.
   */
  it.each(GENERATORS)('%s reports a reply over each size budget with the outcome that budget can know', async (tool, _endpoint, urls) => {
    const overData = { ...urls, report_url: 'x'.repeat(configuration.limits.max_data_bytes) };
    const overDriver = { ...urls, report_url: 'x'.repeat(configuration.limits.max_json_response_bytes) };
    for (const [body, code, outcome] of [
      [overData, 'RESPONSE_TOO_LARGE', 'acknowledged'],
      [overDriver, 'INVALID_RESPONSE', 'unknown'],
    ] as const) {
      const fetch = replying(body);
      const runtime = runtimeFor(fetch);
      try {
        const result = await executeToolCall(operation(tool), { report_template_id: 383 }, { runtime, configuration });
        expect(result.isError).toBe(true);
        expect(errorOf(result)).toMatchObject({ code, write_outcome: outcome });
        expect(fetch).toHaveBeenCalledTimes(1);
      } finally { await runtime.shutdown(); }
    }
  });

  // A reply the driver cannot parse at all tells this server nothing about the run, so it stays unknown.
  it.each(GENERATORS)('%s reports a reply the driver cannot parse as an unknown outcome', async (tool) => {
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(
      new Response('<html>ok</html>', { status: 200, headers: { 'content-type': 'application/json' } })));
    const runtime = runtimeFor(fetch);
    try {
      const result = await executeToolCall(operation(tool), { report_template_id: 383 }, { runtime, configuration });
      expect(result.isError).toBe(true);
      expect(errorOf(result)).toMatchObject({ code: 'INVALID_RESPONSE', write_outcome: 'unknown' });
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally { await runtime.shutdown(); }
  });

  // A body that starts and never finishes is abandoned by the driver, which cannot say whether the run happened.
  it.each(GENERATORS)('%s reports a reply whose body stalls as an unknown outcome', async (tool) => {
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"report_url":')); },
    }), { status: 200, headers: { 'content-type': 'application/json' } })));
    const runtime = runtimeFor(fetch, { bodyTimeout: 100 });
    try {
      const result = await executeToolCall(operation(tool), { report_template_id: 383 }, { runtime, configuration });
      expect(result.isError).toBe(true);
      expect(errorOf(result).write_outcome).toBe('unknown');
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally { await runtime.shutdown(); }
  });

  it.each(GENERATORS)('%s is refused before any request when the template id is not an identifier', async (tool, _endpoint, urls) => {
    const fetch = replying(urls);
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
    // A failed run's outcome is read from write_outcome, which can be either of these.
    expect(description).toContain('acknowledged means TestRail returned a success reply this server could not use');
    expect(description).toContain('unknown is also what a refusal from TestRail carries, with its code and http_status saying what TestRail answered');
    expect(description).toContain('a RATE_LIMITED 429 can instead come from the driver\'s own rate limiter, which refuses before sending and still reports unknown');
    // The retry contract is this family's own text, not the registry's appended sentence.
    expect(description).toContain('Neither this server nor its driver retries a run after a network error or a 5xx');
    expect(description).toContain('the driver re-sends only a rate-limited (429) request, which TestRail rejects before handling');
    expect(description).not.toMatch(/safe to (call|run|retry|repeat)/iu);
  });

  it.each([['testrail_get_cross_project_reports'], ['testrail_run_cross_project_report']] as const)(
    '%s says a permission denial may still mean the instance lacks Enterprise', (tool) => {
      const { description } = operation(tool);
      expect(description).toContain('only when its message says "not an" or "requires" followed by "Enterprise licen" or "Enterprise subscription"');
      expect(description).toContain('"TestRail Enterprise only. Access denied." among them, arrives as PERMISSION_DENIED, which here may still mean the instance lacks Enterprise');
    });

  // The availability warning sits in the page introduction, before all four endpoints, so it is not called single-project only.
  it('says where TestRail warns that a cross-project report may not be ready', () => {
    const { description } = operation('testrail_run_cross_project_report');
    expect(description).toContain('in the introduction that precedes all four report endpoints but opens by speaking of single-project reports');
    expect(description).not.toMatch(/silent/iu);
  });

  it.each([['testrail_get_reports'], ['testrail_get_cross_project_reports']] as const)(
    '%s stays an ordinary read', (tool) => {
      expect(operation(tool).annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true });
    });
});

/*
 * The cross-project endpoints are Enterprise only. The driver calls a 403 a licence
 * restriction only when the message says so in the words it recognises, and TestRail's own
 * reference words the refusal differently. Both cross-project summaries say either code is possible; these
 * pin that, and that no refusal takes a tool out of the catalog.
 */
describe('T11 an instance or user without cross-project reports', () => {
  it.each([
    ['a licence message the driver recognises', 'Not an Enterprise license/subscription.', 'LICENSE_REQUIRED'],
    ['another wording the rule accepts', 'This feature requires Enterprise subscription.', 'LICENSE_REQUIRED'],
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
    const session = await connect(replying({ error: 'Not an Enterprise license/subscription.' }, 403));
    try {
      const before = (await session.client.listTools()).tools;
      const refused = await session.client.callTool({ name: 'testrail_get_cross_project_reports', arguments: {} });
      expect(refused.isError).toBe(true);
      const after = (await session.client.listTools()).tools;
      expect(after).toEqual(before);
      expect(after.map(({ name }) => name)).toEqual(expect.arrayContaining([
        'testrail_get_cross_project_reports', 'testrail_run_cross_project_report',
      ]));
    } finally { await session.close(); }
  });
});

/*
 * The template lists are ordinary one-response reads. Replies abridged from their
 * documented examples must come back unchanged, including per-report settings beside the
 * documented fields, and without drift. The manifests carry the full examples.
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

  /*
   * A list checked against no schema would also report no drift, so each list is shown to
   * report it too: a template missing a field its driver schema requires.
   */
  it.each([
    ['testrail_get_reports', { project_id: 7 }, { id: 1, description: null }],
    ['testrail_get_cross_project_reports', {}, {
      id: 1, name: 'Summary', include_open_runs_and_plans: true, include_completed_runs_and_plans: true, report_timeframe: '90 days',
    }],
  ] as const)('%s reports a template missing a required field as drift', async (tool, input, template) => {
    const fetch = replying([template]);
    const runtime = runtimeFor(fetch);
    try {
      const result = await executeToolCall(operation(tool), input, { runtime, configuration });
      expect(data(result)).toEqual([template]);
      expect(warnings(result)).toEqual([{ code: 'SCHEMA_DRIFT', count: 1 }]);
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
