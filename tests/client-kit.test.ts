import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { operationRegistry } from '../src/operations/catalog.js';

/*
 * R02's host-check kit: the C03 corpus a tester types into each client, and the evidence
 * records their results go into. The corpus must name one real task per API resource
 * whose expected tool and arguments the server would accept, without giving the answer
 * away in the prompt. A record may claim nothing it cannot show: every scenario starts
 * not_run, and a scenario reported as run needs the client, model, versions, negotiated
 * protocol, provenance and its own evidence. The client guide's status table and the
 * expected catalog it states are held to the records and the registry.
 */

const read = async (path: string): Promise<string> => readFile(new URL(path, import.meta.url), 'utf8');
const inventory = JSON.parse(await read('../docs/operation-inventory.json')) as { operations: { tool: string; resource: string }[] };
const guide = await read('../docs/client-compatibility.md');

const corpus = z.strictObject({
  schema_version: z.literal(1),
  purpose: z.string().min(1),
  tasks: z.array(z.strictObject({
    id: z.string().regex(/^[a-z-]+$/u),
    resource: z.string().min(1),
    prompt: z.string().min(10),
    tool: z.string().regex(/^testrail_[a-z_]+$/u),
    arguments: z.record(z.string(), z.json()),
  })),
}).parse(JSON.parse(await read('./fixtures/clients/c03-corpus.json')));

const SCENARIOS = Array.from({ length: 12 }, (_, index) => `C${String(index + 1).padStart(2, '0')}`);
const SURFACES = { 'codex-desktop': 'Codex desktop', 'codex-cli': 'Codex CLI', 'claude-code': 'Claude Code', 'copilot-cli': 'GitHub Copilot CLI' } as const;
const nullable = <T extends z.ZodType>(schema: T) => schema.nullable();
const text = z.string().min(1);

const recordSchema = z.strictObject({
  schema_version: z.literal(1),
  surface: z.enum(Object.values(SURFACES) as [string, ...string[]]),
  client: z.strictObject({ version: nullable(text), os: nullable(text), arch: nullable(text), node: nullable(text), model: nullable(text), provider: nullable(text) }),
  server: z.strictObject({ package_version: nullable(text), tarball_integrity: nullable(z.string().regex(/^sha512-[A-Za-z0-9+/]{86}==$/u)), driver_version: nullable(text) }),
  settings: z.strictObject({
    config_scope: nullable(text),
    discovery_mode: nullable(text),
    // Claude Code alone also records MCP_PROTOCOL_NEGOTIATION=auto.
    negotiated_revisions: z.strictObject({
      default: nullable(z.enum(['legacy', '2026-07-28'])),
      auto: nullable(z.enum(['legacy', '2026-07-28'])).optional(),
    }),
    // Variable names only, never values.
    variables: z.array(z.string().regex(/^TESTRAIL_[A-Z_]+$/u)),
  }),
  catalog: z.strictObject({ count: nullable(z.number().int()), sorted_names_sha256: nullable(z.string().regex(/^[0-9a-f]{64}$/u)) }),
  provenance: nullable(z.enum(['fixture_stand_in', 'live_testrail'])),
  testrail_version: nullable(text),
  tested_on: nullable(z.iso.date()),
  tester: nullable(text),
  scenarios: z.record(z.string().regex(/^C(0[1-9]|1[0-2])$/u), z.strictObject({
    status: z.enum(['not_run', 'pass', 'fail', 'blocked']),
    evidence: nullable(text),
    notes: nullable(text),
  })),
  limitations: z.array(text),
});

const directory = new URL('../docs/evidence/clients/', import.meta.url);
const records = await Promise.all((await readdir(directory)).filter((name) => name.endsWith('.json')).sort().map(async (name) => {
  const raw = await readFile(new URL(name, directory), 'utf8');
  return { slug: name.replace(/\.json$/u, ''), raw, record: recordSchema.parse(JSON.parse(raw)) };
}));

const names = operationRegistry.entries.map(({ tool }) => tool).sort();
const EXPECTED_HASH = createHash('sha256').update(names.join('\n')).digest('hex');

/** Every problem that would make a record claim more than it shows. */
function unsupported(record: z.infer<typeof recordSchema>): string[] {
  const problems: string[] = [];
  const ran = Object.entries(record.scenarios).filter(([, { status }]) => status !== 'not_run');
  for (const [id, { status, evidence, notes }] of ran) {
    if (evidence === null) problems.push(`${id} is ${status} without evidence`);
    if (status !== 'pass' && notes === null) problems.push(`${id} is ${status} without notes saying why`);
  }
  if (ran.length === 0) return problems;
  const required = {
    'client.version': record.client.version, 'client.os': record.client.os, 'client.node': record.client.node,
    'client.model': record.client.model, 'client.provider': record.client.provider,
    'server.package_version': record.server.package_version, 'server.tarball_integrity': record.server.tarball_integrity,
    'server.driver_version': record.server.driver_version, 'settings.discovery_mode': record.settings.discovery_mode,
    'settings.negotiated_revisions.default': record.settings.negotiated_revisions.default,
    provenance: record.provenance, tested_on: record.tested_on, tester: record.tester,
  };
  for (const [field, value] of Object.entries(required)) if (value === null) problems.push(`scenarios ran but ${field} is not recorded`);
  if (record.provenance === 'live_testrail' && record.testrail_version === null) problems.push('live evidence without the TestRail version');
  if (record.surface === 'Claude Code' && (record.settings.negotiated_revisions.auto ?? null) === null) {
    problems.push('Claude Code ran without its MCP_PROTOCOL_NEGOTIATION=auto negotiation recorded');
  }
  if (record.scenarios.C01?.status === 'pass'
    && (record.catalog.count !== names.length || record.catalog.sorted_names_sha256 !== EXPECTED_HASH)) {
    problems.push('C01 passes without the full 133-tool catalog and its hash');
  }
  return problems;
}

describe('the C03 corpus', () => {
  it('has one task per API resource, each for a tool of that resource', () => {
    const resources = [...new Set(inventory.operations.map(({ resource }) => resource))].sort();
    expect(corpus.tasks.map(({ resource }) => resource).sort()).toEqual(resources);
    expect(new Set(corpus.tasks.map(({ id }) => id)).size).toBe(corpus.tasks.length);
    const owner = new Map(inventory.operations.map(({ tool, resource }) => [tool, resource]));
    expect(corpus.tasks.filter(({ tool, resource }) => owner.get(tool) !== resource).map(({ id }) => id)).toEqual([]);
  });

  it('expects arguments each tool accepts', () => {
    const refused = corpus.tasks.filter(({ tool, arguments: input }) => operationRegistry.get(tool)?.inputSchema.safeParse(input).success !== true);
    expect(refused.map(({ id }) => id)).toEqual([]);
  });

  it('keeps the expected tool and argument names out of the prompt', () => {
    const keys = (value: unknown): string[] => typeof value === 'object' && value !== null && !Array.isArray(value)
      ? Object.entries(value).flatMap(([key, inner]) => [key, ...keys(inner)])
      : [];
    const leaked = corpus.tasks.flatMap(({ id, prompt, tool, arguments: input }) => {
      const lower = prompt.toLowerCase();
      // Identifier-like names only: a prompt may say "comment" or "name" as plain words.
      return [tool, tool.replace(/^testrail_/u, ''), 'testrail_', ...keys(input).filter((key) => key.includes('_'))]
        .filter((name) => lower.includes(name.toLowerCase()))
        .map((name) => `${id}: ${name}`);
    });
    expect(leaked).toEqual([]);
  });

  it('mixes reads and writes, overlapping case, test and result wording, and an administrative read', () => {
    const effects = corpus.tasks.map(({ tool }) => operationRegistry.get(tool)?.effects.testRail);
    expect(effects.filter((effect) => effect === 'write').length).toBeGreaterThanOrEqual(5);
    expect(effects.filter((effect) => effect === 'read').length).toBeGreaterThanOrEqual(15);
    for (const resource of ['Cases', 'Tests', 'Results', 'Users', 'Roles', 'Case Fields']) {
      expect(corpus.tasks.some((task) => task.resource === resource), resource).toBe(true);
    }
  });
});

describe('the client evidence records', () => {
  it('exist for exactly the four required surfaces, each with all twelve scenarios', () => {
    expect(records.map(({ slug, record }) => [slug, record.surface])).toEqual(Object.entries(SURFACES).sort());
    for (const { record } of records) expect(Object.keys(record.scenarios).sort()).toEqual(SCENARIOS);
    // Claude Code records both its default negotiation and MCP_PROTOCOL_NEGOTIATION=auto.
    expect(Object.keys(records.find(({ record }) => record.surface === 'Claude Code')?.record.settings.negotiated_revisions ?? {}).sort())
      .toEqual(['auto', 'default']);
  });

  it('claim nothing they do not show', () => {
    expect(records.flatMap(({ slug, record }) => unsupported(record).map((problem) => `${slug}: ${problem}`))).toEqual([]);
  });

  it('refuse a pass without its evidence, versions and catalog', () => {
    const [first] = records;
    if (first === undefined) throw new Error('no records');
    const claimed = structuredClone(first.record);
    claimed.scenarios.C01 = { status: 'pass', evidence: null, notes: null };
    expect(unsupported(claimed)).toEqual(expect.arrayContaining([
      'C01 is pass without evidence',
      'scenarios ran but client.version is not recorded',
      'scenarios ran but provenance is not recorded',
      'C01 passes without the full 133-tool catalog and its hash',
    ]));
  });

  it('carry no credential, email address or local path', () => {
    for (const { slug, raw } of records) {
      expect(raw, slug).not.toMatch(/authorization|basic\s+[A-Za-z0-9+/=]{8,}|[\w.+-]+@[\w-]+\.[\w.]+|\/(?:home|Users|root)\/|[A-Za-z]:[\\/]/iu);
    }
  });

  it('match the guide\'s status table and its stated catalog', () => {
    for (const { slug, record } of records) {
      const row = guide.split('\n').find((line) => line.startsWith(`| ${record.surface} |`)) ?? '';
      const cell = row.split('|').map((part) => part.trim()).at(-2);
      const ran = Object.values(record.scenarios).some(({ status }) => status !== 'not_run');
      if (ran) expect(cell, slug).toContain(`evidence/clients/${slug}.json`);
      else expect(cell, slug).toBe('Pending');
    }
    expect(guide).toContain(`${names.length} tools, sorted-name SHA-256 \`${EXPECTED_HASH}\``);
  });
});

describe('the catalog helper', () => {
  it('hashes the names in sorted order, whatever order a server lists them in', async () => {
    const script = new URL('../scripts/catalog-hash.mjs', import.meta.url).href;
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e',
      `import { catalogHash } from ${JSON.stringify(script)}; process.stdout.write(catalogHash(${JSON.stringify([...names].reverse())}));`]);
    expect(stdout).toBe(EXPECTED_HASH);
  });

  it('reports the installed server\'s 133 tools and their hash in both eras, without a TestRail request', async () => {
    const script = fileURLToPath(new URL('../scripts/catalog-hash.mjs', import.meta.url));
    const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
    const { stdout } = await promisify(execFile)(process.execPath, [script, '--command', process.execPath, '--arg', cli]);
    expect(JSON.parse(stdout)).toEqual({
      eras: {
        legacy: { count: names.length, sorted_names_sha256: EXPECTED_HASH, duplicates: 0 },
        '2026-07-28': { count: names.length, sorted_names_sha256: EXPECTED_HASH, duplicates: 0 },
      },
      testrail_requests: 0,
    });
  }, 30_000);
});
