import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { TestRailClient } from '@dichovsky/testrail-api-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { loadConfiguration } from '../src/config/environment.js';
import { ERROR_CODES } from '../src/contracts/errors.js';
import { driverOptions } from '../src/driver/configuration.js';
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
interface PlanStep { tool: string; label?: string; scope: Scope; requires?: string }
interface ToolResult { isError?: boolean; structuredContent?: unknown }
type Call = (tool: string, input: unknown) => Promise<ToolResult>;
type Environment = Record<string, string | undefined>;
interface Session { call: Call; serverVersion?: string | undefined; protocol?: string | undefined; close: () => Promise<void> }
interface Pacing { minIntervalMs: number; retryDelayMs: number; attempts: number }
interface LedgerLike { add: (kind: string, id: unknown) => void }
interface Runner {
  PLAN: PlanStep[];
  Ledger: new () => LedgerLike;
  GuardRefusal: new (message: string) => Error;
  guard: (step: Pick<PlanStep, 'tool' | 'scope'>, input: unknown, ledger: LedgerLike) => void;
  targetsOf: (tool: string, input: unknown) => { key: string; kind: string; id: unknown }[];
  assertSanitized: (text: string, secrets: (string | undefined)[]) => void;
  main: (options: {
    argv: string[]; env: Environment; pacing?: Pacing; log?: (line: string) => void;
    connect?: (server: { command: string; args: string[]; env: Environment }) => Promise<Session>;
  }) => Promise<unknown>;
  connectStdio: (server: { command: string; args: string[]; env: Environment }) => Promise<Session>;
}
interface StandIn { baseUrl: string; environment: Record<string, string>; requests: { method: string; endpoint: string; tool: string | null }[]; close: () => Promise<void> }

const script = (name: string): string => fileURLToPath(new URL(`../scripts/${name}`, import.meta.url));
const runner = (await import(new URL('../scripts/live-qualification.mjs', import.meta.url).href)) as Runner;
const { startFixtureTestRail } = (await import(new URL('../scripts/fixture-testrail.mjs', import.meta.url).href)) as {
  startFixtureTestRail: () => Promise<StandIn>;
};
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
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
async function qualify(flags: string[], inject?: Parameters<typeof inProcess>[0]) {
  // Each run writes into a directory that does not exist yet.
  const out = join(base, `run-${String(runs += 1)}`, 'evidence.json');
  const log: string[] = [];
  const before = standIn.requests.length;
  const evidence = await runner.main({
    argv: ['--create-qualification-project', '--out', out, ...flags],
    env: standIn.environment, connect: inProcess(inject), pacing: INSTANT, log: (line) => { log.push(line); },
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
    expect(() => { runner.guard({ tool: 'delete_case', scope: 'own' }, { case_id: 5 }, ledger()); }).toThrow(/case_id 5 is not a case this run created/u);
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
      .toThrow(/run_id 1/u);
    const created = ledger();
    created.add('run', 1);
    expect(() => { runner.guard({ tool: 'add_results', scope: 'own' }, { run_id: 1, body: { results: [{ test_id: 99, status_id: 1 }] } }, created); })
      .toThrow(/test_id 99/u);
    expect(() => { runner.guard({ tool: 'update_tests', scope: 'own' }, { body: { test_ids: [7], labels: [8, 'new title'] } }, created); }).not.toThrow();
    expect(() => { runner.guard({ tool: 'update_tests', scope: 'own' }, { body: { test_ids: [7], labels: [9] } }, created); }).toThrow(/labels 9/u);
    expect(() => { runner.guard({ tool: 'get_project', scope: 'read' }, { project_id: 11 }, ledger()); }).not.toThrow();
  });
});

describe('a full run against the stand-in', () => {
  let full: Awaited<ReturnType<typeof qualify>>;
  beforeAll(async () => { full = await qualify(FULL); });

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

  it('writes evidence with no credential, address or personal detail, and no TestRail data', () => {
    const { TESTRAIL_EMAIL: email = '', TESTRAIL_API_KEY: key = '' } = standIn.environment;
    for (const secret of [standIn.baseUrl, new URL(standIn.baseUrl).host, email, key, Buffer.from(`${email}:${key}`).toString('base64'),
      // The stand-in's signed-in user, and a name its fixtures return.
      'ada@example.com', 'Ada Lovelace', 'Fixture project']) {
      expect(full.text).not.toContain(secret);
      expect(full.log.join('\n')).not.toContain(key);
    }
  });

  it('sends every write to an entity the run created, in order, and reports each step', () => {
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

  it('marks a missing licence as blocked, not failed', async () => {
    const { evidence } = await qualify([], (tool, input, real) => (tool === 'testrail_add_dataset' ? Promise.resolve(failure('LICENSE_REQUIRED', 403)) : real(tool, input)));
    expect(evidence.tools.testrail_add_dataset?.status).toBe('blocked');
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
    expect(requests.at(-1)?.tool).toBe('testrail_delete_project');
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

  it('stops at once when TestRail refuses the credentials', async () => {
    const { evidence, requests } = await qualify([], (tool) => Promise.resolve(failure(tool === 'testrail_get_version' ? 'AUTHENTICATION_FAILED' : 'INTERNAL_ERROR')));
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

  it('refuses to write evidence that would carry the TestRail address', async () => {
    const out = join(base, 'refused.json');
    await expect(runner.main({
      argv: ['--create-qualification-project', '--out', out], env: standIn.environment, pacing: INSTANT, log: () => undefined,
      connect: inProcess((tool, input, real) => (tool === 'testrail_get_version'
        ? Promise.resolve({ structuredContent: { data: { version: `10.7 at ${new URL(standIn.baseUrl).host}` } } })
        : real(tool, input))),
    })).rejects.toThrow(/the evidence would carry 1 configured or personal value\(s\); it was not written/u);
    await expect(readFile(out)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('the operator guide', () => {
  const row = (start: string): string => guide.split('\n').find((line) => line.startsWith(start)) ?? '';

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
