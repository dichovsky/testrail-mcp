import type { OperationRegistry } from '../../src/operations/registry.js';
import { compareRegistry, parseInventory } from '../../src/operations/parity.js';
import type { ParameterManifest } from './parameter-manifest.js';

/*
 * R01's machine-readable reports: which endpoints are covered, by which parameter
 * requirements and fixtures, and where each fixture's evidence came from. They describe
 * offline evidence only, and say so, so they can never be read as a live qualification.
 */

/** An inventory row as the pinned file records it, resource and status included. */
export interface InventoryRow {
  readonly family_id: string;
  readonly resource: string;
  readonly http_method: string;
  readonly route: string;
  readonly tool: string;
  readonly driver_method: string;
  readonly pagination: { readonly kind: string; readonly page_method: string | null; readonly all_method: string | null };
  readonly status: string;
}

/** What the reports say about the build they describe; nothing here names a person or a path. */
export interface ReportEnvironment {
  readonly package: { readonly name: string; readonly version: string };
  readonly driver: { readonly name: string; readonly version: string; readonly resolved: string; readonly integrity: string };
  readonly runtime: { readonly node: string; readonly platform: string; readonly arch: string };
  /**
   * Null outside CI. `head_commit` is the commit under review: a pull request's head, or
   * the pushed commit. `built_commit` is what CI checked out and tested, which on a pull
   * request is GitHub's temporary merge of that head into the base branch.
   */
  readonly source: { readonly head_commit: string | null; readonly built_commit: string | null };
}

const ISSUES = 'https://github.com/dichovsky/testrail-mcp/issues';

function header(environment: ReportEnvironment, manifests: readonly ParameterManifest[]) {
  return {
    schema_version: 1,
    evidence: 'offline_fixtures',
    statement: 'Offline evidence only, from a passing run of the deterministic suite (npm test), which replays hand-authored fixtures through the registered tools and the pinned driver with an injected fetch. No TestRail instance, credentials, user directories or MCP host clients were involved.',
    live: {
      testrail: { status: 'not_run', tracked_by: `${ISSUES}/24` },
      clients: { status: 'not_run', tracked_by: `${ISSUES}/23` },
    },
    package: environment.package,
    driver: {
      ...environment.driver,
      reviewed_commits: [...new Set(manifests.map(({ review }) => review.driver_commit))].sort(),
    },
    runtime: environment.runtime,
    source: environment.source,
  };
}

type Target = { id: string; requirements: { id: string; kind: string }[] } & Partial<Record<'scope' | 'requiredness' | 'location', string>>;

/** The manifest audit's requirement keys: endpoint-wide rules under `$input`, the rest per parameter. */
function targets(manifest: ParameterManifest): Target[] {
  return [
    { id: '$input', requirements: manifest.requirements },
    ...manifest.parameters.map((parameter) => ({
      id: parameter.id,
      scope: parameter.scope,
      requiredness: parameter.requiredness,
      location: parameter.wire.location,
      requirements: parameter.requirements ?? [],
    })),
  ];
}

function coveringCases(manifest: ParameterManifest): Map<string, string[]> {
  const covering = new Map<string, string[]>();
  for (const fixture of manifest.cases) {
    for (const { parameter, requirements } of fixture.covers) {
      for (const requirement of requirements) {
        const key = `${parameter}/${requirement}`;
        covering.set(key, [...(covering.get(key) ?? []), fixture.id]);
      }
    }
  }
  return covering;
}

function parameterRows(manifest: ParameterManifest) {
  const covering = coveringCases(manifest);
  return targets(manifest).map(({ requirements, ...target }) => ({
    ...target,
    requirements: requirements.map(({ id, kind }) => ({ id, kind, covered_by: covering.get(`${target.id}/${id}`) ?? [] })),
  }));
}

function count<T>(values: readonly T[], predicate: (value: T) => boolean): number {
  return values.filter(predicate).length;
}

export function buildCoverageReports(
  registry: OperationRegistry,
  inventory: readonly InventoryRow[],
  manifests: readonly ParameterManifest[],
  environment: ReportEnvironment,
) {
  const parity = compareRegistry(registry, parseInventory({ operations: inventory }));
  const mismatched = new Set(parity.differences.map(({ tool }) => tool));
  const byTool = new Map(manifests.map((manifest) => [manifest.endpoint.tool, manifest]));

  const endpoints = inventory.map((row) => {
    const manifest = byTool.get(row.tool);
    const parameters = manifest === undefined ? [] : parameterRows(manifest);
    const requirements = parameters.flatMap((target) => target.requirements);
    return {
      tool: row.tool,
      family: row.family_id,
      resource: row.resource,
      method: row.http_method,
      route: row.route,
      driver_method: row.driver_method,
      pagination: row.pagination,
      inventory_status: row.status,
      registered: registry.get(row.tool) !== undefined && !mismatched.has(row.tool),
      manifest: manifest === undefined ? null : {
        status: manifest.review.status,
        reviewed_on: manifest.review.reviewed_on,
        parameters: manifest.parameters.length,
        requirements: { total: requirements.length, covered: count(requirements, ({ covered_by }) => covered_by.length > 0) },
        cases: {
          accepted: count(manifest.cases, ({ expect }) => expect.kind === 'accepted'),
          rejected: count(manifest.cases, ({ expect }) => expect.kind === 'rejected'),
        },
      },
    };
  });

  const sum = (pick: (row: (typeof endpoints)[number]) => number): number => endpoints.reduce((total, row) => total + pick(row), 0);
  const totals = {
    operations: endpoints.length,
    resources: new Set(endpoints.map(({ resource }) => resource)).size,
    families: new Set(endpoints.map(({ family }) => family)).size,
    paged: {
      controlled: count(endpoints, ({ pagination }) => pagination.kind === 'controlled'),
      response_driven: count(endpoints, ({ pagination }) => pagination.kind === 'response_driven'),
    },
    helpers: new Set(endpoints.flatMap(({ pagination }) => [pagination.page_method, pagination.all_method]).filter((method) => method !== null)).size,
    registered: count(endpoints, ({ registered }) => registered),
    extra_registrations: parity.extra.length,
    manifests: {
      complete: count(endpoints, ({ manifest }) => manifest?.status === 'complete'),
      partial: count(endpoints, ({ manifest }) => manifest?.status === 'partial'),
      absent: count(endpoints, ({ manifest }) => manifest === null),
    },
    parameters: sum(({ manifest }) => manifest?.parameters ?? 0),
    requirements: {
      total: sum(({ manifest }) => manifest?.requirements.total ?? 0),
      covered: sum(({ manifest }) => manifest?.requirements.covered ?? 0),
    },
    cases: {
      accepted: sum(({ manifest }) => manifest?.cases.accepted ?? 0),
      rejected: sum(({ manifest }) => manifest?.cases.rejected ?? 0),
    },
  };

  const meta = header(environment, manifests);
  return {
    coverage: { ...meta, report: 'endpoint_coverage', totals, endpoints },
    parameters: {
      ...meta,
      report: 'parameter_coverage',
      endpoints: inventory.flatMap(({ tool }) => {
        const manifest = byTool.get(tool);
        return manifest === undefined ? [] : [{ tool, targets: parameterRows(manifest) }];
      }),
    },
    evidence: {
      ...meta,
      report: 'fixture_evidence',
      endpoints: inventory.flatMap(({ tool }) => {
        const manifest = byTool.get(tool);
        if (manifest === undefined) return [];
        return [{
          tool,
          review: manifest.review,
          sources: manifest.sources,
          input_policy: { ordinary_fields: manifest.input_policy.ordinary_fields, custom_fields: manifest.input_policy.custom_fields },
          outer_result: { driver: manifest.outer_result.driver, tool_data: manifest.outer_result.tool_data },
          accepted: manifest.cases.flatMap(({ id, expect }) => expect.kind !== 'accepted' ? [] : [{
            id,
            driver_binding: expect.driver.binding,
            wire: {
              method: expect.wire.method,
              endpoint: expect.wire.endpoint,
              body: expect.wire.multipart !== undefined ? 'multipart' : expect.wire.json !== undefined ? 'json' : 'none',
            },
            upstream_response: expect.upstream_response.kind,
            driver_result: expect.driver_result.kind,
          }]),
          rejected: manifest.cases.flatMap(({ id, expect }) => expect.kind !== 'rejected' ? [] : [{ id, code: expect.code }]),
        }];
      }),
    },
  };
}

export type CoverageReports = ReturnType<typeof buildCoverageReports>;
