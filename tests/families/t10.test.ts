import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TestRailClient } from '@dichovsky/testrail-api-client';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConfiguration, type Configuration } from '../../src/config/environment.js';
import { operationRegistry } from '../../src/operations/catalog.js';
import { createRuntime } from '../../src/runtime/invocation.js';
import { buildServer } from '../../src/transport/server.js';
import { executeToolCall } from '../../src/transport/tool-call.js';

let base: string;
let configuration: Configuration;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'testrail-mcp-t10-'));
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

function driverFor(fetch: ReturnType<typeof vi.fn>): TestRailClient {
  return new TestRailClient({
    baseUrl: configuration.baseUrl, email: configuration.email, apiKey: configuration.apiKey,
    registerProcessHandlers: false, maxRetries: 0,
    dnsLookup: () => Promise.resolve([{ address: '203.0.113.10', family: 4 }]),
    fetch: fetch as unknown as typeof globalThis.fetch,
  });
}

function runtimeFor(fetch: ReturnType<typeof vi.fn>) {
  return createRuntime({ client: driverFor(fetch), limits: configuration.limits });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/**
 * Answer each request by the endpoint it names, so a test that makes several calls can
 * tell them apart. An endpoint with no answer here is a request nobody expected.
 */
function routed(answers: Readonly<Record<string, unknown>>): ReturnType<typeof vi.fn> {
  return vi.fn().mockImplementation((url: unknown) => {
    const token = String(url).split('/api/v2/')[1]?.split(/[/&]/u)[0] ?? '';
    return Promise.resolve(Object.hasOwn(answers, token)
      ? json(answers[token])
      : json({ error: `unexpected request to ${token}` }, 500));
  });
}

/** A fresh response per call: a body reads once, so a shared one would be drained. */
function replying(body: unknown, status = 200): ReturnType<typeof vi.fn> {
  return vi.fn().mockImplementation(() => Promise.resolve(json(body, status)));
}

function requested(fetch: ReturnType<typeof vi.fn>, index = 0): string {
  return String(fetch.mock.calls[index]?.[0]);
}

function sentText(fetch: ReturnType<typeof vi.fn>, index = 0): string {
  const init = fetch.mock.calls[index]?.[1] as { body?: string } | undefined;
  return init?.body ?? '';
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

// TestRail's own documented examples, verbatim where the reference gives one.
const APPROVED = { case_status_id: 1, name: 'Approved', abbreviation: null, is_default: false, is_approved: true };
const DRAFT = { case_status_id: 2, name: 'Draft', abbreviation: null, is_default: true, is_approved: false };
const PASSED = {
  color_bright: 12709313, color_dark: 6667107, color_medium: 9820525, id: 1,
  is_final: true, is_system: true, is_untested: false, label: 'Passed', name: 'passed',
};

function envelope(items: readonly unknown[], next: string | null = null, offset = 0, limit = 250): unknown {
  return { offset, limit, size: items.length, _links: { next, prev: null }, case_statuses: items };
}

/*
 * TestRail has two status vocabularies that share a word. get_statuses lists what a test
 * result records, get_case_statuses what a test case itself is, and a model that reached
 * for the wrong one would report Draft as a test outcome or Passed as a review state. The
 * two field lists pair up the same way, one for test cases and one for test results.
 */
describe('T10 the two status vocabularies and the two field lists', () => {
  it.each([
    ['testrail_get_statuses', [PASSED], 'get_statuses'],
    ['testrail_get_case_statuses', envelope([APPROVED, DRAFT]), 'get_case_statuses'],
    ['testrail_get_case_fields', [], 'get_case_fields'],
    ['testrail_get_result_fields', [], 'get_result_fields'],
  ] as const)('%s reads its own endpoint and nothing else', async (tool, reply, endpoint) => {
    const fetch = replying(reply);
    const runtime = runtimeFor(fetch);
    try {
      const result = await executeToolCall(operation(tool), {}, { runtime, configuration });
      expect(result.isError).toBeUndefined();
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(requested(fetch)).toMatch(new RegExp(`/api/v2/${endpoint}$`));
    } finally { await runtime.shutdown(); }
  });

  it('keeps each vocabulary under its own key', async () => {
    const fetch = vi.fn()
      .mockImplementationOnce(() => Promise.resolve(json([PASSED])))
      .mockImplementationOnce(() => Promise.resolve(json(envelope([APPROVED, DRAFT]))));
    const runtime = runtimeFor(fetch);
    try {
      const results = await executeToolCall(operation('testrail_get_statuses'), {}, { runtime, configuration });
      const cases = await executeToolCall(operation('testrail_get_case_statuses'), {}, { runtime, configuration });
      expect(data(results)).toEqual([PASSED]);
      expect(data(cases)).toEqual([APPROVED, DRAFT]);
      // Each reply is checked against its own vocabulary's schema, so neither drifts.
      expect({ results: warnings(results), cases: warnings(cases) }).toEqual({ results: [], cases: [] });
      // Neither list is reshaped into the other's identifiers.
      expect((data(cases) as Record<string, unknown>[]).every((status) => !Object.hasOwn(status, 'id'))).toBe(true);
    } finally { await runtime.shutdown(); }
  });

  // The descriptions are the contract a model reads, so each must point away from the other list.
  // Naming the other tool is not enough: the sentence must say it is the other list.
  it('points each description away from the other list', () => {
    const statuses = operation('testrail_get_statuses').description;
    const caseStatuses = operation('testrail_get_case_statuses').description;
    expect(statuses).toMatch(/These are not case statuses[^.]*testrail_get_case_statuses lists\./u);
    expect(statuses).toContain('Passed');
    expect(statuses).not.toMatch(/Draft|Approved|case_status_id/u);
    expect(caseStatuses).toMatch(/These are not the execution statuses a test result records, which testrail_get_statuses lists\./u);
    expect(caseStatuses).toMatch(/Draft or Approved, identified by case_status_id/u);
    expect(caseStatuses).not.toMatch(/Passed|Failed/u);
    expect(operation('testrail_get_case_fields').description)
      .toMatch(/These are the fields of test cases; the fields of test results are listed by testrail_get_result_fields\./u);
    expect(operation('testrail_get_result_fields').description)
      .toMatch(/the fields a test result can carry, as opposed to the fields of a test case, which testrail_get_case_fields lists\./u);
  });
});

/*
 * TestRail's reference documents get_case_statuses twice over: its example is a bare
 * array and its field table an envelope. A caller must get the statuses from either, and
 * must not be told there is more to fetch when the bare array is all there is.
 */
describe('T10 case statuses in either documented shape', () => {
  it('reads the documented bare array as the whole list', async () => {
    const fetch = replying([APPROVED, DRAFT]);
    const runtime = runtimeFor(fetch);
    try {
      const result = await executeToolCall(operation('testrail_get_case_statuses'), {}, { runtime, configuration });
      expect(result.isError).toBeUndefined();
      expect(data(result)).toEqual([APPROVED, DRAFT]);
      const { pagination } = result.structuredContent as { pagination: Record<string, unknown> };
      expect(pagination.has_more).toBe(false);
      expect(pagination.next_action).toBe('none');
      expect(requested(fetch)).not.toMatch(/limit=|offset=/);
    } finally { await runtime.shutdown(); }
  });

  it('reads the documented bare array in a complete read with one request', async () => {
    const fetch = replying([APPROVED, DRAFT]);
    const runtime = runtimeFor(fetch);
    try {
      const result = await executeToolCall(operation('testrail_get_case_statuses'),
        { _mcp: { pagination: 'all' } }, { runtime, configuration });
      expect(result.isError).toBeUndefined();
      expect(data(result)).toEqual([APPROVED, DRAFT]);
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally { await runtime.shutdown(); }
  });

  /*
   * The field table names the envelope's links key links, while TestRail's other list
   * pages and the driver use _links. The driver refuses an envelope without _links as an
   * invalid page, and the family documentation says so; this pins that it still does, so
   * the documentation cannot silently fall out of date.
   */
  it.each([{}, { _mcp: { pagination: 'all' } }] as const)(
    'reports an envelope keyed links, as the field table names it, as an invalid reply (%j)', async (input) => {
      const fetch = replying({ offset: 0, limit: 250, size: 1, links: { next: null, prev: null }, case_statuses: [APPROVED] });
      const runtime = runtimeFor(fetch);
      try {
        const result = await executeToolCall(operation('testrail_get_case_statuses'), input, { runtime, configuration });
        expect(result.isError).toBe(true);
        expect(errorOf(result).code).toBe('INVALID_RESPONSE');
        expect(fetch).toHaveBeenCalledTimes(1);
      } finally { await runtime.shutdown(); }
    });

  it('offers the bounded aggregate rather than an offset when the envelope has more', async () => {
    const fetch = replying(envelope([APPROVED], '/api/v2/get_case_statuses&limit=1&offset=1', 0, 1));
    const runtime = runtimeFor(fetch);
    try {
      const result = await executeToolCall(operation('testrail_get_case_statuses'), {}, { runtime, configuration });
      expect(result.isError).toBeUndefined();
      const { pagination } = result.structuredContent as { pagination: Record<string, unknown> };
      expect(pagination.has_more).toBe(true);
      expect(pagination.manual_continuation).toBe(false);
      expect(pagination.next_action).toBe('all');
      expect(pagination.next_offset).toBeUndefined();
    } finally { await runtime.shutdown(); }
  });

  /*
   * The first request carries no control of this server's choosing. A continuation
   * carries only what TestRail put in its own link, so the page size stays the server's.
   */
  it('walks the server\'s own continuation and sends no control of its own first', async () => {
    const fetch = vi.fn()
      .mockImplementationOnce(() => Promise.resolve(json(envelope([APPROVED], '/api/v2/get_case_statuses&limit=1&offset=1', 0, 1))))
      .mockImplementationOnce(() => Promise.resolve(json(envelope([DRAFT], null, 1, 1))));
    const runtime = runtimeFor(fetch);
    try {
      const result = await executeToolCall(operation('testrail_get_case_statuses'),
        { _mcp: { pagination: 'all' } }, { runtime, configuration });
      expect(result.isError).toBeUndefined();
      expect(data(result)).toEqual([APPROVED, DRAFT]);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(requested(fetch, 0)).toMatch(/\/api\/v2\/get_case_statuses$/);
      expect(requested(fetch, 1)).toContain('offset=1');
      expect(requested(fetch, 1)).toContain('limit=1');
    } finally { await runtime.shutdown(); }
  });
});

/*
 * A field definition's configs are nested per project, and several of its values have
 * more than one encoding: a global configuration's project_ids may be null, an empty
 * string or an empty array, and TestRail's own examples use more than one of them. The
 * caller needs them exactly as TestRail sent them: normalizing null to an empty array, or
 * splitting a choices string, would answer a question about the server with this server's
 * guess instead.
 */
describe('T10 field definitions arrive as TestRail sent them', () => {
  const FIELD = {
    id: 33, system_name: 'custom_case_browser', label: 'Browser', name: 'browser', type_id: 6, display_order: 7,
    is_active: true, include_all: false, template_ids: [1], description: null,
    configs: [
      { id: 'a', context: { is_global: true, project_ids: null }, options: { is_required: false, items: '1, Chrome\n2, Firefox' } },
      { id: 'b', context: { is_global: true, project_ids: '' }, options: { is_required: false, default_value: '1' } },
      { id: 'c', context: { is_global: false, project_ids: [5, 10] }, options: { is_required: true, has_expected: true } },
    ],
    custom_future_flag: { nested: [1, 2] },
  };

  it.each(['testrail_get_case_fields', 'testrail_get_result_fields'] as const)(
    '%s keeps every encoding of project_ids and every option', async (tool) => {
      const fetch = replying([FIELD]);
      const runtime = runtimeFor(fetch);
      try {
        const result = await executeToolCall(operation(tool), {}, { runtime, configuration });
        expect(result.isError).toBeUndefined();
        expect(data(result)).toEqual([FIELD]);
        expect(warnings(result)).toEqual([]);
      } finally { await runtime.shutdown(); }
    });

  /*
   * TestRail's own get_case_fields example leaves out is_active, include_all and
   * template_ids, which the driver's schema requires. A reply shaped like the documentation
   * is therefore reported as drift, and returned whole rather than refused.
   */
  it('returns TestRail\'s documented example intact and reports the drift', async () => {
    const documented = {
      configs: [{
        context: { is_global: true, project_ids: null }, id: '..',
        options: { default_value: '', format: 'markdown', is_required: false, rows: '5' },
      }],
      description: 'The preconditions of this test case. ..', display_order: 1, id: 1,
      label: 'Preconditions', name: 'preconds', system_name: 'custom_case_preconds', type_id: 3,
    };
    const fetch = replying([documented]);
    const runtime = runtimeFor(fetch);
    try {
      const result = await executeToolCall(operation('testrail_get_case_fields'), {}, { runtime, configuration });
      expect(result.isError).toBeUndefined();
      expect(data(result)).toEqual([documented]);
      expect(warnings(result)).toEqual([{ code: 'SCHEMA_DRIFT', count: 3 }]);
    } finally { await runtime.shutdown(); }
  });

  it('keeps a dynamic filter field\'s choices as the newline-separated string TestRail sent', async () => {
    const fields = [
      { type_id: 6, system_name: 'priority_id', label: 'Priority', options: '1, Low\n2, Medium\n3, High' },
      { type_id: 8, system_name: 'updated_on', label: 'Updated On', sub_filters: '1, Is\n2, Is Not\n3, Is Before\n4, Is After' },
    ];
    const fetch = replying(fields);
    const runtime = runtimeFor(fetch);
    try {
      const result = await executeToolCall(operation('testrail_get_dynamic_filter_fields'),
        { project_id: 3 }, { runtime, configuration });
      expect(result.isError).toBeUndefined();
      expect(requested(fetch)).toMatch(/\/api\/v2\/get_dynamic_filter_fields\/3$/);
      expect(data(result)).toEqual(fields);
    } finally { await runtime.shutdown(); }
  });
});

/*
 * Each read's registration names the driver schema its reply is checked against, and a
 * wrong one would put a drift warning on every correct answer. TestRail's own documented
 * examples, verbatim, must therefore come back unchanged and with no warning. The one
 * exception, get_case_fields, is covered above: its documented example lacks fields the
 * driver's schema requires.
 */
describe('T10 TestRail\'s documented examples', () => {
  const RESULT_FIELDS = [
    {
      id: 11, is_active: true, type_id: 11, name: 'step_results', system_name: 'custom_step_results', label: 'Steps',
      description: null,
      configs: [{
        context: { is_global: true, project_ids: null },
        options: { is_required: false, format: 'markdown', has_expected: true, has_actual: true, rows: '5' },
        id: '4be97c65ea2fd',
      }],
      display_order: 1, include_all: false, i18n_custom_id: 'fields_custom_step_results', template_ids: [2],
    },
    {
      id: 21, is_active: true, type_id: 4, name: 'ai_traces', system_name: 'custom_ai_traces', label: 'Traces (URL)',
      description: 'Trace URL for AI evaluation',
      configs: [{
        context: { is_global: true, project_ids: [] },
        options: { is_required: false, default_value: '' },
        id: '6e5d4c3b-7a8f-4e9d-8c6b-4a3e2d1c9b8f',
      }],
      display_order: 104, include_all: false, i18n_custom_id: 'fields_custom_ai_traces', template_ids: [5],
    },
  ];
  it.each([
    ['testrail_get_case_types', {}, [
      { id: 1, is_default: false, name: 'Automated' },
      { id: 2, is_default: false, name: 'Functionality' },
      { id: 6, is_default: true, name: 'Other' },
    ]],
    ['testrail_get_priorities', {}, [
      { id: 1, is_default: false, name: '1 - Don\'t Test', priority: 1, short_name: '1 - Don\'t' },
      { id: 4, is_default: true, name: '4 - Must Test', priority: 4, short_name: '4 - Must' },
    ]],
    ['testrail_get_statuses', {}, [
      PASSED,
      { color_bright: 16631751, color_dark: 14250867, color_medium: 15829135, id: 5, is_final: true, is_system: true, is_untested: false, label: 'Failed', name: 'failed' },
      { color_bright: 13684944, color_dark: 0, color_medium: 10526880, id: 6, is_final: false, is_system: false, is_untested: false, label: 'Custom', name: 'custom_status1' },
    ]],
    ['testrail_get_case_statuses', {}, [APPROVED, DRAFT]],
    ['testrail_get_result_fields', {}, RESULT_FIELDS],
    ['testrail_get_templates', { project_id: 7 }, [
      { id: 1, name: 'Test Case (Text)', i18n_custom_id: 'templates_test_case_text', is_default: true },
      { id: 2, name: 'Test Case (Steps)', i18n_custom_id: 'templates_test_case_steps', is_default: false },
      { id: 3, name: 'Exploratory Session', i18n_custom_id: 'templates_exploratory_session', is_default: false },
      { id: 4, name: 'Behaviour Driven Development', i18n_custom_id: 'templates_behaviour_driven_development', is_default: false },
      { id: 5, name: 'AI Evaluation', i18n_custom_id: 'templates_ai_evaluation', is_default: false },
    ]],
    ['testrail_get_dynamic_filter_fields', { project_id: 7 }, [
      { type_id: 6, system_name: 'status_id', label: 'Status', options: '1, Untested\n2, Retest\n3, Passed\n4, Failed' },
      { type_id: 6, system_name: 'priority_id', label: 'Priority', options: '1, Low\n2, Medium\n3, High' },
      { type_id: 1, system_name: 'title', label: 'Title', sub_filters: '1, Is\n2, Is Not\n5, Contains\n6, Does not contain' },
      { type_id: 8, system_name: 'updated_on', label: 'Updated On', sub_filters: '1, Is\n2, Is Not\n3, Is Before\n4, Is After' },
      { type_id: 12, system_name: 'custom_multiselect', label: 'Custom Multiselect', options: '1, Option 1\n2, Option 2' },
    ]],
    ['testrail_get_version', {}, { version: '10.6.0.1041' }],
  ] as const)('%s returns the documented example unchanged and without drift', async (tool, input, example) => {
    const fetch = replying(example);
    const runtime = runtimeFor(fetch);
    try {
      const result = await executeToolCall(operation(tool), input, { runtime, configuration });
      expect(result.isError).toBeUndefined();
      expect(data(result)).toEqual(example);
      expect(warnings(result)).toEqual([]);
    } finally { await runtime.shutdown(); }
  });
});

/*
 * The two project-scoped reads document a 400 for an unknown project and a 403 for one
 * the user cannot see. Those are answers about the instance, so they must arrive as the
 * two different errors they are, after the request rather than instead of it.
 */
describe('T10 a project the configured user cannot read', () => {
  it.each([
    ['testrail_get_templates', 400, 'UPSTREAM_ERROR'],
    ['testrail_get_templates', 403, 'PERMISSION_DENIED'],
    ['testrail_get_dynamic_filter_fields', 400, 'UPSTREAM_ERROR'],
    ['testrail_get_dynamic_filter_fields', 403, 'PERMISSION_DENIED'],
  ] as const)('%s reports a %i as %s', async (tool, status, code) => {
    const fetch = replying({ error: 'Field :project_id is not a valid or accessible project.' }, status);
    const runtime = runtimeFor(fetch);
    try {
      const result = await executeToolCall(operation(tool), { project_id: 99 }, { runtime, configuration });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(result.isError).toBe(true);
      expect(errorOf(result).code).toBe(code);
      expect(errorOf(result).http_status).toBe(status);
      // A read carries no write outcome.
      expect(errorOf(result).write_outcome).toBeUndefined();
    } finally { await runtime.shutdown(); }
  });
});

/*
 * add_case_field is the one write here, and the one reply in the server whose nested
 * structure arrives as a string. TestRail's own request example goes out as written, and
 * its own reply comes back as sent: configs stays the JSON-encoded string, the flags stay
 * 0 or 1, and nothing is parsed or coerced on the way.
 */
describe('T10 creating a case field', () => {
  const REQUEST = {
    type: 'Multiselect', name: 'my_multiselect', label: 'My Multiselect',
    description: 'my custom Multiselect description',
    configs: [{ context: { is_global: true, project_ids: '' }, options: { is_required: false, items: '1, One\n2, Two' } }],
    include_all: true,
  };
  const REPLY = {
    id: 33, name: 'my_multiselect', system_name: 'custom_case_my_multiselect', entity_id: 1, label: 'My Multiselect',
    description: 'my custom Multiselect description', type_id: 12, location_id: 2, display_order: 7,
    configs: '[{"context":{"is_global":true,"project_ids":""},"options":{"is_required":false,"items":"1, One\\n2, Two"},"id":"9f105ba2-1ed0-45e0-b459-18d890bad86e"}]',
    is_multi: 1, is_active: 1, status_id: 1, is_system: 0, include_all: 1, template_ids: [],
  };

  it('sends TestRail\'s own request example unchanged, choices string included', async () => {
    const fetch = replying(REPLY);
    const runtime = runtimeFor(fetch);
    try {
      const result = await executeToolCall(operation('testrail_add_case_field'), { body: REQUEST }, { runtime, configuration });
      expect(result.isError).toBeUndefined();
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(requested(fetch)).toMatch(/\/api\/v2\/add_case_field$/);
      expect(JSON.parse(sentText(fetch))).toEqual(REQUEST);
      // The newline travels as a JSON escape inside one string, not as separate choices.
      expect(sentText(fetch)).toContain('"items":"1, One\\n2, Two"');
    } finally { await runtime.shutdown(); }
  });

  it('returns TestRail\'s documented reply as sent, configs still a string', async () => {
    const fetch = replying(REPLY);
    const runtime = runtimeFor(fetch);
    try {
      const result = await executeToolCall(operation('testrail_add_case_field'), { body: REQUEST }, { runtime, configuration });
      expect(result.isError).toBeUndefined();
      const reply = data(result) as Record<string, unknown>;
      expect(reply).toEqual(REPLY);
      expect(typeof reply.configs).toBe('string');
      expect(reply.is_active).toBe(1);
      // The documented reply is the shape the driver's reply schema models, so nothing drifts.
      expect(warnings(result)).toEqual([]);
    } finally { await runtime.shutdown(); }
  });

  it('refuses a type sent as a number before any request, as TestRail would refuse it after one', async () => {
    const fetch = replying(REPLY);
    const runtime = runtimeFor(fetch);
    try {
      const result = await executeToolCall(operation('testrail_add_case_field'),
        { body: { ...REQUEST, type: 12 } }, { runtime, configuration });
      expect(result.isError).toBe(true);
      expect(errorOf(result).code).toBe('INVALID_ARGUMENT');
      expect(errorOf(result).write_outcome).toBe('not_started');
      expect(fetch).not.toHaveBeenCalled();
    } finally { await runtime.shutdown(); }
  });

  it('forwards a request TestRail refuses on a per-type rule and reports its refusal', async () => {
    // TestRail does not allow default_value on a Multiselect; that rule is TestRail's alone.
    const body = { ...REQUEST, configs: [{ ...REQUEST.configs[0], options: { is_required: false, default_value: '1' } }] };
    const fetch = replying({ error: 'Field :default_value is not allowed for this field type.' }, 400);
    const runtime = runtimeFor(fetch);
    try {
      const result = await executeToolCall(operation('testrail_add_case_field'), { body }, { runtime, configuration });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(JSON.parse(sentText(fetch))).toEqual(body);
      expect(result.isError).toBe(true);
      expect(errorOf(result).code).toBe('UPSTREAM_ERROR');
      expect(errorOf(result).http_status).toBe(400);
      // TestRail's own sentence is not echoed back; the message is this server's.
      expect(JSON.stringify(result.structuredContent)).not.toContain('not allowed');
    } finally { await runtime.shutdown(); }
  });

  it('publishes the write as neither destructive nor safe to repeat', () => {
    const { annotations } = operation('testrail_add_case_field');
    expect(annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false });
  });
});

/*
 * get_version is a tool like any other. The server asks for the version only when a
 * caller does, and what it hears decides nothing: the catalog a client sees is the same
 * before and after, whatever version is reported.
 */
describe('T10 the version is asked for only when a caller asks', () => {
  async function connect(fetch: ReturnType<typeof vi.fn>) {
    const driver = driverFor(fetch);
    const getVersion = vi.spyOn(driver.metadata, 'getVersion');
    const runtime = createRuntime({ client: driver, limits: configuration.limits });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const handle = serveStdio(() => buildServer({
      configuration, runtime, registry: operationRegistry, stagingDirectory: () => Promise.resolve(base),
    }), { transport: serverTransport });
    const client = new Client({ name: 't10-version', version: '1.0.0' });
    await client.connect(clientTransport);
    return {
      client, getVersion,
      close: async () => {
        await client.close().catch(() => undefined);
        await handle.close().catch(() => undefined);
        await runtime.shutdown();
      },
    };
  }

  it('makes no version request to start, to list tools or to serve another tool', async () => {
    const fetch = routed({
      get_case_types: [{ id: 1, name: 'Automated', is_default: false }],
      add_case_field: { id: 40, name: 'build', label: 'Build' },
    });
    const session = await connect(fetch);
    try {
      const { tools } = await session.client.listTools();
      expect(fetch).not.toHaveBeenCalled();
      expect(tools).toHaveLength(operationRegistry.entries.length);
      await session.client.callTool({ name: 'testrail_get_case_types', arguments: {} });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(requested(fetch)).toMatch(/\/api\/v2\/get_case_types$/);
      // A write is served the same way: its own request and nothing asked first.
      const write = await session.client.callTool({ name: 'testrail_add_case_field', arguments: {
        body: { type: 'String', name: 'build', label: 'Build', configs: [{ context: { is_global: true, project_ids: '' }, options: { is_required: true } }] },
      } });
      expect(write.isError).toBeFalsy();
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(requested(fetch, 1)).toMatch(/\/api\/v2\/add_case_field$/);
      expect(session.getVersion).not.toHaveBeenCalled();
    } finally { await session.close(); }
  });

  it.each(['5.0.0.1000', 'not a version', '10.7.1.1003'])(
    'offers the same catalog after the server reports %s', async (version) => {
      const fetch = routed({ get_version: { version }, get_case_types: [{ id: 6, name: 'Other', is_default: true }] });
      const session = await connect(fetch);
      try {
        const before = (await session.client.listTools()).tools.map(({ name }) => name);
        const result = await session.client.callTool({ name: 'testrail_get_version', arguments: {} });
        expect(result.isError).toBeFalsy();
        expect((result.structuredContent as { data: unknown }).data).toEqual({ version });
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(requested(fetch)).toMatch(/\/api\/v2\/get_version$/);
        const after = (await session.client.listTools()).tools.map(({ name }) => name);
        expect(after).toEqual(before);
        // Nothing asked again on its own after the answer arrived.
        expect(fetch).toHaveBeenCalledTimes(1);
        // And the answer gates nothing: another tool is still dispatched and served.
        const other = await session.client.callTool({ name: 'testrail_get_case_types', arguments: {} });
        expect(other.isError).toBeFalsy();
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(requested(fetch, 1)).toMatch(/\/api\/v2\/get_case_types$/);
      } finally { await session.close(); }
    });

  /*
   * startServer composes the driver, runtime and transport over the process's own stdio,
   * so it cannot be started in-process here, and the lifecycle suite that spawns it can
   * see its output but not its requests. The source is the gate for it instead: nothing
   * but the endpoint's own registration may name the endpoint or its driver method.
   */
  it('names the endpoint nowhere in the server but its own registration', async () => {
    const root = new URL('../../src/', import.meta.url);
    const files = (await readdir(root, { recursive: true }))
      .map((file) => file.replaceAll('\\', '/'))
      .filter((file) => file.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(20);
    const naming: string[] = [];
    for (const file of files) {
      if (/getVersion|get_version/u.test(await readFile(new URL(file, root), 'utf8'))) naming.push(file);
    }
    expect(naming).toEqual(['operations/families/t10.ts']);
  });

  it('reports a server without the endpoint as that server\'s answer, not a missing tool', async () => {
    const fetch = replying({ error: 'Unknown method \'get_version\'' }, 400);
    const session = await connect(fetch);
    try {
      const result = await session.client.callTool({ name: 'testrail_get_version', arguments: {} });
      expect(result.isError).toBe(true);
      expect((result.structuredContent as { error: { code: string; http_status?: number } }).error)
        .toMatchObject({ code: 'UPSTREAM_ERROR', http_status: 400 });
      const { tools } = await session.client.listTools();
      expect(tools.map(({ name }) => name)).toContain('testrail_get_version');
    } finally { await session.close(); }
  });
});
