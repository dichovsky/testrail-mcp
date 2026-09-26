import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TestRailClient } from '@dichovsky/testrail-api-client';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { loadConfiguration, type Configuration } from '../src/config/environment.js';
import { operationRegistry } from '../src/operations/catalog.js';
import { createRegistry, defineOperation, type Operation } from '../src/operations/registry.js';
import type { DriverCall } from '../src/operations/driver-call.js';
import { assertRegistryParity, compareRegistry, parseInventory } from '../src/operations/parity.js';
import { createRuntime } from '../src/runtime/invocation.js';
import { buildServer } from '../src/transport/server.js';
import { runRegisteredFixture } from './contracts/fixture-runner.js';
import { loadParameterManifests, type ParameterManifest } from './contracts/parameter-manifest.js';
import { auditRegisteredParameters, unregisteredManifests } from './contracts/registered-parameters.js';

/*
 * R01's regression gates, over the production registry and the authored manifests rather
 * than synthetic samples. The first block accounts for the whole inventory; the last shows
 * that each gate fails on the kind of mistake it exists to catch, by breaking a real
 * registration or a real manifest and running the gate over the result.
 */

const rawInventory = JSON.parse(await readFile(new URL('../docs/operation-inventory.json', import.meta.url), 'utf8')) as {
  counts: { operations: number; resources: number; families: number; http_methods: Record<string, number>;
    pagination: Record<string, number>; additional_page_and_all_helpers: number };
  families: { id: string; resources: string[]; operation_count: number }[];
  operations: { tool: string; resource: string; family_id: string }[];
};
const inventory = parseInventory(rawInventory);
const manifests = await loadParameterManifests();

/** The product contract's own numbers, stated here rather than read from the inventory they check. */
const CONTRACT = { operations: 133, resources: 28, families: 12, paged: 24 } as const;

function counted<T>(values: readonly T[]): Map<T, number> {
  const counts = new Map<T, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
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

function fixture(tool: string, id: string): ParameterManifest['cases'][number] {
  const found = manifestFor(tool).cases.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`${tool} has no fixture ${id}`);
  return found;
}

describe('the registry accounts for the whole inventory', () => {
  it('holds the contract\'s 133 operations, 28 resources, 12 families and 24 page/all pairs', () => {
    const paged = inventory.filter(({ pagination }) => pagination.kind !== 'none');
    expect(inventory).toHaveLength(CONTRACT.operations);
    expect(new Set(rawInventory.operations.map(({ resource }) => resource)).size).toBe(CONTRACT.resources);
    expect(new Set(inventory.map(({ family_id: family }) => family)).size).toBe(CONTRACT.families);
    expect(paged).toHaveLength(CONTRACT.paged);

    // The inventory's declared totals agree with its own rows, key for key: a declared
    // method or paging kind that no row carries fails here as well as a wrong count.
    expect(rawInventory.counts).toEqual({
      operations: inventory.length,
      resources: CONTRACT.resources,
      families: CONTRACT.families,
      http_methods: Object.fromEntries(counted(inventory.map(({ http_method: method }) => method))),
      pagination: Object.fromEntries(counted(inventory.map(({ pagination }) => pagination.kind))),
      additional_page_and_all_helpers: 2 * paged.length,
    });
    for (const family of rawInventory.families) {
      const rows = rawInventory.operations.filter(({ family_id: id }) => id === family.id);
      expect(rows, family.id).toHaveLength(family.operation_count);
      expect([...new Set(rows.map(({ resource }) => resource))].sort(), family.id).toEqual([...family.resources].sort());
    }
  });

  it('registers every inventory endpoint exactly, with nothing extra and nothing pending', () => {
    const report = compareRegistry(operationRegistry, inventory);
    expect(report).toEqual({ missing: [], extra: [], differences: [] });
    expect(() => { assertRegistryParity(report, true); }).not.toThrow();
    expect(operationRegistry.entries).toHaveLength(CONTRACT.operations);
  });

  /*
   * A registration names its family but not its resource, so a resource is accounted for
   * through the family that owns it: every registered tool must sit in the family the
   * inventory gives its resource, and each family must hold exactly its own tools.
   */
  it('registers each family with exactly its own tools, and each resource under the family that owns it', () => {
    const ownerOf = new Map(rawInventory.families.flatMap(({ id, resources }) => resources.map((resource) => [resource, id] as const)));
    expect(ownerOf.size).toBe(CONTRACT.resources);
    const resourceOf = new Map(rawInventory.operations.map(({ tool, resource }) => [tool, resource]));
    for (const { tool, family } of operationRegistry.entries) {
      expect(family, tool).toBe(ownerOf.get(resourceOf.get(tool) ?? ''));
    }
    const byFamily = (rows: readonly { tool: string; family: string }[]) => {
      const groups = new Map<string, string[]>();
      for (const { tool, family } of rows) groups.set(family, [...(groups.get(family) ?? []), tool].sort());
      return groups;
    };
    expect(byFamily(operationRegistry.entries))
      .toEqual(byFamily(rawInventory.operations.map(({ tool, family_id: family }) => ({ tool, family }))));
  });

  it('binds each of the 24 page/all pairs to the inventory\'s helpers', () => {
    const helpers = (entries: readonly { tool: string; kind: string; page: string | null; all: string | null }[]) =>
      entries.filter(({ kind }) => kind !== 'none').map((entry) => ({ ...entry })).sort((left, right) => left.tool.localeCompare(right.tool));
    const fromRegistry = helpers(operationRegistry.entries.map(({ tool, pagination }) => pagination.kind === 'none'
      ? { tool, kind: 'none', page: null, all: null }
      : { tool, kind: pagination.kind, page: pagination.page.binding, all: pagination.all.binding }));
    const fromInventory = helpers(inventory.map(({ tool, pagination }) => ({
      tool, kind: pagination.kind, page: pagination.page_method, all: pagination.all_method,
    })));
    expect(fromRegistry).toHaveLength(CONTRACT.paged);
    expect(fromRegistry).toEqual(fromInventory);
    // Forty-eight distinct helpers: no two lists share one.
    expect(new Set(fromRegistry.flatMap(({ page, all }) => [page, all])).size).toBe(2 * CONTRACT.paged);
  });

  it('pairs every registration with a complete manifest, and every manifest with a registration', () => {
    expect(manifests).toHaveLength(CONTRACT.operations);
    expect(auditRegisteredParameters(operationRegistry, manifests)).toEqual([]);
    expect(unregisteredManifests(operationRegistry, manifests)).toEqual([]);
  });
});

describe('the served catalog is the inventory, in both protocol eras', () => {
  let base: string;
  let configuration: Configuration;

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), 'testrail-mcp-gates-'));
    configuration = await loadConfiguration({
      TESTRAIL_BASE_URL: 'https://gates.testrail.io',
      TESTRAIL_EMAIL: 'user@example.com',
      TESTRAIL_API_KEY: 'synthetic',
      TESTRAIL_MCP_UPLOAD_ROOTS: JSON.stringify([base]),
      TESTRAIL_MCP_DOWNLOAD_DIR: base,
    });
  });

  afterAll(async () => { await rm(base, { recursive: true, force: true }); });

  async function discover(negotiation: 'legacy' | { readonly pin: string }) {
    let requests = 0;
    const driver = new TestRailClient({
      baseUrl: configuration.baseUrl, email: configuration.email, apiKey: configuration.apiKey,
      registerProcessHandlers: false, maxRetries: 0,
      dnsLookup: () => Promise.resolve([{ address: '203.0.113.10', family: 4 }]),
      fetch: () => { requests += 1; return Promise.resolve(new Response('{}')); },
    });
    const runtime = createRuntime({ client: driver, limits: configuration.limits });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const handle = serveStdio(() => buildServer({
      configuration, runtime, registry: operationRegistry, stagingDirectory: () => Promise.resolve(base),
    }), { transport: serverTransport });
    const client = new Client({ name: 'regression-gates', version: '1.0.0' }, { versionNegotiation: { mode: negotiation } });
    try {
      await client.connect(clientTransport);
      const first = (await client.listTools()).tools;
      const second = (await client.listTools()).tools;
      return { era: client.getProtocolEra(), first, second, requests };
    } finally {
      await client.close().catch(() => undefined);
      await handle.close().catch(() => undefined);
      await runtime.shutdown();
    }
  }

  it.each([
    ['legacy', 'legacy'],
    ['modern', { pin: '2026-07-28' }],
  ] as const)('lists exactly the 133 inventory tools to a %s client, identically each time and without a request', async (era, negotiation) => {
    const session = await discover(negotiation);
    expect(session.era).toBe(era);
    const names = session.first.map(({ name }) => name);
    expect(names).toHaveLength(CONTRACT.operations);
    expect(new Set(names).size).toBe(CONTRACT.operations);
    for (const name of names) expect(name).toMatch(/^testrail_[a-z][a-z0-9_]*$/u);
    // No helper, dispatcher or generic tool: the names are the inventory's, one for one.
    expect([...names].sort()).toEqual(inventory.map(({ tool }) => tool).sort());
    expect(JSON.stringify(session.second)).toBe(JSON.stringify(session.first));
    expect(session.requests).toBe(0);
  });

  it('serves the same catalog to both eras', async () => {
    const legacy = await discover('legacy');
    const modern = await discover({ pin: '2026-07-28' });
    // Structurally: the eras order a schema's keys differently, as docs/transport.md records.
    expect(legacy.first).toEqual(modern.first);
  });
});

/** A registration with one call replaced: the kind of edit that breaks a tool while it still type-checks. */
function withCall(operation: Operation, mode: 'single' | 'page' | 'all', call: DriverCall): Operation {
  if (operation.pagination.kind === 'none') {
    if (mode !== 'single') throw new Error(`${operation.tool} has no ${mode} call`);
    return { ...operation, pagination: { ...operation.pagination, single: call } };
  }
  if (mode === 'single') throw new Error(`${operation.tool} pages`);
  return { ...operation, pagination: { ...operation.pagination, [mode]: call } };
}

/** The same call, handed an input the registration rewrote after validating the caller's. */
function rewriting(call: DriverCall, rewrite: (input: Record<string, unknown>) => Record<string, unknown>): DriverCall {
  return { ...call, invoke: (client, input, context) => call.invoke(client, rewrite(input as Record<string, unknown>), context) };
}

function without(record: unknown, key: string): Record<string, unknown> {
  const copy = { ...(record as Record<string, unknown>) };
  delete copy[key];
  return copy;
}

/*
 * Each test below runs its gate twice: on the unbroken production sample, where it must
 * pass, and on the broken one, where it must fail. Without the first half a gate that
 * rejects everything would pass these tests too.
 */
describe('each gate fails on the mistake it exists to catch', () => {
  let unbrokenAudit: string[] | undefined;
  /** The full audit is the slowest gate here, so the unbroken result is computed once. */
  const auditUnbroken = () => (unbrokenAudit ??= auditRegisteredParameters(operationRegistry, manifests));

  it('fails an omitted endpoint, both against the inventory and against its manifest', () => {
    expect(() => { assertRegistryParity(compareRegistry(operationRegistry, inventory), true); }).not.toThrow();
    expect(unregisteredManifests(operationRegistry, manifests)).toEqual([]);
    expect(auditUnbroken()).toEqual([]);
    const broken = createRegistry(...operationRegistry.entries.filter(({ tool }) => tool !== 'testrail_get_project'));
    expect(() => { assertRegistryParity(compareRegistry(broken, inventory), true); })
      .toThrow('Missing: GET get_project/{project_id} -> testrail_get_project -> projects.getProject');
    expect(unregisteredManifests(broken, manifests)).toEqual(['testrail_get_project: manifest has no production registration']);
    // A manifest removed instead leaves its registration unreviewed.
    expect(auditRegisteredParameters(operationRegistry, manifests.filter(({ endpoint }) => endpoint.tool !== 'testrail_get_project')))
      .toEqual(['testrail_get_project: missing independent parameter manifest']);
  });

  it('fails a registration that puts the wrong ID in the path', async () => {
    const sections = registered('testrail_get_sections');
    if (sections.pagination.kind === 'none') throw new Error('get_sections pages');
    // The suite filter's value sent as the project: the path still holds a valid ID.
    const broken = withCall(sections, 'page', rewriting(sections.pagination.page, (input) => ({
      ...input, project_id: (input.query as { suite_id?: number } | undefined)?.suite_id ?? input.project_id,
    })));
    const promised = fixture('testrail_get_sections', 'suite-filter');
    await expect(runRegisteredFixture(sections, manifestFor('testrail_get_sections'), promised)).resolves.toBeUndefined();
    await expect(runRegisteredFixture(broken, manifestFor('testrail_get_sections'), promised)).rejects.toThrow();
  });

  it('fails a registration that drops an optional query filter', async () => {
    const cases = registered('testrail_get_cases');
    if (cases.pagination.kind === 'none') throw new Error('get_cases pages');
    const broken = withCall(cases, 'page', rewriting(cases.pagination.page, (input) => ({
      ...input, query: without(input.query, 'priority_id'),
    })));
    const promised = fixture('testrail_get_cases', 'scalar-filters');
    await expect(runRegisteredFixture(cases, manifestFor('testrail_get_cases'), promised)).resolves.toBeUndefined();
    await expect(runRegisteredFixture(broken, manifestFor('testrail_get_cases'), promised)).rejects.toThrow();
  });

  it('fails a registration that drops an optional body field', async () => {
    const addCase = registered('testrail_add_case');
    if (addCase.pagination.kind !== 'none') throw new Error('add_case does not page');
    const broken = withCall(addCase, 'single', rewriting(addCase.pagination.single, (input) => ({
      ...input, body: without(input.body, 'estimate'),
    })));
    const promised = fixture('testrail_add_case', 'full-body');
    await expect(runRegisteredFixture(addCase, manifestFor('testrail_add_case'), promised)).resolves.toBeUndefined();
    await expect(runRegisteredFixture(broken, manifestFor('testrail_add_case'), promised)).rejects.toThrow();
  });

  it('refuses a registration that would accept unknown input', () => {
    const project = registered('testrail_get_project');
    if (project.pagination.kind !== 'none') throw new Error('get_project does not page');
    const { single } = project.pagination;
    const permissive = z.looseObject({ project_id: z.int().positive() });
    /*
     * Refused where it is defined, before it can reach a catalog. The call must carry the
     * same schema as the operation, or the definition fails its schema-identity check first
     * and the looseness itself is never examined. Either closed-input guard may refuse it.
     */
    expect(() => defineOperation(project)).not.toThrow();
    expect(() => defineOperation({
      ...project, inputSchema: permissive,
      pagination: { kind: 'none', single: { ...single, inputSchema: permissive } },
    })).toThrow(/explicitly reject unknown keys|must be closed objects/u);
    // Were it slipped in after definition, the audit sees the manifest's unknown-key rejection accepted.
    expect(auditRegisteredParameters(createRegistry(project), manifests)).toEqual([]);
    const slipped = { ...project, inputSchema: permissive } as unknown as Operation;
    const unknownKey = manifestFor('testrail_get_project').cases
      .filter(({ expect: outcome }) => outcome.kind === 'rejected')
      .filter(({ input }) => permissive.safeParse(input).success);
    expect(unknownKey.length).toBeGreaterThan(0);
    expect(auditRegisteredParameters(createRegistry(slipped), manifests)).toEqual(
      unknownKey.map(({ id }) => `testrail_get_project: runtime schema disagrees with fixture ${id}`));
  });

  it('fails two tools bound to one driver method', () => {
    expect(compareRegistry(operationRegistry, inventory).differences).toEqual([]);
    const suite = registered('testrail_get_suite');
    const duplicate = { ...suite, driverBinding: 'projects.getProject' } as unknown as Operation;
    const broken = createRegistry(...operationRegistry.entries.map((entry) => entry.tool === suite.tool ? duplicate : entry));
    expect(compareRegistry(broken, inventory).differences).toEqual([
      { tool: 'testrail_get_suite', field: 'driver_binding', expected: 'suites.getSuite', actual: 'projects.getProject' },
    ]);
    expect(() => { assertRegistryParity(compareRegistry(broken, inventory), true); })
      .toThrow('testrail_get_suite driver_binding: expected suites.getSuite, received projects.getProject');
  });

  it('fails a registration whose HTTP method or route differs from the inventory', () => {
    expect(compareRegistry(operationRegistry, inventory).differences).toEqual([]);
    const project = registered('testrail_get_project');
    // The wire method comes from the driver, so only this comparison sees a wrong one.
    const posted = { ...project, method: 'POST' } as unknown as Operation;
    const moved = { ...project, route: 'get_project/{project_id}/details' } as unknown as Operation;
    for (const [broken, field, actual] of [[posted, 'method', 'POST'], [moved, 'route', 'get_project/{project_id}/details']] as const) {
      const registry = createRegistry(...operationRegistry.entries.map((entry) => entry.tool === project.tool ? broken : entry));
      expect(compareRegistry(registry, inventory).differences).toEqual([
        { tool: project.tool, field, expected: field === 'method' ? 'GET' : 'get_project/{project_id}', actual },
      ]);
    }
  });

  it('fails a list that claims page/all helpers its endpoint does not have', () => {
    expect(compareRegistry(operationRegistry, inventory).differences).toEqual([]);
    const forTest = registered('testrail_get_attachments_for_test');
    const forCase = registered('testrail_get_attachments_for_case');
    if (forCase.pagination.kind === 'none') throw new Error('get_attachments_for_case pages');
    const claimed = { ...forTest, pagination: forCase.pagination } as Operation;
    const broken = createRegistry(...operationRegistry.entries.map((entry) => entry.tool === forTest.tool ? claimed : entry));
    expect(compareRegistry(broken, inventory).differences).toEqual([
      { tool: forTest.tool, field: 'pagination.kind', expected: 'none', actual: 'controlled' },
      { tool: forTest.tool, field: 'pagination.page_binding', expected: null, actual: forCase.pagination.page.binding },
      { tool: forTest.tool, field: 'pagination.all_binding', expected: null, actual: forCase.pagination.all.binding },
    ]);
  });

  // get_sections has three accepted fixtures carrying the suite filter, two in page mode and
  // one in all mode; with all of them gone, nothing shows the filter reaches either call.
  it('fails a manifest that loses every fixture exercising an optional parameter', () => {
    expect(auditUnbroken()).toEqual([]);
    const manifest = manifestFor('testrail_get_sections');
    const thinned = { ...manifest, cases: manifest.cases.filter(({ expect: outcome, input }) =>
      outcome.kind !== 'accepted' || (input.query as { suite_id?: unknown } | undefined)?.suite_id === undefined) };
    const others = manifests.filter((candidate) => candidate !== manifest);
    expect(auditRegisteredParameters(operationRegistry, [...others, thinned])).toEqual([
      'testrail_get_sections: no accepted page fixture supplies query.suite_id',
      'testrail_get_sections: no accepted all fixture supplies query.suite_id',
    ]);
  });

  it('fails a fixture whose promised path ID the registration does not send', async () => {
    const promised = fixture('testrail_get_project', 'representative-id');
    if (promised.expect.kind !== 'accepted') throw new Error('Expected an accepted fixture');
    await expect(runRegisteredFixture(registered('testrail_get_project'), manifestFor('testrail_get_project'), promised)).resolves.toBeUndefined();
    const altered = { ...promised, expect: { ...promised.expect, wire: { ...promised.expect.wire, endpoint: 'get_project/2' } } };
    await expect(runRegisteredFixture(registered('testrail_get_project'), manifestFor('testrail_get_project'), altered)).rejects.toThrow();
  });
});
