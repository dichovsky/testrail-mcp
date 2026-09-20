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
  base = await mkdtemp(join(tmpdir(), 'testrail-mcp-t08-'));
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

function sentBody(fetch: ReturnType<typeof vi.fn>, index = 0): unknown {
  const init = fetch.mock.calls[index]?.[1] as { body?: string } | undefined;
  return JSON.parse(init?.body ?? 'null');
}

const USER = { id: 1, name: 'Ada Lovelace', email: 'ada@example.com', is_active: true, role_id: 3, mfa_required: 0 };
const GROUP = { id: 7, name: 'QA', user_ids: [1, 2] };

/*
 * get_users is the one list in this server whose optional input changes the endpoint
 * rather than a query parameter. The two forms return different sets, so sending the
 * wrong one answers a different question than the caller asked.
 */
describe('T08 the two forms of the user list', () => {
  it('omits the segment entirely when no project is named', async () => {
    const fetch = vi.fn().mockResolvedValue(json([USER]));
    const runtime = runtimeFor(fetch);
    try {
      const result = await executeToolCall(operation('testrail_get_users'), {}, { runtime, configuration });
      expect(result.isError).toBeUndefined();
      // No trailing segment and no empty one: get_users, not get_users/ or get_users/undefined.
      expect(requested(fetch)).toMatch(/\/api\/v2\/get_users$/);
    } finally { await runtime.shutdown(); }
  });

  it('addresses the project form when one is named', async () => {
    const fetch = vi.fn().mockResolvedValue(json([USER]));
    const runtime = runtimeFor(fetch);
    try {
      await executeToolCall(operation('testrail_get_users'),
        { query: { project_id: 5 } }, { runtime, configuration });
      expect(requested(fetch)).toMatch(/\/api\/v2\/get_users\/5$/);
    } finally { await runtime.shutdown(); }
  });

  /*
   * TestRail documents a bare array here while every sibling documents an envelope, and
   * the driver accepts a third shape besides. A caller must not have to tell them apart,
   * and a null collection is an empty list rather than a fault.
   */
  it.each([
    ['a bare array', [USER], [USER]],
    ['a users wrapper', { users: [USER] }, [USER]],
    ['a null collection', { users: null }, []],
  ] as const)('reads %s as the same kind of answer', async (_label, reply, expected) => {
    const fetch = vi.fn().mockResolvedValue(json(reply));
    const runtime = runtimeFor(fetch);
    try {
      const result = await executeToolCall(operation('testrail_get_users'), {}, { runtime, configuration });
      expect(result.isError).toBeUndefined();
      expect((result.structuredContent as { data: unknown }).data).toEqual(expected);
    } finally { await runtime.shutdown(); }
  });
});

/*
 * The lookup is deliberately looser than the write. An address a directory instance
 * stores must reach TestRail rather than being refused here, and it must reach it
 * encoded, since an unescaped one would address a different query.
 */
describe('T08 the address a lookup accepts', () => {
  it.each([
    ['a plus tag', 'ada+test@example.com', 'email=ada%2Btest%40example.com'],
    ['a single-label domain', 'ada@corp', 'email=ada%40corp'],
    ['a domain literal', 'ada@[192.168.1.1]', 'email=ada%40%5B192.168.1.1%5D'],
  ] as const)('sends %s percent encoded', async (_label, address, encoded) => {
    const fetch = vi.fn().mockResolvedValue(json(USER));
    const runtime = runtimeFor(fetch);
    try {
      const result = await executeToolCall(operation('testrail_get_user_by_email'),
        { query: { email: address } }, { runtime, configuration });
      expect(result.isError).toBeUndefined();
      expect(requested(fetch)).toContain(encoded);
    } finally { await runtime.shutdown(); }
  });

  it.each([
    ['no at sign', 'not-an-address'],
    ['two at signs', 'ada@a@b'],
    ['leading whitespace', ' ada@example.com'],
    ['a trailing line feed', 'ada@example.com\n'],
  ] as const)('refuses %s before any request', async (_label, address) => {
    const fetch = vi.fn().mockResolvedValue(json(USER));
    const runtime = runtimeFor(fetch);
    try {
      const result = await executeToolCall(operation('testrail_get_user_by_email'),
        { query: { email: address } }, { runtime, configuration });
      expect(result.isError).toBe(true);
      expect((result.structuredContent as { error: { code: string } }).error.code).toBe('INVALID_ARGUMENT');
      expect(fetch).not.toHaveBeenCalled();
    } finally { await runtime.shutdown(); }
  });

  /*
   * The gap between the two rules is the driver's, not this server's, and it is real:
   * the same address is usable for a lookup and refused for a write.
   */
  it('accepts for a lookup an address the write tools refuse', async () => {
    const fetch = vi.fn().mockResolvedValue(json(USER));
    const runtime = runtimeFor(fetch);
    try {
      const lookup = await executeToolCall(operation('testrail_get_user_by_email'),
        { query: { email: 'ada@corp' } }, { runtime, configuration });
      expect(lookup.isError).toBeUndefined();
      const write = await executeToolCall(operation('testrail_add_user'),
        { body: { name: 'Ada', email: 'ada@corp' } }, { runtime, configuration });
      expect(write.isError).toBe(true);
      expect((write.structuredContent as { error: { code: string } }).error.code).toBe('INVALID_ARGUMENT');
      // One request for the lookup; the write never reached the wire.
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally { await runtime.shutdown(); }
  });
});

/*
 * TestRail requires a group's own ID in the body as well as the path, and the driver
 * supplies it. A caller cannot, because their value would be overwritten, so the
 * boundary refuses the field rather than accepting one that cannot take effect.
 */
describe('T08 the identifier a group update carries twice', () => {
  it('sends the path identifier in the body without being asked', async () => {
    const fetch = vi.fn().mockResolvedValue(json(GROUP));
    const runtime = runtimeFor(fetch);
    try {
      await executeToolCall(operation('testrail_update_group'),
        { group_id: 7, body: { name: 'QA renamed' } }, { runtime, configuration });
      expect(requested(fetch)).toContain('update_group/7');
      expect(sentBody(fetch)).toEqual({ name: 'QA renamed', group_id: 7 });
    } finally { await runtime.shutdown(); }
  });

  it('refuses a caller-supplied group_id rather than letting it be overwritten', async () => {
    const fetch = vi.fn().mockResolvedValue(json(GROUP));
    const runtime = runtimeFor(fetch);
    try {
      const result = await executeToolCall(operation('testrail_update_group'),
        { group_id: 7, body: { group_id: 99 } }, { runtime, configuration });
      expect(result.isError).toBe(true);
      expect((result.structuredContent as { error: { code: string } }).error.code).toBe('INVALID_ARGUMENT');
      expect(fetch).not.toHaveBeenCalled();
    } finally { await runtime.shutdown(); }
  });

  // An empty body is still a request that carries the identifier TestRail demands.
  it('carries the identifier even when the caller changes nothing', async () => {
    const fetch = vi.fn().mockResolvedValue(json(GROUP));
    const runtime = runtimeFor(fetch);
    try {
      await executeToolCall(operation('testrail_update_group'),
        { group_id: 7, body: {} }, { runtime, configuration });
      expect(sentBody(fetch)).toEqual({ group_id: 7 });
    } finally { await runtime.shutdown(); }
  });
});

/*
 * Two endpoints here document no request control at all. Sending one would look
 * honoured and be ignored, so the server must send none and refuse to accept one.
 */
describe('T08 the lists that take no controls', () => {
  it.each(['testrail_get_groups', 'testrail_get_roles'] as const)('%s sends a bare request', async (tool) => {
    const key = tool === 'testrail_get_groups' ? 'groups' : 'roles';
    const fetch = vi.fn().mockResolvedValue(json({
      offset: 0, limit: 250, size: 0, _links: { next: null, prev: null }, [key]: [],
    }));
    const runtime = runtimeFor(fetch);
    try {
      const result = await executeToolCall(operation(tool), {}, { runtime, configuration });
      expect(result.isError).toBeUndefined();
      const url = requested(fetch);
      expect(url).not.toContain('limit=');
      expect(url).not.toContain('offset=');
      expect(url).toMatch(new RegExp(`/api/v2/${tool.replace('testrail_', '')}$`));
    } finally { await runtime.shutdown(); }
  });

  it.each(['testrail_get_groups', 'testrail_get_roles'] as const)(
    '%s refuses a page control it could not honour', async (tool) => {
      const fetch = vi.fn().mockResolvedValue(json({ groups: [], roles: [] }));
      const runtime = runtimeFor(fetch);
      try {
        const result = await executeToolCall(operation(tool),
          { _mcp: { pagination: 'all', page_size: 10 } }, { runtime, configuration });
        expect(result.isError).toBe(true);
        expect((result.structuredContent as { error: { code: string } }).error.code).toBe('INVALID_ARGUMENT');
        expect(fetch).not.toHaveBeenCalled();
      } finally { await runtime.shutdown(); }
    });
});

/*
 * The identity comes from the configured credentials. A tool that accepted a user
 * argument here would suggest it could answer for someone else, which it cannot.
 */
describe('T08 the configured identity', () => {
  it('asks for the current user with no arguments at all', async () => {
    const fetch = vi.fn().mockResolvedValue(json(USER));
    const runtime = runtimeFor(fetch);
    try {
      const result = await executeToolCall(operation('testrail_get_current_user'), {}, { runtime, configuration });
      expect(result.isError).toBeUndefined();
      expect(requested(fetch)).toMatch(/\/api\/v2\/get_current_user$/);
    } finally { await runtime.shutdown(); }
  });

  it('refuses a user argument rather than ignoring it', async () => {
    const fetch = vi.fn().mockResolvedValue(json(USER));
    const runtime = runtimeFor(fetch);
    try {
      const result = await executeToolCall(operation('testrail_get_current_user'),
        { user_id: 2 }, { runtime, configuration });
      expect(result.isError).toBe(true);
      expect(fetch).not.toHaveBeenCalled();
    } finally { await runtime.shutdown(); }
  });
});
