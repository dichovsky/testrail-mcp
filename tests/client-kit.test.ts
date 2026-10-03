import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { operationRegistry } from '../src/operations/catalog.js';

/*
 * R02's host-check kit: the C03 corpus a tester types into each client, and the evidence
 * records their results go into. The corpus must name one real task per API resource
 * whose expected tool and arguments the server would accept, with every expected value in
 * the prompt and neither the tool nor an argument name. A record may claim nothing it
 * cannot show: a record of nothing run states nothing; a blocked surface says when, who,
 * which client and why; a scenario that passed or failed needs the client, model,
 * versions, provenance and its own evidence, and a pass the negotiated protocol. The
 * client guide's status table and the expected catalog it states are held to the records
 * and the registry.
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
      // `unsupported` when the installed runtime has no MCP_PROTOCOL_NEGOTIATION=auto.
      auto: nullable(z.enum(['legacy', '2026-07-28', 'unsupported'])).optional(),
    }),
    // Variable names only, never values.
    variables: z.array(z.string().regex(/^(?:TESTRAIL_[A-Z_]+|MCP_PROTOCOL_NEGOTIATION)$/u)),
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

type ClientRecord = z.infer<typeof recordSchema>;

/** Every problem that would make a record claim more than it shows. */
function unsupported(record: ClientRecord): string[] {
  const problems: string[] = [];
  const scenarios = Object.entries(record.scenarios);
  for (const [id, { status, evidence, notes }] of scenarios) {
    if (status === 'not_run' && evidence !== null) problems.push(`${id} is not_run but cites evidence`);
    if ((status === 'pass' || status === 'fail') && evidence === null) problems.push(`${id} is ${status} without evidence`);
    if ((status === 'fail' || status === 'blocked') && notes === null) problems.push(`${id} is ${status} without notes saying why`);
  }
  const missing = (fields: Record<string, unknown>, reason: string) => {
    for (const [field, value] of Object.entries(fields)) if (value === null || value === undefined) problems.push(`${reason} but ${field} is not recorded`);
  };
  const attempted = scenarios.some(([, { status }]) => status !== 'not_run');
  const exercised = scenarios.some(([, { status }]) => status === 'pass' || status === 'fail');
  const passed = scenarios.some(([, { status }]) => status === 'pass');
  if (!attempted) {
    // A record of nothing run states nothing about a run.
    const { settings, catalog } = record;
    const stated = Object.entries({
      ...record.client, ...record.server, config_scope: settings.config_scope, discovery_mode: settings.discovery_mode,
      ...settings.negotiated_revisions, ...catalog, provenance: record.provenance, testrail_version: record.testrail_version,
      tested_on: record.tested_on, tester: record.tester,
    }).filter(([, value]) => value !== null && value !== undefined);
    for (const [field] of stated) problems.push(`nothing ran but ${field} is stated`);
    if (settings.variables.length > 0) problems.push('nothing ran but variables are stated');
    if (record.limitations.length > 0) problems.push('nothing ran but limitations are stated');
    for (const [id, { notes }] of scenarios) if (notes !== null) problems.push(`nothing ran but ${id} has notes`);
    return problems;
  }
  // Even a blocked surface says when, who and which client.
  missing({ tested_on: record.tested_on, tester: record.tester, 'client.version': record.client.version, 'client.os': record.client.os }, 'a scenario was attempted');
  if (exercised) {
    missing({
      'client.node': record.client.node, 'client.model': record.client.model, 'client.provider': record.client.provider,
      'server.package_version': record.server.package_version, 'server.tarball_integrity': record.server.tarball_integrity,
      'server.driver_version': record.server.driver_version, 'settings.discovery_mode': record.settings.discovery_mode, provenance: record.provenance,
    }, 'a scenario passed or failed');
  }
  // A pass means the server connected, so the session negotiated a revision.
  if (passed) missing({ 'settings.negotiated_revisions.default': record.settings.negotiated_revisions.default }, 'a scenario passed');
  if (passed && record.surface === 'Claude Code') {
    missing({ 'settings.negotiated_revisions.auto': record.settings.negotiated_revisions.auto }, 'Claude Code passed a scenario');
  }
  if (record.provenance === 'live_testrail' && record.testrail_version === null) problems.push('live evidence without the TestRail version');
  if (record.scenarios.C01?.status === 'pass'
    && (record.catalog.count !== names.length || record.catalog.sorted_names_sha256 !== EXPECTED_HASH)) {
    problems.push('C01 passes without the full 133-tool catalog and its hash');
  }
  return problems;
}

/** Hash fields are the one place a long run of letters and digits belongs. */
const HASH_FIELDS = new Set(['server.tarball_integrity', 'catalog.sorted_names_sha256']);
/** A web link is evidence, checked apart from the text around it. */
const LINK = /\bhttps?:\/\/[^\s)\]>"'`]+/gu;
/** A credential in a link: user information, or a parameter that carries a secret. */
const LINK_CREDENTIAL = /^https?:\/\/[^/?#\s]*@|[?&#;](?:access[_-]?token|api[_-]?key|apikey|auth|client[_-]?secret|credentials?|jwt|key|password|private[_-]?token|secret|sig|signature|token|x-amz-[a-z-]+)=/iu;
/** A TestRail API path in prose, such as GET /index.php?/api/v2/get_case/42, is not a local path. */
const API_PATH = /(?:\/?index\.php\?)?\/api\/v2\/[\w/&=.?-]*/gu;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,}\b/u;
/** The pieces of an ordinary name: words, camel case, numbers, and IDs such as C01 or R02. */
const NATURAL = /^(?:(?:[A-Z]?[a-z]+)+\d*|[A-Z]+\d*|\d+[a-z]*)$/u;
const SERVICE_TOKEN = /\b(?:gh[oprsu]_|github_pat_|glpat-|[rs]k_(?:live|test)_|xox[abeprs]-|AKIA)[\w-]{10,}/u;

/**
 * A secret-like run: 20 or more letters, digits and / . - _ + =, with a letter and a
 * digit, that is neither a commit SHA or SHA-256 digest nor built from the pieces of an
 * ordinary name, as a file path, a version or a run ID is; or a service token.
 */
const keyLike = {
  test: (text: string): boolean => SERVICE_TOKEN.test(text) || [...text.matchAll(/(?<![\w+/=.-])[\w+/=.-]{20,}/gu)].some(([run]) =>
    /\d/u.test(run) && /[A-Za-z]/u.test(run)
    && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(run)
    && !run.split(/[/._+=-]+/u).filter(Boolean).every((piece) => NATURAL.test(piece))),
};

const LEAKS: [string, { test: (text: string) => boolean }][] = [
  // A header value, not the word: "Basic discovery works" and "Basic 133-tool discovery" are prose.
  ['a credential header', /\b(?:[Bb]asic|BASIC|[Bb]earer|BEARER)\s+(?=[A-Za-z0-9+/=._-]*\d)(?=[A-Za-z0-9+/=._-]*[a-z])(?=[A-Za-z0-9+/=._-]*[A-Z])[A-Za-z0-9+/=._-]{12,}|\b(?:[Aa]uthorization|AUTHORIZATION)\s*[:=]\s*(?:[Bb]asic|BASIC|[Bb]earer|BEARER|[Tt]oken|TOKEN)\b/u],
  ['an email address', EMAIL],
  // An absolute path, a home-relative one, a home or user-directory variable, a drive, a
  // network share or a file link. A relative path, a package spec or "and/or" is not.
  ['a local path', /(?<![\w@.~$%+-])\/[\w.@+-]+\/|(?<![\w@.~$%+-])\/(?:home|Users|root|tmp|private|var|opt|mnt|srv|Volumes|workspace|data)\b|~[\w.-]*\/|~[a-z_][\w.-]*\b|\$HOME\b|\$\{HOME\}|\$env:\w+|\$XDG_\w+|%[A-Za-z_]+%[\\/]|(?<![A-Za-z])[A-Za-z]:(?:\\|\/(?!\/))|\\\\[\w.$-]+\\|\bfile:/iu],
  // In any form: NAME=value, NAME: value, or a pasted "NAME": "value" map. A ${NAME} reference is not a value.
  ['a variable value', /\bTESTRAIL_[A-Z_]+"?\s*[:=]\s*(?!"?\$\{)\S/u],
  ['a key-like token', keyLike],
];

/** Whether a link carries a credential: in its user information or parameters, or as a token or address in its path or query. */
function linkLeaks(link: string): boolean {
  if (LINK_CREDENTIAL.test(link)) return true;
  const [, host = '', rest = ''] = /^https?:\/\/([^/?#]*)(.*)$/u.exec(link) ?? [];
  // A GitHub path names repositories, branches, commits and runs; elsewhere a path can carry a token.
  const checked = /(?:^|\.)github\.com$/iu.test(host) ? rest.replace(/^[^?#]*/u, '') : rest;
  return keyLike.test(checked) || EMAIL.test(checked);
}

/** Every text in a record that looks like a credential, an email address, a local path or a secret. */
function leaks(record: unknown): string[] {
  const found: string[] = [];
  const visit = (value: unknown, path: string) => {
    if (typeof value === 'string') {
      if (HASH_FIELDS.has(path)) return;
      if ((value.match(LINK) ?? []).some(linkLeaks)) found.push(`${path} holds a credential in a link`);
      const text = value.replace(LINK, '<link>').replace(API_PATH, '<api>');
      for (const [kind, pattern] of LEAKS) if (pattern.test(text)) found.push(`${path} holds ${kind}`);
    } else if (Array.isArray(value)) {
      value.forEach((item, index) => { visit(item, `${path}[${String(index)}]`); });
    } else if (typeof value === 'object' && value !== null) {
      for (const [key, inner] of Object.entries(value)) visit(inner, path === '' ? key : `${path}.${key}`);
    }
  };
  visit(record, '');
  return found;
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
    const camel = (name: string): string => name.replace(/_([a-z])/gu, (_match, letter: string) => letter.toUpperCase());
    const leaked = corpus.tasks.flatMap(({ id, prompt, tool, arguments: input }) => {
      const lower = prompt.toLowerCase();
      const bare = tool.replace(/^testrail_/u, '');
      // Identifier-like argument names only: a prompt may say "comment" or "name" as plain
      // words. The tool's name counts in any spelling: snake, spaced, kebab or camel case.
      return [tool, bare, bare.replaceAll('_', ' '), bare.replaceAll('_', '-'), camel(bare), 'testrail_', ...keys(input).filter((key) => key.includes('_')).flatMap((key) => [key, camel(key)])]
        .filter((name) => lower.includes(name.toLowerCase()))
        .map((name) => `${id}: ${name}`);
    });
    expect(leaked).toEqual([]);
  });

  it('states every expected argument value in the prompt, so a choice can be graded against it', () => {
    const leaves = (value: unknown, path: string): [string, unknown][] => typeof value === 'object' && value !== null
      ? Object.entries(value).flatMap(([key, inner]) => leaves(inner, path === '' ? key : `${path}.${key}`))
      : [[path, value]];
    // As a whole value: 4 is not stated by "group 14", nor 1 by "build 2.1".
    const stated = (prompt: string, value: unknown) =>
      new RegExp(`(?<![\\w.])${String(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(?![\\w]|\\.\\w)`, 'u').test(prompt);
    const unstated = corpus.tasks.flatMap(({ id, prompt, arguments: input }) => leaves(input, '')
      .filter(([, value]) => !stated(prompt, value))
      .map(([path, value]) => `${id}: ${path} = ${JSON.stringify(value)}`));
    expect(unstated).toEqual([]);
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

  /** Every scenario back to not_run, so a test record starts from the committed shape alone, whatever was run. */
  const unrun = (record: ClientRecord): ClientRecord => {
    for (const id of SCENARIOS) record.scenarios[id] = { status: 'not_run', evidence: null, notes: null };
    record.limitations = [];
    return record;
  };

  /** A Claude Code record of a full, clean C01 pass, which every rule accepts. */
  const complete = (): ClientRecord => {
    const found = records.find(({ record: candidate }) => candidate.surface === 'Claude Code')?.record;
    if (found === undefined) throw new Error('no Claude Code record');
    const record = unrun(structuredClone(found));
    record.client = { version: '2.1.0', os: 'macOS 15', arch: 'arm64', node: '24.1.0', model: 'a model', provider: 'a provider' };
    record.server = { package_version: '1.0.0', tarball_integrity: `sha512-${'A'.repeat(86)}==`, driver_version: '7.2.0' };
    record.settings = { config_scope: 'user', discovery_mode: 'automatic', negotiated_revisions: { default: 'legacy', auto: '2026-07-28' }, variables: ['TESTRAIL_BASE_URL', 'MCP_PROTOCOL_NEGOTIATION'] };
    record.catalog = { count: names.length, sorted_names_sha256: EXPECTED_HASH };
    record.provenance = 'fixture_stand_in';
    record.tested_on = '2026-10-01';
    record.tester = 'a tester';
    record.scenarios.C01 = { status: 'pass', evidence: 'https://github.com/dichovsky/testrail-mcp/actions/runs/1', notes: null };
    return record;
  };
  const refusal = (change: (record: ClientRecord) => void): string[] => {
    const record = complete();
    change(record);
    return unsupported(record);
  };

  it('accept a complete record, and a blocked surface that says when, who, which client and why', () => {
    expect(unsupported(complete())).toEqual([]);
    const first = records[0]?.record;
    if (first === undefined) throw new Error('no records');
    const blocked = unrun(structuredClone(first));
    blocked.scenarios.C01 = { status: 'blocked', evidence: null, notes: 'No supported model on this account.' };
    Object.assign(blocked, { tested_on: '2026-10-01', tester: 'a tester' });
    Object.assign(blocked.client, { version: '1.0.67', os: 'Linux' });
    expect(unsupported(blocked)).toEqual([]);
    expect(refusal((record) => { record.settings.negotiated_revisions.auto = 'unsupported'; })).toEqual([]);
    // Only Claude Code records an auto negotiation.
    expect(refusal((record) => { record.surface = 'Codex CLI'; delete record.settings.negotiated_revisions.auto; })).toEqual([]);
  });

  /** C01 blocked, and nothing passed or failed. */
  const blocked = (record: ClientRecord) => { record.scenarios.C01 = { status: 'blocked', evidence: null, notes: 'No supported model on this account.' }; };
  /** Nothing run at all. */
  const nothing = (record: ClientRecord) => { record.scenarios.C01 = { status: 'not_run', evidence: null, notes: null }; };

  it.each<[string, (record: ClientRecord) => void, string]>([
    ['a pass without evidence', (record) => { record.scenarios.C01 = { status: 'pass', evidence: null, notes: null }; }, 'C01 is pass without evidence'],
    ['a failure without evidence', (record) => { record.scenarios.C02 = { status: 'fail', evidence: null, notes: 'It listed 120 tools.' }; }, 'C02 is fail without evidence'],
    ['a failure without notes', (record) => { record.scenarios.C02 = { status: 'fail', evidence: 'a log', notes: null }; }, 'C02 is fail without notes saying why'],
    ['a block without notes', (record) => { record.scenarios.C02 = { status: 'blocked', evidence: null, notes: null }; }, 'C02 is blocked without notes saying why'],
    ['evidence for a scenario not run', (record) => { record.scenarios.C02 = { status: 'not_run', evidence: 'a log', notes: null }; }, 'C02 is not_run but cites evidence'],
    ['a pass with no model', (record) => { record.client.model = null; }, 'a scenario passed or failed but client.model is not recorded'],
    ['a pass with no provenance', (record) => { record.provenance = null; }, 'a scenario passed or failed but provenance is not recorded'],
    ['a pass with no negotiated revision', (record) => { record.settings.negotiated_revisions.default = null; }, 'a scenario passed but settings.negotiated_revisions.default is not recorded'],
    ['Claude Code with no auto negotiation', (record) => { record.settings.negotiated_revisions.auto = null; }, 'Claude Code passed a scenario but settings.negotiated_revisions.auto is not recorded'],
    ['live evidence with no TestRail version', (record) => { record.provenance = 'live_testrail'; }, 'live evidence without the TestRail version'],
    ['a C01 pass with the right count and a wrong hash', (record) => { record.catalog.sorted_names_sha256 = '0'.repeat(64); }, 'C01 passes without the full 133-tool catalog and its hash'],
    ['a C01 pass with a short catalog', (record) => { record.catalog.count = names.length - 1; }, 'C01 passes without the full 133-tool catalog and its hash'],
    ['an attempt with no tester', (record) => { record.tester = null; }, 'a scenario was attempted but tester is not recorded'],
    ['a blocked surface with no test date', (record) => { blocked(record); record.tested_on = null; }, 'a scenario was attempted but tested_on is not recorded'],
    ['a blocked surface with no tester', (record) => { blocked(record); record.tester = null; }, 'a scenario was attempted but tester is not recorded'],
    ['a blocked surface with no client version', (record) => { blocked(record); record.client.version = null; }, 'a scenario was attempted but client.version is not recorded'],
    ['a blocked surface with no OS', (record) => { blocked(record); record.client.os = null; }, 'a scenario was attempted but client.os is not recorded'],
    ['a pass with no Node version', (record) => { record.client.node = null; }, 'a scenario passed or failed but client.node is not recorded'],
    ['a pass with no provider', (record) => { record.client.provider = null; }, 'a scenario passed or failed but client.provider is not recorded'],
    ['a pass with no package version', (record) => { record.server.package_version = null; }, 'a scenario passed or failed but server.package_version is not recorded'],
    ['a pass with no tarball integrity', (record) => { record.server.tarball_integrity = null; }, 'a scenario passed or failed but server.tarball_integrity is not recorded'],
    ['a pass with no driver version', (record) => { record.server.driver_version = null; }, 'a scenario passed or failed but server.driver_version is not recorded'],
    ['a pass with no discovery mode', (record) => { record.settings.discovery_mode = null; }, 'a scenario passed or failed but settings.discovery_mode is not recorded'],
    ['a record of nothing run that states a client version', (record) => { nothing(record); }, 'nothing ran but version is stated'],
    ['a record of nothing run that states a package version', (record) => { nothing(record); }, 'nothing ran but package_version is stated'],
    ['a record of nothing run that states a negotiated revision', (record) => { nothing(record); }, 'nothing ran but default is stated'],
    ['a record of nothing run that states a catalog', (record) => { nothing(record); }, 'nothing ran but count is stated'],
    ['a record of nothing run that states a test date', (record) => { nothing(record); }, 'nothing ran but tested_on is stated'],
    ['a record of nothing run that states a provenance', (record) => { nothing(record); }, 'nothing ran but provenance is stated'],
    ['a record of nothing run that states variables', (record) => { nothing(record); }, 'nothing ran but variables are stated'],
    ['a record of nothing run that states limitations', (record) => {
      nothing(record);
      record.limitations = ['All twelve scenarios passed.'];
    }, 'nothing ran but limitations are stated'],
    ['a record of nothing run with notes on a scenario', (record) => {
      record.scenarios.C01 = { status: 'not_run', evidence: null, notes: 'Passed: 133 tools listed.' };
    }, 'nothing ran but C01 has notes'],
  ])('refuse %s', (_label, change, problem) => {
    expect(refusal(change)).toContain(problem);
  });

  it('hold variable names only: the TESTRAIL_ variables and MCP_PROTOCOL_NEGOTIATION, never a value', () => {
    const withVariables = (variables: string[]) => {
      const record = complete();
      record.settings.variables = variables;
      return recordSchema.safeParse(record).success;
    };
    expect(withVariables(['TESTRAIL_BASE_URL', 'TESTRAIL_ALLOW_INSECURE', 'MCP_PROTOCOL_NEGOTIATION'])).toBe(true);
    for (const variables of [['TESTRAIL_API_KEY=abc'], ['HOME'], ['TESTRAIL_BASE_URL', 'MCP_PROTOCOL_NEGOTIATION=auto'], ['testrail_base_url']]) {
      expect(withVariables(variables), variables.join()).toBe(false);
    }
  });

  it('carry no credential, email address, local path or key-like token', () => {
    expect(records.flatMap(({ slug, record }) => leaks(record).map((leak) => `${slug}: ${leak}`))).toEqual([]);
    const notes = (text: string): string[] => leaks({ notes: text });
    // Service-token samples are joined here, so no whole fake token sits in the source for
    // a secret scanner to take for a real one.
    const sample = (...parts: string[]) => parts.join('_');
    for (const text of [
      // Credentials and addresses.
      'a@example.com', 'Authorization: Basic dXNlcjpwYXNzd29yZA==', 'Basic dXNlcjpwYXNzd29yZA==', 'Bearer eyJhbGciOiJIUzI1NiJ9',
      'https://user:secret@example.test/runs/1', 'https://example.test/runs/1?token=abc',
      // Local paths, in any setting.
      '/tmp/uploads', '~/testrail-downloads', '~/.codex/config.toml', 'C:\\Users\\me', 'D:/work', '/usr/local/bin/testrail-mcp', '/Volumes/Work/uploads',
      '/workspace/igor/downloads', '$HOME/testrail-uploads', 'Log saved in `/home/igor/copilot.log`', 'file:///home/igor/evidence/c01.log',
      'log:/home/igor/c01.log', 'see [/Users/igor/c01.log]', 'uploads root \\\\fileserver\\igor\\uploads',
      // Variable values and secrets.
      'TESTRAIL_API_KEY=fixture-api-key', 'TESTRAIL_BASE_URL=http://127.0.0.1:37453',
      'AbC123dEf456GhI789jKl012', 'key 0123456789abcdef0123', `token ${sample('ghp', 'AbC123dEf456GhI789jKl012mNo345pQr678')}`,
      sample('github', 'pat', '11ABCDEFG0123456789', 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ'), sample('sk', 'live', '51H8AbC123dEf456GhI789jKl0'),
      'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'Q5jxjqNNMnbQ0HrCW3ga-cVdgyZLF2Q6jX8Wt1Q2f', ['glpat', 'abcdefghij0123456789'].join('-'),
      // Variable values in any form.
      'TESTRAIL_API_KEY: abc123secret', '"TESTRAIL_API_KEY": "abc123secret"', '"env": { "TESTRAIL_BASE_URL": "https://acme.testrail.io" }',
      // Home and user-directory variables, and bare local roots.
      '${HOME}/uploads', '%USERPROFILE%\\uploads', '%APPDATA%\\Claude\\logs\\mcp.log', '$env:USERPROFILE\\testrail-uploads',
      '$XDG_CONFIG_HOME/copilot/mcp-config.json', '~igor', 'uploads went to /tmp',
      // Links that carry a credential, in a parameter, a path or a query.
      'https://private-user-images.githubusercontent.com/1/2-a.png?jwt=eyJhbGciOiJIUzI1NiJ9',
      'https://bucket.s3.amazonaws.com/x.png?X-Amz-Signature=abc&X-Amz-Credential=def', 'https://gitlab.example.test/x?private_token=abc',
      'https://example.test/x?api-key=abc', 'https://example.test/x?access-token=abc', 'https://example.test/x?auth=abc', 'https://example.test/x?password=abc',
      'https://example.test/x?sig=abc', 'https://example.test/x?key=abc', 'https://example.test/x?email=ada@example.com',
      ['https://hooks', 'slack', 'com/services/T000/B000/AbC123dEf456GhI789jKl012'].join('.'),
    ]) {
      expect(notes(text), text).not.toEqual([]);
    }
    // Links, package specs, repository paths, version strings and plain words are evidence, not leaks.
    for (const text of [
      'https://github.com/dichovsky/testrail-mcp/actions/runs/1', '@dichovsky/testrail-api-client@7.2.0', 'testrail-mcp@0.1.0-dev.0', 'codex-cli 0.149.0',
      'tests/fixtures/clients/c03-corpus.json', 'MCP_PROTOCOL_NEGOTIATION=auto', 'C01/C02 read/write', 'testrail_get_history_for_case',
      'Basic discovery works; all 133 names found.', 'Basic Authentication is refused', 'Host asked for authorization: approved each write',
      'Basic 133-tool discovery works.', 'Basic toolSearch was left at its default.', 'Basic deferTools auto worked.',
      // Evidence files named after their scenario, and TestRail API paths.
      'docs/evidence/clients/claude-code/C01-catalog.txt', 'docs/evidence/clients/C01.log', 'evidence/C01-codex-cli.log', './docs/issues/R02.md',
      'Screenshot-2026-10-01.png', 'GET /index.php?/api/v2/get_case/42', '/api/v2/add_case/990500',
      // A commit SHA and the catalog hash quoted in notes.
      'commit 3ccde21e8f0a4a9b2c7d6e5f4a3b2c1d0e9f8a7b', `The catalog hash ${EXPECTED_HASH} matched the guide.`,
      // GitHub and package links, whatever their path holds; a variable referenced, not set.
      'https://github.com/dichovsky/testrail-mcp/tree/claude/fervent-davinci-y0v90v', 'https://github.com/dichovsky/testrail-mcp/pull/84#issuecomment-5874717208',
      'https://www.npmjs.com/package/@dichovsky/testrail-mcp/v/1.0.0', '"TESTRAIL_API_KEY": "${TESTRAIL_API_KEY}"',
    ]) {
      expect(notes(text), text).toEqual([]);
    }
    expect(leaks({ server: { tarball_integrity: `sha512-${'A1'.repeat(43)}==` }, catalog: { sorted_names_sha256: EXPECTED_HASH } })).toEqual([]);
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
    const report = JSON.parse(stdout) as { eras: Record<string, { protocol: string }> };
    expect(report).toEqual({
      eras: {
        legacy: { protocol: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/u) as unknown, count: names.length, sorted_names_sha256: EXPECTED_HASH, duplicates: 0 },
        '2026-07-28': { protocol: '2026-07-28', count: names.length, sorted_names_sha256: EXPECTED_HASH, duplicates: 0 },
      },
      testrail_requests: 0,
    });
    // Each era really negotiated its own revision.
    expect(report.eras.legacy?.protocol).not.toBe('2026-07-28');
    // Run through a symlinked path, as from a clone under /tmp on macOS, it reports the same.
    if (process.platform !== 'win32') {
      const base = await mkdtemp(join(tmpdir(), 'testrail-mcp-catalog-'));
      try {
        await symlink(fileURLToPath(new URL('../scripts/', import.meta.url)), join(base, 'scripts'));
        const linked = await promisify(execFile)(process.execPath, [join(base, 'scripts', 'catalog-hash.mjs'), '--command', process.execPath, '--arg', cli]);
        expect(JSON.parse(linked.stdout)).toEqual(report);
      } finally {
        await rm(base, { recursive: true, force: true });
      }
    }
  }, 60_000);
});
