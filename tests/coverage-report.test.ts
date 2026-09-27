import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { operationRegistry } from '../src/operations/catalog.js';
import { createRegistry, type Operation } from '../src/operations/registry.js';
import { buildCoverageReports, type InventoryRow, type ReportEnvironment } from './contracts/coverage-report.js';
import { loadParameterManifests, type ParameterManifest } from './contracts/parameter-manifest.js';

/*
 * R01: publish the coverage, parameter and fixture-evidence reports as CI artifacts. The
 * reports are built from the registry, the pinned inventory and the manifests, and are
 * held here to the contract before anything is written: an artifact can only ever
 * describe a build whose coverage is complete. CI sets TESTRAIL_MCP_REPORT_DIR and
 * uploads what lands there.
 */

const read = async (path: string): Promise<string> => readFile(new URL(path, import.meta.url), 'utf8');
const rawInventory = JSON.parse(await read('../docs/operation-inventory.json')) as { status: string; operations: InventoryRow[] };
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

const sha = process.env.GITHUB_SHA;
const environment: ReportEnvironment = {
  package: { name: packageJson.name, version: packageJson.version },
  driver: { name: installedDriver.name, version: installedDriver.version, resolved: locked.resolved, integrity: locked.integrity },
  runtime: { node: process.version, platform: process.platform, arch: process.arch },
  source_commit: sha !== undefined && /^[0-9a-f]{40}$/u.test(sha) ? sha : null,
};

const reports = buildCoverageReports(operationRegistry, rawInventory.operations, manifests, environment);
const { totals, endpoints } = reports.coverage;

describe('the coverage reports', () => {
  it('account for the whole contract', () => {
    expect({
      operations: totals.operations, resources: totals.resources, families: totals.families,
      controlled: totals.paged.controlled, response_driven: totals.paged.response_driven, helpers: totals.helpers,
    }).toEqual(CONTRACT);
    expect(totals.registered).toBe(CONTRACT.operations);
    expect(totals.extra_registrations).toBe(0);
    expect(totals.manifests).toEqual({ complete: CONTRACT.operations, partial: 0, absent: 0 });
    expect(totals.requirements.total).toBeGreaterThan(0);
    expect(totals.requirements.covered).toBe(totals.requirements.total);
    expect(totals.cases.accepted).toBeGreaterThanOrEqual(CONTRACT.operations);
  });

  it('show every endpoint registered, with a complete manifest whose every requirement a fixture covers', () => {
    const gaps = endpoints.filter(({ registered, manifest }) =>
      !registered || manifest?.status !== 'complete' || manifest.requirements.covered !== manifest.requirements.total || manifest.cases.accepted === 0);
    expect(gaps.map(({ tool }) => tool)).toEqual([]);
    const uncovered = reports.parameters.endpoints.flatMap(({ tool, targets }) => targets.flatMap(({ id, requirements }) =>
      requirements.filter(({ covered_by }) => covered_by.length === 0).map((requirement) => `${tool} ${id}/${requirement.id}`)));
    expect(uncovered).toEqual([]);
  });

  it('say they are offline evidence, and name the exact package and driver', () => {
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
    }
    // The installed driver is the one the package pins exactly and the lockfile resolves.
    expect(packageJson.dependencies[DRIVER]).toBe(REVIEWED_DRIVER.version);
    expect(locked.version).toBe(REVIEWED_DRIVER.version);
  });

  it('carry no local path, home directory or credential', () => {
    const text = JSON.stringify(reports);
    const local = [process.cwd(), homedir(), tmpdir(), new URL('..', import.meta.url).href]
      .flatMap((path) => [path, path.replaceAll('\\', '\\\\')]);
    expect(local.filter((path) => text.includes(path))).toEqual([]);
    expect(text).not.toMatch(/file:\/\/|[A-Za-z]:\\\\|\/(?:home|Users|root)\//u);
    const secrets = Object.entries(process.env)
      .filter(([key, value]) => /TOKEN|SECRET|KEY|PASSWORD|TESTRAIL/u.test(key) && value !== undefined && value.length >= 8)
      .map(([key]) => key);
    expect(secrets.filter((key) => text.includes(process.env[key] ?? ''))).toEqual([]);
  });

  it('match the inventory status: implemented exactly where coverage is complete', () => {
    const complete = new Set(endpoints.filter(({ registered, manifest }) =>
      registered && manifest?.status === 'complete' && manifest.requirements.covered === manifest.requirements.total).map(({ tool }) => tool));
    const wrong = endpoints.filter(({ tool, inventory_status: status }) => status !== (complete.has(tool) ? 'implemented' : 'planned'));
    expect(wrong.map(({ tool, inventory_status: status }) => `${tool}: ${status}`)).toEqual([]);
    expect(rawInventory.status).toBe(complete.size === endpoints.length ? 'implemented' : 'planned');
  });

  it('match the API coverage document\'s row statuses', async () => {
    const document = await read('../docs/api-coverage.md');
    const statuses = new Map([...document.matchAll(/^\| `(?:GET|POST) [^`]+` \| `(testrail_[a-z_]+)` \|.*\| ([a-z]+) \|$/gmu)]
      .map(([, tool, status]) => [tool, status]));
    expect(statuses.size).toBe(CONTRACT.operations);
    expect(endpoints.filter(({ tool, inventory_status: status }) => statuses.get(tool) !== status).map(({ tool }) => tool)).toEqual([]);
    const resources = [...document.matchAll(/^\| \[([A-Za-z ]+)\]\(#[a-z-]+\) \|.*\| ([a-z]+) \|$/gmu)];
    expect(resources).toHaveLength(CONTRACT.resources);
    const resourceStatus = (resource: string): string =>
      endpoints.filter((row) => row.resource === resource).every(({ inventory_status: status }) => status === 'implemented') ? 'implemented' : 'planned';
    expect(resources.filter(([, resource = '', status]) => status !== resourceStatus(resource)).map(([, resource]) => resource)).toEqual([]);
  });
});

describe('a coverage gap shows in the reports', () => {
  it('reports an endpoint missing from the registry as unregistered', () => {
    const broken = createRegistry(...operationRegistry.entries.filter(({ tool }) => tool !== 'testrail_get_project'));
    const report = buildCoverageReports(broken, rawInventory.operations, manifests, environment).coverage;
    expect(report.totals.registered).toBe(CONTRACT.operations - 1);
    expect(report.endpoints.filter(({ registered }) => !registered).map(({ tool }) => tool)).toEqual(['testrail_get_project']);
  });

  it('reports a registration bound to the wrong driver method as unregistered', () => {
    // Bound after definition to another endpoint's driver method, as a copy-paste slip would be.
    const slipped = operationRegistry.entries.map((entry) => entry.tool === 'testrail_get_project'
      ? { ...entry, driverBinding: 'projects.getProjects' } as unknown as Operation
      : entry);
    const report = buildCoverageReports(createRegistry(...slipped), rawInventory.operations, manifests, environment).coverage;
    expect(report.endpoints.filter(({ registered }) => !registered).map(({ tool }) => tool)).toEqual(['testrail_get_project']);
  });

  it('reports a requirement no fixture covers, and a missing manifest', () => {
    const thinned = manifests.flatMap((manifest): ParameterManifest[] => {
      if (manifest.endpoint.tool === 'testrail_get_projects') return [];
      if (manifest.endpoint.tool !== 'testrail_get_project') return [manifest];
      return [{ ...manifest, cases: manifest.cases.map((fixture) => ({ ...fixture, covers: fixture.covers.filter(({ parameter }) => parameter !== 'project_id') })) }];
    });
    const report = buildCoverageReports(operationRegistry, rawInventory.operations, thinned, environment);
    expect(report.coverage.totals.manifests.absent).toBe(1);
    expect(report.coverage.totals.requirements.covered).toBeLessThan(report.coverage.totals.requirements.total);
    const project = report.coverage.endpoints.find(({ tool }) => tool === 'testrail_get_project')?.manifest;
    expect(project?.requirements.covered).toBeLessThan(project?.requirements.total ?? 0);
    expect(report.parameters.endpoints.find(({ tool }) => tool === 'testrail_get_project')?.targets
      .find(({ id }) => id === 'project_id')?.requirements.every(({ covered_by }) => covered_by.length === 0)).toBe(true);
  });
});

describe('the report files', () => {
  const requested = process.env.TESTRAIL_MCP_REPORT_DIR;
  let scratch: string | undefined;
  afterAll(async () => { if (scratch !== undefined) await rm(scratch, { recursive: true, force: true }); });

  it('are written as JSON that reads back unchanged', async () => {
    const directory = requested ?? (scratch = await mkdtemp(join(tmpdir(), 'testrail-mcp-reports-')));
    await mkdir(directory, { recursive: true });
    const files = { 'coverage.json': reports.coverage, 'parameters.json': reports.parameters, 'fixture-evidence.json': reports.evidence };
    for (const [name, report] of Object.entries(files)) await writeFile(join(directory, name), `${JSON.stringify(report, null, 2)}\n`);
    for (const [name, report] of Object.entries(files)) {
      expect(JSON.parse(await readFile(join(directory, name), 'utf8'))).toEqual(report);
    }
  });
});
