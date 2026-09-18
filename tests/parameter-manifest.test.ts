import { readFile } from 'node:fs/promises';
import {
  TestRailClient,
  UpdateCasePayloadSchema,
  AddProjectPayloadSchema,
  AddSuitePayloadSchema,
  UpdateProjectPayloadSchema,
  UpdateSuitePayloadSchema,
} from '@dichovsky/testrail-api-client';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  auditParameterManifests,
  loadParameterManifests,
  parameterCoverageReport,
  ParameterManifestSchema,
} from './contracts/parameter-manifest.js';
import type { ParameterFixture } from './contracts/parameter-manifest.js';

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
      'testrail_add_project',
      'testrail_add_suite',
      'testrail_delete_project',
      'testrail_delete_suite',
      'testrail_get_attachment',
      'testrail_get_attachments_for_plan_entry',
      'testrail_get_project',
      'testrail_get_projects',
      'testrail_get_suite',
      'testrail_get_suites',
      'testrail_update_project',
      'testrail_update_suite',
    ]);
    expect(report.partialEndpoints).toEqual(['testrail_get_cases', 'testrail_update_case']);
    expect(report.pendingEndpoints).toHaveLength(119);
    expect([...report.reviewedEndpoints, ...report.pendingEndpoints].sort())
      .toEqual(inventory.map(({ tool }) => tool).sort());
    expect(report.pendingEndpoints).toContain('testrail_add_case');
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
    case 'cases.getCasesPage': {
      const [projectId, options] = z.tuple([z.number(), z.strictObject({
        refs: z.union([z.string(), z.array(z.string())]).optional(),
        limit: z.number(), offset: z.number(),
      })]).parse(expected.driver.arguments);
      return client.cases.getCasesPage(projectId, {
        limit: options.limit,
        offset: options.offset,
        ...(options.refs === undefined ? {} : { refs: options.refs }),
      });
    }
    case 'cases.updateCase': {
      const [caseId, payload] = z.tuple([z.number(), UpdateCasePayloadSchema]).parse(expected.driver.arguments);
      return client.cases.updateCase(caseId, payload);
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
    default: throw new Error(`Missing independent driver evidence harness: ${expected.driver.binding}`);
  }
}

describe('published driver evidence for reviewed examples (not adapter qualification)', () => {
  for (const manifest of manifests) {
    for (const fixture of manifest.cases) {
      if (fixture.expect.kind !== 'accepted') continue;
      const expected = fixture.expect;
      it(`${manifest.endpoint.tool}: ${fixture.id}`, async () => {
        const calls: { url: string; method: string | undefined; body: unknown }[] = [];
        const fetchMock = vi.fn<typeof globalThis.fetch>((input, init) => {
          const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body;
          const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
          calls.push({ url, method: init?.method, body });
          const response = expected.upstream_response;
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
          const result = await invokeDriver(client, expected);
          expect(dnsLookup).toHaveBeenCalled();
          expect(calls).toEqual([{
            url: `https://fixture.testrail.test/index.php?/api/v2/${expected.wire.endpoint}`,
            method: expected.wire.method,
            body: expected.wire.json,
          }]);
          if (expected.driver_result.kind === 'binary') {
            expect(result).toBeInstanceOf(ArrayBuffer);
            if (!(result instanceof ArrayBuffer)) throw new Error('Expected binary driver result');
            expect(Buffer.from(result)).toEqual(Buffer.from(expected.driver_result.utf8));
          } else if (expected.driver_result.kind === 'void') {
            expect(result).toBeUndefined();
          } else {
            expect(result).toEqual(expected.driver_result.value);
          }
        } finally {
          client.destroy();
        }
      });
    }
  }
});
