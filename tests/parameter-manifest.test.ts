import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  TestRailClient,
  AddCasePayloadSchema,
  AddCasesBulkPayloadSchema,
  AddProjectPayloadSchema,
  AddSectionPayloadSchema,
  AddSuitePayloadSchema,
  CopyCasesToSectionPayloadSchema,
  DeleteCasesPayloadSchema,
  MoveCasesToSectionPayloadSchema,
  MoveSectionPayloadSchema,
  UpdateCasePayloadSchema,
  UpdateCasesPayloadSchema,
  AddRunPayloadSchema,
  AddSharedStepPayloadSchema,
  UpdateProjectPayloadSchema,
  UpdateRunPayloadSchema,
  UpdateTestLabelsPayloadSchema,
  UpdateTestsLabelsPayloadSchema,
  UpdateSectionPayloadSchema,
  UpdateSharedStepPayloadSchema,
  UpdateSuitePayloadSchema,
} from '@dichovsky/testrail-api-client';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { loadDomainLibrary } from './contracts/domains.js';
import {
  auditParameterManifests,
  loadParameterManifests,
  parameterCoverageReport,
  ParameterManifestSchema,
  resolveDomains,
} from './contracts/parameter-manifest.js';
import type { ParameterFixture } from './contracts/parameter-manifest.js';
import { describeBody, materializeFiles, substituteTokens } from './contracts/uploads.js';

const manifests = await loadParameterManifests();
const rawInventory: unknown = JSON.parse(await readFile(new URL('../docs/operation-inventory.json', import.meta.url), 'utf8'));
const inventory = z.object({
  operations: z.array(ParameterManifestSchema.shape.endpoint.strip()),
}).parse(rawInventory).operations;
const rawDriverMetadata: unknown = JSON.parse(await readFile(
  new URL('../package.json', import.meta.resolve('@dichovsky/testrail-api-client')), 'utf8',
));
const driverVersion = z.object({ version: z.string() }).parse(rawDriverMetadata).version;

function example() {
  const manifest = manifests.find(({ endpoint }) => endpoint.tool === 'testrail_get_attachment');
  if (!manifest) throw new Error('Required attachment manifest is missing');
  return structuredClone(manifest);
}

function zeroParameterExample() {
  const baseline = example();
  return ParameterManifestSchema.parse({
    ...baseline,
    endpoint: {
      family_id: 'T10', http_method: 'GET', route: 'get_priorities',
      tool: 'testrail_get_priorities', driver_method: 'metadata.getPriorities',
    },
    sources: [{
      id: 'driver-module',
      url: `https://github.com/dichovsky/testrail-api-client/blob/${baseline.review.driver_commit}/src/modules/metadata.ts`,
      supports: 'getPriorities takes no arguments and returns a priority array.',
    }],
    outer_result: { driver: 'array', tool_data: 'array', notes: 'Preserve the priority array.' },
    parameters: [],
    requirements: [
      { id: 'empty-input', kind: 'valid', description: 'Accept an empty object without invented parameters.' },
      { id: 'unknown-key', kind: 'invalid', description: 'Reject unknown input fields.' },
    ],
    cases: [{
      id: 'empty-input', input: {},
      covers: [{ parameter: '$input', requirements: ['empty-input'] }],
      expect: {
        kind: 'accepted',
        driver: { binding: 'metadata.getPriorities', arguments: [] },
        wire: { method: 'GET', endpoint: 'get_priorities' },
        upstream_response: { kind: 'json', body: [] },
        driver_result: { kind: 'json', value: [] },
      },
    }, {
      id: 'unknown-key', input: { unexpected: true },
      covers: [{ parameter: '$input', requirements: ['unknown-key'] }],
      expect: { kind: 'rejected', code: 'INVALID_ARGUMENT' },
    }],
  });
}

describe('independent parameter manifest format', () => {
  it('audits reviewed requirements, references and exact inventory identities', () => {
    expect(auditParameterManifests(manifests, inventory)).toEqual([]);
  });

  it('requires an explicit provenance review when the installed driver changes', () => {
    expect([...new Set(manifests.map(({ review }) => review.driver_version))]).toEqual([driverVersion]);
  });

  it('represents a complete endpoint with zero parameters and an empty driver argument list', () => {
    const manifest = zeroParameterExample();
    expect(manifest.review.status).toBe('complete');
    expect(manifest.parameters).toEqual([]);
    expect(auditParameterManifests([manifest], inventory)).toEqual([]);
  });

  it('requires accepted wire evidence even when an endpoint has no parameters', () => {
    const manifest = zeroParameterExample();
    manifest.requirements = manifest.requirements.filter(({ kind }) => kind === 'invalid');
    manifest.cases = manifest.cases.filter(({ expect }) => expect.kind === 'rejected');
    expect(auditParameterManifests([manifest], inventory))
      .toContain('testrail_get_priorities: No accepted fixture provides driver and wire evidence');
  });

  it('represents adapter-only call selectors without inventing driver arguments', () => {
    const schema = ParameterManifestSchema.shape.parameters.element;
    const selector = schema.parse({
      id: '_mcp.pagination', input_path: ['_mcp', 'pagination'], scope: 'mcp', requiredness: 'optional',
      domain: { enum: ['page', 'all'] },
      semantics: 'Select the public page or all helper; do not pass this selector as a driver argument.',
      driver: null,
      wire: { location: 'adapter_only', names: [], encoding: 'Never serialized upstream.' },
      sources: ['driver-pagination'],
      requirements: [
        { id: 'mapping', kind: 'mapping', description: 'Select the expected public helper in each literal call fixture.' },
        { id: 'page', kind: 'valid', description: 'Accept page mode.' },
        { id: 'all', kind: 'valid', description: 'Accept all mode.' },
        { id: 'invalid', kind: 'invalid', description: 'Reject an unknown mode.' },
        { id: 'omitted', kind: 'omitted', description: 'Use page mode when omitted.' },
      ],
    });
    expect(selector.driver).toBeNull();
    expect(schema.safeParse({ ...selector, scope: 'query' }).success).toBe(false);
    expect(schema.safeParse({ ...selector, wire: { ...selector.wire, location: 'query' } }).success).toBe(false);
    expect(schema.safeParse({
      ...selector, id: '_mcp.page_size', input_path: ['_mcp', 'page_size'],
      driver: { argument: 1, path: ['pageSize'] },
    }).success).toBe(true);
  });

  it('requires UUID domains to match the complete input, including terminal line breaks', () => {
    const attachment = example().parameters.find(({ id }) => id === 'attachment_id');
    const entry = manifests.find(({ endpoint }) => endpoint.tool === 'testrail_get_attachments_for_plan_entry')
      ?.parameters.find(({ id }) => id === 'entry_id');
    if (!attachment || !entry) throw new Error('Required UUID parameter fixtures are missing');
    const attachmentPattern = z.object({ anyOf: z.tuple([z.unknown(), z.object({ pattern: z.string() })]) })
      .parse(attachment.domain).anyOf[1].pattern;
    const entryPattern = z.object({ pattern: z.string() }).parse(entry.domain).pattern;
    const uuid = '3933d74b-4282-44de-82ae-a6412808369d';
    for (const pattern of [attachmentPattern, entryPattern]) {
      const regex = new RegExp(pattern);
      expect(regex.test(uuid)).toBe(true);
      for (const suffix of ['\n', '\r', '\r\n', '\u2028', '\u2029']) {
        expect(regex.test(`${uuid}${suffix}`)).toBe(false);
      }
    }
  });

  it('reports every unreviewed endpoint and partial endpoint separately', () => {
    const report = parameterCoverageReport(manifests, inventory);
    expect(report.completeEndpoints).toEqual([
      'testrail_add_bdd',
      'testrail_add_case',
      'testrail_add_cases',
      'testrail_add_project',
      'testrail_add_run',
      'testrail_add_section',
      'testrail_add_shared_step',
      'testrail_add_suite',
      'testrail_close_run',
      'testrail_copy_cases_to_section',
      'testrail_delete_case',
      'testrail_delete_cases',
      'testrail_delete_project',
      'testrail_delete_run',
      'testrail_delete_section',
      'testrail_delete_shared_step',
      'testrail_delete_suite',
      'testrail_get_attachment',
      'testrail_get_attachments_for_plan_entry',
      'testrail_get_bdd',
      'testrail_get_bdds',
      'testrail_get_case',
      'testrail_get_case_titles',
      'testrail_get_cases',
      'testrail_get_history_for_case',
      'testrail_get_project',
      'testrail_get_projects',
      'testrail_get_run',
      'testrail_get_runs',
      'testrail_get_section',
      'testrail_get_sections',
      'testrail_get_shared_step',
      'testrail_get_shared_step_history',
      'testrail_get_shared_steps',
      'testrail_get_suite',
      'testrail_get_suites',
      'testrail_get_test',
      'testrail_get_tests',
      'testrail_move_cases_to_section',
      'testrail_move_section',
      'testrail_update_bdd',
      'testrail_update_case',
      'testrail_update_cases',
      'testrail_update_project',
      'testrail_update_run',
      'testrail_update_section',
      'testrail_update_shared_step',
      'testrail_update_suite',
      'testrail_update_test',
      'testrail_update_tests',
    ]);
    expect(report.partialEndpoints).toEqual([]);
    expect(report.pendingEndpoints).toHaveLength(83);
    expect([...report.reviewedEndpoints, ...report.pendingEndpoints].sort())
      .toEqual(inventory.map(({ tool }) => tool).sort());
    expect(report.pendingEndpoints).toContain('testrail_add_plan');
  });

  it('derives a control\'s rejections from the baseline of its own call mode', () => {
    const suites = manifests.find(({ endpoint }) => endpoint.tool === 'testrail_get_suites');
    if (!suites) throw new Error('Required get_suites manifest is missing');
    const derived = (id: string) => suites.cases.find((fixture) => fixture.id === id)?.input;
    // An aggregate bound mutates the all-mode case; a page control mutates the page-mode
    // baseline. Mutating the wrong one would still be refused, but by the mode mismatch.
    expect(derived('_mcp.max_items:zero')).toEqual({ project_id: 7, _mcp: { pagination: 'all', max_items: 0 } });
    expect(derived('_mcp.page_size:above-maximum')).toEqual({ project_id: 7, _mcp: { pagination: 'all', page_size: 251 } });
    expect(derived('query.limit:zero')).toEqual({ project_id: 7, query: { limit: 0, offset: 50 } });
    expect(derived('project_id:missing')).toEqual({ query: { limit: 50, offset: 50 } });
  });

  it('refuses a baseline from the other call mode, which would make derived rejections vacuous', async () => {
    const raw: unknown = JSON.parse(await readFile(new URL('./fixtures/parameters/get_suites.json', import.meta.url), 'utf8'));
    const suites = ParameterManifestSchema.parse(raw);
    const library = await loadDomainLibrary();
    const rebase = (id: string, baseline: string) => ({
      ...suites,
      parameters: suites.parameters.map((parameter) => parameter.id === id ? { ...parameter, baseline } : parameter),
    });
    // The mode union would refuse these mutations whatever the registration enforced.
    expect(() => resolveDomains(rebase('_mcp.max_items', 'page-controls'), library))
      .toThrow('_mcp.max_items baseline is a case of the other call mode');
    expect(() => resolveDomains(rebase('query.limit', 'all-defaults'), library))
      .toThrow('query.limit baseline is a case of the other call mode');
    expect(() => resolveDomains(rebase('_mcp.max_items', 'largest-safe-project'), library)).toThrow();
    expect(() => resolveDomains(suites, library)).not.toThrow();
  });

  it('refuses an omission claim from a case that supplies the parameter', () => {
    const sections = manifests.find(({ endpoint }) => endpoint.tool === 'testrail_get_sections');
    if (!sections) throw new Error('Required get_sections manifest is missing');
    const moved = { ...sections, cases: sections.cases.map((fixture) => fixture.id === 'suite-filter'
      ? { ...fixture, covers: [...fixture.covers, { parameter: 'query.suite_id', requirements: ['omitted'] }] }
      : fixture) };
    expect(auditParameterManifests([moved])).toContain('testrail_get_sections: Case suite-filter supplies query.suite_id/omitted it claims to omit');
    expect(auditParameterManifests([sections])).toEqual([]);
  });

  it('detects a removed union-branch fixture instead of merely counting endpoints', () => {
    const manifest = example();
    manifest.cases = manifest.cases.filter(({ id }) => id !== 'uuid-id');
    expect(auditParameterManifests([manifest])).toContain('testrail_get_attachment: Uncovered requirement: attachment_id/uuid');
  });

  it('requires mapping and validation requirements for every reviewed parameter', () => {
    const manifest = example();
    manifest.parameters = manifest.parameters.map((parameter) => ({
      ...parameter,
      requirements: (parameter.requirements ?? []).filter(({ kind }) => kind !== 'mapping'),
    }));
    expect(auditParameterManifests([manifest])).toContain('testrail_get_attachment: Parameter attachment_id has no mapping requirement');
  });

  it('rejects unsupported parameter references, including plausible misspellings', () => {
    const manifest = example();
    manifest.cases = manifest.cases.map((fixture) => ({
      ...fixture,
      covers: fixture.covers.map((coverage) => ({ ...coverage, parameter: 'attachmentId' })),
    }));
    expect(auditParameterManifests([manifest]).some((error) => error.includes('unknown requirement attachmentId/'))).toBe(true);
  });

  it('detects duplicate endpoint, parameter and case IDs', () => {
    const manifest = example();
    manifest.parameters = [...manifest.parameters, ...manifest.parameters];
    manifest.cases = [...manifest.cases, ...manifest.cases];
    const errors = auditParameterManifests([manifest, manifest]);
    expect(errors).toContain('Duplicate endpoint: testrail_get_attachment');
    expect(errors).toContain('testrail_get_attachment: Duplicate parameter: attachment_id');
    expect(errors).toContain('testrail_get_attachment: Duplicate case: numeric-id');
  });

  it('does not let an accepted fixture satisfy a rejection requirement', () => {
    const manifest = example();
    manifest.cases = manifest.cases.map((fixture) => fixture.id === 'numeric-id'
      ? { ...fixture, covers: [{ parameter: 'attachment_id', requirements: ['invalid'] }] }
      : fixture);
    expect(auditParameterManifests([manifest])).toContain('testrail_get_attachment: Case numeric-id has wrong outcome for attachment_id/invalid');
  });

  it('detects identity drift and false complete status', () => {
    const manifest = example();
    manifest.endpoint.driver_method = 'attachments.getAttachmentsForCase';
    manifest.review.pending = ['Still unreviewed'];
    const errors = auditParameterManifests([manifest], inventory);
    expect(errors).toContain('testrail_get_attachment: Inventory mismatch: driver_method');
    expect(errors).toContain('testrail_get_attachment: Review status disagrees with pending work');
  });

  it('rejects unknown fixture-format keys', () => {
    expect(ParameterManifestSchema.safeParse({ ...example(), ignored: true }).success).toBe(false);
  });

  it('detects a source link using an unpinned or different driver revision', () => {
    const manifest = example();
    manifest.sources = manifest.sources.map((source) => ({
      ...source, url: source.url.replace(manifest.review.driver_commit, 'main'),
    }));
    const errors = auditParameterManifests([manifest]);
    expect(errors).toContain('testrail_get_attachment: Missing pinned driver source evidence');
    expect(errors).toContain('testrail_get_attachment: Source driver-module uses a different driver revision');
  });
});

const idOrList = z.union([z.number(), z.array(z.number())]);
/** The case filters under the driver's option names, as a fixture writes them. */
const caseFilterOptions = z.strictObject({
  suiteId: z.number().optional(), sectionId: z.number().optional(),
  typeId: idOrList.optional(), priorityId: idOrList.optional(), templateId: idOrList.optional(), milestoneId: idOrList.optional(),
  createdAfter: z.number().optional(), createdBefore: z.number().optional(), createdBy: idOrList.optional(),
  filter: z.string().optional(),
  updatedAfter: z.number().optional(), updatedBefore: z.number().optional(), updatedBy: idOrList.optional(),
  labelId: idOrList.optional(), refs: z.union([z.string(), z.array(z.string())]).optional(),
});
/** The BDD filters under the driver's option names, as a fixture writes them. */
const bddFilterOptions = z.strictObject({
  suiteId: z.number().optional(), sectionId: z.number().optional(),
  labelId: idOrList.optional(), refs: z.union([z.string(), z.array(z.string())]).optional(),
});
/** The shared-step filters under the driver's option names. */
const sharedStepFilterOptions = z.strictObject({
  createdAfter: z.number().optional(), createdBefore: z.number().optional(), createdBy: idOrList.optional(),
  updatedAfter: z.number().optional(), updatedBefore: z.number().optional(), refs: z.string().optional(),
});
/** The run filters under the driver's option names, as a fixture writes them. */
const runFilterOptions = z.strictObject({
  createdAfter: z.number().optional(), createdBefore: z.number().optional(), createdBy: z.array(z.number()).optional(),
  includePlanRuns: z.boolean().optional(), isCompleted: z.boolean().optional(),
  milestoneId: idOrList.optional(), refs: z.string().optional(), suiteId: idOrList.optional(),
});
/** The test filters under the driver's option names. */
const testFilterOptions = z.strictObject({
  statusId: z.array(z.number()).optional(), labelId: z.array(z.number()).optional(),
});
/** A staged upload as the adapter hands it to the driver. */
const uploadFile = z.strictObject({ path: z.string(), type: z.string().optional() });
const aggregateOptions = {
  pageSize: z.number().optional(), startOffset: z.number().optional(),
  maxItems: z.number(), maxPages: z.number(), maxBytes: z.number(), maxDurationMs: z.number(),
};

/** Drop the optionals a fixture left out, so the literal satisfies exactOptionalPropertyTypes. */
function present<T extends object>(value: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as {
    [K in keyof T]: Exclude<T[K], undefined>;
  };
}

// This explicitly invokes the pinned public API. It is not an endpoint adapter:
// the literal expected driver arguments already live in independently authored fixtures.
async function invokeDriver(client: TestRailClient, expected: Extract<ParameterFixture['expect'], { kind: 'accepted' }>): Promise<unknown> {
  switch (expected.driver.binding) {
    case 'attachments.getAttachment': {
      const [id] = z.tuple([z.union([z.number(), z.string()])]).parse(expected.driver.arguments);
      return client.attachments.getAttachment(id);
    }
    case 'attachments.getAttachmentsForPlanEntry': {
      const [planId, entryId] = z.tuple([z.number(), z.string()]).parse(expected.driver.arguments);
      return client.attachments.getAttachmentsForPlanEntry(planId, entryId);
    }
    case 'runs.getRun': {
      const [runId] = z.tuple([z.number()]).parse(expected.driver.arguments);
      return client.runs.getRun(runId);
    }
    case 'runs.getRunsPage': {
      const [projectId, options] = z.tuple([z.number(), runFilterOptions.extend({ limit: z.number(), offset: z.number() })])
        .parse(expected.driver.arguments);
      return client.runs.getRunsPage(projectId, present(options));
    }
    case 'runs.getAllRuns': {
      const [projectId, options] = z.tuple([z.number(), runFilterOptions.extend(aggregateOptions)]).parse(expected.driver.arguments);
      return client.runs.getAllRuns(projectId, present(options));
    }
    case 'runs.addRun': {
      const [projectId, payload] = z.tuple([z.number(), AddRunPayloadSchema]).parse(expected.driver.arguments);
      return client.runs.addRun(projectId, payload);
    }
    case 'runs.updateRun': {
      const [runId, payload] = z.tuple([z.number(), UpdateRunPayloadSchema]).parse(expected.driver.arguments);
      return client.runs.updateRun(runId, payload);
    }
    case 'runs.closeRun': {
      const [runId] = z.tuple([z.number()]).parse(expected.driver.arguments);
      return client.runs.closeRun(runId);
    }
    case 'runs.deleteRun': {
      const [runId, options] = z.tuple([z.number(), z.strictObject({ soft: z.boolean() }).optional()])
        .parse(expected.driver.arguments);
      return options === undefined ? client.runs.deleteRun(runId) : client.runs.deleteRun(runId, options);
    }
    case 'tests.getTest': {
      const [testId, options] = z.tuple([z.number(), z.strictObject({ withData: z.enum(['0', '1']) }).optional()])
        .parse(expected.driver.arguments);
      return options === undefined ? client.tests.getTest(testId) : client.tests.getTest(testId, options);
    }
    case 'tests.getTestsPage': {
      const [runId, options] = z.tuple([z.number(), testFilterOptions.extend({ limit: z.number(), offset: z.number() })])
        .parse(expected.driver.arguments);
      return client.tests.getTestsPage(runId, present(options));
    }
    case 'tests.getAllTests': {
      const [runId, options] = z.tuple([z.number(), testFilterOptions.extend(aggregateOptions)]).parse(expected.driver.arguments);
      return client.tests.getAllTests(runId, present(options));
    }
    case 'tests.updateTest': {
      const [testId, payload] = z.tuple([z.number(), UpdateTestLabelsPayloadSchema]).parse(expected.driver.arguments);
      return client.tests.updateTest(testId, payload);
    }
    case 'tests.updateTests': {
      const [payload] = z.tuple([UpdateTestsLabelsPayloadSchema]).parse(expected.driver.arguments);
      return client.tests.updateTests(payload);
    }
    case 'bdd.getBdd': {
      const [caseId] = z.tuple([z.number()]).parse(expected.driver.arguments);
      return client.bdd.getBdd(caseId);
    }
    case 'bdd.getBddsPage': {
      const [projectId, options] = z.tuple([z.number(), bddFilterOptions.extend({ limit: z.number(), offset: z.number() })])
        .parse(expected.driver.arguments);
      return client.bdd.getBddsPage(projectId, present(options));
    }
    case 'bdd.getAllBdds': {
      const [projectId, options] = z.tuple([z.number(), bddFilterOptions.extend(aggregateOptions)]).parse(expected.driver.arguments);
      return client.bdd.getAllBdds(projectId, present(options));
    }
    case 'bdd.addBdd': {
      const [sectionId, file, filename] = z.tuple([z.number(), uploadFile, z.string()]).parse(expected.driver.arguments);
      return client.bdd.addBdd(sectionId, present(file), filename);
    }
    case 'bdd.updateBdd': {
      const [caseId, file, filename] = z.tuple([z.number(), uploadFile, z.string()]).parse(expected.driver.arguments);
      return client.bdd.updateBdd(caseId, present(file), filename);
    }
    case 'sharedSteps.getSharedStep': {
      const [sharedStepId] = z.tuple([z.number()]).parse(expected.driver.arguments);
      return client.sharedSteps.getSharedStep(sharedStepId);
    }
    case 'sharedSteps.getSharedStepsPage': {
      const [projectId, options] = z.tuple([z.number(), sharedStepFilterOptions.extend({ limit: z.number(), offset: z.number() })])
        .parse(expected.driver.arguments);
      return client.sharedSteps.getSharedStepsPage(projectId, present(options));
    }
    case 'sharedSteps.getAllSharedSteps': {
      const [projectId, options] = z.tuple([z.number(), sharedStepFilterOptions.extend(aggregateOptions)]).parse(expected.driver.arguments);
      return client.sharedSteps.getAllSharedSteps(projectId, present(options));
    }
    case 'sharedSteps.getSharedStepHistoryPage': {
      const [sharedStepId] = z.tuple([z.number()]).parse(expected.driver.arguments);
      return client.sharedSteps.getSharedStepHistoryPage(sharedStepId);
    }
    case 'sharedSteps.getAllSharedStepHistory': {
      const [sharedStepId, options] = z.tuple([z.number(), z.strictObject({
        maxItems: z.number(), maxPages: z.number(), maxBytes: z.number(), maxDurationMs: z.number(),
      })]).parse(expected.driver.arguments);
      return client.sharedSteps.getAllSharedStepHistory(sharedStepId, options);
    }
    case 'sharedSteps.addSharedStep': {
      const [projectId, payload] = z.tuple([z.number(), AddSharedStepPayloadSchema]).parse(expected.driver.arguments);
      return client.sharedSteps.addSharedStep(projectId, payload);
    }
    case 'sharedSteps.updateSharedStep': {
      const [sharedStepId, payload] = z.tuple([z.number(), UpdateSharedStepPayloadSchema]).parse(expected.driver.arguments);
      return client.sharedSteps.updateSharedStep(sharedStepId, payload);
    }
    case 'sharedSteps.deleteSharedStep': {
      const [sharedStepId, options] = z.tuple([z.number(), z.strictObject({ keepInCases: z.boolean() }).optional()])
        .parse(expected.driver.arguments);
      return options === undefined
        ? client.sharedSteps.deleteSharedStep(sharedStepId)
        : client.sharedSteps.deleteSharedStep(sharedStepId, options);
    }
    case 'cases.getCase': {
      const [caseId] = z.tuple([z.number()]).parse(expected.driver.arguments);
      return client.cases.getCase(caseId);
    }
    case 'cases.getCaseTitles': {
      const [caseIds] = z.tuple([z.array(z.number())]).parse(expected.driver.arguments);
      return client.cases.getCaseTitles(caseIds);
    }
    case 'cases.getCasesPage': {
      const [projectId, options] = z.tuple([z.number(), caseFilterOptions.extend({ limit: z.number(), offset: z.number() })])
        .parse(expected.driver.arguments);
      return client.cases.getCasesPage(projectId, present(options));
    }
    case 'cases.getAllCases': {
      const [projectId, options] = z.tuple([z.number(), caseFilterOptions.extend(aggregateOptions)]).parse(expected.driver.arguments);
      return client.cases.getAllCases(projectId, present(options));
    }
    case 'cases.getHistoryForCasePage': {
      const [caseId, options] = z.tuple([z.number(), z.strictObject({ limit: z.number(), offset: z.number() })])
        .parse(expected.driver.arguments);
      return client.cases.getHistoryForCasePage(caseId, options);
    }
    case 'cases.getAllHistoryForCase': {
      const [caseId, options] = z.tuple([z.number(), z.strictObject(aggregateOptions)]).parse(expected.driver.arguments);
      return client.cases.getAllHistoryForCase(caseId, present(options));
    }
    case 'cases.addCase': {
      const [sectionId, payload] = z.tuple([z.number(), AddCasePayloadSchema]).parse(expected.driver.arguments);
      return client.cases.addCase(sectionId, payload);
    }
    case 'cases.addCases': {
      const [sectionId, payload] = z.tuple([z.number(), AddCasesBulkPayloadSchema]).parse(expected.driver.arguments);
      return client.cases.addCases(sectionId, payload);
    }
    case 'cases.updateCase': {
      const [caseId, payload] = z.tuple([z.number(), UpdateCasePayloadSchema]).parse(expected.driver.arguments);
      return client.cases.updateCase(caseId, payload);
    }
    case 'cases.updateCases': {
      const [suiteId, payload] = z.tuple([z.number(), UpdateCasesPayloadSchema]).parse(expected.driver.arguments);
      return client.cases.updateCases(suiteId, payload);
    }
    case 'cases.deleteCase': {
      const [caseId, options] = z.tuple([z.number(), z.strictObject({ soft: z.boolean() }).optional()])
        .parse(expected.driver.arguments);
      return options === undefined ? client.cases.deleteCase(caseId) : client.cases.deleteCase(caseId, options);
    }
    case 'cases.deleteCases': {
      const [suiteId, projectId, payload, options] = z.tuple([
        z.number(), z.number(), DeleteCasesPayloadSchema, z.strictObject({ soft: z.boolean() }).optional(),
      ]).parse(expected.driver.arguments);
      return options === undefined
        ? client.cases.deleteCases(suiteId, projectId, payload)
        : client.cases.deleteCases(suiteId, projectId, payload, options);
    }
    case 'cases.copyCasesToSection': {
      const [sectionId, payload] = z.tuple([z.number(), CopyCasesToSectionPayloadSchema]).parse(expected.driver.arguments);
      return client.cases.copyCasesToSection(sectionId, payload);
    }
    case 'cases.moveCasesToSection': {
      const [sectionId, payload] = z.tuple([z.number(), MoveCasesToSectionPayloadSchema]).parse(expected.driver.arguments);
      return client.cases.moveCasesToSection(sectionId, payload);
    }
    case 'projects.getProject': {
      const [projectId] = z.tuple([z.number()]).parse(expected.driver.arguments);
      return client.projects.getProject(projectId);
    }
    case 'projects.getProjectsPage': {
      const [options] = z.tuple([z.strictObject({
        isCompleted: z.boolean().optional(), limit: z.number(), offset: z.number(),
      })]).parse(expected.driver.arguments);
      return client.projects.getProjectsPage({
        limit: options.limit, offset: options.offset,
        ...(options.isCompleted === undefined ? {} : { isCompleted: options.isCompleted }),
      });
    }
    case 'projects.getAllProjects': {
      const [options] = z.tuple([z.strictObject({
        isCompleted: z.boolean().optional(), pageSize: z.number().optional(), startOffset: z.number().optional(),
        maxItems: z.number(), maxPages: z.number(), maxBytes: z.number(), maxDurationMs: z.number(),
      })]).parse(expected.driver.arguments);
      const { isCompleted, pageSize, startOffset, ...bounds } = options;
      return client.projects.getAllProjects({
        ...bounds,
        ...(isCompleted === undefined ? {} : { isCompleted }),
        ...(pageSize === undefined ? {} : { pageSize }),
        ...(startOffset === undefined ? {} : { startOffset }),
      });
    }
    case 'projects.deleteProject': {
      const [projectId] = z.tuple([z.number()]).parse(expected.driver.arguments);
      return client.projects.deleteProject(projectId);
    }
    case 'projects.addProject': {
      const [payload] = z.tuple([AddProjectPayloadSchema]).parse(expected.driver.arguments);
      return client.projects.addProject(payload);
    }
    case 'projects.updateProject': {
      const [projectId, payload] = z.tuple([z.number(), UpdateProjectPayloadSchema]).parse(expected.driver.arguments);
      return client.projects.updateProject(projectId, payload);
    }
    case 'suites.getSuite': {
      const [suiteId] = z.tuple([z.number()]).parse(expected.driver.arguments);
      return client.suites.getSuite(suiteId);
    }
    case 'suites.getSuitesPage': {
      const [projectId, options] = z.tuple([z.number(), z.strictObject({ limit: z.number(), offset: z.number() })])
        .parse(expected.driver.arguments);
      return client.suites.getSuitesPage(projectId, options);
    }
    case 'suites.getAllSuites': {
      const [projectId, options] = z.tuple([z.number(), z.strictObject({
        pageSize: z.number().optional(), startOffset: z.number().optional(),
        maxItems: z.number(), maxPages: z.number(), maxBytes: z.number(), maxDurationMs: z.number(),
      })]).parse(expected.driver.arguments);
      const { pageSize, startOffset, ...bounds } = options;
      return client.suites.getAllSuites(projectId, {
        ...bounds,
        ...(pageSize === undefined ? {} : { pageSize }),
        ...(startOffset === undefined ? {} : { startOffset }),
      });
    }
    case 'suites.addSuite': {
      const [projectId, payload] = z.tuple([z.number(), AddSuitePayloadSchema]).parse(expected.driver.arguments);
      return client.suites.addSuite(projectId, payload);
    }
    case 'suites.updateSuite': {
      const [suiteId, payload] = z.tuple([z.number(), UpdateSuitePayloadSchema]).parse(expected.driver.arguments);
      return client.suites.updateSuite(suiteId, payload);
    }
    case 'suites.deleteSuite': {
      const [suiteId, options] = z.tuple([z.number(), z.strictObject({ soft: z.boolean() }).optional()])
        .parse(expected.driver.arguments);
      return options === undefined ? client.suites.deleteSuite(suiteId) : client.suites.deleteSuite(suiteId, options);
    }
    case 'sections.getSection': {
      const [sectionId] = z.tuple([z.number()]).parse(expected.driver.arguments);
      return client.sections.getSection(sectionId);
    }
    case 'sections.getSectionsPage': {
      const [projectId, options] = z.tuple([z.number(), z.strictObject({
        suiteId: z.number().optional(), limit: z.number(), offset: z.number(),
      })]).parse(expected.driver.arguments);
      return client.sections.getSectionsPage(projectId, {
        limit: options.limit, offset: options.offset,
        ...(options.suiteId === undefined ? {} : { suiteId: options.suiteId }),
      });
    }
    case 'sections.getAllSections': {
      const [projectId, options] = z.tuple([z.number(), z.strictObject({
        suiteId: z.number().optional(), pageSize: z.number().optional(), startOffset: z.number().optional(),
        maxItems: z.number(), maxPages: z.number(), maxBytes: z.number(), maxDurationMs: z.number(),
      })]).parse(expected.driver.arguments);
      const { suiteId, pageSize, startOffset, ...bounds } = options;
      return client.sections.getAllSections(projectId, {
        ...bounds,
        ...(suiteId === undefined ? {} : { suiteId }),
        ...(pageSize === undefined ? {} : { pageSize }),
        ...(startOffset === undefined ? {} : { startOffset }),
      });
    }
    case 'sections.addSection': {
      const [projectId, payload] = z.tuple([z.number(), AddSectionPayloadSchema]).parse(expected.driver.arguments);
      return client.sections.addSection(projectId, payload);
    }
    case 'sections.updateSection': {
      const [sectionId, payload] = z.tuple([z.number(), UpdateSectionPayloadSchema]).parse(expected.driver.arguments);
      return client.sections.updateSection(sectionId, payload);
    }
    case 'sections.moveSection': {
      const [sectionId, payload] = z.tuple([z.number(), MoveSectionPayloadSchema]).parse(expected.driver.arguments);
      return client.sections.moveSection(sectionId, payload);
    }
    case 'sections.deleteSection': {
      const [sectionId, options] = z.tuple([z.number(), z.strictObject({ soft: z.boolean() }).optional()])
        .parse(expected.driver.arguments);
      return options === undefined ? client.sections.deleteSection(sectionId) : client.sections.deleteSection(sectionId, options);
    }
    default: throw new Error(`Missing independent driver evidence harness: ${expected.driver.binding}`);
  }
}

describe('published driver evidence for reviewed examples (not adapter qualification)', () => {
  for (const manifest of manifests) {
    for (const fixture of manifest.cases) {
      if (fixture.expect.kind !== 'accepted') continue;
      const expected = fixture.expect;
      it(`${manifest.endpoint.tool}: ${fixture.id}`, async () => {
        // An upload fixture declares its file's contents rather than a path, so the
        // file is real for the length of this case and its token stands for that path.
        const directory = (manifest.files ?? []).length === 0
          ? undefined
          : await mkdtemp(join(tmpdir(), 'testrail-mcp-fixture-'));
        const paths = directory === undefined ? {} : await materializeFiles(manifest, directory);
        const expectedCall = substituteTokens(expected, paths);
        const calls: { url: string; method: string | undefined; body: unknown }[] = [];
        const fetchMock = vi.fn<typeof globalThis.fetch>(async (input, init) => {
          const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
          // Described inside the request: the driver owns an upload's streams and
          // cancels them once it settles, so a later read would never complete.
          calls.push({ url, method: init?.method, body: await describeBody(init?.body) });
          const response = expectedCall.upstream_response;
          return Promise.resolve(response.kind === 'json'
            ? new Response(JSON.stringify(response.body), { headers: { 'content-type': 'application/json' } })
            : response.kind === 'text'
              ? new Response(response.text, { headers: { 'content-type': 'text/plain' } })
              : new Response(response.utf8, { headers: { 'content-type': 'application/octet-stream' } }));
        });
        const dnsLookup = vi.fn(() => Promise.resolve([{ address: '203.0.113.10', family: 4 }]));
        const client = new TestRailClient({
          baseUrl: 'https://fixture.testrail.test', email: 'fixture@example.test', apiKey: 'synthetic-fixture-key',
          registerProcessHandlers: false, enableCache: false, maxRetries: 0,
          fetch: fetchMock, dnsLookup,
        });
        try {
          const result = await invokeDriver(client, expectedCall);
          expect(dnsLookup).toHaveBeenCalled();
          const sent = calls;
          expect(sent).toEqual([{
            url: `https://fixture.testrail.test/index.php?/api/v2/${expectedCall.wire.endpoint}`,
            method: expectedCall.wire.method,
            // A multipart upload is compared part by part; everything else by its JSON.
            body: expectedCall.wire.multipart ?? expectedCall.wire.json,
          }]);
          if (expectedCall.driver_result.kind === 'binary') {
            expect(result).toBeInstanceOf(ArrayBuffer);
            if (!(result instanceof ArrayBuffer)) throw new Error('Expected binary driver result');
            expect(Buffer.from(result)).toEqual(Buffer.from(expectedCall.driver_result.utf8));
          } else if (expectedCall.driver_result.kind === 'void') {
            expect(result).toBeUndefined();
          } else {
            expect(result).toEqual(expectedCall.driver_result.value);
          }
        } finally {
          client.destroy();
          if (directory !== undefined) await rm(directory, { recursive: true, force: true });
        }
      });
    }
  }
});
