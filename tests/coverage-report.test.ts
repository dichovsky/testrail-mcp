import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { operationRegistry } from '../src/operations/catalog.js';
import { createRegistry, type Operation } from '../src/operations/registry.js';
import { buildCoverageReports, type InventoryRow, type ReportEnvironment } from './contracts/coverage-report.js';
import { loadParameterManifests, type ParameterManifest } from './contracts/parameter-manifest.js';

/*
 * R01: publish the coverage, parameter and fixture-evidence reports as CI artifacts. The
 * reports are built from the registry, the pinned inventory and the manifests. Every check
 * below is a gate: the last test writes the files only when all of them passed earlier in
 * the same run, so a failing or filtered run writes nothing. CI sets
 * TESTRAIL_MCP_REPORT_DIR and uploads what lands there.
 */

const REPORT_DIR = 'TESTRAIL_MCP_REPORT_DIR';
const read = async (path: string): Promise<string> => readFile(new URL(path, import.meta.url), 'utf8');
const rawInventory = JSON.parse(await read('../docs/operation-inventory.json')) as {
  status: string;
  status_scope: string;
  release_verification: {
    production_release: { status: string; exact_dependency: string | null };
    qualified_release: { version: string; release_commit: string; npm_integrity: string; qualified_for_production: boolean };
  };
  operations: InventoryRow[];
};
const manifests = await loadParameterManifests();
const packageJson = JSON.parse(await read('../package.json')) as { name: string; version: string; dependencies: Record<string, string> };
const lock = JSON.parse(await read('../package-lock.json')) as { packages: Record<string, { version: string; resolved: string; integrity: string }> };
const DRIVER = '@dichovsky/testrail-api-client';
const installedDriver = JSON.parse(await read(`../node_modules/${DRIVER}/package.json`)) as { name: string; version: string };
const locked = lock.packages[`node_modules/${DRIVER}`];
if (locked === undefined) throw new Error('The driver is missing from the lockfile');

/** The product contract's numbers and the reviewed driver release, stated here rather than read back. */
const CONTRACT = { operations: 133, resources: 28, families: 12, controlled: 18, response_driven: 6, helpers: 48 } as const;
const REVIEWED_DRIVER = { version: '7.2.0', commit: 'cc7751c01c3d3956d061073283bee6b23bf33422' } as const;

const commit = (value: string | undefined): string | null => value !== undefined && /^[0-9a-f]{40}$/u.test(value) ? value : null;

/** A pull request's head from the event GitHub hands the job; otherwise the pushed commit. */
async function headCommit(): Promise<string | null> {
  if (process.env.GITHUB_EVENT_NAME !== 'pull_request') return commit(process.env.GITHUB_SHA);
  const path = process.env.GITHUB_EVENT_PATH;
  if (path === undefined) return null;
  const event = JSON.parse(await readFile(path, 'utf8')) as { pull_request?: { head?: { sha?: string } } };
  return commit(event.pull_request?.head?.sha);
}

const environment: ReportEnvironment = {
  package: { name: packageJson.name, version: packageJson.version },
  driver: { name: installedDriver.name, version: installedDriver.version, resolved: locked.resolved, integrity: locked.integrity },
  runtime: { node: process.version, platform: process.platform, arch: process.arch },
  source: { head_commit: await headCommit(), built_commit: commit(process.env.GITHUB_SHA) },
};

const reports = buildCoverageReports(operationRegistry, rawInventory.operations, manifests, environment);
const { totals, endpoints } = reports.coverage;

const GATES: string[] = [];
const held = new Set<string>();

/** A check the report files depend on: the writer refuses unless it passed in this run. */
function gate(name: string, check: () => void | Promise<void>): void {
  GATES.push(name);
  it(name, async () => {
    await check();
    held.add(name);
  });
}

const manifestFor = (tool: string): ParameterManifest => {
  const found = manifests.find(({ endpoint }) => endpoint.tool === tool);
  if (found === undefined) throw new Error(`${tool} has no manifest`);
  return found;
};
const bodyKind = (wire: { json?: unknown; multipart?: unknown }): string =>
  wire.multipart !== undefined ? 'multipart' : wire.json !== undefined ? 'json' : 'none';

describe('the coverage reports', () => {
  gate('account for the whole contract', () => {
    expect({
      operations: totals.operations, resources: totals.resources, families: totals.families,
      controlled: totals.paged.controlled, response_driven: totals.paged.response_driven, helpers: totals.helpers,
    }).toEqual(CONTRACT);
    expect(totals.registered).toBe(CONTRACT.operations);
    expect(totals.extra_registrations).toBe(0);
    expect(totals.manifests).toEqual({ complete: CONTRACT.operations, partial: 0, absent: 0 });
    expect(totals.requirements.covered).toBe(totals.requirements.total);
    expect(totals.cases.accepted).toBeGreaterThanOrEqual(CONTRACT.operations);
  });

  gate('count what the manifests hold, not what the report builder kept', () => {
    // Every target a manifest declares, in order, with every requirement row it declares.
    const declared = (manifest: ParameterManifest) => [
      { id: '$input', requirements: manifest.requirements.map(({ id }) => id) },
      ...manifest.parameters.map(({ id, requirements }) => ({ id, requirements: (requirements ?? []).map((requirement) => requirement.id) })),
    ];
    const reported = new Map(reports.parameters.endpoints.map(({ tool, targets }) =>
      [tool, targets.map(({ id, requirements }) => ({ id, requirements: requirements.map((requirement) => requirement.id) }))]));
    expect(manifests.filter((manifest) => JSON.stringify(reported.get(manifest.endpoint.tool)) !== JSON.stringify(declared(manifest)))
      .map(({ endpoint }) => endpoint.tool)).toEqual([]);

    const rows = (manifest: ParameterManifest): number => declared(manifest).reduce((sum, { requirements }) => sum + requirements.length, 0);
    const cases = (kind: string): number => manifests.reduce((sum, { cases: all }) => sum + all.filter(({ expect: outcome }) => outcome.kind === kind).length, 0);
    expect({
      parameters: totals.parameters,
      requirements: totals.requirements.total,
      accepted: totals.cases.accepted,
      rejected: totals.cases.rejected,
    }).toEqual({
      parameters: manifests.reduce((sum, { parameters }) => sum + parameters.length, 0),
      requirements: manifests.reduce((sum, manifest) => sum + rows(manifest), 0),
      accepted: cases('accepted'),
      rejected: cases('rejected'),
    });
    // The three files describe the same endpoints and the same cases.
    const evidence = new Map(reports.evidence.endpoints.map((entry) => [entry.tool, entry]));
    expect(endpoints.filter(({ tool, manifest }) => {
      const recorded = evidence.get(tool);
      return manifest === null || recorded === undefined || manifest.requirements.total !== rows(manifestFor(tool))
        || recorded.accepted.length !== manifest.cases.accepted || recorded.rejected.length !== manifest.cases.rejected;
    }).map(({ tool }) => tool)).toEqual([]);
  });

  gate('show every endpoint registered, with a complete manifest whose every requirement a fixture covers', () => {
    const gaps = endpoints.filter(({ registered, manifest }) =>
      !registered || manifest?.status !== 'complete' || manifest.requirements.covered !== manifest.requirements.total || manifest.cases.accepted === 0);
    expect(gaps.map(({ tool }) => tool)).toEqual([]);
    const uncovered = reports.parameters.endpoints.flatMap(({ tool, targets }) => targets.flatMap(({ id, requirements }) =>
      requirements.filter(({ covered_by }) => covered_by.length === 0).map((requirement) => `${tool} ${id}/${requirement.id}`)));
    expect(uncovered).toEqual([]);
  });

  gate('list, row by row, the cases that cover each requirement', () => {
    // Transcribed from tests/fixtures/parameters/get_project.json and the project_id domain.
    expect(reports.parameters.endpoints.find(({ tool }) => tool === 'testrail_get_project')?.targets).toEqual([
      { id: '$input', requirements: [{ id: 'unknown-top-level', kind: 'invalid', covered_by: ['unknown-top-level'] }] },
      {
        id: 'project_id', scope: 'path', requiredness: 'required', location: 'path',
        requirements: [
          { id: 'mapping', kind: 'mapping', covered_by: ['representative-id'] },
          { id: 'valid', kind: 'valid', covered_by: ['representative-id'] },
          { id: 'invalid', kind: 'invalid', covered_by: ['project_id:zero', 'project_id:negative', 'project_id:fractional', 'project_id:numeric-string'] },
          { id: 'required', kind: 'required', covered_by: ['project_id:missing'] },
          { id: 'upper-bound', kind: 'valid', covered_by: ['largest-safe-id'] },
          { id: 'above-upper-bound', kind: 'invalid', covered_by: ['project_id:above-safe-integer'] },
        ],
      },
    ]);
  });

  gate('record each fixture\'s binding and literal wire request', () => {
    const evidence = (tool: string) => reports.evidence.endpoints.find((entry) => entry.tool === tool);
    // Transcribed from the three manifests: a path-only read, JSON writes and multipart uploads.
    expect(evidence('testrail_get_project')?.accepted).toEqual([
      { id: 'representative-id', driver_binding: 'projects.getProject', wire: { method: 'GET', endpoint: 'get_project/7', body: 'none' }, upstream_response: 'json', driver_result: 'json' },
      { id: 'largest-safe-id', driver_binding: 'projects.getProject', wire: { method: 'GET', endpoint: 'get_project/9007199254740991', body: 'none' }, upstream_response: 'json', driver_result: 'json' },
    ]);
    expect(evidence('testrail_get_project')?.rejected.map(({ id }) => id)).toEqual([
      'unknown-top-level', 'project_id:zero', 'project_id:negative', 'project_id:fractional',
      'project_id:numeric-string', 'project_id:above-safe-integer', 'project_id:missing',
    ]);
    expect(evidence('testrail_add_project')?.accepted.map(({ id, driver_binding, wire }) => [id, driver_binding, wire])).toEqual([
      ['name-only', 'projects.addProject', { method: 'POST', endpoint: 'add_project', body: 'json' }],
      ['every-field', 'projects.addProject', { method: 'POST', endpoint: 'add_project', body: 'json' }],
    ]);
    expect(evidence('testrail_add_attachment_to_case')?.accepted.map(({ wire }) => wire.body)).toEqual(Array<string>(5).fill('multipart'));
    // Every accepted case keeps its own binding and body kind, and every endpoint its sources.
    const drifted = reports.evidence.endpoints.flatMap(({ tool, accepted, sources }) => {
      const manifest = manifestFor(tool);
      const expected = manifest.cases.flatMap(({ id, expect: outcome }) => outcome.kind !== 'accepted' ? [] : [{
        id, driver_binding: outcome.driver.binding, wire: { method: outcome.wire.method, endpoint: outcome.wire.endpoint, body: bodyKind(outcome.wire) },
      }]);
      const recorded = accepted.map(({ id, driver_binding, wire }) => ({ id, driver_binding, wire }));
      return JSON.stringify(recorded) === JSON.stringify(expected) && sources.length === manifest.sources.length ? [] : [tool];
    });
    expect(drifted).toEqual([]);
  });

  gate('say they are offline evidence, and name the exact package, driver and commits', () => {
    for (const report of [reports.coverage, reports.parameters, reports.evidence]) {
      expect(report.evidence).toBe('offline_fixtures');
      expect(report.live).toEqual({
        testrail: { status: 'not_run', tracked_by: 'https://github.com/dichovsky/testrail-mcp/issues/24' },
        clients: { status: 'not_run', tracked_by: 'https://github.com/dichovsky/testrail-mcp/issues/23' },
      });
      expect(report.package).toEqual({ name: '@dichovsky/testrail-mcp', version: packageJson.version });
      expect(report.driver).toEqual({
        name: DRIVER,
        version: REVIEWED_DRIVER.version,
        resolved: `https://registry.npmjs.org/${DRIVER}/-/testrail-api-client-${REVIEWED_DRIVER.version}.tgz`,
        integrity: expect.stringMatching(/^sha512-[A-Za-z0-9+/]{86}==$/u) as unknown,
        reviewed_commits: [REVIEWED_DRIVER.commit],
      });
      expect(report.source).toEqual(environment.source);
    }
    // The installed driver is the one the package pins exactly and the lockfile resolves.
    expect(packageJson.dependencies[DRIVER]).toBe(REVIEWED_DRIVER.version);
    expect(locked.version).toBe(REVIEWED_DRIVER.version);
    // In CI both commits are known, and a pull request's head differs from the merge CI built.
    if (process.env.GITHUB_ACTIONS === 'true') {
      expect(environment.source.head_commit).toMatch(/^[0-9a-f]{40}$/u);
      expect(environment.source.built_commit).toMatch(/^[0-9a-f]{40}$/u);
      if (process.env.GITHUB_EVENT_NAME === 'pull_request') expect(environment.source.head_commit).not.toBe(environment.source.built_commit);
      else expect(environment.source.head_commit).toBe(environment.source.built_commit);
    } else {
      expect(environment.source).toEqual({ head_commit: null, built_commit: null });
    }
  });

  gate('carry no local path, home directory or credential', () => {
    const text = JSON.stringify(reports);
    const local = [
      process.cwd(), homedir(), tmpdir(), process.execPath, fileURLToPath(new URL('..', import.meta.url)),
      ...['GITHUB_WORKSPACE', 'RUNNER_TEMP', 'RUNNER_TOOL_CACHE', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', REPORT_DIR].map((key) => process.env[key]),
    ].filter((path): path is string => path !== undefined && /[\\/]/u.test(path))
      .flatMap((path) => [path, path.replaceAll('\\', '/'), path.replaceAll('\\', '\\\\')]);
    expect(local.filter((path) => text.includes(path))).toEqual([]);
    // Path shapes rather than this machine's values: a drive in either slash form, a home
    // shorthand, the usual Unix roots and a runner's tool cache.
    expect(text).not.toMatch(/file:\/\/|(?<![A-Za-z0-9])[A-Za-z]:[\\/]|(?<![\w.-])~[\\/]|\/(?:home|Users|root|opt|tmp|var|private)\/|hostedtoolcache/u);
    const secrets = Object.entries(process.env)
      .filter(([key, value]) => key !== REPORT_DIR && /TOKEN|SECRET|KEY|PASSWORD|TESTRAIL/u.test(key) && value !== undefined && value.length >= 8)
      .map(([key]) => key);
    expect(secrets.filter((key) => text.includes(process.env[key] ?? ''))).toEqual([]);
  });

  gate('match the inventory status: implemented exactly where coverage is complete', () => {
    const complete = new Set(endpoints.filter(({ registered, manifest }) =>
      registered && manifest?.status === 'complete' && manifest.requirements.covered === manifest.requirements.total).map(({ tool }) => tool));
    const wrong = endpoints.filter(({ tool, inventory_status: status }) => status !== (complete.has(tool) ? 'implemented' : 'planned'));
    expect(wrong.map(({ tool, inventory_status: status }) => `${tool}: ${status}`)).toEqual([]);
    expect(rawInventory.status).toBe(complete.size === endpoints.length ? 'implemented' : 'planned');
    // The file says what that status means, and its release record names the pinned driver.
    expect(rawInventory.status_scope).toMatch(/^Offline verification only\b/u);
    expect(rawInventory.release_verification.production_release.exact_dependency).toBe(REVIEWED_DRIVER.version);
    expect(rawInventory.release_verification.qualified_release).toMatchObject({
      version: REVIEWED_DRIVER.version, release_commit: REVIEWED_DRIVER.commit, npm_integrity: locked.integrity, qualified_for_production: true,
    });
  });

  gate('match the API coverage document: every endpoint and resource row, the total and the status line', async () => {
    const document = await read('../docs/api-coverage.md');
    const statuses = new Map([...document.matchAll(/^\| `(?:GET|POST) [^`]+` \| `(testrail_[a-z_]+)` \|.*\| ([a-z]+) \|$/gmu)]
      .map(([, tool, status]) => [tool, status]));
    expect(statuses.size).toBe(CONTRACT.operations);
    expect(endpoints.filter(({ tool, inventory_status: status }) => statuses.get(tool) !== status).map(({ tool }) => tool)).toEqual([]);

    const resources = [...document.matchAll(/^\| \[([A-Za-z ]+)\]\(#[a-z-]+\) \|.*\| ([a-z]+) \|$/gmu)].map(([, resource = '', status]) => ({ resource, status }));
    expect(resources.map(({ resource }) => resource).sort()).toEqual([...new Set(endpoints.map(({ resource }) => resource))].sort());
    const statusOf = (rows: readonly { inventory_status: string }[]): string =>
      rows.every(({ inventory_status: status }) => status === 'implemented') ? 'implemented' : 'planned';
    expect(resources.filter(({ resource, status }) => status !== statusOf(endpoints.filter((row) => row.resource === resource)))
      .map(({ resource }) => resource)).toEqual([]);

    const overall = statusOf(endpoints);
    expect([...document.matchAll(/^\| \*\*Total\*\* \|.*\| \*\*([a-z]+)\*\* \|$/gmu)].map(([, status]) => status)).toEqual([overall]);
    expect(document).toMatch(overall === 'implemented' ? /^Status: implemented and verified offline\./mu : /^Status: planning baseline\./mu);
  });
});

describe('a coverage gap shows in the reports', () => {
  const baseline = reports.parameters.endpoints.find(({ tool }) => tool === 'testrail_get_project')?.targets;

  gate('reports an endpoint missing from the registry as unregistered', () => {
    const broken = createRegistry(...operationRegistry.entries.filter(({ tool }) => tool !== 'testrail_get_project'));
    const report = buildCoverageReports(broken, rawInventory.operations, manifests, environment).coverage;
    expect(report.totals.registered).toBe(CONTRACT.operations - 1);
    expect(report.endpoints.filter(({ registered }) => !registered).map(({ tool }) => tool)).toEqual(['testrail_get_project']);
  });

  gate('reports a registration bound to the wrong driver method as unregistered', () => {
    // Bound after definition to another endpoint's driver method, as a copy-paste slip would be.
    const slipped = operationRegistry.entries.map((entry) => entry.tool === 'testrail_get_project'
      ? { ...entry, driverBinding: 'projects.getProjects' } as unknown as Operation
      : entry);
    const report = buildCoverageReports(createRegistry(...slipped), rawInventory.operations, manifests, environment).coverage;
    expect(report.endpoints.filter(({ registered }) => !registered).map(({ tool }) => tool)).toEqual(['testrail_get_project']);
  });

  gate('counts a registration the inventory does not list', () => {
    const project = operationRegistry.get('testrail_get_project');
    if (project === undefined) throw new Error('testrail_get_project is not registered');
    const extra = { ...project, tool: 'testrail_get_projectx', route: 'get_projectx/{project_id}' } as unknown as Operation;
    const report = buildCoverageReports(createRegistry(...operationRegistry.entries, extra), rawInventory.operations, manifests, environment).coverage;
    expect(report.totals.extra_registrations).toBe(1);
    expect(report.totals.registered).toBe(CONTRACT.operations);
  });

  gate('reports one requirement no fixture covers, and leaves its siblings as they were', () => {
    const thinned = manifests.map((manifest) => manifest.endpoint.tool !== 'testrail_get_project' ? manifest : {
      ...manifest,
      cases: manifest.cases.map((fixture) => ({
        ...fixture,
        covers: fixture.covers.map(({ parameter, requirements }) => ({
          parameter, requirements: parameter === 'project_id' ? requirements.filter((id) => id !== 'above-upper-bound') : requirements,
        })).filter(({ requirements }) => requirements.length > 0),
      })),
    });
    const report = buildCoverageReports(operationRegistry, rawInventory.operations, thinned, environment);
    expect(report.coverage.endpoints.find(({ tool }) => tool === 'testrail_get_project')?.manifest?.requirements).toEqual({ total: 7, covered: 6 });
    expect(report.coverage.totals.requirements.covered).toBe(totals.requirements.total - 1);
    const expected = baseline?.map((target) => target.id !== 'project_id' ? target : {
      ...target,
      requirements: target.requirements.map((requirement) => requirement.id === 'above-upper-bound' ? { ...requirement, covered_by: [] } : requirement),
    });
    expect(report.parameters.endpoints.find(({ tool }) => tool === 'testrail_get_project')?.targets).toEqual(expected);
  });

  gate('reports a missing manifest as absent', () => {
    const report = buildCoverageReports(operationRegistry, rawInventory.operations,
      manifests.filter(({ endpoint }) => endpoint.tool !== 'testrail_get_projects'), environment);
    expect(report.coverage.totals.manifests).toEqual({ complete: CONTRACT.operations - 1, partial: 0, absent: 1 });
    expect(report.coverage.endpoints.find(({ tool }) => tool === 'testrail_get_projects')?.manifest).toBeNull();
    expect(report.parameters.endpoints.some(({ tool }) => tool === 'testrail_get_projects')).toBe(false);
    expect(report.evidence.endpoints.some(({ tool }) => tool === 'testrail_get_projects')).toBe(false);
  });
});

describe('the report files', () => {
  const requested = process.env[REPORT_DIR];
  let scratch: string | undefined;
  afterAll(async () => { if (scratch !== undefined) await rm(scratch, { recursive: true, force: true }); });

  it('are written only after every check above passed in this run, as JSON that reads back unchanged', async () => {
    expect(GATES.filter((name) => !held.has(name))).toEqual([]);
    const directory = requested ?? (scratch = await mkdtemp(join(tmpdir(), 'testrail-mcp-reports-')));
    await mkdir(directory, { recursive: true });
    const files = { 'coverage.json': reports.coverage, 'parameters.json': reports.parameters, 'fixture-evidence.json': reports.evidence };
    for (const [name, report] of Object.entries(files)) await writeFile(join(directory, name), `${JSON.stringify(report, null, 2)}\n`);
    for (const [name, report] of Object.entries(files)) {
      expect(JSON.parse(await readFile(join(directory, name), 'utf8'))).toEqual(report);
    }
  });
});
