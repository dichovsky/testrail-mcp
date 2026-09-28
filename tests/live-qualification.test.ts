import { execFile, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmod, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { TestRailApiError, TestRailClient } from '@dichovsky/testrail-api-client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { loadConfiguration } from '../src/config/environment.js';
import { classifyError, ERROR_CODES } from '../src/contracts/errors.js';
import { driverOptions, REQUEST_TIMEOUT_MS } from '../src/driver/configuration.js';
import { operationRegistry } from '../src/operations/catalog.js';
import type { Operation } from '../src/operations/registry.js';
import { createRuntime } from '../src/runtime/invocation.js';
import { executeToolCall } from '../src/transport/tool-call.js';

/*
 * R03: the live qualification runner, held offline. It must call every tool, touch
 * nothing it did not create, clean up after itself even when a run stops early, tell a
 * missing licence or permission from a failure, and write evidence that names no
 * credential, address or personal detail. The plan runs here through the registered
 * tools and the real driver against the fixture stand-in, which answers every endpoint.
 */

type Scope = 'read' | 'own' | 'instance' | 'report';
interface Context { own: (kind: string, id: unknown, name?: string) => unknown; id: (name: string) => unknown; gone: (name: string) => void }
interface PlanStep {
  tool: string; label?: string; scope: Scope; requires?: string; unconfirmed?: string;
  input?: (c: Context) => unknown; capture?: (data: unknown, c: Context) => void;
}
interface ToolResult { isError?: boolean; structuredContent?: unknown }
type Call = (tool: string, input: unknown) => Promise<ToolResult>;
type Environment = Record<string, string | undefined>;
interface Session { call: Call; serverVersion?: string | undefined; protocol?: string | undefined; close: () => Promise<void> }
interface Pacing { minIntervalMs: number; retryDelayMs: number; attempts: number }
interface LedgerLike { add: (kind: string, id: unknown) => void }
interface StepRecord { tool: string; label: string | null; status: string; code?: string; reason?: string; retries?: number }
interface Run { steps: StepRecord[]; cleanup: { project: string; group: string; residue: { kind: string; count: number }[] }; stopped: string | null }
type Connect = (server: { command: string; args: string[]; env: Environment }) => Promise<Session>;
interface Runner {
  PLAN: PlanStep[];
  TARGET_KINDS: Record<string, string>;
  ITEM_KINDS: Record<string, string>;
  LIVE_PACING: Pacing;
  Ledger: new () => LedgerLike;
  GuardRefusal: new (message: string) => Error;
  guard: (step: Pick<PlanStep, 'tool' | 'scope' | 'capture'>, input: unknown, ledger: LedgerLike) => void;
  targetsOf: (tool: string, input: unknown) => { key: string; kind: string; id: unknown }[];
  toolStatus: (steps: { status: string }[]) => string;
  exitCode: (evidence: { summary: { fail: number }; cleanup: { project: string; group: string }; stopped: string | null }) => number;
  pacedCaller: (call: Call, pacing: Pacing) => (tool: string, input: unknown) => Promise<{ result: ToolResult; retries: number }>;
  parseOptions: (argv: string[]) => { out: string; server: { command: string; args: string[] } };
  runQualification: (options: {
    call: Call; plan?: PlanStep[]; options?: Record<string, unknown>; stamp: string; uploads: Record<string, unknown>; pacing?: Pacing;
    shouldStop?: () => string | undefined; reconnect?: () => Promise<Call>;
  }) => Promise<Run>;
  main: (options: {
    argv: string[]; env: Environment; pacing?: Pacing; log?: (line: string) => void; connect?: Connect; signals?: EventEmitter;
    exit?: (code: number) => void;
  }) => Promise<unknown>;
  connectStdio: Connect;
}
interface StandIn { baseUrl: string; environment: Record<string, string>; requests: { method: string; endpoint: string; tool: string | null }[]; close: () => Promise<void> }

const script = (name: string): string => fileURLToPath(new URL(`../scripts/${name}`, import.meta.url));
const runner = (await import(new URL('../scripts/live-qualification.mjs', import.meta.url).href)) as Runner;
const { startFixtureTestRail } = (await import(new URL('../scripts/fixture-testrail.mjs', import.meta.url).href)) as {
  startFixtureTestRail: () => Promise<StandIn>;
};
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
const installedDriver = JSON.parse(await readFile(new URL('../node_modules/@dichovsky/testrail-api-client/package.json', import.meta.url), 'utf8')) as { version: string };
// Windows checkouts may carry CRLF line endings.
const guide = (await readFile(new URL('../docs/live-qualification.md', import.meta.url), 'utf8')).replace(/\r\n/gu, '\n');

const STATUSES = ['pass', 'fail', 'blocked', 'not_run'] as const;
const INSTANT: Pacing = { minIntervalMs: 0, retryDelayMs: 0, attempts: 3 };
/** Writes outside the qualification project, named here rather than read from the plan. */
const INSTANCE_WRITES = ['add_case_field', 'add_group', 'add_user', 'delete_group', 'update_group', 'update_user'];

const stepSchema = z.strictObject({
  label: z.string().min(1).nullable(),
  status: z.enum(STATUSES),
  code: z.enum(ERROR_CODES).optional(),
  http_status: z.number().int().optional(),
  reason: z.string().min(1).optional(),
  retries: z.number().int().positive().optional(),
  warnings: z.array(z.string()),
});
const count = z.number().int().nonnegative();
const evidenceSchema = z.strictObject({
  schema_version: z.literal(1),
  provenance: z.literal('live_testrail'),
  tested_on: z.iso.date(),
  testrail_version: z.string().min(1).nullable(),
  server: z.strictObject({ package_version: z.string().nullable(), protocol: z.string().nullable(), driver_version: z.string().nullable() }),
  options: z.strictObject({ instance_writes: z.boolean(), report_template: z.boolean(), cross_project_report_template: z.boolean() }),
  stopped: z.string().min(1).nullable(),
  summary: z.strictObject({ pass: count, not_run: count, blocked: count, fail: count }),
  tools: z.record(z.string(), z.strictObject({ status: z.enum(STATUSES), steps: z.array(stepSchema).min(1) })),
  cleanup: z.strictObject({
    project: z.enum(['not_created', 'deleted', 'deleted_in_cleanup', 'left_behind']),
    group: z.enum(['not_created', 'deleted', 'deleted_in_cleanup', 'left_behind']),
    residue: z.array(z.strictObject({ kind: z.string().min(1), count: z.number().int().positive() })),
  }),
});
type Evidence = z.infer<typeof evidenceSchema>;

function registered(tool: string): Operation {
  const operation = operationRegistry.get(tool);
  if (operation === undefined) throw new Error(`${tool} is not registered`);
  return operation;
}

const failure = (code: string, httpStatus?: number): ToolResult => ({
  isError: true, structuredContent: { error: { code, message: `Synthetic ${code}.`, ...(httpStatus === undefined ? {} : { http_status: httpStatus }) } },
});

let standIn: StandIn;
let base: string;
beforeAll(async () => {
  standIn = await startFixtureTestRail();
  base = await mkdtemp(join(tmpdir(), 'testrail-mcp-live-'));
});
afterAll(async () => {
  await standIn.close();
  await rm(base, { recursive: true, force: true });
});

/**
 * The runner's own path, with the server replaced by the registered tools in-process: the
 * same inputs, validation, driver and HTTP, without the production limiter's pace.
 * `inject` may answer a call itself, or pass it on to `real`.
 */
function inProcess(inject?: (tool: string, input: unknown, real: Call) => Promise<ToolResult>) {
  return async ({ env }: { env: Environment }): Promise<Session> => {
    const configuration = await loadConfiguration(env);
    const runtime = createRuntime({
      client: new TestRailClient({ ...driverOptions(configuration), rateLimiter: { maxRequests: 10_000, windowMs: 60_000 } }),
      limits: configuration.limits,
    });
    const staging = await mkdtemp(join(base, 'staging-'));
    const real: Call = (tool, input) => executeToolCall(registered(tool), input, { runtime, configuration, stagingDirectory: () => Promise.resolve(staging) });
    return {
      call: inject === undefined ? real : (tool, input) => inject(tool, input, real),
      serverVersion: packageJson.version,
      protocol: undefined,
      close: async () => { await runtime.shutdown(); },
    };
  };
}

let runs = 0;
async function qualify(flags: string[], inject?: Parameters<typeof inProcess>[0], { connect, signals }: { connect?: Connect; signals?: EventEmitter } = {}) {
  // Each run writes into a directory that does not exist yet.
  const out = join(base, `run-${String(runs += 1)}`, 'evidence.json');
  const log: string[] = [];
  const before = standIn.requests.length;
  const evidence = await runner.main({
    argv: ['--create-qualification-project', '--out', out, ...flags],
    env: standIn.environment, connect: connect ?? inProcess(inject), pacing: INSTANT, log: (line) => { log.push(line); },
    ...(signals === undefined ? {} : { signals }),
  });
  const text = await readFile(out, 'utf8');
  return { evidence: evidenceSchema.parse(JSON.parse(text)), returned: evidence, text, log, requests: standIn.requests.slice(before) };
}

const stepsOf = (evidence: Evidence) => Object.entries(evidence.tools).flatMap(([tool, { steps }]) => steps.map((step) => ({ tool, ...step })));
const FULL = ['--instance-writes', '--report-template-id', '1', '--cross-project-report-template-id', '2'];

describe('the qualification plan', () => {
  const tools = runner.PLAN.map(({ tool }) => `testrail_${tool}`);

  it('calls every registered tool, and nothing else', () => {
    expect([...new Set(tools)].sort()).toEqual(operationRegistry.entries.map(({ tool }) => tool).sort());
  });

  it('scopes each step by what the tool does to TestRail', () => {
    const wrong = runner.PLAN.filter(({ tool, scope }) => {
      const effect = registered(`testrail_${tool}`).effects.testRail;
      return effect === 'read' ? scope !== 'read' : effect === 'report' ? scope !== 'report' : !['own', 'instance'].includes(scope);
    });
    expect(wrong.map(({ tool, label }) => `${tool}${label === undefined ? '' : ` (${label})`}`)).toEqual([]);
  });

  it('writes outside the project only on request, and runs reports only from a named template', () => {
    expect(runner.PLAN.filter(({ scope }) => scope === 'instance').map(({ tool }) => tool).sort()).toEqual(INSTANCE_WRITES);
    for (const step of runner.PLAN) {
      if (step.scope === 'instance') expect(step.requires, step.tool).toBe('instanceWrites');
      if (step.scope === 'report') expect(step.requires, step.tool).toMatch(/^(reportTemplateId|crossProjectReportTemplateId)$/u);
    }
  });

  it('creates the project before any other write inside it, and deletes it last', () => {
    const own = runner.PLAN.filter(({ scope }) => scope === 'own');
    expect(own[0]?.tool).toBe('add_project');
    expect(runner.PLAN.at(-1)).toMatchObject({ tool: 'delete_project', scope: 'own' });
  });
});

describe('the ownership guard', () => {
  const ledger = () => {
    const created = new runner.Ledger();
    created.add('project', 10);
    created.add('section', 5);
    created.add('case', 6);
    created.add('test', 7);
    created.add('label', 8);
    return created;
  };

  it('refuses a write naming anything the run did not create', () => {
    expect(() => { runner.guard({ tool: 'delete_project', scope: 'own' }, { project_id: 11 }, ledger()); }).toThrow(runner.GuardRefusal);
    expect(() => { runner.guard({ tool: 'delete_project', scope: 'own' }, { project_id: 10 }, ledger()); }).not.toThrow();
    // An ID the run created as one kind is not a licence to write to that number as another.
    expect(() => { runner.guard({ tool: 'delete_case', scope: 'own' }, { case_id: 5 }, ledger()); }).toThrow(/case_id names a case this run did not create/u);
  });

  it('finds targets wherever the arguments name them', () => {
    const targets = (tool: string, input: unknown) => runner.targetsOf(`testrail_${tool}`, input).map(({ key, kind, id }) => `${key}:${kind}:${String(id)}`);
    expect(targets('delete_cases', { suite_id: 1, query: { project_id: 2 }, body: { case_ids: [3, 4] } }))
      .toEqual(['suite_id:suite:1', 'project_id:project:2', 'case_ids:case:3', 'case_ids:case:4']);
    expect(targets('add_results', { run_id: 1, body: { results: [{ test_id: 2, status_id: 5, assignedto_id: 9 }] } })).toEqual(['run_id:run:1', 'test_id:test:2']);
    expect(targets('update_tests', { body: { test_ids: [1], labels: [2, 'title'] } })).toEqual(['test_ids:test:1', 'labels:label:2']);
    expect(targets('add_user', { body: { name: 'x', email: 'x', role_id: 3, group_ids: [4], assigned_projects: [5] } })).toEqual(['group_ids:group:4', 'assigned_projects:project:5']);
    expect(targets('add_case_field', { body: { configs: [{ context: { is_global: false, project_ids: [6] } }] } })).toEqual(['project_ids:project:6']);
    expect(targets('add_section', { project_id: 1, body: { parent_id: 2 } })).toEqual(['project_id:project:1', 'parent_id:section:2']);
    expect(targets('add_milestone', { project_id: 1, body: { parent_id: 2 } })).toEqual(['project_id:project:1', 'parent_id:milestone:2']);
    expect(targets('move_section', { section_id: 1, body: { parent_id: null, after_id: 3 } })).toEqual(['section_id:section:1', 'after_id:section:3']);
    expect(targets('get_tests', { run_id: 1, _mcp: { pagination: 'all', max_items: 5 } })).toEqual(['run_id:run:1']);
  });

  it('checks nested targets, and lets reads name anything', () => {
    expect(() => { runner.guard({ tool: 'add_results', scope: 'own' }, { run_id: 1, body: { results: [{ test_id: 7, status_id: 1 }] } }, ledger()); })
      .toThrow(/run_id names a run/u);
    const created = ledger();
    created.add('run', 1);
    expect(() => { runner.guard({ tool: 'add_results', scope: 'own' }, { run_id: 1, body: { results: [{ test_id: 99, status_id: 1 }] } }, created); })
      .toThrow(/test_id names a test/u);
    expect(() => { runner.guard({ tool: 'update_tests', scope: 'own' }, { body: { test_ids: [7], labels: [8, 'new title'] } }, created); }).not.toThrow();
    expect(() => { runner.guard({ tool: 'update_tests', scope: 'own' }, { body: { test_ids: [7], labels: [9] } }, created); }).toThrow(/labels names a label/u);
    expect(() => { runner.guard({ tool: 'get_project', scope: 'read' }, { project_id: 11 }, ledger()); }).not.toThrow();
  });

  it('refuses GUID entries and attachments the run did not create, and names no ID', () => {
    const created = ledger();
    created.add('plan', 3);
    created.add('entry', '3933d74b-4282-44de-82ae-a6412808369d');
    created.add('attachment', '2ec27be4-812f-4806-9a5d-d39130d1691a');
    const foreign = 'a1b2c3d4-0000-4000-8000-000000000000';
    expect(() => { runner.guard({ tool: 'delete_plan_entry', scope: 'own' }, { plan_id: 3, entry_id: foreign }, created); })
      .toThrow(/^testrail_delete_plan_entry: entry_id names an entry this run did not create$/u);
    expect(() => { runner.guard({ tool: 'delete_plan_entry', scope: 'own' }, { plan_id: 3, entry_id: '3933d74b-4282-44de-82ae-a6412808369d' }, created); }).not.toThrow();
    expect(() => { runner.guard({ tool: 'delete_attachment', scope: 'own' }, { attachment_id: foreign }, created); })
      .toThrow(/^testrail_delete_attachment: attachment_id names an attachment this run did not create$/u);
    expect(() => { runner.guard({ tool: 'delete_attachment', scope: 'own' }, { attachment_id: '2ec27be4-812f-4806-9a5d-d39130d1691a' }, created); }).not.toThrow();
  });

  it('checks the group and user IDs in a project\'s access rows', () => {
    const input = { project_id: 10, body: { groups: [{ id: 2, role_id: 3 }], users: [{ id: 4, role_id: 3 }, { user_id: 4, role_id: 3 }] } };
    expect(runner.targetsOf('testrail_update_project', input).map(({ key, kind, id }) => `${key}:${kind}:${String(id)}`))
      .toEqual(['project_id:project:10', 'id:group:2', 'id:user:4', 'user_id:user:4']);
    const created = ledger();
    expect(() => { runner.guard({ tool: 'update_project', scope: 'own' }, input, created); }).toThrow(/id names a group/u);
    created.add('group', 2);
    expect(() => { runner.guard({ tool: 'update_project', scope: 'own' }, input, created); }).toThrow(/id names a user/u);
    created.add('user', 4);
    expect(() => { runner.guard({ tool: 'update_project', scope: 'own' }, input, created); }).not.toThrow();
    // A bare id outside those lists names nothing the guard knows.
    expect(runner.targetsOf('testrail_update_anything', { body: { id: 5, steps: [{ id: 6 }] } })).toEqual([]);
  });

  it('checks a read whose answer later steps use, since what it returns can become the run\'s own', () => {
    const created = ledger();
    created.add('run', 3);
    const capture = () => undefined;
    expect(() => { runner.guard({ tool: 'get_tests', scope: 'read', capture }, { run_id: 1 }, created); }).toThrow(/run_id names a run this run did not create/u);
    expect(() => { runner.guard({ tool: 'get_tests', scope: 'read', capture }, { run_id: 3 }, created); }).not.toThrow();
    expect(() => { runner.guard({ tool: 'get_tests', scope: 'read' }, { run_id: 1 }, created); }).not.toThrow();
    // The plan's tests are read that way: its later writes to them rest on that read.
    expect(runner.PLAN.find(({ tool }) => tool === 'get_tests')?.capture).toBeTypeOf('function');
  });
});

describe('the guard\'s view of every argument', () => {
  /** The entity kind each target argument names, written here rather than read from the runner. */
  const KINDS: Record<string, string> = {
    project_id: 'project', project_ids: 'project', assigned_projects: 'project', suite_id: 'suite', section_id: 'section',
    case_id: 'case', case_ids: 'case', run_id: 'run', test_id: 'test', test_ids: 'test', result_id: 'result', plan_id: 'plan',
    entry_id: 'entry', milestone_id: 'milestone', config_group_id: 'config_group', config_id: 'config', config_ids: 'config',
    label_id: 'label', label_ids: 'label', labels: 'label', shared_step_id: 'shared_step', dataset_id: 'dataset',
    variable_id: 'variable', attachment_id: 'attachment', group_id: 'group', group_ids: 'group', user_id: 'user',
    // add_case_field adds the field to these templates, and the run creates none.
    template_ids: 'template',
  };
  /** Arguments that pick among the instance's settings or people, and change nothing they name. */
  const REFERENCES = ['assignedto_id', 'created_by', 'default_role_id', 'priority_id', 'report_template_id', 'role_id', 'status_id', 'template_id', 'type_id', 'updated_by', 'user_ids'];
  /** Lists whose items name a group or user by a bare id, and the parent or neighbour of a section or milestone. */
  const ITEMS: Record<string, string> = { groups: 'group', users: 'user' };
  const RELATIVE = ['after_id', 'parent_id'];

  it('knows the kind of every target argument', () => {
    expect(runner.TARGET_KINDS).toEqual(KINDS);
    expect(runner.ITEM_KINDS).toEqual(ITEMS);
    for (const [key, kind] of Object.entries(KINDS)) {
      expect(runner.targetsOf('testrail_update_anything', { body: { [key]: [7] } }), key).toEqual([{ key, kind, id: 7 }]);
      const created = new runner.Ledger();
      expect(() => { runner.guard({ tool: 'update_anything', scope: 'instance' }, { [key]: 7 }, created); }, key).toThrow(runner.GuardRefusal);
      created.add(kind, 7);
      expect(() => { runner.guard({ tool: 'update_anything', scope: 'instance' }, { [key]: 7 }, created); }, key).not.toThrow();
    }
  });

  it('accounts for every ID-like argument any tool accepts', () => {
    const names = new Set<string>();
    // The property each bare id sits in, such as groups for groups[].id.
    const holders = new Set<string | undefined>();
    const visit = (node: unknown, holder: string | undefined) => {
      if (Array.isArray(node)) { node.forEach((item) => { visit(item, holder); }); return; }
      if (node === null || typeof node !== 'object') return;
      for (const [key, value] of Object.entries(node) as [string, unknown][]) {
        if (key !== 'properties' || value === null || typeof value !== 'object') { visit(value, holder); continue; }
        for (const [name, schema] of Object.entries(value)) {
          names.add(name);
          if (name === 'id') holders.add(holder);
          visit(schema, name);
        }
      }
    };
    for (const { tool } of operationRegistry.entries) visit(z.toJSONSchema(registered(tool).inputSchema as z.ZodType, { unrepresentable: 'any', io: 'input' }), undefined);
    const idLike = [...names].filter((name) => /_(?:id|ids|by)$/u.test(name) || ['id', 'labels', 'assigned_projects', 'groups', 'users'].includes(name));
    const known = new Set([...Object.keys(KINDS), ...REFERENCES, ...Object.keys(ITEMS), 'id', ...RELATIVE]);
    expect(idLike.filter((name) => !known.has(name))).toEqual([]);
    expect([...holders]).toEqual(expect.arrayContaining(Object.keys(ITEMS)));
    expect([...holders].filter((holder) => holder === undefined || !(holder in ITEMS))).toEqual([]);
    // And each list names something a tool really takes.
    expect([...known].filter((name) => !names.has(name))).toEqual([]);
  });

  it('refuses, inside a run, a write to anything the run did not create, never sends it, and fails the tool', async () => {
    const sent: string[] = [];
    const call: Call = (tool) => {
      sent.push(tool);
      return Promise.resolve({ structuredContent: { data: { id: 5 } } });
    };
    const plan: PlanStep[] = [
      { tool: 'add_project', scope: 'own', input: () => ({ body: { name: 'p' } }), capture: (data, c) => { c.own('project', (data as { id: number }).id); } },
      { tool: 'update_project', label: 'a slip', scope: 'own', input: () => ({ project_id: 99, body: {} }) },
      { tool: 'update_project', label: 'its own', scope: 'own', input: (c) => ({ project_id: c.id('project'), body: {} }) },
      { tool: 'delete_group', scope: 'instance', input: () => ({ group_id: 5 }) },
      { tool: 'delete_project', scope: 'own', input: (c) => ({ project_id: c.id('project') }), capture: (_data, c) => { c.gone('project'); } },
    ];
    const run = await runner.runQualification({ call, plan, stamp: 's', uploads: {}, pacing: INSTANT });
    expect(sent).toEqual(['testrail_add_project', 'testrail_update_project', 'testrail_delete_project']);
    // The refusal names the argument and the kind, never the ID.
    expect(run.steps.map(({ tool, status, reason }) => `${tool} ${status}${reason === undefined ? '' : `: ${reason}`}`)).toEqual([
      'testrail_add_project pass',
      'testrail_update_project fail: refused by the guard: testrail_update_project: project_id names a project this run did not create',
      'testrail_update_project pass',
      'testrail_delete_group fail: refused by the guard: testrail_delete_group: group_id names a group this run did not create',
      'testrail_delete_project pass',
    ]);
    // A step that passed beside it does not hide it.
    expect(runner.toolStatus(run.steps.filter(({ tool }) => tool === 'testrail_update_project'))).toBe('fail');
  });
});

describe('the pace, and what is repeated', () => {
  it('keeps under the server\'s request rate, and waits out its window before repeating', async () => {
    const { rateLimiter } = driverOptions(await loadConfiguration({ ...standIn.environment, TESTRAIL_MCP_UPLOAD_ROOTS: '[]', TESTRAIL_MCP_DOWNLOAD_DIR: base }));
    const { maxRequests = 0, windowMs = 0 } = rateLimiter ?? {};
    expect(runner.LIVE_PACING.minIntervalMs).toBeGreaterThanOrEqual(windowMs / maxRequests);
    expect(runner.LIVE_PACING.retryDelayMs).toBeGreaterThan(windowMs);
    expect(runner.LIVE_PACING.attempts).toBeGreaterThanOrEqual(2);
    expect(runner.LIVE_PACING.attempts).toBeLessThanOrEqual(5);
  });

  it('spaces calls, and repeats a rate-limited call, and only that, after the delay', async () => {
    const at: number[] = [];
    let answers: ToolResult[] = [];
    const paced = runner.pacedCaller(() => {
      at.push(performance.now());
      return Promise.resolve(answers.shift() ?? { structuredContent: { data: {} } });
    }, { minIntervalMs: 40, retryDelayMs: 80, attempts: 3 });
    await paced('a', {});
    await paced('b', {});
    expect((at[1] ?? 0) - (at[0] ?? 0)).toBeGreaterThanOrEqual(35);
    answers = [failure('RATE_LIMITED'), { structuredContent: { data: {} } }];
    at.length = 0;
    expect(await paced('c', {})).toMatchObject({ retries: 1 });
    expect((at[1] ?? 0) - (at[0] ?? 0)).toBeGreaterThanOrEqual(75);
    // A write whose outcome is unknown is never repeated.
    answers = [{ isError: true, structuredContent: { error: { code: 'TIMEOUT', write_outcome: 'unknown' } } }];
    at.length = 0;
    expect(await paced('d', {})).toMatchObject({ retries: 0 });
    expect(at).toHaveLength(1);
    // A call still rate-limited after every attempt is given up.
    answers = [failure('RATE_LIMITED'), failure('RATE_LIMITED'), failure('RATE_LIMITED'), { structuredContent: { data: {} } }];
    at.length = 0;
    const limited = await runner.pacedCaller(() => {
      at.push(performance.now());
      return Promise.resolve(answers.shift() ?? { structuredContent: { data: {} } });
    }, INSTANT)('e', {});
    expect(limited).toMatchObject({ retries: 2, result: { structuredContent: { error: { code: 'RATE_LIMITED' } } } });
    expect(at).toHaveLength(3);
  });

  it('runs at the live pace unless told otherwise', async () => {
    const at: number[] = [];
    const connect: Connect = () => Promise.resolve({
      call: (tool) => {
        at.push(performance.now());
        if (at.length > 3) return Promise.reject(new Error('Not connected'));
        return Promise.resolve({ structuredContent: { data: tool === 'testrail_get_current_user' ? { id: 1, email: 'x@example.invalid' } : { version: '10.7' } } });
      },
      serverVersion: undefined, protocol: undefined, close: () => Promise.resolve(),
    });
    await runner.main({ argv: ['--create-qualification-project', '--out', join(base, 'paced.json')], env: standIn.environment, connect, log: () => undefined });
    for (let index = 1; index < at.length; index += 1) expect((at[index] ?? 0) - (at[index - 1] ?? 0)).toBeGreaterThanOrEqual(runner.LIVE_PACING.minIntervalMs - 50);
  }, 20_000);
});

describe('statuses and exit codes', () => {
  it('gives a tool its worst step, except that a pass outranks steps not run', () => {
    const of = (...statuses: string[]) => runner.toolStatus(statuses.map((status) => ({ status })));
    expect(of('pass', 'fail')).toBe('fail');
    expect(of('fail', 'pass')).toBe('fail');
    expect(of('pass', 'blocked')).toBe('blocked');
    expect(of('blocked', 'fail')).toBe('fail');
    expect(of('not_run', 'blocked')).toBe('blocked');
    expect(of('pass', 'not_run')).toBe('pass');
    expect(of('not_run')).toBe('not_run');
  });

  it('fails a run with a failed tool, anything left behind, or a stop before the end', () => {
    const evidence = (fail: number, project: string, group: string, stopped: string | null) => ({ summary: { fail }, cleanup: { project, group }, stopped });
    expect(runner.exitCode(evidence(0, 'deleted', 'not_created', null))).toBe(0);
    expect(runner.exitCode(evidence(0, 'deleted_in_cleanup', 'deleted', null))).toBe(0);
    expect(runner.exitCode(evidence(1, 'deleted', 'not_created', null))).toBe(1);
    expect(runner.exitCode(evidence(0, 'left_behind', 'not_created', null))).toBe(1);
    expect(runner.exitCode(evidence(0, 'deleted', 'left_behind', null))).toBe(1);
    expect(runner.exitCode(evidence(0, 'deleted_in_cleanup', 'not_created', 'interrupted'))).toBe(1);
  });
});

/**
 * The stand-in answers every creation with the same few IDs, so a write aimed at an entity
 * that already existed could not be told from one aimed at the run's own. This gives each
 * entity a creation returns an ID of its own, as TestRail does, and keeps every write.
 */
function distinctIds() {
  let next = 810_000;
  const created = new Set<string>();
  const writes: { tool: string; input: unknown }[] = [];
  const renumber = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(renumber);
    if (node === null || typeof node !== 'object') return node;
    return Object.fromEntries(Object.entries(node).map(([key, value]) => {
      if (key !== 'id' && key !== 'attachment_id') return [key, renumber(value)];
      if (typeof value === 'string') {
        created.add(value);
        return [key, value];
      }
      next += 1;
      created.add(String(next));
      return [key, next];
    }));
  };
  const inject: Parameters<typeof inProcess>[0] = async (tool, input, real) => {
    if (registered(tool).effects.testRail !== 'read') writes.push({ tool, input });
    const result = await real(tool, input);
    // A run's tests are created with the run: they count when read from a run the run created.
    if (tool === 'testrail_get_tests' && created.has(String((input as { run_id?: unknown }).run_id))) {
      const { data } = result.structuredContent as { data?: unknown };
      const tests = Array.isArray(data) ? data : (data as { tests?: unknown[] } | undefined)?.tests ?? [];
      for (const test of tests) created.add(String((test as { id?: unknown }).id));
    }
    if (!/^testrail_add_/u.test(tool) || result.isError === true) return result;
    const content = result.structuredContent as { data?: unknown };
    return { ...result, structuredContent: { ...content, data: renumber(content.data) } };
  };
  return { inject, created, writes };
}

describe('a full run against the stand-in', () => {
  let full: Awaited<ReturnType<typeof qualify>>;
  const ids = distinctIds();
  beforeAll(async () => { full = await qualify(FULL, ids.inject); });

  it('passes every tool, with nothing refused, and cleans up', () => {
    expect(Object.keys(full.evidence.tools).sort()).toEqual(operationRegistry.entries.map(({ tool }) => tool).sort());
    expect(Object.entries(full.evidence.tools).filter(([, { status }]) => status !== 'pass').map(([tool, entry]) => `${tool}: ${JSON.stringify(entry.steps)}`)).toEqual([]);
    expect(full.evidence.summary).toEqual({ pass: 133, not_run: 0, blocked: 0, fail: 0 });
    expect(full.evidence.cleanup).toEqual({
      project: 'deleted', group: 'deleted',
      // TestRail's API cannot delete users or case fields.
      residue: [{ kind: 'user', count: 1 }, { kind: 'case_field', count: 1 }],
    });
    expect(full.evidence).toMatchObject({
      testrail_version: '10.6.0.1041',
      server: { package_version: packageJson.version, driver_version: '7.2.0' },
      options: { instance_writes: true, report_template: true, cross_project_report_template: true },
    });
    expect(full.returned).toEqual(full.evidence);
  });

  it('records the driver only for its own server, since the driver of one --command names cannot be seen', async () => {
    // Refused credentials end each run at its first call.
    const refuse: Parameters<typeof inProcess>[0] = (tool, input, real) => (tool === 'testrail_get_version' ? Promise.resolve(failure('AUTHENTICATION_FAILED', 401)) : real(tool, input));
    const own = await qualify([], refuse);
    expect(own.evidence.server).toEqual({ package_version: packageJson.version, protocol: null, driver_version: installedDriver.version });
    const other = await qualify(['--command', 'testrail-mcp'], refuse);
    expect(other.evidence.server).toEqual({ package_version: packageJson.version, protocol: null, driver_version: null });
  });

  it('writes evidence with no credential, address or personal detail, and no TestRail data', () => {
    const { TESTRAIL_EMAIL: email = '', TESTRAIL_API_KEY: key = '' } = standIn.environment;
    for (const secret of [standIn.baseUrl, new URL(standIn.baseUrl).host, email, key, Buffer.from(`${email}:${key}`).toString('base64'),
      // The stand-in's signed-in user, and a name its fixtures return.
      'ada@example.com', 'Ada Lovelace', 'Fixture project']) {
      expect(full.text).not.toContain(secret);
      expect(full.log.join('\n')).not.toContain(key);
    }
  });

  it('runs to the end, which is a successful run', () => {
    expect(full.evidence.stopped).toBeNull();
    expect(runner.exitCode(full.evidence)).toBe(0);
  });

  it('sends every write to an entity the run created, in order, and reports each step', () => {
    // Every ID a write names came back from one of the run's own creations.
    const foreign = ids.writes.flatMap(({ tool, input }) => runner.targetsOf(tool, input)
      .filter(({ id }) => !ids.created.has(String(id))).map(({ key, id }) => `${tool} ${key} ${String(id)}`));
    expect(foreign).toEqual([]);
    // Every write the plan makes was seen: the full run leaves none out.
    expect(ids.writes).toHaveLength(runner.PLAN.filter(({ tool }) => registered(`testrail_${tool}`).effects.testRail !== 'read').length);
    expect(full.requests.filter(({ method }) => method === 'POST').map(({ tool }) => tool).at(-1)).toBe('testrail_delete_project');
    expect(stepsOf(full.evidence).filter(({ reason }) => reason?.startsWith('refused by the guard') === true)).toEqual([]);
    expect(full.log.filter((line) => /^pass {4}testrail_/u.test(line))).toHaveLength(runner.PLAN.length);
  });
});

describe('a run by default', () => {
  it('leaves writes outside the project and report generation alone, and says why', async () => {
    const { evidence, requests } = await qualify([]);
    const notRun = Object.entries(evidence.tools).filter(([, { status }]) => status === 'not_run').map(([tool]) => tool.replace(/^testrail_/u, '')).sort();
    expect(notRun).toEqual([...INSTANCE_WRITES, 'run_cross_project_report', 'run_report'].sort());
    expect(evidence.summary).toEqual({ pass: 125, not_run: 8, blocked: 0, fail: 0 });
    expect(evidence.tools.testrail_add_user?.steps).toEqual([{ label: null, status: 'not_run', reason: 'needs --instance-writes', warnings: [] }]);
    expect(evidence.tools.testrail_run_report?.steps).toEqual([{ label: null, status: 'not_run', reason: 'needs --report-template-id', warnings: [] }]);
    // The existing group is read; the run's own group is not made.
    expect(evidence.tools.testrail_get_group?.steps.map(({ label, status }) => `${String(label)}: ${status}`)).toEqual(['existing group: pass', 'own group: not_run']);
    const routes = requests.map(({ tool }) => tool?.replace(/^testrail_/u, ''));
    for (const tool of [...INSTANCE_WRITES, 'run_report', 'run_cross_project_report']) expect(routes, tool).not.toContain(tool);
    expect(evidence.cleanup).toEqual({ project: 'deleted', group: 'not_created', residue: [] });
  });
});

describe('a run that cannot finish', () => {
  it('blocks what needs the project when TestRail refuses to create it, and still reads', async () => {
    const { evidence, requests } = await qualify([], (tool, input, real) => (tool === 'testrail_add_project' ? Promise.resolve(failure('PERMISSION_DENIED', 403)) : real(tool, input)));
    expect(evidence.tools.testrail_add_project).toMatchObject({ status: 'blocked', steps: [{ code: 'PERMISSION_DENIED' }] });
    expect(evidence.tools.testrail_add_suite?.steps[0]).toMatchObject({ status: 'blocked', reason: 'needs the project an earlier step did not provide' });
    expect(evidence.tools.testrail_get_projects?.status).toBe('pass');
    expect(requests.some(({ tool }) => tool === 'testrail_delete_project')).toBe(false);
    // TestRail refused it, so there is nothing to clean up.
    expect(evidence.cleanup).toEqual({ project: 'not_created', group: 'not_created', residue: [] });
  });

  it('marks a missing licence as blocked, not failed, with its code and HTTP status', async () => {
    const { evidence } = await qualify([], (tool, input, real) => (tool === 'testrail_add_dataset' ? Promise.resolve(failure('LICENSE_REQUIRED', 403)) : real(tool, input)));
    expect(evidence.tools.testrail_add_dataset).toEqual({ status: 'blocked', steps: [{ label: null, status: 'blocked', code: 'LICENSE_REQUIRED', http_status: 403, warnings: [] }] });
    expect(evidence.tools.testrail_get_dataset?.steps[0]).toMatchObject({ status: 'blocked', reason: 'needs the dataset an earlier step did not provide' });
    expect(evidence.summary.fail).toBe(0);
  });

  it('deletes the project on the way out when the session fails part-way', async () => {
    let failed = false;
    const { evidence, requests } = await qualify([], (tool, input, real) => {
      if (tool === 'testrail_add_run' && !failed) {
        failed = true;
        return Promise.reject(new Error('the connection closed'));
      }
      return real(tool, input);
    });
    expect(evidence.tools.testrail_add_run?.steps[0]).toMatchObject({ status: 'fail', reason: 'the call failed: the connection closed' });
    expect(evidence.tools.testrail_close_run?.steps[0]).toMatchObject({ status: 'not_run', reason: 'the MCP session failed' });
    expect(evidence.cleanup.project).toBe('deleted_in_cleanup');
    expect(evidence.stopped).toBe('the MCP session failed');
    expect(runner.exitCode(evidence)).toBe(1);
    expect(requests.at(-1)?.tool).toBe('testrail_delete_project');
  });

  /** A session that stops answering after `tool`, as when its server has exited; later sessions work. */
  const dyingAfter = (tool: string, onDeath: () => void = () => undefined): Connect => {
    let opened = 0;
    return async (server) => {
      opened += 1;
      const session = await inProcess()(server);
      if (opened > 1) return session;
      let dead = false;
      return {
        ...session,
        call: async (name, input) => {
          if (dead) throw new Error('Not connected');
          const result = await session.call(name, input);
          if (name === tool) {
            dead = true;
            onDeath();
          }
          return result;
        },
      };
    };
  };

  it('cleans up through a fresh session when the session dies part-way', async () => {
    const { evidence, requests, log } = await qualify([], undefined, { connect: dyingAfter('testrail_add_run') });
    expect(stepsOf(evidence).filter(({ status }) => status === 'fail').map(({ reason }) => reason)).toEqual(['the call failed: Not connected']);
    expect(evidence.tools.testrail_close_run?.steps[0]).toMatchObject({ status: 'not_run', reason: 'the MCP session failed' });
    expect(evidence.cleanup).toEqual({ project: 'deleted_in_cleanup', group: 'not_created', residue: [] });
    expect(requests.at(-1)?.tool).toBe('testrail_delete_project');
    expect(log).toContain('The session to the server has ended; starting a fresh one to clean up.');
  });

  it('stops at Ctrl-C, which ends the server too, and still deletes the project and the group', async () => {
    const signals = new EventEmitter();
    let signalled = 0;
    // Ctrl-C at a terminal reaches the server as well as the runner, so the session dies with it.
    const { evidence, log } = await qualify(FULL, undefined, {
      signals,
      connect: dyingAfter('testrail_add_group', () => {
        signalled = standIn.requests.length;
        signals.emit('SIGINT');
      }),
    });
    const requests = standIn.requests.slice(signalled);
    expect(evidence.stopped).toBe('interrupted');
    expect(evidence.tools.testrail_update_group?.steps[0]).toMatchObject({ status: 'not_run', reason: 'interrupted' });
    expect(evidence.cleanup).toEqual({ project: 'deleted_in_cleanup', group: 'deleted_in_cleanup', residue: [] });
    const deletes = requests.filter(({ method, tool }) => method === 'POST' && tool?.startsWith('testrail_delete_') === true).map(({ tool }) => tool);
    expect(deletes).toEqual(['testrail_delete_project', 'testrail_delete_group']);
    expect(log[log.findIndex((line) => line.startsWith('Stopping:'))]).toBe('Stopping: the qualification project will be deleted. Press Ctrl-C again to abandon that cleanup.');
    for (const signal of ['SIGINT', 'SIGHUP', 'SIGTERM']) expect(signals.listenerCount(signal), signal).toBe(0);
    expect(runner.exitCode(evidence)).toBe(1);
  });

  it('stops the same way when the terminal closes, or on SIGTERM', async () => {
    for (const signal of ['SIGHUP', 'SIGTERM']) {
      const signals = new EventEmitter();
      const { evidence } = await qualify([], (tool, input, real) => {
        if (tool === 'testrail_add_case') signals.emit(signal);
        return real(tool, input);
      }, { signals });
      expect(evidence.stopped, signal).toBe('interrupted');
      expect(evidence.cleanup.project, signal).toBe('deleted_in_cleanup');
    }
  });

  it('abandons cleanup on a second Ctrl-C: removes its files, names what may be left, and exits with 2', async () => {
    const signals = new EventEmitter();
    const exits: number[] = [];
    const log: string[] = [];
    let work = '';
    let workAfter: boolean | undefined;
    const connect: Connect = async (server) => {
      work = dirname((JSON.parse(server.env.TESTRAIL_MCP_UPLOAD_ROOTS ?? '[]') as string[])[0] ?? '');
      const session = await inProcess()(server);
      return {
        ...session,
        call: async (tool, input) => {
          const result = await session.call(tool, input);
          if (tool === 'testrail_add_project') {
            signals.emit('SIGINT');
            signals.emit('SIGINT');
            workAfter = existsSync(work);
          }
          return result;
        },
      };
    };
    await runner.main({
      argv: ['--create-qualification-project', '--out', join(base, 'abandoned.json')], env: standIn.environment, connect, pacing: INSTANT,
      log: (line) => { log.push(line); }, signals, exit: (code) => { exits.push(code); },
    });
    expect(exits).toEqual([2]);
    expect(work).toMatch(/testrail-mcp-live-/u);
    expect(workAfter).toBe(false);
    expect(log).toContainEqual(expect.stringMatching(/^Cleanup abandoned: anything named "testrail-mcp qualification \S+ …" may be left behind, and no evidence was written\.$/u));
  });

  it('marks the step Ctrl-C cut short as not run, not failed', async () => {
    const signals = new EventEmitter();
    const { evidence } = await qualify([], (tool, input, real) => {
      if (tool !== 'testrail_add_case') return real(tool, input);
      signals.emit('SIGINT');
      return Promise.reject(new Error('Connection closed'));
    }, { signals });
    expect(evidence.tools.testrail_add_case?.steps[0]).toMatchObject({ status: 'not_run', reason: 'interrupted during the call' });
    expect(evidence.cleanup.project).toBe('deleted_in_cleanup');
  });

  it('reports a project, or a group, it could not delete even through a fresh session', async () => {
    const refusing = await qualify([], (tool, input, real) => (tool === 'testrail_delete_project' ? Promise.reject(new Error('Not connected')) : real(tool, input)));
    expect(refusing.evidence.cleanup).toEqual({ project: 'left_behind', group: 'not_created', residue: [{ kind: 'project', count: 1 }] });
    expect(refusing.log).toContain('The session to the server has ended; starting a fresh one to clean up.');
    const denied = await qualify(FULL, (tool, input, real) => (tool === 'testrail_delete_group' ? Promise.resolve(failure('PERMISSION_DENIED', 403)) : real(tool, input)));
    expect(denied.evidence.cleanup).toEqual({ project: 'deleted', group: 'left_behind', residue: [{ kind: 'user', count: 1 }, { kind: 'case_field', count: 1 }, { kind: 'group', count: 1 }] });
    expect(runner.exitCode(denied.evidence)).toBe(1);
  });

  it('lists a group, user or case field that may exist when its creation\'s outcome is unknown', async () => {
    const unknown: ToolResult = { isError: true, structuredContent: { error: { code: 'TIMEOUT', message: 'Synthetic.', write_outcome: 'unknown' } } };
    for (const [tool, kind] of [['testrail_add_group', 'possible group'], ['testrail_add_user', 'possible user'], ['testrail_add_case_field', 'possible case_field']]) {
      const { evidence } = await qualify(FULL, (name, input, real) => (name === tool ? Promise.resolve(unknown) : real(name, input)));
      expect(evidence.cleanup.residue, tool).toContainEqual({ kind, count: 1 });
    }
    // A server error, and a session lost mid-call, leave the same doubt.
    const failed = await qualify(FULL, (name, input, real) => (name === 'testrail_add_group' ? Promise.resolve(failure('UPSTREAM_ERROR', 500)) : real(name, input)));
    expect(failed.evidence.cleanup.residue).toContainEqual({ kind: 'possible group', count: 1 });
    let lost = false;
    const dropped = await qualify(FULL, (name, input, real) => {
      if (name === 'testrail_add_user' && !lost) {
        lost = true;
        return Promise.reject(new Error('the connection closed'));
      }
      return real(name, input);
    });
    expect(dropped.evidence.cleanup.residue).toContainEqual({ kind: 'possible user', count: 1 });
  });

  it('still cleans up when the runner itself throws part-way', async () => {
    const calls: string[] = [];
    const plan: PlanStep[] = [
      { tool: 'add_project', scope: 'own', input: () => ({ body: { name: 'p' } }), capture: (data, c) => { c.own('project', (data as { id: number }).id); } },
      { tool: 'get_project', scope: 'read', input: () => { throw new TypeError('a bug in the plan'); } },
    ];
    const call: Call = (tool) => {
      calls.push(tool);
      return Promise.resolve({ structuredContent: { data: { id: 5 } } });
    };
    await expect(runner.runQualification({ call, plan, stamp: 's', uploads: {}, pacing: INSTANT })).rejects.toThrow(/a bug in the plan/u);
    expect(calls).toEqual(['testrail_add_project', 'testrail_delete_project']);
  });

  it('says what cleanup did even when the run throws part-way', async () => {
    const log: string[] = [];
    // Any fault inside the run will do: here, the line for a step cannot be written.
    const fault = new Error('a fault inside the run');
    await expect(runner.main({
      argv: ['--create-qualification-project', '--out', join(base, 'faulted.json')], env: standIn.environment, connect: inProcess(), pacing: INSTANT,
      log: (line) => {
        if (line.startsWith('pass    testrail_add_suite')) throw fault;
        log.push(line);
      },
    })).rejects.toBe(fault);
    expect(log.at(-1)).toBe('Cleanup: project deleted_in_cleanup, group not_created.');
  });

  it('reports a project it could not delete as left behind', async () => {
    const { evidence } = await qualify([], (tool, input, real) => (tool === 'testrail_delete_project' ? Promise.resolve(failure('UPSTREAM_ERROR')) : real(tool, input)));
    expect(evidence.cleanup).toMatchObject({ project: 'left_behind', residue: [{ kind: 'project', count: 1 }] });
    expect(evidence.tools.testrail_delete_project?.status).toBe('fail');
  });

  it('reports a project that may exist when TestRail\'s answer to creating it is unknown', async () => {
    const unknown = (outcome: string): ToolResult => ({ isError: true, structuredContent: { error: { code: 'TIMEOUT', message: 'Synthetic.', write_outcome: outcome } } });
    const timedOut = await qualify([], (tool, input, real) => (tool === 'testrail_add_project' ? Promise.resolve(unknown('unknown')) : real(tool, input)));
    expect(timedOut.evidence.cleanup).toEqual({ project: 'not_created', group: 'not_created', residue: [{ kind: 'possible project', count: 1 }] });
    // A write TestRail never received leaves nothing.
    const refused = await qualify([], (tool, input, real) => (tool === 'testrail_add_project' ? Promise.resolve(unknown('not_started')) : real(tool, input)));
    expect(refused.evidence.cleanup.residue).toEqual([]);
    const unusable = await qualify([], (tool, input, real) => (tool === 'testrail_add_project' ? Promise.resolve({ structuredContent: { data: {} } }) : real(tool, input)));
    expect(unusable.evidence.tools.testrail_add_project?.steps[0]).toMatchObject({ status: 'fail', reason: 'unexpected response: the response has no id' });
    expect(unusable.evidence.cleanup.residue).toEqual([{ kind: 'possible project', count: 1 }]);
  });

  it('lists what a write may have created when the driver\'s own deadline ends it, though its status is 408', async () => {
    // The driver raises a 408 of its own when TestRail has not answered in time; TestRail may still have acted.
    const context = { mutates: true, dispatched: true, acknowledged: false };
    const deadline: ToolResult = { isError: true, structuredContent: { error: classifyError(new TestRailApiError(408, `Request timeout after ${String(REQUEST_TIMEOUT_MS)}ms`), context) } };
    expect(deadline.structuredContent).toMatchObject({ error: { http_status: 408, write_outcome: 'unknown' } });
    // TestRail creates the project, and its answer is lost.
    const project = await qualify([], async (tool, input, real) => {
      if (tool !== 'testrail_add_project') return real(tool, input);
      await real(tool, input);
      return deadline;
    });
    expect(project.evidence.cleanup).toEqual({ project: 'not_created', group: 'not_created', residue: [{ kind: 'possible project', count: 1 }] });
    for (const [tool, kind] of [['testrail_add_group', 'possible group'], ['testrail_add_user', 'possible user'], ['testrail_add_case_field', 'possible case_field']]) {
      const { evidence } = await qualify(FULL, (name, input, real) => (name === tool ? Promise.resolve(deadline) : real(name, input)));
      expect(evidence.cleanup.residue, tool).toContainEqual({ kind, count: 1 });
    }
    // A 4xx TestRail sent is a refusal, and leaves nothing.
    const refusal: ToolResult = { isError: true, structuredContent: { error: classifyError(new TestRailApiError(400, 'Bad Request', '{"error":"Field :name is required."}'), context) } };
    expect(refusal.structuredContent).toMatchObject({ error: { http_status: 400, write_outcome: 'unknown' } });
    const refused = await qualify([], (tool, input, real) => (tool === 'testrail_add_project' ? Promise.resolve(refusal) : real(tool, input)));
    expect(refused.evidence.cleanup.residue).toEqual([]);
  });

  it('stops at once when TestRail refuses the credentials', async () => {
    // Every other call would reach the stand-in, so any sent after the refusal shows.
    const { evidence, requests } = await qualify([], (tool, input, real) => (tool === 'testrail_get_version' ? Promise.resolve(failure('AUTHENTICATION_FAILED', 401)) : real(tool, input)));
    expect(evidence.tools.testrail_get_version?.steps[0]).toMatchObject({ status: 'fail', code: 'AUTHENTICATION_FAILED' });
    const rest = stepsOf(evidence).filter(({ tool }) => tool !== 'testrail_get_version');
    expect(new Set(rest.map(({ status, reason }) => `${status}: ${String(reason)}`))).toEqual(new Set(['not_run: TestRail refused the credentials']));
    expect(requests).toEqual([]);
  });

  it('repeats a rate-limited call, which TestRail did not handle', async () => {
    let limited = 0;
    const { evidence } = await qualify([], (tool, input, real) => (tool === 'testrail_get_run' && (limited += 1) === 1 ? Promise.resolve(failure('RATE_LIMITED')) : real(tool, input)));
    expect(evidence.tools.testrail_get_run?.steps).toEqual([{ label: null, status: 'pass', retries: 1, warnings: [] }]);
  });

  /** A run whose TestRail version reply carries `echo`, as a message quoting the instance might. */
  const echoing = async (echo: string, env: Environment = standIn.environment) => {
    const out = join(base, `echo-${String(runs += 1)}.json`);
    const log: string[] = [];
    const settled = await runner.main({
      argv: ['--create-qualification-project', '--out', out], env, pacing: INSTANT, log: (line) => { log.push(line); },
      // The server always reaches the stand-in, whatever address the evidence is checked against.
      connect: async (server) => inProcess((tool, input, real) => (tool === 'testrail_get_version'
        ? Promise.resolve({ structuredContent: { data: { version: `10.7 ${echo}` } } })
        : real(tool, input)))({ ...server, env: { ...server.env, ...standIn.environment } }),
    }).then(() => 'written', (error: unknown) => (error instanceof Error ? error.message : String(error)));
    return { settled, log, written: await readFile(out, 'utf8').then(() => true, () => false) };
  };

  it('refuses to write evidence that would carry the address, the host, the identity, the key, the credential or the signed-in address', async () => {
    const { TESTRAIL_BASE_URL: url = '', TESTRAIL_EMAIL: email = '', TESTRAIL_API_KEY: key = '' } = standIn.environment;
    const values = [url, new URL(url).host, new URL(url).hostname, email, key, Buffer.from(`${email}:${key}`).toString('base64'), 'ada@example.com'];
    for (const value of values) {
      const { settled, written, log } = await echoing(`at ${value}`);
      expect(settled, value).toMatch(/the evidence would carry \d+ configured or personal value\(s\); it was not written/u);
      expect(written, value).toBe(false);
      // What cleanup did is still said.
      expect(log, value).toContain('Cleanup: project deleted, group not_created.');
    }
  });

  it('checks a host as a whole name, so a one-word host does not refuse every run', async () => {
    const env = { ...standIn.environment, TESTRAIL_BASE_URL: 'https://testrail' };
    expect(await echoing('ok', env)).toMatchObject({ settled: 'written', written: true });
    expect(await echoing('on testrail today', env)).toMatchObject({ written: false });
  });

  it('refuses, before any request, a configuration its evidence could never be checked against, and an unusable --out', async () => {
    const connect = vi.fn<Connect>();
    const before = standIn.requests.length;
    const attempt = (env: Environment, out: string) => runner.main({ argv: ['--create-qualification-project', '--out', out], env, connect, pacing: INSTANT, log: () => undefined });
    // An API key that is also a word the evidence always contains.
    await expect(attempt({ ...standIn.environment, TESTRAIL_API_KEY: 'pass' }, join(base, 'never-1.json'))).rejects.toThrow(/appears in the evidence's own words.*Nothing was sent to TestRail/u);
    await expect(attempt(standIn.environment, base)).rejects.toThrow(/is a directory/u);
    expect(() => runner.parseOptions(['--create-qualification-project', '--out', ''])).toThrow(/Name the evidence file with --out/u);
    expect(connect).not.toHaveBeenCalled();
    expect(standIn.requests.length).toBe(before);
  });

  it('checks an existing evidence file without changing it, so a run that ends early leaves it as it was', async () => {
    const out = join(base, 'earlier.json');
    await writeFile(out, 'earlier evidence\n');
    const connect: Connect = () => Promise.reject(new Error('the server did not start'));
    await expect(runner.main({ argv: ['--create-qualification-project', '--out', out], env: standIn.environment, connect, pacing: INSTANT, log: () => undefined }))
      .rejects.toThrow(/the server did not start/u);
    expect(await readFile(out, 'utf8')).toBe('earlier evidence\n');
  });

  // Root writes through a file's permissions, so there a read-only file is writable and nothing is refused.
  it.skipIf(process.getuid?.() === 0)('refuses, before any request, an evidence file it cannot overwrite, and leaves it as it was', async () => {
    const connect = vi.fn<Connect>();
    const out = join(base, 'read-only.json');
    await writeFile(out, 'earlier evidence\n');
    await chmod(out, 0o444);
    try {
      await expect(runner.main({ argv: ['--create-qualification-project', '--out', out], env: standIn.environment, connect, pacing: INSTANT, log: () => undefined }))
        .rejects.toThrow(/--out .* cannot be written/u);
      expect(connect).not.toHaveBeenCalled();
      expect(await readFile(out, 'utf8')).toBe('earlier evidence\n');
    } finally {
      await chmod(out, 0o644);
    }
  });

  it('skips the existing group read, rather than blocking it, on an instance with no groups', async () => {
    const { evidence } = await qualify(FULL, (tool, input, real) => (tool === 'testrail_get_groups' ? Promise.resolve({ structuredContent: { data: [] } }) : real(tool, input)));
    expect(evidence.tools.testrail_get_group).toEqual({ status: 'pass', steps: [
      { label: 'existing group', status: 'not_run', reason: 'the instance has no group to read', warnings: [] },
      { label: 'own group', status: 'pass', warnings: [] },
    ] });
  });
});

describe('the operator guide', () => {
  const row = (start: string): string => guide.split('\n').find((line) => line.startsWith(start)) ?? '';

  it('rehearses with every option, so every tool passes against the stand-in', () => {
    expect(guide).toContain('--instance-writes --report-template-id 1 --cross-project-report-template-id 2');
  });

  it('says how to find what a run leaves behind', () => {
    const user = runner.PLAN.find(({ tool }) => tool === 'add_user');
    const field = runner.PLAN.find(({ tool }) => tool === 'add_case_field');
    const context = { name: (suffix: string) => `testrail-mcp qualification STAMP ${suffix}`, email: () => 'x@example.invalid', short: (tag: string) => `tmq-abcdef-${tag}`, id: () => 1 };
    const userBody = (user?.input?.(context as unknown as Context) as { body: { name: string; email: string } }).body;
    const fieldBody = (field?.input?.(context as unknown as Context) as { body: { name: string; label: string } }).body;
    expect(userBody.name.startsWith('testrail-mcp qualification')).toBe(true);
    expect(fieldBody.label.startsWith('testrail-mcp qualification')).toBe(true);
    expect(fieldBody.name).toBe('tmq_abcdef_f');
    expect(guide).toContain('The user\'s name and the case field\'s label start with `testrail-mcp qualification`; the case field\'s system name is `tmq_<id>_f`, and the user\'s address ends in `@example.invalid`.');
  });

  it('names exactly the plan\'s writes outside the project', () => {
    const named = [...row('| Writes outside the project |').matchAll(/`([a-z_]+)`/gu)].map(([, tool]) => tool).sort();
    expect(named).toEqual(runner.PLAN.filter(({ scope }) => scope === 'instance').map(({ tool }) => tool).sort());
  });

  it('states the pace the server allows, and every option the runner takes', async () => {
    const configuration = driverOptions(await loadConfiguration({ ...standIn.environment, TESTRAIL_MCP_UPLOAD_ROOTS: '[]', TESTRAIL_MCP_DOWNLOAD_DIR: base }));
    expect(guide).toContain(`allows ${String(configuration.rateLimiter?.maxRequests)} TestRail requests a minute`);
    expect(configuration.rateLimiter?.windowMs).toBe(60_000);
    const options = [...guide.matchAll(/^\| `(--[a-z-]+)[^|]*\|/gmu)].map(([, flag]) => flag);
    expect(options.sort()).toEqual(['--command', '--create-qualification-project', '--cross-project-report-template-id', '--instance-writes', '--out', '--report-template-id']);
  });
});

describe('the command line', () => {
  const cli = (args: string[], env: Environment) => promisify(execFile)(process.execPath, [script('live-qualification.mjs'), ...args], { env });

  it.each([
    [[], /pass --create-qualification-project to confirm/u],
    [['--create-qualification-project'], /Name the evidence file with --out/u],
    [['--create-qualification-project', '--out', 'x.json', '--report-template-id', '0'], /--report-template-id must be a positive integer/u],
  ])('refuses %j', async (args, message) => {
    await expect(cli(args, { PATH: process.env.PATH })).rejects.toMatchObject({ code: 2, stderr: expect.stringMatching(message) as unknown });
  });

  it.skipIf(process.platform === 'win32')('runs when invoked through a symlinked path, as from a clone under /tmp on macOS', async () => {
    const link = join(base, 'linked-scripts');
    await symlink(fileURLToPath(new URL('../scripts/', import.meta.url)), link);
    await expect(promisify(execFile)(process.execPath, [join(link, 'live-qualification.mjs')], { env: { PATH: process.env.PATH } }))
      .rejects.toMatchObject({ code: 2, stderr: expect.stringMatching(/pass --create-qualification-project to confirm/u) as unknown });
  });

  it('names a missing variable without echoing any value', async () => {
    const env = { PATH: process.env.PATH, TESTRAIL_BASE_URL: 'https://secret-host.example.invalid', TESTRAIL_EMAIL: 'secret-person@example.invalid' };
    const refused = cli(['--create-qualification-project', '--out', join(base, 'never.json')], env);
    await expect(refused).rejects.toMatchObject({ code: 2, stderr: expect.stringContaining('Set TESTRAIL_API_KEY in the environment') as unknown });
    const { stderr } = await refused.catch((error: unknown) => error as { stderr: string });
    expect(stderr).not.toMatch(/secret-host|secret-person/u);
  });

  it('takes a server argument that starts with a dash as --arg=', () => {
    expect(runner.parseOptions(['--create-qualification-project', '--out', 'x.json', '--command', 'npx', '--arg=-y', '--arg', 'pkg']).server).toEqual({ command: 'npx', args: ['-y', 'pkg'] });
    expect(guide).toContain('`--arg=-y`');
  });

  it('says why a server that will not start did not', async () => {
    await expect(runner.connectStdio({
      command: process.execPath, args: [fileURLToPath(new URL('../dist/cli.js', import.meta.url))],
      env: { PATH: process.env.PATH, TESTRAIL_BASE_URL: 'http://127.0.0.1:9', TESTRAIL_EMAIL: 'nobody@example.invalid', TESTRAIL_API_KEY: 'synthetic-key' },
    })).rejects.toThrow(/^The server did not start: .*TESTRAIL_BASE_URL/u);
  }, 30_000);

  it.skipIf(process.platform === 'win32')('deletes the project when Ctrl-C at a terminal stops the runner and the server together', async () => {
    const out = join(base, 'interrupted', 'evidence.json');
    const launched = standIn.requests.length;
    // Detached, the runner leads its own process group, as a terminal's foreground job does.
    const cli = spawn(process.execPath, [script('live-qualification.mjs'), '--create-qualification-project', '--out', out], {
      detached: true, stdio: ['ignore', 'ignore', 'pipe'], env: { PATH: process.env.PATH, HOME: process.env.HOME, ...standIn.environment },
    });
    let stderr = '';
    cli.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    const exited = new Promise<number | null>((resolve) => { cli.once('exit', resolve); });
    await vi.waitFor(() => { expect(standIn.requests.slice(launched).some(({ tool }) => tool === 'testrail_add_project')).toBe(true); }, { timeout: 60_000, interval: 200 });
    const signalled = standIn.requests.length;
    // As Ctrl-C does: the signal goes to the whole group, the runner and the server it started.
    process.kill(-(cli.pid ?? 0), 'SIGINT');
    expect(await exited).toBe(1);
    expect(standIn.requests.slice(signalled).map(({ method, tool }) => `${method} ${String(tool)}`)).toContain('POST testrail_delete_project');
    expect(evidenceSchema.parse(JSON.parse(await readFile(out, 'utf8')))).toMatchObject({ stopped: 'interrupted', cleanup: { project: 'deleted_in_cleanup' } });
    expect(stderr).toContain('The session to the server has ended; starting a fresh one to clean up.');
  }, 120_000);

  it.skipIf(process.platform === 'win32')('still deletes the project when the terminal closes and nothing reads its output any more', async () => {
    const out = join(base, 'hung-up', 'evidence.json');
    // With its output gone, a crash would leave nothing to read but Node's own report.
    const reports = await mkdtemp(join(base, 'reports-'));
    const launched = standIn.requests.length;
    const cli = spawn(process.execPath, ['--report-uncaught-exception', `--report-directory=${reports}`, script('live-qualification.mjs'), '--create-qualification-project', '--out', out], {
      detached: true, stdio: ['ignore', 'ignore', 'pipe'], env: { PATH: process.env.PATH, HOME: process.env.HOME, ...standIn.environment },
    });
    let said = '';
    cli.stderr?.on('data', (chunk: Buffer) => { said += chunk.toString(); });
    const exited = new Promise<number | null>((resolve) => { cli.once('exit', resolve); });
    await vi.waitFor(() => { expect(standIn.requests.slice(launched).some(({ tool }) => tool === 'testrail_add_project')).toBe(true); }, { timeout: 60_000, interval: 200 });
    const signalled = standIn.requests.length;
    // As a `| tee` that Ctrl-C stopped too: the output's reader is gone, then the signal arrives.
    cli.stderr?.destroy();
    process.kill(-(cli.pid ?? 0), 'SIGHUP');
    const code = await exited;
    const after = standIn.requests.slice(signalled).map(({ method, tool }) => `${method} ${String(tool)}`);
    const evidence = await readFile(out, 'utf8').catch(() => undefined);
    const [report] = await readdir(reports);
    // Should it fail, everything the run left behind to explain why.
    const context = JSON.stringify({
      code, after, cleanup: evidence === undefined ? 'no evidence' : (JSON.parse(evidence) as { cleanup: unknown }).cleanup,
      crash: report === undefined ? null : (JSON.parse(await readFile(join(reports, report), 'utf8')) as { javascriptStack?: unknown }).javascriptStack,
      said: said.trim().split('\n').slice(-3),
    });
    expect(code, context).toBe(1);
    expect(after, context).toContain('POST testrail_delete_project');
    expect(evidenceSchema.parse(JSON.parse(evidence ?? 'null'))).toMatchObject({ stopped: 'interrupted', cleanup: { project: 'deleted_in_cleanup' } });
  }, 120_000);

  it('drives the built server over stdio', async () => {
    const downloads = await mkdtemp(join(base, 'downloads-'));
    const session = await runner.connectStdio({
      command: process.execPath, args: [fileURLToPath(new URL('../dist/cli.js', import.meta.url))],
      env: { ...process.env, ...standIn.environment, TESTRAIL_MCP_UPLOAD_ROOTS: '[]', TESTRAIL_MCP_DOWNLOAD_DIR: downloads },
    });
    try {
      const result = await session.call('testrail_get_project', { project_id: 7 });
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toMatchObject({ data: { id: expect.any(Number) as unknown } });
      expect(session.serverVersion).toBe(packageJson.version);
      expect(session.protocol).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    } finally {
      await session.close();
    }
  }, 30_000);
});
