import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
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
  AddResultPayloadSchema,
  AddResultsForCasesPayloadSchema,
  AddResultsPayloadSchema,
  AddRunPayloadSchema,
  AddSharedStepPayloadSchema,
  EditResultPayloadSchema,
  UpdateProjectPayloadSchema,
  UpdateRunPayloadSchema,
  UpdateTestLabelsPayloadSchema,
  UpdateTestsLabelsPayloadSchema,
  UpdateSectionPayloadSchema,
  UpdateSharedStepPayloadSchema,
  UpdateSuitePayloadSchema,
  AddConfigurationGroupPayloadSchema,
  AddConfigurationPayloadSchema,
  AddPlanEntryPayloadSchema,
  AddPlanPayloadSchema,
  AddRunToPlanEntryPayloadSchema,
  UpdateConfigurationGroupPayloadSchema,
  UpdateConfigurationPayloadSchema,
  UpdatePlanEntryPayloadSchema,
  UpdatePlanPayloadSchema,
  UpdateRunInPlanEntryPayloadSchema,
  AddLabelPayloadSchema,
  AddMilestonePayloadSchema,
  DeleteLabelsPayloadSchema,
  UpdateLabelPayloadSchema,
  UpdateMilestonePayloadSchema,
  AddGroupPayloadSchema,
  UpdateGroupPayloadSchema,
  UserAddPayloadSchema,
  UserUpdatePayloadSchema,
  AddDatasetPayloadSchema,
  AddVariablePayloadSchema,
  UpdateDatasetPayloadSchema,
  UpdateVariablePayloadSchema,
  AddCaseFieldPayloadSchema,
} from '@dichovsky/testrail-api-client';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { loadDomainLibrary } from './contracts/domains.js';
import { auditDriverReleases, loadDriverReleases } from './contracts/driver-releases.js';
import type { DriverReleases, InstalledDriver } from './contracts/driver-releases.js';
import {
  auditParameterManifests,
  loadParameterManifests,
  parameterCoverageReport,
  ParameterManifestSchema,
  resolveDomains,
} from './contracts/parameter-manifest.js';
import type { ParameterFixture, ParameterManifest } from './contracts/parameter-manifest.js';
import { auditRegisteredParameters } from './contracts/registered-parameters.js';
import { describeBody, materializeFiles, substituteTokens } from './contracts/uploads.js';
import { positiveIdSchema, strictObject } from '../src/contracts/inputs.js';
import { driverCall } from '../src/operations/driver-call.js';
import { deletePlanEntry } from '../src/operations/families/t06.js';
import { createRegistry, defineOperation } from '../src/operations/registry.js';

const manifests = await loadParameterManifests();
const rawInventory: unknown = JSON.parse(await readFile(new URL('../docs/operation-inventory.json', import.meta.url), 'utf8'));
const inventory = z.object({
  operations: z.array(ParameterManifestSchema.shape.endpoint.strip()),
}).parse(rawInventory).operations;
const rawDriverMetadata: unknown = JSON.parse(await readFile(
  new URL('../package.json', import.meta.resolve('@dichovsky/testrail-api-client')), 'utf8',
));
const driverVersion = z.object({ version: z.string() }).parse(rawDriverMetadata).version;
const releases = await loadDriverReleases();
const driverRoot = new URL('../', import.meta.resolve('@dichovsky/testrail-api-client'));
const rawLock: unknown = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
const lockedDriver = z.object({
  packages: z.object({ 'node_modules/@dichovsky/testrail-api-client': z.object({ integrity: z.string() }) }),
}).parse(rawLock).packages['node_modules/@dichovsky/testrail-api-client'];
const installedDriver: InstalledDriver = {
  version: driverVersion,
  integrity: lockedDriver.integrity,
  read: (path) => {
    const file = new URL(path, driverRoot);
    return existsSync(file) ? readFileSync(file) : undefined;
  },
};
const release700 = '71a80d984aea14713d8eeaf6ac9a0d41c1fba12b';
const release720 = 'cc7751c01c3d3956d061073283bee6b23bf33422';
const release800 = '7680ab6c0d1973749e3178016a3d133af27bfb0a';
const release900 = 'a5ccffbfa176e9c6675bd81fff61859bd7b6be5d';

function example() {
  const manifest = manifests.find(({ endpoint }) => endpoint.tool === 'testrail_get_attachment');
  if (!manifest) throw new Error('Required attachment manifest is missing');
  return structuredClone(manifest);
}

function zeroParameterExample() {
  const baseline = example();
  // Authored at the pinned commit, so it inherits none of the attachment manifest's evidence.
  const review = { ...baseline.review, authored_commit: baseline.review.driver_commit };
  delete review.evidence;
  return ParameterManifestSchema.parse({
    ...baseline,
    review,
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

describe('driver provenance evidence', () => {
  function find(name: string) {
    const manifest = manifests.find(({ endpoint }) => endpoint.tool === `testrail_${name}`);
    if (!manifest) throw new Error(`Required ${name} manifest is missing`);
    return structuredClone(manifest);
  }

  function ledger(edit: (copy: DriverReleases) => void): DriverReleases {
    const copy = structuredClone(releases);
    edit(copy);
    return copy;
  }

  function releaseFile(copy: DriverReleases, commit: string, path: string) {
    const file = copy.releases.find((release) => release.commit === commit)?.files[path];
    if (!file) throw new Error(`Ledger has no ${path} at ${commit}`);
    return file;
  }

  function audit(manifest: ParameterManifest, ledgerCopy: DriverReleases = releases): string[] {
    return auditParameterManifests([manifest], undefined, undefined, ledgerCopy);
  }

  const bumped = ['get_attachment', 'get_attachments_for_plan_entry', 'get_cases', 'update_case', 'update_project'];

  it('carries evidence on every manifest, from 7.0.0 on exactly the five authored there', () => {
    // Every manifest was re-reviewed against 8.0.0 and then 9.0.0, so none has a driver commit it was authored at.
    expect(manifests.filter(({ review }) => review.authored_commit === review.driver_commit)).toEqual([]);
    expect(manifests.filter(({ review }) => review.driver_commit !== release900)).toEqual([]);
    expect(manifests.filter(({ review }) => review.evidence === undefined)).toEqual([]);
    // authored_commit is declared, not derived, so the gate alone cannot tell a moved one
    // from an honest one. Pin it here: re-authoring any manifest at a later commit, the
    // way a stamp would to avoid evidence, has to edit this test in the same diff.
    expect(Object.fromEntries(manifests.map(({ endpoint, review }) => [endpoint.tool, review.authored_commit])))
      .toEqual(Object.fromEntries(manifests.map(({ endpoint }) => [
        endpoint.tool, bumped.includes(endpoint.tool.replace(/^testrail_/, '')) ? release700 : release720,
      ])));
    for (const { endpoint, review } of manifests) {
      const steps = review.evidence?.map(({ from_commit, to_commit }) => [from_commit, to_commit]);
      expect(steps, endpoint.tool).toEqual(bumped.includes(endpoint.tool.replace(/^testrail_/, ''))
        ? [[release700, release720], [release720, release800], [release800, release900]]
        : [[release720, release800], [release800, release900]]);
    }
  });

  it('pins every recorded release, installed or not', () => {
    // Only the installed release can be checked against real bytes offline. The others are
    // pinned here, so rewriting a historical entry, which would let a false unchanged claim
    // pass, also has to edit this test; scripts/audit-driver-ledger.mjs re-checks every
    // entry against the driver's history and npm.
    expect(Object.fromEntries(releases.releases.map((release) => [
      release.version, createHash('sha256').update(JSON.stringify(release)).digest('hex'),
    ]))).toEqual({
      '7.0.0': '1a282e74688b1869c60b01f0779b6e8938fb83cb1daf8b58a92b3767023797f0',
      // Rewritten twice on 2026-10-03, to record files a later release first cited as
      // absent here, since an evidence step needs both ends: src/upload-source.ts, where
      // 8.0.0 moved the multipart builder, and skill/reference/recipes.md, where 9.0.0
      // moved the skill's recipes.
      '7.2.0': '6cff0397e51d262be7d0a85961ff6dc9f4a1b2c3dc165f9113ec4adba39ee4a0',
      // Rewritten once, on 2026-10-03, to record skill/reference/recipes.md as absent at
      // 8.0.0: 9.0.0 split skill/SKILL.md and moved the recipes the attachment manifests
      // cite there, and an evidence step needs both ends.
      '8.0.0': '6fa18ca4c519ba2503814e50c9f1ca0d35a1202f8c573ef0c6e8e36f789d1796',
      '9.0.0': '4e7b00db1f2ed301adb32abf1e2f8ccf7420b257250b801f423594ccd562d5d1',
    });
  });

  it('records the installed driver in the release ledger, integrity and shipped files alike', () => {
    expect(auditDriverReleases(releases, installedDriver)).toEqual([]);
    const installed = releases.releases.find(({ version }) => version === driverVersion);
    expect(installed?.commit).toBe(release900);
  });

  it('fails a driver_commit bump that carries no evidence', () => {
    const project = find('update_project');
    delete project.review.evidence;
    expect(audit(project)).toEqual(['testrail_update_project: Driver commit advanced from 71a80d98 to a5ccffbf without evidence']);
  });

  it('fails a manifest backdated to an earlier authored commit without evidence for the span', () => {
    const cases = find('add_case');
    cases.review.authored_commit = release700;
    expect(audit(cases)).toEqual(['testrail_add_case: Evidence step 1 starts at cc7751c0, not 71a80d98']);
    delete cases.review.evidence;
    expect(audit(cases)).toEqual(['testrail_add_case: Driver commit advanced from 71a80d98 to a5ccffbf without evidence']);
  });

  it('rejects evidence claiming a changed file unchanged', () => {
    const attachment = find('get_attachment');
    const entry = attachment.review.evidence?.[0]?.files.find(({ path }) => path === 'src/retry-policy.ts');
    if (!entry) throw new Error('retry-policy evidence is missing');
    entry.changed = false;
    expect(audit(attachment)).toEqual([
      'testrail_get_attachment: Evidence 71a80d98..cc7751c0 claims src/retry-policy.ts unchanged, but the release ledger records it changed',
    ]);
  });

  it('rejects an unchanged claim for a newly cited file that changed', () => {
    const project = find('update_project');
    project.sources.push({
      id: 'driver-client-core',
      url: `https://github.com/dichovsky/testrail-api-client/blob/${release900}/src/client-core.ts`,
      supports: 'The shared request pipeline.',
    });
    expect(audit(project)).toEqual([
      'testrail_update_project: Evidence 71a80d98..cc7751c0 does not cover cited file src/client-core.ts',
      'testrail_update_project: Evidence cc7751c0..7680ab6c does not cover cited file src/client-core.ts',
      'testrail_update_project: Evidence 7680ab6c..a5ccffbf does not cover cited file src/client-core.ts',
    ]);
    for (const step of project.review.evidence ?? []) step.files.push({ path: 'src/client-core.ts', changed: false });
    expect(audit(project)).toEqual([
      'testrail_update_project: Evidence 71a80d98..cc7751c0 claims src/client-core.ts unchanged, but the release ledger records it changed',
      'testrail_update_project: Evidence cc7751c0..7680ab6c claims src/client-core.ts unchanged, but the release ledger records it changed',
      'testrail_update_project: Evidence 7680ab6c..a5ccffbf claims src/client-core.ts unchanged, but the release ledger records it changed',
    ]);
  });

  it('rejects evidence claiming an unchanged file changed', () => {
    const project = find('update_project');
    const entry = project.review.evidence?.[0]?.files[0];
    if (!entry) throw new Error('update_project evidence is missing');
    entry.changed = true;
    entry.note = 'Claimed changed.';
    expect(audit(project)).toEqual([
      'testrail_update_project: Evidence 71a80d98..cc7751c0 claims src/modules/projects.ts changed, but the release ledger records it unchanged',
    ]);
  });

  it('judges a change by the ledger, in the source blob or the shipped file', () => {
    const project = find('update_project');
    expect(audit(project, ledger((copy) => { releaseFile(copy, release800, 'src/modules/projects.ts').git_blob = '0'.repeat(40); }))).toEqual([
      'testrail_update_project: Evidence cc7751c0..7680ab6c claims src/modules/projects.ts unchanged, but the release ledger records it changed',
    ]);
    expect(audit(project, ledger((copy) => { releaseFile(copy, release700, 'src/schemas/projects.ts').package_sha256 = '0'.repeat(64); }))).toEqual([
      'testrail_update_project: Evidence 71a80d98..cc7751c0 claims src/schemas/projects.ts unchanged, but the release ledger records it changed',
    ]);
  });

  it('requires a note for every file recorded as changed', () => {
    const attachment = find('get_attachment');
    const entry = attachment.review.evidence?.[0]?.files.find(({ path }) => path === 'src/retry-policy.ts');
    if (!entry) throw new Error('retry-policy evidence is missing');
    delete entry.note;
    expect(audit(attachment)).toEqual(['testrail_get_attachment: Evidence 71a80d98..cc7751c0 gives no note for changed file src/retry-policy.ts']);
  });

  it('requires every cited driver file to be covered once', () => {
    const cases = find('update_case');
    const files = cases.review.evidence?.[0]?.files;
    if (!files) throw new Error('update_case evidence is missing');
    const [first] = files.splice(1, 1);
    if (!first) throw new Error('update_case evidence is too short');
    expect(audit(cases)).toEqual([`testrail_update_case: Evidence 71a80d98..cc7751c0 does not cover cited file ${first.path}`]);
    files.push(first, { ...first });
    expect(audit(cases)).toEqual([`testrail_update_case: Evidence 71a80d98..cc7751c0 names ${first.path} twice`]);
  });

  it('refuses evidence naming a file the ledger does not record at both commits', () => {
    const project = find('update_project');
    project.review.evidence?.[0]?.files.push({ path: 'src/unrecorded.ts', changed: false });
    expect(audit(project)).toEqual([
      'testrail_update_project: Evidence 71a80d98..cc7751c0 names src/unrecorded.ts, which the release ledger does not record at both commits',
    ]);
  });

  it('requires the evidence to chain from the authored commit to the driver commit', () => {
    const project = find('update_project');
    const step = project.review.evidence?.[0];
    if (!step) throw new Error('update_project evidence is missing');
    const broken = structuredClone(project);
    const brokenStep = broken.review.evidence?.[0];
    if (!brokenStep) throw new Error('update_project evidence is missing');
    brokenStep.from_commit = release720;
    expect(audit(broken)).toEqual([
      'testrail_update_project: Evidence step 1 starts at cc7751c0, not 71a80d98',
      'testrail_update_project: Evidence step 1 does not advance',
    ]);
    const short = structuredClone(project);
    const shortStep = short.review.evidence?.[0];
    if (!shortStep) throw new Error('update_project evidence is missing');
    shortStep.to_commit = release700;
    short.review.evidence?.splice(1);
    expect(audit(short)).toEqual([
      'testrail_update_project: Evidence step 1 does not advance',
      'testrail_update_project: Evidence ends at 71a80d98, not at driver commit a5ccffbf',
    ]);
    const unrecorded = structuredClone(project);
    const unrecordedStep = unrecorded.review.evidence?.at(-1);
    if (!unrecordedStep) throw new Error('update_project evidence is missing');
    unrecorded.review.evidence?.push({ ...unrecordedStep, from_commit: release900, to_commit: 'f'.repeat(40) });
    expect(audit(unrecorded)).toEqual([
      'testrail_update_project: Evidence a5ccffbf..ffffffff names a commit that is not a recorded release',
      'testrail_update_project: Evidence ends at ffffffff, not at driver commit a5ccffbf',
    ]);
    const unrecordedStart = structuredClone(project);
    Object.assign(unrecordedStart.review, { authored_commit: 'e'.repeat(40) });
    const startStep = unrecordedStart.review.evidence?.[0];
    if (!startStep) throw new Error('update_project evidence is missing');
    startStep.from_commit = 'e'.repeat(40);
    expect(audit(unrecordedStart)).toEqual([
      'testrail_update_project: Authored commit eeeeeeee is not a recorded release',
      'testrail_update_project: Evidence eeeeeeee..cc7751c0 names a commit that is not a recorded release',
    ]);
  });

  it('refuses a driver link in any form but a blob URL pinned at the driver commit', () => {
    const stale = `${release700}/src/client-core.ts`;
    for (const url of [
      `https://github.com/dichovsky/testrail-api-client/blame/${stale}`,
      `https://github.com/dichovsky/testrail-api-client/raw/${stale}`,
      `https://github.com/dichovsky/testrail-api-client/tree/${release700}`,
      `https://raw.githubusercontent.com/dichovsky/testrail-api-client/${stale}`,
      `https://github.com/Dichovsky/testrail-api-client/blob/${stale}`,
      `http://github.com/dichovsky/testrail-api-client/blob/${stale}`,
      'https://github.com/dichovsky/testrail-api-client.git',
      // Spellings a text match missed: each serves the same stale driver file.
      `https://github.com:443/dichovsky/testrail-api-client/blob/${stale}`,
      `https://github.com./dichovsky/testrail-api-client/blob/${stale}`,
      `https://reviewer@github.com/dichovsky/testrail-api-client/blob/${stale}`,
      `https://github.com/%64ichovsky/testrail-api-client/blob/${stale}`,
      `https://codeload.github.com/dichovsky/testrail-api-client/tar.gz/${release700}`,
    ]) {
      const project = find('update_project');
      project.sources.push({ id: 'stale-link', url, supports: 'A driver link in another form.' });
      expect(audit(project), url).toEqual(['testrail_update_project: Source stale-link cites the driver outside a blob URL pinned at a5ccffbf']);
    }
    const unrelated = find('update_project');
    unrelated.sources.push({ id: 'other', url: 'https://github.com/dichovsky/testrail-api-client-extras/blob/main/x.ts', supports: 'Another repository.' });
    expect(audit(unrelated)).toEqual([]);
  });

  it('refuses a ledger that describes another repository', () => {
    expect(audit(find('add_case'), ledger((copy) => { copy.repository = 'https://github.com/example/testrail-api-client'; })))
      .toEqual(['testrail_add_case: Release ledger describes https://github.com/example/testrail-api-client, not the driver the manifests cite']);
  });

  it('keeps evidence steps in release and review order', () => {
    const project = find('update_project');
    const step = project.review.evidence?.[0];
    if (!step) throw new Error('update_project evidence is missing');
    // A downgrade: authored at 7.2.0, evidenced back to 7.0.0.
    const downgrade = structuredClone(project);
    Object.assign(downgrade.review, { authored_commit: release720, driver_commit: release700, driver_version: '7.0.0' });
    downgrade.sources = downgrade.sources.map((source) => ({ ...source, url: source.url.replace(release900, release700) }));
    downgrade.review.evidence = [{ ...step, from_commit: release720, to_commit: release700 }];
    expect(audit(downgrade)).toEqual(['testrail_update_project: Evidence step 1 moves back to an earlier release']);
    const late = structuredClone(project);
    const lateStep = late.review.evidence?.at(-1);
    if (!lateStep) throw new Error('update_project evidence is missing');
    lateStep.reviewed_on = '2026-10-04';
    expect(audit(late)).toEqual(['testrail_update_project: Evidence step 3 reviewed on 2026-10-04, out of order with the review dates around it']);
    const twoSteps = structuredClone(project);
    Object.assign(twoSteps.review, { authored_commit: release700, driver_commit: release720 });
    twoSteps.review.evidence = [
      { ...step, reviewed_on: '2026-09-18' },
      { ...step, from_commit: release720, to_commit: release720, reviewed_on: '2026-09-17' },
    ];
    expect(audit(twoSteps)).toContain('testrail_update_project: Evidence step 2 reviewed on 2026-09-17, out of order with the review dates around it');
  });

  it('refuses evidence on a manifest whose driver commit never advanced', () => {
    // Authored at the driver commit it is reviewed against, yet carrying a step.
    const cases = find('add_case');
    cases.review.authored_commit = release900;
    expect(audit(cases)).toEqual(['testrail_add_case: Evidence is recorded for a driver commit that never advanced']);
  });

  it('requires the driver and authored commits to be recorded releases of the stated version', () => {
    const cases = find('add_case');
    cases.review.driver_version = '7.2.0';
    expect(audit(cases)).toEqual(['testrail_add_case: Driver version 7.2.0 disagrees with release 9.0.0 recorded for a5ccffbf']);
    const orphan = find('add_case');
    orphan.review.authored_commit = 'a'.repeat(40);
    delete orphan.review.evidence;
    expect(audit(orphan)).toEqual([
      'testrail_add_case: Authored commit aaaaaaaa is not a recorded release',
      'testrail_add_case: Driver commit advanced from aaaaaaaa to a5ccffbf without evidence',
    ]);
    expect(audit(find('add_case'), ledger((copy) => { copy.releases = copy.releases.filter(({ commit }) => commit !== release900); })))
      .toContain('testrail_add_case: Driver commit a5ccffbf is not a recorded release');
  });

  it('requires the ledger to record every cited driver file at the driver commit', () => {
    const without = ledger((copy) => {
      const release = copy.releases.find(({ commit }) => commit === release900);
      if (!release) throw new Error('9.0.0 is missing from the ledger');
      release.files = Object.fromEntries(Object.entries(release.files).filter(([path]) => path !== 'src/schemas/cases.ts'));
    });
    expect(audit(find('add_case'), without)).toEqual([
      'testrail_add_case: Release ledger does not record cited file src/schemas/cases.ts at a5ccffbf',
      'testrail_add_case: Evidence 7680ab6c..a5ccffbf names src/schemas/cases.ts, which the release ledger does not record at both commits',
    ]);
    const absent = ledger((copy) => { releaseFile(copy, release900, 'src/schemas/cases.ts').git_blob = null; });
    expect(audit(find('add_case'), absent)).toEqual([
      'testrail_add_case: Release ledger does not record cited file src/schemas/cases.ts at a5ccffbf',
    ]);
  });

  it('reads a cited path without its anchor or query, decoded, and reports a malformed one', () => {
    const cite = (manifest: ParameterManifest, path: string): void => {
      manifest.sources.push({ id: `extra-${String(manifest.sources.length)}`, url: `https://github.com/dichovsky/testrail-api-client/blob/${release900}/${path}`, supports: 'An extra citation.' });
    };
    const anchored = find('update_project');
    cite(anchored, 'src/modules/projects.ts#L10-L20');
    cite(anchored, 'src/schemas/projects.ts?plain=1');
    expect(audit(anchored)).toEqual([]);
    const encoded = find('update_project');
    cite(encoded, 'src/url%2Ets');
    expect(audit(encoded)).toEqual([
      'testrail_update_project: Evidence 71a80d98..cc7751c0 does not cover cited file src/url.ts',
      'testrail_update_project: Evidence cc7751c0..7680ab6c does not cover cited file src/url.ts',
      'testrail_update_project: Evidence 7680ab6c..a5ccffbf does not cover cited file src/url.ts',
    ]);
    const malformed = find('update_project');
    cite(malformed, 'src/%E0.ts');
    expect(audit(malformed)).toEqual([`testrail_update_project: Source extra-${String(malformed.sources.length - 1)} has a malformed driver path: src/%E0.ts`]);
  });

  it('holds the ledger to the installed package', () => {
    expect(auditDriverReleases(releases, { ...installedDriver, version: '9.9.9' })).toEqual(['No recorded release for installed driver 9.9.9']);
    expect(auditDriverReleases(releases, { ...installedDriver, integrity: 'sha512-AAAA' }))
      .toEqual(['Release 9.0.0 integrity disagrees with the locked package']);
    expect(auditDriverReleases(ledger((copy) => { releaseFile(copy, release900, 'src/url.ts').package_sha256 = '0'.repeat(64); }), installedDriver))
      .toEqual(['src/url.ts: installed dist/url.js does not match its recorded SHA-256']);
    expect(auditDriverReleases(ledger((copy) => { releaseFile(copy, release900, 'src/url.ts').package_sha256 = null; }), installedDriver))
      .toEqual(['src/url.ts: dist/url.js is installed but recorded as absent']);
    expect(auditDriverReleases(ledger((copy) => { releaseFile(copy, release900, 'src/url.ts').package_file = 'dist/absent.js'; }), installedDriver))
      .toEqual([
        '9.0.0 src/url.ts: package_file dist/absent.js is not the file the package ships for it (dist/url.js)',
        'src/url.ts: dist/absent.js is recorded but not installed',
      ]);
    // A shipped file that exists but belongs to another source is caught by path, not by hash.
    expect(auditDriverReleases(ledger((copy) => {
      for (const release of copy.releases) {
        const plans = release.files['src/modules/plans.ts'];
        const projects = release.files['src/modules/projects.ts'];
        if (plans && projects) Object.assign(projects, { package_file: plans.package_file, package_sha256: plans.package_sha256 });
      }
    }), installedDriver)).toEqual([
      '7.0.0 src/modules/projects.ts: package_file dist/modules/plans.js is not the file the package ships for it (dist/modules/projects.js)',
      '7.2.0 src/modules/projects.ts: package_file dist/modules/plans.js is not the file the package ships for it (dist/modules/projects.js)',
      '8.0.0 src/modules/projects.ts: package_file dist/modules/plans.js is not the file the package ships for it (dist/modules/projects.js)',
      '9.0.0 src/modules/projects.ts: package_file dist/modules/plans.js is not the file the package ships for it (dist/modules/projects.js)',
    ]);
    expect(auditDriverReleases(ledger((copy) => {
      const [first] = copy.releases;
      if (first) first.files['README.md'] = { git_blob: null, package_file: 'README.md', package_sha256: null };
    }), installedDriver)).toEqual(['7.0.0 README.md: package_file README.md is not the file the package ships for it (none known)']);
    expect(auditDriverReleases(ledger((copy) => {
      const [first] = copy.releases;
      if (first) copy.releases.push({ ...first });
    }), installedDriver)).toEqual([
      'Duplicate release version: 7.0.0',
      'Duplicate release commit: 71a80d984aea14713d8eeaf6ac9a0d41c1fba12b',
      'Release 7.0.0 is not listed after 9.0.0',
    ]);
    expect(auditDriverReleases(ledger((copy) => { copy.releases.reverse(); }), installedDriver))
      .toEqual(['Release 8.0.0 is not listed after 9.0.0', 'Release 7.2.0 is not listed after 8.0.0', 'Release 7.0.0 is not listed after 7.2.0']);
  });
});

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
      'testrail_add_attachment_to_case',
      'testrail_add_attachment_to_plan',
      'testrail_add_attachment_to_plan_entry',
      'testrail_add_attachment_to_result',
      'testrail_add_attachment_to_run',
      'testrail_add_bdd',
      'testrail_add_case',
      'testrail_add_case_field',
      'testrail_add_cases',
      'testrail_add_config',
      'testrail_add_config_group',
      'testrail_add_dataset',
      'testrail_add_group',
      'testrail_add_label',
      'testrail_add_milestone',
      'testrail_add_plan',
      'testrail_add_plan_entry',
      'testrail_add_project',
      'testrail_add_result',
      'testrail_add_result_for_case',
      'testrail_add_results',
      'testrail_add_results_for_cases',
      'testrail_add_run',
      'testrail_add_run_to_plan_entry',
      'testrail_add_section',
      'testrail_add_shared_step',
      'testrail_add_suite',
      'testrail_add_user',
      'testrail_add_variable',
      'testrail_close_plan',
      'testrail_close_run',
      'testrail_copy_cases_to_section',
      'testrail_delete_attachment',
      'testrail_delete_case',
      'testrail_delete_cases',
      'testrail_delete_config',
      'testrail_delete_config_group',
      'testrail_delete_dataset',
      'testrail_delete_group',
      'testrail_delete_label',
      'testrail_delete_labels',
      'testrail_delete_milestone',
      'testrail_delete_plan',
      'testrail_delete_plan_entry',
      'testrail_delete_project',
      'testrail_delete_run',
      'testrail_delete_run_from_plan_entry',
      'testrail_delete_section',
      'testrail_delete_shared_step',
      'testrail_delete_suite',
      'testrail_delete_variable',
      'testrail_edit_result',
      'testrail_get_attachment',
      'testrail_get_attachments_for_case',
      'testrail_get_attachments_for_plan',
      'testrail_get_attachments_for_plan_entry',
      'testrail_get_attachments_for_run',
      'testrail_get_attachments_for_test',
      'testrail_get_bdd',
      'testrail_get_bdds',
      'testrail_get_case',
      'testrail_get_case_fields',
      'testrail_get_case_statuses',
      'testrail_get_case_titles',
      'testrail_get_case_types',
      'testrail_get_cases',
      'testrail_get_configs',
      'testrail_get_cross_project_reports',
      'testrail_get_current_user',
      'testrail_get_dataset',
      'testrail_get_datasets',
      'testrail_get_dynamic_filter_fields',
      'testrail_get_group',
      'testrail_get_groups',
      'testrail_get_history_for_case',
      'testrail_get_label',
      'testrail_get_labels',
      'testrail_get_milestone',
      'testrail_get_milestones',
      'testrail_get_plan',
      'testrail_get_plans',
      'testrail_get_priorities',
      'testrail_get_project',
      'testrail_get_projects',
      'testrail_get_reports',
      'testrail_get_result_fields',
      'testrail_get_results',
      'testrail_get_results_for_case',
      'testrail_get_results_for_run',
      'testrail_get_roles',
      'testrail_get_run',
      'testrail_get_runs',
      'testrail_get_section',
      'testrail_get_sections',
      'testrail_get_shared_step',
      'testrail_get_shared_step_history',
      'testrail_get_shared_steps',
      'testrail_get_statuses',
      'testrail_get_suite',
      'testrail_get_suites',
      'testrail_get_templates',
      'testrail_get_test',
      'testrail_get_tests',
      'testrail_get_user',
      'testrail_get_user_by_email',
      'testrail_get_users',
      'testrail_get_variables',
      'testrail_get_version',
      'testrail_move_cases_to_section',
      'testrail_move_section',
      'testrail_run_cross_project_report',
      'testrail_run_report',
      'testrail_update_bdd',
      'testrail_update_case',
      'testrail_update_cases',
      'testrail_update_config',
      'testrail_update_config_group',
      'testrail_update_dataset',
      'testrail_update_group',
      'testrail_update_label',
      'testrail_update_milestone',
      'testrail_update_plan',
      'testrail_update_plan_entry',
      'testrail_update_project',
      'testrail_update_run',
      'testrail_update_run_in_plan_entry',
      'testrail_update_section',
      'testrail_update_shared_step',
      'testrail_update_suite',
      'testrail_update_test',
      'testrail_update_tests',
      'testrail_update_user',
      'testrail_update_variable',
    ]);
    expect(report.partialEndpoints).toEqual([]);
    expect(report.pendingEndpoints).toEqual([]);
    expect([...report.reviewedEndpoints, ...report.pendingEndpoints].sort())
      .toEqual(inventory.map(({ tool }) => tool).sort());
  });

  // The guide's coverage table is prose a reader trusts; nothing else holds it to the files.
  it('keeps the guide\'s coverage table in step with the authored manifests', async () => {
    const guide = await readFile(new URL('../docs/parameter-manifest.md', import.meta.url), 'utf8');
    const rows = [...guide.matchAll(/^\| `([a-z_]+)` \| (\d+) \| (\d+) \| Complete input manifest \|$/gmu)]
      .map((match) => ({ name: match[1] ?? '', parameters: Number(match[2]), cases: Number(match[3]) }));
    const shape = z.object({ parameters: z.array(z.unknown()), cases: z.array(z.unknown()) });
    const authored = await Promise.all(rows.map(async ({ name }) => {
      const raw = shape.parse(JSON.parse(await readFile(new URL(`./fixtures/parameters/${name}.json`, import.meta.url), 'utf8')));
      return { name, parameters: raw.parameters.length, cases: raw.cases.length };
    }));
    expect(rows).toEqual(authored);
    expect(rows.map(({ name }) => `testrail_${name}`).sort()).toEqual(inventory.map(({ tool }) => tool).sort());
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

  it('holds each parameter\'s declared driver location to the case\'s literal arguments', () => {
    const find = (tool: string) => {
      const manifest = manifests.find(({ endpoint }) => endpoint.tool === `testrail_${tool}`);
      if (!manifest) throw new Error(`Required ${tool} manifest is missing`);
      return structuredClone(manifest);
    };
    const relocate = (tool: string, id: string, driver: { argument: number; path: string[] }) => {
      const manifest = find(tool);
      manifest.parameters = manifest.parameters.map((parameter) => parameter.id === id ? { ...parameter, driver } : parameter);
      return auditParameterManifests([manifest]);
    };
    expect(auditParameterManifests([find('get_cases'), find('add_section')])).toEqual([]);
    // A positional argument moved.
    expect(relocate('get_project', 'project_id', { argument: 1, path: [] })).toEqual([
      'testrail_get_project: Case representative-id passes project_id to argument 1 as [], not [7]',
      'testrail_get_project: Case largest-safe-id passes project_id to argument 1 as [], not [9007199254740991]',
    ]);
    // Two filters renamed onto each other's options. Distinct values are what expose it.
    expect(relocate('get_cases', 'query.type_id', { argument: 1, path: ['templateId'] }))
      .toContain('testrail_get_cases: Case list-filters passes query.type_id to argument 1 at templateId as [[1,2]], not [[2,3]]');
    // A body field the case supplies without claiming to cover it is checked all the same.
    const sections = find('add_section');
    const covering = sections.cases.filter(({ covers }) => covers.some(({ parameter }) => parameter === 'body.description'));
    sections.cases = sections.cases.map((fixture) => fixture.id !== 'every-field' || fixture.expect.kind !== 'accepted' ? fixture : {
      ...fixture,
      covers: fixture.covers.filter(({ parameter }) => parameter !== 'body.description'),
      expect: { ...fixture.expect, driver: { ...fixture.expect.driver, arguments: [7, {
        name: 'Nested section', suite_id: 3, parent_id: 10, description: 'Created under section 3.',
      }] } },
    });
    expect(covering.map(({ id }) => id)).toContain('every-field');
    expect(auditParameterManifests([sections])).toContain(
      'testrail_add_section: Case every-field passes body.description to argument 1 at description as ["Created under section 3."], not ["Created under section 10."]',
    );
  });

  it('reads an extension point and every member of a fan-out when it compares locations', () => {
    const find = (tool: string) => {
      const manifest = manifests.find(({ endpoint }) => endpoint.tool === `testrail_${tool}`);
      if (!manifest) throw new Error(`Required ${tool} manifest is missing`);
      return structuredClone(manifest);
    };
    // custom_* gathers the matching keys on both sides, so a moved extension point is seen.
    const cases = find('add_case');
    const custom = cases.parameters.find(({ id }) => id === 'body.custom_*');
    expect(custom?.driver).toEqual({ argument: 1, path: ['custom_*'] });
    cases.parameters = cases.parameters.map((parameter) => parameter === custom ? { ...parameter, driver: { argument: 1, path: ['extra_*'] } } : parameter);
    expect(auditParameterManifests([cases]).some((error) => error.startsWith('testrail_add_case: Case full-body passes body.custom_* to argument 1 at extra_* as [], not [{'))).toBe(true);
    // A second member whose argument differs is caught, not only the first.
    const results = find('add_results');
    results.cases = results.cases.map((fixture) => {
      if (fixture.id !== 'two-entries' || fixture.expect.kind !== 'accepted') return fixture;
      const changed = structuredClone(fixture);
      if (changed.expect.kind !== 'accepted') return changed;
      ((changed.expect.driver.arguments[1] as { results: { status_id: number }[] }).results[1] ?? { status_id: 0 }).status_id = 4;
      return changed;
    });
    expect(auditParameterManifests([results])).toContain(
      'testrail_add_results: Case two-entries passes body[].status_id to argument 1 at results.*.status_id as [5,4], not [5,1]',
    );
  });

  it('tells every pair of parameter locations apart by some accepted case', () => {
    // Two parameters that carry equal values in every case could have their locations
    // swapped, in the manifest and the registration alike, and every literal argument
    // list would still agree. Each pair needs a case where they differ or one is absent.
    const undetected: string[] = [];
    for (const manifest of manifests) {
      const located = manifest.parameters.filter(({ driver }) => driver !== null);
      for (const [index, left] of located.entries()) {
        for (const right of located.slice(index + 1)) {
          if (JSON.stringify(left.driver) === JSON.stringify(right.driver)) continue;
          const swapped = { ...manifest, parameters: manifest.parameters.map((parameter) => parameter === left
            ? { ...parameter, driver: right.driver } : parameter === right ? { ...parameter, driver: left.driver } : parameter) };
          if (auditParameterManifests([swapped]).length === 0) undetected.push(`${manifest.endpoint.tool}: ${left.id} <-> ${right.id}`);
        }
      }
    }
    expect(undetected).toEqual([]);
  });

  it('requires a case covering a shared domain requirement to use a value the domain proved for it', () => {
    const project = manifests.find(({ endpoint }) => endpoint.tool === 'testrail_get_project');
    const cases = manifests.find(({ endpoint }) => endpoint.tool === 'testrail_get_cases');
    if (!project || !cases) throw new Error('Required get_project and get_cases manifests are missing');
    const retarget = (manifest: typeof project, id: string, input: ParameterFixture['input']) => ({
      ...manifest, cases: manifest.cases.map((fixture) => fixture.id === id ? { ...fixture, input } : fixture),
    });
    // The issue's example: the upper bound claimed with an ordinary identifier.
    expect(auditParameterManifests([retarget(project, 'largest-safe-id', { project_id: 7 })])).toContain(
      'testrail_get_project: Case largest-safe-id covers project_id/upper-bound with [7], not a value positive_id proves for it: [9007199254740991]',
    );
    // The representative pair admits any value in the domain, but nothing outside it.
    expect(auditParameterManifests([retarget(project, 'representative-id', { project_id: 42 })])
      .filter((error) => error.includes('covers project_id/'))).toEqual([]);
    expect(auditParameterManifests([retarget(project, 'representative-id', { project_id: 1.5 })])).toContain(
      'testrail_get_project: Case representative-id covers project_id/mapping with [1.5], outside the positive_id domain',
    );
    // Every member of a fan-out must be in the domain, not only the first.
    const results = manifests.find(({ endpoint }) => endpoint.tool === 'testrail_add_results');
    const twoEntries = results?.cases.find(({ id }) => id === 'two-entries');
    if (!results || twoEntries === undefined) throw new Error('Required add_results two-entries case is missing');
    const fractional = structuredClone(twoEntries.input);
    ((fractional.body as { results: { status_id: number }[] }).results[1] ?? { status_id: 0 }).status_id = 1.5;
    expect(auditParameterManifests([retarget(results, 'two-entries', fractional)])).toContain(
      'testrail_add_results: Case two-entries covers body[].status_id/mapping with [5,1.5], outside the positive_id domain',
    );
    // A case that covers the pair must supply the value it claims.
    expect(auditParameterManifests([retarget(project, 'representative-id', {})])).toContain(
      'testrail_get_project: Case representative-id covers project_id/mapping with [], outside the positive_id domain',
    );
    expect(auditParameterManifests([retarget(project, 'largest-safe-id', {})])).toContain(
      'testrail_get_project: Case largest-safe-id covers project_id/upper-bound with [], not a value positive_id proves for it: [9007199254740991]',
    );
    // An exact requirement judges every member too: one proven bound does not carry an unproven one.
    const bounded = structuredClone(twoEntries);
    ((bounded.input.body as { results: { status_id: number }[] }).results[0] ?? { status_id: 0 }).status_id = 9007199254740991;
    bounded.covers = [...bounded.covers, { parameter: 'body[].status_id', requirements: ['upper-bound'] }];
    expect(auditParameterManifests([{ ...results, cases: results.cases.map((fixture) => fixture.id === 'two-entries' ? bounded : fixture) }])).toContain(
      'testrail_add_results: Case two-entries covers body[].status_id/upper-bound with [9007199254740991,1], not a value positive_id proves for it: [9007199254740991]',
    );
    // A list is exact too: only lists the probe drove through the driver count.
    const listFilters = cases.cases.find(({ id }) => id === 'list-filters');
    if (listFilters === undefined) throw new Error('Required list-filters case is missing');
    expect(auditParameterManifests([retarget(cases, 'list-filters', { ...listFilters.input, query: {
      ...(listFilters.input.query as object), type_id: [5, 6],
    } })])).toContain(
      'testrail_get_cases: Case list-filters covers query.type_id/list with [[5,6]], not a value id_filter proves for it: [[3,4],[1,2],[2,3],[7,8],[9,10],[10,11],[11,12]]',
    );
  });

  it('detects a removed union-branch fixture instead of merely counting endpoints', () => {
    const manifest = example();
    manifest.cases = manifest.cases.filter(({ id }) => id !== 'uuid-id');
    expect(auditParameterManifests([manifest])).toContain('testrail_get_attachment: Uncovered requirement: attachment_id/uuid');
  });

  it('refuses a rejected case that claims the rejections of more than one parameter', () => {
    const plans = manifests.find(({ endpoint }) => endpoint.tool === 'testrail_delete_plan_entry');
    if (!plans) throw new Error('Required delete_plan_entry manifest is missing');
    // Both values are outside their domains, so only the count rule can object.
    const doubled = { ...plans, cases: [...plans.cases, {
      id: 'both-wrong', input: { plan_id: 0, entry_id: '../../admin' },
      covers: [{ parameter: 'plan_id', requirements: ['invalid'] }, { parameter: 'entry_id', requirements: ['path-safety'] }],
      expect: { kind: 'rejected' as const, code: 'INVALID_ARGUMENT' as const },
    }] };
    expect(auditParameterManifests([doubled])).toEqual([
      'testrail_delete_plan_entry: Case both-wrong attributes one rejection to 2 parameters: plan_id, entry_id',
    ]);
  });

  it('refuses a rejection attributed to a parameter whose own value is not what is wrong', () => {
    const plans = manifests.find(({ endpoint }) => endpoint.tool === 'testrail_delete_plan_entry');
    if (!plans) throw new Error('Required delete_plan_entry manifest is missing');
    const uuid = '3933d74b-4282-44de-82ae-a6412808369d';
    const rejected = { kind: 'rejected' as const, code: 'INVALID_ARGUMENT' as const };
    const audit = (id: string, input: ParameterFixture['input'], covers: ParameterFixture['covers']) =>
      auditParameterManifests([{ ...plans, cases: [...plans.cases, { id, input, covers, expect: rejected }] }])
        .map((error) => error.replace('testrail_delete_plan_entry: ', ''));
    const entry = (...requirements: string[]) => [{ parameter: 'entry_id', requirements }];
    const unknownKey = { parameter: '$input', requirements: ['unknown-top-level'] };

    // The one cause, named: a value the library proved refused for that requirement.
    expect(audit('attributable', { plan_id: 10, entry_id: '../../admin' }, entry('path-safety'))).toEqual([]);
    // The named parameter is not what is wrong.
    expect(audit('other-field', { plan_id: 0, entry_id: uuid }, entry('terminal'))).toEqual([
      'Case other-field gives entry_id a value its domain accepts, so its refusal is not evidence for entry_id/terminal',
      'Case other-field also gives plan_id a value outside its domain, so its refusal is not evidence for entry_id',
    ]);
    // It is wrong, but so is another field, which could have caused the refusal alone.
    expect(audit('two-faults', { plan_id: 0, entry_id: '../../admin' }, entry('path-safety'))).toEqual([
      'Case two-faults also gives plan_id a value outside its domain, so its refusal is not evidence for entry_id',
    ]);
    // An unknown key is a second cause, whether or not the case admits to it.
    expect(audit('unknown-key', { plan_id: 10, entry_id: '../../admin', extra: true }, [unknownKey, ...entry('path-safety')])).toEqual([
      'Case unknown-key shares its refusal between $input and entry_id',
      'Case unknown-key also carries the unknown key extra, so its refusal is not evidence for entry_id',
    ]);
    expect(audit('silent-key', { plan_id: 10, entry_id: '../../admin', extra: true }, entry('path-safety'))).toEqual([
      'Case silent-key also carries the unknown key extra, so its refusal is not evidence for entry_id',
    ]);
    // An endpoint-wide claim is refused when a parameter is wrong as well.
    expect(audit('wide', { plan_id: 0, entry_id: uuid, extra: true }, [unknownKey])).toEqual([
      'Case wide also gives plan_id a value outside its domain, so its refusal is not evidence for $input',
    ]);
    // A required parameter left out is a second cause too, whatever the case names.
    expect(audit('no-plan', { entry_id: '../../admin' }, entry('path-safety'))).toEqual([
      'Case no-plan also leaves out the required plan_id, so its refusal is not evidence for entry_id',
    ]);
    expect(audit('bare-key', { extra: 1 }, [unknownKey])).toEqual([
      'Case bare-key also leaves out the required plan_id, so its refusal is not evidence for $input',
      'Case bare-key also leaves out the required entry_id, so its refusal is not evidence for $input',
    ]);
    expect(audit('empty', {}, entry('required'))).toEqual([
      'Case empty also leaves out the required plan_id, so its refusal is not evidence for entry_id',
    ]);
    // One out-of-domain value does not cover every rejection: each needs its own proven value.
    expect(audit('one-for-all', { plan_id: 10, entry_id: '../../admin' }, entry('invalid', 'path-safety', 'terminal'))).toEqual([
      'Case one-for-all rejects entry_id with ["../../admin"], not a value entry_id proves refused for entry_id/invalid',
      'Case one-for-all rejects entry_id with ["../../admin"], not a value entry_id proves refused for entry_id/terminal',
    ]);
    // Presence: the parameter must be absent, and the value rule needs one to judge.
    expect(audit('present', { plan_id: 10, entry_id: uuid }, entry('required'))).toEqual([
      'Case present does not leave out only entry_id, so its refusal is not evidence for entry_id/required',
    ]);
    expect(audit('absent', { plan_id: 10 }, entry('invalid'))).toEqual([
      'Case absent carries no entry_id, so its refusal is not evidence for entry_id/invalid',
    ]);
  });

  it('attributes a missing nested field only when its parent is present and well-typed', () => {
    const users = manifests.find(({ endpoint }) => endpoint.tool === 'testrail_add_user');
    if (!users) throw new Error('Required add_user manifest is missing');
    const missing = users.cases.find(({ id }) => id === 'missing-name');
    expect(missing?.covers).toEqual([{ parameter: 'body.name', requirements: ['required'] }]);
    expect(auditParameterManifests([users])).toEqual([]);
    for (const input of [{}, { body: 7 }, { body: [] }, { body: [{ email: 'ada@example.com' }] }]) {
      expect(auditParameterManifests([{ ...users, cases: users.cases.map((fixture) => fixture === missing ? { ...fixture, input } : fixture) }]))
        .toContain('testrail_add_user: Case missing-name does not leave out only body.name, so its refusal is not evidence for body.name/required');
    }
  });

  it('judges a wildcard parameter by its members and exempts an extension point', () => {
    const results = manifests.find(({ endpoint }) => endpoint.tool === 'testrail_add_results');
    const update = manifests.find(({ endpoint }) => endpoint.tool === 'testrail_update_case');
    if (!results || !update) throw new Error('Required add_results and update_case manifests are missing');
    const missing = results.cases.find(({ id }) => id === 'body[].test_id:missing');
    if (missing === undefined) throw new Error('Required derived omission is missing');
    // The derivation removes the field from the first member only, and that is enough.
    expect(auditParameterManifests([results])).toEqual([]);
    const refilled = structuredClone(missing);
    const [first] = (refilled.input.body as { results: { test_id?: number }[] }).results;
    if (first !== undefined) first.test_id = 101;
    expect(auditParameterManifests([{ ...results, cases: results.cases.map((fixture) => fixture === missing ? refilled : fixture) }]))
      .toEqual(['testrail_add_results: Case body[].test_id:missing does not leave out only body[].test_id, so its refusal is not evidence for body[].test_id/required']);
    // With no array to hold members, the fault is the array's, not a member's.
    for (const body of [{}, { results: {} }]) {
      expect(auditParameterManifests([{ ...results, cases: results.cases.map((fixture) => fixture === missing ? { ...fixture, input: { run_id: 1, body } } : fixture) }]))
        .toContain('testrail_add_results: Case body[].test_id:missing does not leave out only body[].test_id, so its refusal is not evidence for body[].test_id/required');
    }
    // An unknown body key covers the custom_* rule by being outside the prefix, not by a value.
    expect(update.cases.find(({ id }) => id === 'unknown-body')?.covers)
      .toContainEqual({ parameter: 'body.custom_*', requirements: ['invalid'] });
    expect(auditParameterManifests([update])).toEqual([]);
  });

  /*
   * The hole this guard closes, rebuilt end to end. The entry identifier is registered as
   * any string, so a traversal sequence or a trailing newline would reach the request
   * path, and the derived fixtures that isolate its domain are replaced by one case that
   * claims them. The registration audit is blind to every such replacement: the fixtures
   * it is given all agree with the weakened schema, because the one rejection it sees is
   * caused by something other than the entry identifier. Removing the fixtures without a
   * replacement is already reported as uncovered; the replacements are what this catches.
   */
  it('detects a weakened parameter constraint whose isolating fixtures were replaced', () => {
    const plans = manifests.find(({ endpoint }) => endpoint.tool === 'testrail_delete_plan_entry');
    if (!plans) throw new Error('Required delete_plan_entry manifest is missing');
    const weakenedInput = strictObject({ plan_id: positiveIdSchema, entry_id: z.string() });
    const weakened = defineOperation({
      ...deletePlanEntry,
      inputSchema: weakenedInput,
      pagination: {
        kind: 'none',
        single: driverCall(weakenedInput, 'plans.deletePlanEntry', (method, input) => method(input.plan_id, input.entry_id)),
      },
    });
    const isolating = plans.cases.filter(({ id }) => id.startsWith('entry_id:') && id !== 'entry_id:missing');
    expect(isolating.map(({ id }) => id)).toEqual([
      'entry_id:malformed', 'entry_id:numeric', 'entry_id:empty', 'entry_id:traversal',
      'entry_id:leading-space', 'entry_id:trailing-space', 'entry_id:trailing-line-feed', 'entry_id:trailing-carriage-return',
    ]);
    // With the isolating fixtures present the weakening is visible, which is what they are for.
    expect(auditParameterManifests([plans])).toEqual([]);
    expect(auditRegisteredParameters(createRegistry(weakened), [plans])).toEqual(
      isolating.flatMap(({ id }) => [
        `testrail_delete_plan_entry: runtime schema disagrees with fixture ${id}`,
        `testrail_delete_plan_entry: JSON Schema disagrees with fixture ${id}`,
      ]),
    );
    const kept = plans.cases.filter((fixture) => !isolating.includes(fixture));
    expect(auditParameterManifests([{ ...plans, cases: kept }])).toEqual(['invalid', 'path-safety', 'terminal']
      .map((id) => `testrail_delete_plan_entry: Uncovered requirement: entry_id/${id}`));

    const uuid = '3933d74b-4282-44de-82ae-a6412808369d';
    const entryRejections = { parameter: 'entry_id', requirements: ['invalid', 'path-safety', 'terminal'] };
    // A carrier whose entry value is wrong is still refused when another field is wrong too.
    const twoFaults = { ...plans, cases: [...kept, {
      id: 'smuggled', input: { plan_id: 0, entry_id: '../../admin' }, covers: [{ parameter: 'entry_id', requirements: ['path-safety'] }],
      expect: { kind: 'rejected' as const, code: 'INVALID_ARGUMENT' as const },
    }] };
    expect(auditRegisteredParameters(createRegistry(weakened), [twoFaults])).toEqual([]);
    expect(auditParameterManifests([twoFaults])).toContain(
      'testrail_delete_plan_entry: Case smuggled also gives plan_id a value outside its domain, so its refusal is not evidence for entry_id',
    );
    // So is a carrier that simply leaves the other identifier out.
    const withoutPlan = { ...plans, cases: [...kept, ...isolating.map(({ input, ...fixture }) => ({
      ...fixture, input: Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'plan_id')),
    }))] };
    expect(auditRegisteredParameters(createRegistry(weakened), [withoutPlan])).toEqual([]);
    expect(auditParameterManifests([withoutPlan])).toEqual(isolating.map(({ id }) =>
      `testrail_delete_plan_entry: Case ${id} also leaves out the required plan_id, so its refusal is not evidence for entry_id`));
    const accepts = (id: string) => `Case smuggled gives entry_id a value its domain accepts, so its refusal is not evidence for entry_id/${id}`;
    const carriers = [
      {
        input: { plan_id: 0, entry_id: uuid },
        covers: [{ parameter: 'plan_id', requirements: ['invalid'] }, entryRejections],
        errors: ['Case smuggled attributes one rejection to 2 parameters: plan_id, entry_id'],
      },
      {
        input: { plan_id: 0, entry_id: uuid },
        covers: [entryRejections],
        errors: [...entryRejections.requirements.map(accepts),
          'Case smuggled also gives plan_id a value outside its domain, so its refusal is not evidence for entry_id'],
      },
      {
        input: { plan_id: 10, entry_id: uuid, extra: true },
        covers: [{ parameter: '$input', requirements: ['unknown-top-level'] }, entryRejections],
        errors: ['Case smuggled shares its refusal between $input and entry_id', ...entryRejections.requirements.map(accepts),
          'Case smuggled also carries the unknown key extra, so its refusal is not evidence for entry_id'],
      },
    ];
    for (const { errors, ...carrier } of carriers) {
      const hole = { ...plans, cases: [...kept, { id: 'smuggled', ...carrier, expect: { kind: 'rejected' as const, code: 'INVALID_ARGUMENT' as const } }] };
      expect(auditRegisteredParameters(createRegistry(weakened), [hole])).toEqual([]);
      expect(auditParameterManifests([hole])).toEqual(errors.map((error) => `testrail_delete_plan_entry: ${error}`));
    }
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

  it('accepts enforcement labels only on a shared domain reference', () => {
    const manifest = example();
    const [parameter] = manifest.parameters;
    if (parameter === undefined) throw new Error('Required attachment parameter is missing');
    manifest.parameters = [{ ...parameter, rejected_by: 'adapter' }];
    expect(ParameterManifestSchema.safeParse(manifest).success).toBe(false);
    const plans = manifests.find(({ endpoint }) => endpoint.tool === 'testrail_delete_plan_entry');
    if (!plans) throw new Error('Required delete_plan_entry manifest is missing');
    const raw = JSON.parse(JSON.stringify({ ...plans, cases: plans.cases.filter(({ id }) => !id.includes(':')) })) as typeof plans;
    // Resolution inlined each referenced domain; the authored form carries only the reference.
    raw.parameters = raw.parameters.map((parameter) => ({
      ...Object.fromEntries(Object.entries(parameter).filter(([key]) => key !== 'domain' && key !== 'requirements')) as typeof parameter,
      rejected_by: { malformed: 'driver' },
    }));
    expect(ParameterManifestSchema.safeParse(raw).success).toBe(true);
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
/** The milestone filters under the driver's option names, as a fixture writes them. */
const milestoneFilterOptions = z.strictObject({
  isCompleted: z.boolean().optional(), isStarted: z.boolean().optional(),
});
/** The plan filters under the driver's option names, as a fixture writes them. */
const planFilterOptions = z.strictObject({
  createdAfter: z.number().optional(), createdBefore: z.number().optional(), createdBy: z.array(z.number()).optional(),
  isCompleted: z.boolean().optional(), milestoneId: z.array(z.number()).optional(), refs: z.string().optional(),
});
/** The result filters under the driver's option names, as a fixture writes them. */
const resultFilterOptions = z.strictObject({
  statusId: z.array(z.number()).optional(), defectsFilter: z.string().optional(),
});
/** The run-wide result list adds the creation filters. */
const runResultFilterOptions = resultFilterOptions.extend({
  createdAfter: z.number().optional(), createdBefore: z.number().optional(), createdBy: z.array(z.number()).optional(),
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
    case 'attachments.getAttachmentsForCasePage': {
      const [caseId, options] = z.tuple([z.number(), z.strictObject({ limit: z.number(), offset: z.number() })])
        .parse(expected.driver.arguments);
      return client.attachments.getAttachmentsForCasePage(caseId, options);
    }
    case 'attachments.getAllAttachmentsForCase': {
      const [caseId, options] = z.tuple([z.number(), z.strictObject(aggregateOptions)]).parse(expected.driver.arguments);
      return client.attachments.getAllAttachmentsForCase(caseId, present(options));
    }
    case 'attachments.getAttachmentsForPlanPage': {
      const [planId, options] = z.tuple([z.number(), z.strictObject({ limit: z.number(), offset: z.number() })])
        .parse(expected.driver.arguments);
      return client.attachments.getAttachmentsForPlanPage(planId, options);
    }
    case 'attachments.getAllAttachmentsForPlan': {
      const [planId, options] = z.tuple([z.number(), z.strictObject(aggregateOptions)]).parse(expected.driver.arguments);
      return client.attachments.getAllAttachmentsForPlan(planId, present(options));
    }
    case 'attachments.getAttachmentsForRunPage': {
      const [runId, options] = z.tuple([z.number(), z.strictObject({ limit: z.number(), offset: z.number() })])
        .parse(expected.driver.arguments);
      return client.attachments.getAttachmentsForRunPage(runId, options);
    }
    case 'attachments.getAllAttachmentsForRun': {
      const [runId, options] = z.tuple([z.number(), z.strictObject(aggregateOptions)]).parse(expected.driver.arguments);
      return client.attachments.getAllAttachmentsForRun(runId, present(options));
    }
    case 'attachments.getAttachmentsForTest': {
      const [testId] = z.tuple([z.number()]).parse(expected.driver.arguments);
      return client.attachments.getAttachmentsForTest(testId);
    }
    case 'attachments.addAttachmentToCase': {
      const [caseId, file, filename] = z.tuple([z.number(), uploadFile, z.string()]).parse(expected.driver.arguments);
      return client.attachments.addAttachmentToCase(caseId, present(file), filename);
    }
    case 'attachments.addAttachmentToPlan': {
      const [planId, file, filename] = z.tuple([z.number(), uploadFile, z.string()]).parse(expected.driver.arguments);
      return client.attachments.addAttachmentToPlan(planId, present(file), filename);
    }
    case 'attachments.addAttachmentToPlanEntry': {
      const [planId, entryId, file, filename] = z.tuple([z.number(), z.string(), uploadFile, z.string()])
        .parse(expected.driver.arguments);
      return client.attachments.addAttachmentToPlanEntry(planId, entryId, present(file), filename);
    }
    case 'attachments.addAttachmentToResult': {
      const [resultId, file, filename] = z.tuple([z.number(), uploadFile, z.string()]).parse(expected.driver.arguments);
      return client.attachments.addAttachmentToResult(resultId, present(file), filename);
    }
    case 'attachments.addAttachmentToRun': {
      const [runId, file, filename] = z.tuple([z.number(), uploadFile, z.string()]).parse(expected.driver.arguments);
      return client.attachments.addAttachmentToRun(runId, present(file), filename);
    }
    case 'attachments.deleteAttachment': {
      const [id] = z.tuple([z.union([z.number(), z.string()])]).parse(expected.driver.arguments);
      return client.attachments.deleteAttachment(id);
    }
    case 'results.getResultsPage': {
      const [testId, options] = z.tuple([z.number(), resultFilterOptions.extend({ limit: z.number(), offset: z.number() })])
        .parse(expected.driver.arguments);
      return client.results.getResultsPage(testId, present(options));
    }
    case 'results.getAllResults': {
      const [testId, options] = z.tuple([z.number(), resultFilterOptions.extend(aggregateOptions)]).parse(expected.driver.arguments);
      return client.results.getAllResults(testId, present(options));
    }
    case 'results.getResultsForCasePage': {
      const [runId, caseId, options] = z.tuple([z.number(), z.number(), resultFilterOptions.extend({ limit: z.number(), offset: z.number() })])
        .parse(expected.driver.arguments);
      return client.results.getResultsForCasePage(runId, caseId, present(options));
    }
    case 'results.getAllResultsForCase': {
      const [runId, caseId, options] = z.tuple([z.number(), z.number(), resultFilterOptions.extend(aggregateOptions)])
        .parse(expected.driver.arguments);
      return client.results.getAllResultsForCase(runId, caseId, present(options));
    }
    case 'results.getResultsForRunPage': {
      const [runId, options] = z.tuple([z.number(), runResultFilterOptions.extend({ limit: z.number(), offset: z.number() })])
        .parse(expected.driver.arguments);
      return client.results.getResultsForRunPage(runId, present(options));
    }
    case 'results.getAllResultsForRun': {
      const [runId, options] = z.tuple([z.number(), runResultFilterOptions.extend(aggregateOptions)]).parse(expected.driver.arguments);
      return client.results.getAllResultsForRun(runId, present(options));
    }
    case 'results.addResult': {
      const [testId, payload] = z.tuple([z.number(), AddResultPayloadSchema]).parse(expected.driver.arguments);
      return client.results.addResult(testId, payload);
    }
    case 'results.addResultForCase': {
      const [runId, caseId, payload] = z.tuple([z.number(), z.number(), AddResultPayloadSchema]).parse(expected.driver.arguments);
      return client.results.addResultForCase(runId, caseId, payload);
    }
    case 'results.addResults': {
      const [runId, payload] = z.tuple([z.number(), AddResultsPayloadSchema]).parse(expected.driver.arguments);
      return client.results.addResults(runId, payload);
    }
    case 'results.addResultsForCases': {
      const [runId, payload] = z.tuple([z.number(), AddResultsForCasesPayloadSchema]).parse(expected.driver.arguments);
      return client.results.addResultsForCases(runId, payload);
    }
    case 'results.editResult': {
      const [resultId, payload] = z.tuple([z.number(), EditResultPayloadSchema]).parse(expected.driver.arguments);
      return client.results.editResult(resultId, payload);
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
    case 'configurations.getConfigurations': {
      const [projectId] = z.tuple([z.number()]).parse(expected.driver.arguments);
      return client.configurations.getConfigurations(projectId);
    }
    case 'configurations.addConfigurationGroup': {
      const [projectId, payload] = z.tuple([z.number(), AddConfigurationGroupPayloadSchema]).parse(expected.driver.arguments);
      return client.configurations.addConfigurationGroup(projectId, payload);
    }
    case 'configurations.updateConfigurationGroup': {
      const [groupId, payload] = z.tuple([z.number(), UpdateConfigurationGroupPayloadSchema]).parse(expected.driver.arguments);
      return client.configurations.updateConfigurationGroup(groupId, payload);
    }
    case 'configurations.deleteConfigurationGroup': {
      const [groupId] = z.tuple([z.number()]).parse(expected.driver.arguments);
      return client.configurations.deleteConfigurationGroup(groupId);
    }
    case 'configurations.addConfiguration': {
      const [groupId, payload] = z.tuple([z.number(), AddConfigurationPayloadSchema]).parse(expected.driver.arguments);
      return client.configurations.addConfiguration(groupId, payload);
    }
    case 'configurations.updateConfiguration': {
      const [configId, payload] = z.tuple([z.number(), UpdateConfigurationPayloadSchema]).parse(expected.driver.arguments);
      return client.configurations.updateConfiguration(configId, payload);
    }
    case 'configurations.deleteConfiguration': {
      const [configId] = z.tuple([z.number()]).parse(expected.driver.arguments);
      return client.configurations.deleteConfiguration(configId);
    }
    case 'plans.getPlan': {
      const [planId] = z.tuple([z.number()]).parse(expected.driver.arguments);
      return client.plans.getPlan(planId);
    }
    case 'plans.getPlansPage': {
      const [projectId, options] = z.tuple([z.number(), planFilterOptions.extend({ limit: z.number(), offset: z.number() })])
        .parse(expected.driver.arguments);
      return client.plans.getPlansPage(projectId, present(options));
    }
    case 'plans.getAllPlans': {
      const [projectId, options] = z.tuple([z.number(), planFilterOptions.extend(aggregateOptions)]).parse(expected.driver.arguments);
      return client.plans.getAllPlans(projectId, present(options));
    }
    case 'plans.addPlan': {
      const [projectId, payload] = z.tuple([z.number(), AddPlanPayloadSchema]).parse(expected.driver.arguments);
      return client.plans.addPlan(projectId, payload);
    }
    case 'plans.updatePlan': {
      const [planId, payload] = z.tuple([z.number(), UpdatePlanPayloadSchema]).parse(expected.driver.arguments);
      return client.plans.updatePlan(planId, payload);
    }
    case 'plans.closePlan': {
      const [planId] = z.tuple([z.number()]).parse(expected.driver.arguments);
      return client.plans.closePlan(planId);
    }
    case 'plans.deletePlan': {
      const [planId] = z.tuple([z.number()]).parse(expected.driver.arguments);
      return client.plans.deletePlan(planId);
    }
    case 'plans.addPlanEntry': {
      const [planId, payload] = z.tuple([z.number(), AddPlanEntryPayloadSchema]).parse(expected.driver.arguments);
      return client.plans.addPlanEntry(planId, payload);
    }
    case 'plans.updatePlanEntry': {
      const [planId, entryId, payload] = z.tuple([z.number(), z.string(), UpdatePlanEntryPayloadSchema])
        .parse(expected.driver.arguments);
      return client.plans.updatePlanEntry(planId, entryId, payload);
    }
    case 'plans.deletePlanEntry': {
      const [planId, entryId] = z.tuple([z.number(), z.string()]).parse(expected.driver.arguments);
      return client.plans.deletePlanEntry(planId, entryId);
    }
    case 'plans.addRunToPlanEntry': {
      const [planId, entryId, payload] = z.tuple([z.number(), z.string(), AddRunToPlanEntryPayloadSchema])
        .parse(expected.driver.arguments);
      return client.plans.addRunToPlanEntry(planId, entryId, payload);
    }
    case 'plans.updateRunInPlanEntry': {
      const [runId, payload] = z.tuple([z.number(), UpdateRunInPlanEntryPayloadSchema]).parse(expected.driver.arguments);
      return client.plans.updateRunInPlanEntry(runId, payload);
    }
    case 'plans.deleteRunFromPlanEntry': {
      const [runId] = z.tuple([z.number()]).parse(expected.driver.arguments);
      return client.plans.deleteRunFromPlanEntry(runId);
    }
    case 'labels.getLabel': {
      const [labelId] = z.tuple([z.number()]).parse(expected.driver.arguments);
      return client.labels.getLabel(labelId);
    }
    case 'labels.getLabelsPage': {
      const [projectId, options] = z.tuple([z.number(), z.strictObject({ limit: z.number(), offset: z.number() })])
        .parse(expected.driver.arguments);
      return client.labels.getLabelsPage(projectId, options);
    }
    case 'labels.getAllLabels': {
      const [projectId, options] = z.tuple([z.number(), z.strictObject(aggregateOptions)]).parse(expected.driver.arguments);
      return client.labels.getAllLabels(projectId, present(options));
    }
    case 'labels.addLabel': {
      const [projectId, payload] = z.tuple([z.number(), AddLabelPayloadSchema]).parse(expected.driver.arguments);
      return client.labels.addLabel(projectId, payload);
    }
    case 'labels.updateLabel': {
      const [labelId, payload] = z.tuple([z.number(), UpdateLabelPayloadSchema]).parse(expected.driver.arguments);
      return client.labels.updateLabel(labelId, payload);
    }
    case 'labels.deleteLabel': {
      const [labelId] = z.tuple([z.number()]).parse(expected.driver.arguments);
      return client.labels.deleteLabel(labelId);
    }
    case 'labels.deleteLabels': {
      const [payload] = z.tuple([DeleteLabelsPayloadSchema]).parse(expected.driver.arguments);
      return client.labels.deleteLabels(payload);
    }
    case 'milestones.getMilestone': {
      const [milestoneId] = z.tuple([z.number()]).parse(expected.driver.arguments);
      return client.milestones.getMilestone(milestoneId);
    }
    case 'milestones.getMilestonesPage': {
      const [projectId, options] = z.tuple([z.number(), milestoneFilterOptions.extend({ limit: z.number(), offset: z.number() })])
        .parse(expected.driver.arguments);
      return client.milestones.getMilestonesPage(projectId, present(options));
    }
    case 'milestones.getAllMilestones': {
      const [projectId, options] = z.tuple([z.number(), milestoneFilterOptions.extend(aggregateOptions)]).parse(expected.driver.arguments);
      return client.milestones.getAllMilestones(projectId, present(options));
    }
    case 'milestones.addMilestone': {
      const [projectId, payload] = z.tuple([z.number(), AddMilestonePayloadSchema]).parse(expected.driver.arguments);
      return client.milestones.addMilestone(projectId, payload);
    }
    case 'milestones.updateMilestone': {
      const [milestoneId, payload] = z.tuple([z.number(), UpdateMilestonePayloadSchema]).parse(expected.driver.arguments);
      return client.milestones.updateMilestone(milestoneId, payload);
    }
    case 'milestones.deleteMilestone': {
      const [milestoneId] = z.tuple([z.number()]).parse(expected.driver.arguments);
      return client.milestones.deleteMilestone(milestoneId);
    }
    case 'users.getCurrentUser': {
      z.tuple([]).parse(expected.driver.arguments);
      return client.users.getCurrentUser();
    }
    case 'users.getUser': {
      const [userId] = z.tuple([z.number()]).parse(expected.driver.arguments);
      return client.users.getUser(userId);
    }
    case 'users.getUserByEmail': {
      const [email] = z.tuple([z.string()]).parse(expected.driver.arguments);
      return client.users.getUserByEmail(email);
    }
    case 'users.getUsers': {
      const [projectId] = z.tuple([z.number().optional()]).parse(expected.driver.arguments);
      return projectId === undefined ? client.users.getUsers() : client.users.getUsers(projectId);
    }
    case 'users.addUser': {
      const [payload] = z.tuple([UserAddPayloadSchema]).parse(expected.driver.arguments);
      return client.users.addUser(payload);
    }
    case 'users.updateUser': {
      const [userId, payload] = z.tuple([z.number(), UserUpdatePayloadSchema]).parse(expected.driver.arguments);
      return client.users.updateUser(userId, payload);
    }
    case 'users.getGroup': {
      const [groupId] = z.tuple([z.number()]).parse(expected.driver.arguments);
      return client.users.getGroup(groupId);
    }
    case 'users.getGroupsPage': {
      z.tuple([]).parse(expected.driver.arguments);
      return client.users.getGroupsPage();
    }
    case 'users.getAllGroups': {
      const [options] = z.tuple([z.strictObject(aggregateOptions)]).parse(expected.driver.arguments);
      return client.users.getAllGroups(present(options));
    }
    case 'users.addGroup': {
      const [payload] = z.tuple([AddGroupPayloadSchema]).parse(expected.driver.arguments);
      return client.users.addGroup(payload);
    }
    case 'users.updateGroup': {
      const [groupId, payload] = z.tuple([z.number(), UpdateGroupPayloadSchema]).parse(expected.driver.arguments);
      return client.users.updateGroup(groupId, payload);
    }
    case 'users.deleteGroup': {
      const [groupId] = z.tuple([z.number()]).parse(expected.driver.arguments);
      return client.users.deleteGroup(groupId);
    }
    case 'metadata.getRolesPage': {
      z.tuple([]).parse(expected.driver.arguments);
      return client.metadata.getRolesPage();
    }
    case 'metadata.getAllRoles': {
      const [options] = z.tuple([z.strictObject(aggregateOptions)]).parse(expected.driver.arguments);
      return client.metadata.getAllRoles(present(options));
    }
    case 'datasets.getDataset': {
      const [datasetId] = z.tuple([z.number()]).parse(expected.driver.arguments);
      return client.datasets.getDataset(datasetId);
    }
    case 'datasets.getDatasetsPage': {
      const [projectId] = z.tuple([z.number()]).parse(expected.driver.arguments);
      return client.datasets.getDatasetsPage(projectId);
    }
    case 'datasets.getAllDatasets': {
      const [projectId, options] = z.tuple([z.number(), z.strictObject(aggregateOptions)]).parse(expected.driver.arguments);
      return client.datasets.getAllDatasets(projectId, present(options));
    }
    case 'datasets.addDataset': {
      const [projectId, payload] = z.tuple([z.number(), AddDatasetPayloadSchema]).parse(expected.driver.arguments);
      return client.datasets.addDataset(projectId, payload);
    }
    case 'datasets.updateDataset': {
      const [datasetId, payload] = z.tuple([z.number(), UpdateDatasetPayloadSchema]).parse(expected.driver.arguments);
      return client.datasets.updateDataset(datasetId, payload);
    }
    case 'datasets.deleteDataset': {
      const [datasetId] = z.tuple([z.number()]).parse(expected.driver.arguments);
      return client.datasets.deleteDataset(datasetId);
    }
    case 'variables.getVariablesPage': {
      const [projectId] = z.tuple([z.number()]).parse(expected.driver.arguments);
      return client.variables.getVariablesPage(projectId);
    }
    case 'variables.getAllVariables': {
      const [projectId, options] = z.tuple([z.number(), z.strictObject(aggregateOptions)]).parse(expected.driver.arguments);
      return client.variables.getAllVariables(projectId, present(options));
    }
    case 'variables.addVariable': {
      const [projectId, payload] = z.tuple([z.number(), AddVariablePayloadSchema]).parse(expected.driver.arguments);
      return client.variables.addVariable(projectId, payload);
    }
    case 'variables.updateVariable': {
      const [variableId, payload] = z.tuple([z.number(), UpdateVariablePayloadSchema]).parse(expected.driver.arguments);
      return client.variables.updateVariable(variableId, payload);
    }
    case 'variables.deleteVariable': {
      const [variableId] = z.tuple([z.number()]).parse(expected.driver.arguments);
      return client.variables.deleteVariable(variableId);
    }
    case 'metadata.getCaseFields': {
      z.tuple([]).parse(expected.driver.arguments);
      return client.metadata.getCaseFields();
    }
    case 'metadata.addCaseField': {
      const [payload] = z.tuple([AddCaseFieldPayloadSchema]).parse(expected.driver.arguments);
      return client.metadata.addCaseField(payload);
    }
    case 'metadata.getCaseTypes': {
      z.tuple([]).parse(expected.driver.arguments);
      return client.metadata.getCaseTypes();
    }
    case 'metadata.getDynamicFilterFields': {
      const [projectId] = z.tuple([z.number()]).parse(expected.driver.arguments);
      return client.metadata.getDynamicFilterFields(projectId);
    }
    case 'metadata.getPriorities': {
      z.tuple([]).parse(expected.driver.arguments);
      return client.metadata.getPriorities();
    }
    case 'metadata.getResultFields': {
      z.tuple([]).parse(expected.driver.arguments);
      return client.metadata.getResultFields();
    }
    case 'metadata.getCaseStatusesPage': {
      z.tuple([]).parse(expected.driver.arguments);
      return client.metadata.getCaseStatusesPage();
    }
    case 'metadata.getAllCaseStatuses': {
      const [options] = z.tuple([z.strictObject(aggregateOptions)]).parse(expected.driver.arguments);
      return client.metadata.getAllCaseStatuses(present(options));
    }
    case 'metadata.getStatuses': {
      z.tuple([]).parse(expected.driver.arguments);
      return client.metadata.getStatuses();
    }
    case 'metadata.getTemplates': {
      const [projectId] = z.tuple([z.number()]).parse(expected.driver.arguments);
      return client.metadata.getTemplates(projectId);
    }
    case 'metadata.getVersion': {
      z.tuple([]).parse(expected.driver.arguments);
      return client.metadata.getVersion();
    }
    case 'reports.getReports': {
      const [projectId] = z.tuple([z.number()]).parse(expected.driver.arguments);
      return client.reports.getReports(projectId);
    }
    case 'reports.runReport': {
      const [reportTemplateId] = z.tuple([z.number()]).parse(expected.driver.arguments);
      return client.reports.runReport(reportTemplateId);
    }
    case 'reports.getCrossProjectReports': {
      z.tuple([]).parse(expected.driver.arguments);
      return client.reports.getCrossProjectReports();
    }
    case 'reports.runCrossProjectReport': {
      const [reportTemplateId] = z.tuple([z.number()]).parse(expected.driver.arguments);
      return client.reports.runCrossProjectReport(reportTemplateId);
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
