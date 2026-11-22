import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

interface Candidate {
  schema_version: number;
  package_name: string;
  package_version: string;
  source_commit: string;
  integrity: string;
  driver_version: string;
  prepared_at: string;
  prepare_run_id?: number;
  prepare_run_attempt?: number;
  node_version: string;
  npm_version: string;
}
interface ToolEvidence { status: string; steps: { label: string | null; status: string; reason?: string; code?: string; http_status?: number }[] }
interface ValidationOptions {
  candidate: Candidate;
  tools: string[];
  preparedAt: string;
  publishedAt: string;
  releaseNotes: string;
  dependencies: Record<string, string>;
}
const { packCandidate, sha512Integrity } = (await import(new URL('../scripts/prepare-candidate.mjs', import.meta.url).href)) as {
  packCandidate: (input: { root: string; output: string; sourceCommit: string; preparationRun?: { id: number; attempt: number } }) => Promise<Candidate>;
  sha512Integrity: (bytes: Buffer) => string;
};
const { downloadReleaseAssets, renderLiveLimitations, validateCandidateTarball, validateQualification, verifyCandidateOrigin } =
  (await import(new URL('../scripts/release-evidence.mjs', import.meta.url).href)) as {
    downloadReleaseAssets: (input: { event: unknown; repository: string; token: string; request: typeof fetch }) => Promise<Record<string, Buffer>>;
    renderLiveLimitations: (tools: Record<string, ToolEvidence>) => string;
    validateCandidateTarball: (input: { candidate: Candidate; rebuilt: Candidate; tarball: Buffer; sourceCommit: string; tag: string }) => Candidate;
    validateQualification: (value: unknown, options: ValidationOptions) => void;
    verifyCandidateOrigin: (input: { candidate: Candidate; manifest: Buffer; repository: string; token: string; request: typeof fetch;
      now: () => number; readManifest?: ((archive: Buffer) => Promise<Buffer>) | undefined }) => Promise<{ preparedAt: string; expiresAt: string }>;
  };

const { operations } = JSON.parse(await readFile(new URL('../docs/operation-inventory.json', import.meta.url), 'utf8')) as { operations: { tool: string }[] };
const priorLiveRun = JSON.parse(await readFile(new URL('../docs/evidence/live/testrail-10.8.1.json', import.meta.url), 'utf8')) as {
  testrail_version: string;
  options: { instance_writes: boolean; report_template: boolean; cross_project_report_template: boolean };
  tools: Record<string, ToolEvidence>;
  summary: { pass: number; blocked: number; not_run: number; fail: number };
  cleanup: { project: string; group: string; verified: { gone: number; present: number; unverified: number }; residue: { kind: string; count: number }[] };
};
const tools = operations.map(({ tool }) => tool).sort();
const driver = '@dichovsky/testrail-api-client';
const dependencies = { [driver]: '10.0.0', zod: '4.6.7' };
const packageName = '@dichovsky/testrail-mcp';
const catalog = { count: 133, sorted_names_sha256: createHash('sha256').update(tools.join('\n')).digest('hex') };
const sourceCommit = '1'.repeat(40);
const tarball = Buffer.from('synthetic candidate bytes');
const candidate = {
  schema_version: 1, package_name: packageName, package_version: '2.0.0', source_commit: sourceCommit, integrity: sha512Integrity(tarball),
  driver_version: '10.0.0', prepared_at: '2026-11-23T12:00:00.000Z', prepare_run_id: 777, prepare_run_attempt: 2,
  node_version: '26.13.1', npm_version: '11.20.0',
};

function qualification() {
  const identity = {
    source_commit: candidate.source_commit, integrity: candidate.integrity,
    prepare_run_id: candidate.prepare_run_id, prepare_run_attempt: candidate.prepare_run_attempt,
    started_at: '2026-11-24T16:00:00Z', finished_at: '2026-11-24T17:00:00Z',
  };
  const server = { package_version: candidate.package_version, driver_version: candidate.driver_version };
  const scenarioNames = Array.from({ length: 12 }, (_, index) => `C${String(index + 1).padStart(2, '0')}`);
  const clients = ['Claude Code', 'Codex CLI', 'Codex desktop', 'GitHub Copilot CLI'].map((surface) => ({
    ...identity, schema_version: 1, surface, provenance: 'fixture_stand_in', catalog,
    client: { version: '1.2.3', node_machine_version: '26.13.1' }, server: { ...server, tarball_integrity: candidate.integrity },
    settings: { negotiated_revisions: { default: '2026-07-28' } },
    scenarios: Object.fromEntries(scenarioNames.map((name) => [name, { status: 'pass', evidence: `${surface} ${name} sanitized trace` }])),
    c10: { admitted: 4, busy: 1, busy_upstream_requests: 0, timed_out: 4, cancelled_request_id: 6, notification_request_id: 6, late_reply: false, recovered: true },
  }));
  const results = structuredClone(priorLiveRun.tools);
  const live = {
    ...identity, schema_version: 2, provenance: 'live_testrail', testrail_version: priorLiveRun.testrail_version, stopped: null, tools: results,
    options: { ...priorLiveRun.options },
    observations: { existing_group_found: true },
    server: { ...server, node_version: '26.13.1', production_dependencies: { ...dependencies } },
    summary: { ...priorLiveRun.summary },
    cleanup: { ...structuredClone(priorLiveRun.cleanup), project_verified_absent: true, project_readback: { code: 'UPSTREAM_ERROR', http_status: 400 } },
  };
  const options = {
    candidate, tools, preparedAt: '2026-11-23T12:08:00Z', publishedAt: '2026-11-25T00:00:00Z',
    releaseNotes: `Changes\n\n${renderLiveLimitations(results)}`, dependencies,
  };
  return { value: { schema_version: 1, clients, live }, options };
}

describe('the release-only qualification gate', () => {
  it('accepts four fresh host records and all live results for one source and digest', () => {
    const { value, options } = qualification();
    expect(() => validateQualification(value, options)).not.toThrow();
    expect(options.releaseNotes).toContain('testrail_add_case_field` — not_run: needs --instance-writes');
  });

  it.each<[string, (input: ReturnType<typeof qualification>) => void]>([
    ['missing host', ({ value }) => { value.clients.pop(); }],
    ['duplicate host', ({ value }) => { value.clients[1]!.surface = value.clients[0]!.surface; }],
    ['old Node', ({ value }) => { value.clients[0]!.client.node_machine_version = '24.19.0'; }],
    ['missing scenario', ({ value }) => { delete value.clients[0]!.scenarios.C01; }],
    ['failed scenario', ({ value }) => { value.clients[0]!.scenarios.C01!.status = 'fail'; }],
    ['mismatched cancellation ID', ({ value }) => { value.clients[0]!.c10.notification_request_id = 7; }],
    ['wrong commit', ({ value }) => { value.clients[0]!.source_commit = '2'.repeat(40); }],
    ['another Prepare Candidate run', ({ value }) => { value.clients[0]!.prepare_run_id += 1; }],
    ['another Prepare Candidate attempt', ({ value }) => { value.live.prepare_run_attempt -= 1; }],
    ['different integrity', ({ value }) => { value.live.integrity = sha512Integrity(Buffer.from('different')); }],
    ['run between the manifest date and the successful workflow completion', ({ value }) => { value.live.started_at = '2026-11-23T12:04:00Z'; }],
    ['zero-duration evidence', ({ value }) => { value.live.finished_at = value.live.started_at; }],
    ['run after the release', ({ value }) => { value.live.finished_at = '2026-11-26T16:00:00Z'; }],
    ['fixture evidence', ({ value }) => { value.live.provenance = 'fixture_stand_in'; }],
    ['different TestRail', ({ value }) => { value.live.testrail_version = '10.8.2'; }],
    ['absent cleanup proof', ({ value }) => { value.live.cleanup.project_verified_absent = false; }],
    ['an unverified cleanup readback', ({ value }) => { value.live.cleanup.project_readback = { code: 'PERMISSION_DENIED', http_status: 403 }; }],
    ['project never created', ({ value }) => { value.live.cleanup.project = 'not_created'; }],
    ['wrong installed production driver', ({ value }) => { value.live.server.production_dependencies[driver] = '9.0.0'; }],
    ['wrong counts', ({ value }) => { value.live.summary.pass += 1; }],
    ['missing limitations in notes', ({ options }) => { options.releaseNotes = 'Changes'; }],
  ])('rejects %s', (_label, change) => {
    const input = qualification();
    change(input);
    expect(() => validateQualification(input.value, input.options)).toThrow();
  });

  it('allows the existing-group read to be skipped when the instance has no group', () => {
    const input = qualification();
    input.value.live.observations.existing_group_found = false;
    input.value.live.tools.testrail_get_group!.steps[0] = {
      label: 'existing group', status: 'not_run', reason: 'the instance has no group to read',
    };
    input.value.live.tools.testrail_get_group!.status = 'not_run';
    summarizeLive(input);
    expect(() => validateQualification(input.value, input.options)).not.toThrow();
  });

  it('allows an upstream permission refusal for the project read or a configured report', () => {
    const input = qualification();
    input.value.live.options.report_template = true;
    for (const tool of ['testrail_get_project', 'testrail_run_report']) {
      input.value.live.tools[tool] = { status: 'blocked', steps: [{ label: null, status: 'blocked', code: 'PERMISSION_DENIED', http_status: 403 }] };
    }
    summarizeLive(input);
    expect(() => validateQualification(input.value, input.options)).not.toThrow();
  });

  it.each([1, 6])('rejects %i verified absences when the project and four uploads passed', (gone) => {
    const { value, options } = qualification();
    value.live.cleanup.verified.gone = gone;
    expect(() => validateQualification(value, options)).toThrow(/verify 5 absences/u);
  });

  it('requires a readback for a created group even when its planned delete was refused', () => {
    const input = qualification();
    const { live } = input.value;
    enableInstanceWrites(live);
    live.tools.testrail_add_group = { status: 'pass', steps: [{ label: null, status: 'pass' }] };
    live.tools.testrail_get_group!.steps[1] = { label: 'own group', status: 'pass' };
    live.tools.testrail_get_group!.status = 'pass';
    live.tools.testrail_update_group = { status: 'pass', steps: [{ label: null, status: 'pass' }] };
    live.tools.testrail_delete_group = { status: 'blocked', steps: [{ label: null, status: 'blocked', code: 'PERMISSION_DENIED', http_status: 403 }] };
    live.cleanup.group = 'deleted_in_cleanup';
    summarizeLive(input);
    expect(() => validateQualification(input.value, input.options)).toThrow(/verify 6 absences/u);
    live.cleanup.verified.gone += 1;
    expect(() => validateQualification(input.value, input.options)).not.toThrow();
  });

  it.each([
    ['testrail_run_report', 'report_template'],
    ['testrail_run_cross_project_report', 'cross_project_report_template'],
    ['testrail_add_user', 'instance_writes'],
    ['testrail_add_case_field', 'instance_writes'],
  ] as const)('rejects a passing %s with omitted residue', (tool, requiredOption) => {
    const input = qualification();
    const { live } = input.value;
    if (requiredOption === 'instance_writes') enableInstanceWrites(live);
    live.options[requiredOption] = true;
    live.tools[tool] = { status: 'pass', steps: [{ label: null, status: 'pass' }] };
    if (tool === 'testrail_add_user') live.tools.testrail_update_user = { status: 'pass', steps: [{ label: null, status: 'pass' }] };
    summarizeLive(input);
    expect(() => validateQualification(input.value, input.options)).toThrow(`successful steps leave residue: ${tool}`);
  });

  it('rejects reported residue even when all required readbacks found the entities gone', () => {
    const { value, options } = qualification();
    value.live.cleanup.residue = [{ kind: 'possible attachment', count: 1 }];
    expect(() => validateQualification(value, options)).toThrow(/residue/u);
  });

  it.each<[string, (live: ReturnType<typeof qualification>['value']['live']) => void, RegExp]>([
    ['an unobserved version probe', (live) => {
      live.tools.testrail_get_version = { status: 'blocked', steps: [{ label: null, status: 'blocked', code: 'PERMISSION_DENIED', http_status: 403 }] };
    }, /successful version probe/u],
    ['a missing repeated step', (live) => { live.tools.testrail_add_case!.steps.splice(1, 1); }, /planned step testrail_add_case \(second\)/u],
    ['an extra repeated step', (live) => { live.tools.testrail_get_cases!.steps.push({ label: null, status: 'pass' }); }, /unexpected steps for testrail_get_cases/u],
    ['a claimed prerequisite that was provided', (live) => {
      live.tools.testrail_get_templates = { status: 'blocked', steps: [{ label: null, status: 'blocked', reason: 'needs the project an earlier step did not provide' }] };
    }, /outcome of testrail_get_templates/u],
    ['the wrong missing prerequisite', (live) => {
      live.tools.testrail_get_dataset!.steps[0]!.reason = 'needs the group an earlier step did not provide';
    }, /outcome of testrail_get_dataset/u],
    ['a passed step when a prerequisite never ran', (live) => {
      live.tools.testrail_get_dataset = { status: 'pass', steps: [{ label: null, status: 'pass' }] };
    }, /outcome of testrail_get_dataset/u],
    ['a skip that conflicts with the report option', (live) => { live.options.report_template = true; }, /outcome of testrail_run_report/u],
    ['a no-group skip contradicting the recorded observation', (live) => {
      live.tools.testrail_get_group!.steps[0] = { label: 'existing group', status: 'not_run', reason: 'the instance has no group to read' };
      live.tools.testrail_get_group!.status = 'not_run';
    }, /outcome of testrail_get_group/u],
    ['a license limitation without an upstream refusal', (live) => { delete live.tools.testrail_add_dataset!.steps[0]!.http_status; }, /outcome of testrail_add_dataset/u],
    ['an arbitrary skip reason', (live) => {
      live.tools.testrail_get_version = { status: 'not_run', steps: [{ label: null, status: 'not_run', reason: 'the project was enough' }] };
    }, /outcome of testrail_get_version/u],
  ])('rejects %s even when the summary and release notes agree', (_name, change, expected) => {
    const input = qualification();
    change(input.value.live);
    summarizeLive(input);
    expect(() => validateQualification(input.value, input.options)).toThrow(expected);
  });
});

function enableInstanceWrites(live: ReturnType<typeof qualification>['value']['live']) {
  live.options.instance_writes = true;
  for (const tool of ['testrail_add_group', 'testrail_add_user', 'testrail_add_case_field']) {
    live.tools[tool] = { status: 'blocked', steps: [{ label: null, status: 'blocked', code: 'PERMISSION_DENIED', http_status: 403 }] };
  }
  for (const tool of ['testrail_get_group', 'testrail_update_group', 'testrail_delete_group', 'testrail_update_user']) {
    const kind = tool.endsWith('_group') ? 'group' : 'user';
    const groupRead = tool === 'testrail_get_group';
    const step = { label: groupRead ? 'own group' : null, status: 'blocked', reason: `needs the ${kind} an earlier step did not provide` };
    live.tools[tool]!.steps[groupRead ? 1 : 0] = step;
    live.tools[tool]!.status = 'blocked';
  }
}

function summarizeLive({ value: { live }, options }: ReturnType<typeof qualification>) {
  const outcomes = Object.values(live.tools);
  live.summary = {
    pass: outcomes.filter(({ status }) => status === 'pass').length,
    not_run: outcomes.filter(({ status }) => status === 'not_run').length,
    blocked: outcomes.filter(({ status }) => status === 'blocked').length,
    fail: outcomes.filter(({ status }) => status === 'fail').length,
  };
  options.releaseNotes = `Changes\n\n${renderLiveLimitations(live.tools)}`;
}

describe('the exact release candidate', () => {
  it('packs the same byte sequence in separate staging directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'testrail-candidate-test-'));
    try {
      await mkdir(join(root, 'dist'));
      await writeFile(join(root, 'dist/cli.js'), '#!/usr/bin/env node\n');
      await writeFile(join(root, 'README.md'), 'Candidate\n');
      await writeFile(join(root, 'LICENSE'), 'MIT\n');
      await writeFile(join(root, 'package.json'), JSON.stringify({
        name: packageName, version: '2.0.0', files: ['dist/', 'README.md', 'LICENSE'], bin: { 'testrail-mcp': 'dist/cli.js' }, dependencies,
        scripts: { prepack: 'exit 19' },
      }));
      const first = await packCandidate({ root, output: join(root, 'first'), sourceCommit, preparationRun: { id: 777, attempt: 2 } });
      const second = await packCandidate({ root, output: join(root, 'second'), sourceCommit });
      const firstBytes = await readFile(join(root, 'first/candidate.tgz'));
      expect(firstBytes.equals(await readFile(join(root, 'second/candidate.tgz')))).toBe(true);
      expect(validateCandidateTarball({ candidate: first, rebuilt: second, tarball: firstBytes, sourceCommit, tag: 'release/2.0.0' })).toEqual(first);
      expect(() => validateCandidateTarball({ candidate: first, rebuilt: second, tarball, sourceCommit, tag: 'release/2.0.0' })).toThrow(/does not match/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);

  function originFixture(archive = new TextEncoder().encode('synthetic zip with candidate files')) {
    const repository = 'dichovsky/testrail-mcp';
    const run = {
      id: 777, run_attempt: 2, path: '.github/workflows/prepare-candidate.yml', status: 'completed', conclusion: 'success',
      event: 'workflow_dispatch', head_branch: 'main', head_sha: sourceCommit, updated_at: '2026-11-23T12:08:00Z',
      repository: { full_name: repository }, head_repository: { full_name: repository },
    };
    const artifact = {
      name: 'npm-release-candidate-2', id: 999, size_in_bytes: archive.length, expired: false,
      digest: `sha256:${createHash('sha256').update(archive).digest('hex')}`, created_at: '2026-11-23T12:07:00Z',
      expires_at: '2027-02-22T12:00:00Z',
    };
    const manifest = Buffer.from(JSON.stringify(candidate));
    const prefix = `https://api.github.com/repos/${repository}/actions`;
    const requests: string[] = [];
    const request: typeof fetch = (input) => {
      const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
      requests.push(url);
      switch (url) {
        case `${prefix}/runs/777`: return Promise.resolve(Response.json(run));
        case `${prefix}/runs/777/artifacts?name=npm-release-candidate-2`:
          return Promise.resolve(Response.json({ total_count: 1, artifacts: [artifact] }));
        case `${prefix}/artifacts/999/zip`: return Promise.resolve(new Response(archive));
        default: return Promise.reject(new Error(`Unexpected request ${url}`));
      }
    };
    const options = { candidate, manifest, repository, token: 'synthetic-token', request, now: () => Date.parse('2026-11-25T00:00:00Z'),
      readManifest: (bytes: Buffer) => { expect(bytes.equals(archive)).toBe(true); return Promise.resolve(manifest); } };
    return { options, run, artifact, requests, prefix };
  }

  it('uses the trusted run and artifact timestamps and verifies the manifest copied to the release', async () => {
    const { options, requests, prefix } = originFixture();
    await expect(verifyCandidateOrigin(options)).resolves.toEqual({ preparedAt: '2026-11-23T12:08:00.000Z', expiresAt: '2027-02-22T12:00:00Z' });
    expect(requests).toEqual([`${prefix}/runs/777`, `${prefix}/runs/777/artifacts?name=npm-release-candidate-2`, `${prefix}/artifacts/999/zip`]);
  });

  it.skipIf(process.platform === 'win32')('extracts the manifest from a verified Actions-format ZIP', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'testrail-action-artifact-'));
    try {
      await writeFile(join(directory, 'candidate.json'), JSON.stringify(candidate));
      await writeFile(join(directory, 'candidate.tgz'), tarball);
      execFileSync('zip', ['-q', 'artifact.zip', 'candidate.json', 'candidate.tgz'], { cwd: directory });
      const archive = new Uint8Array(await readFile(join(directory, 'artifact.zip')));
      const { options } = originFixture(archive);
      await expect(verifyCandidateOrigin({ ...options, readManifest: undefined })).resolves.toMatchObject({
        preparedAt: '2026-11-23T12:08:00.000Z',
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each<[string, (fixture: ReturnType<typeof originFixture>) => void, RegExp]>([
    ['failed preparation workflow', ({ run }) => { run.conclusion = 'failure'; }, /successful Prepare Candidate/u],
    ['a different workflow', ({ run }) => { run.path = '.github/workflows/ci.yml'; }, /successful Prepare Candidate/u],
    ['a different source commit', ({ run }) => { run.head_sha = '2'.repeat(40); }, /successful Prepare Candidate/u],
    ['an earlier attempt after a rerun', ({ run }) => { run.run_attempt = 3; }, /successful Prepare Candidate/u],
    ['an expired artifact', ({ options, artifact }) => { options.now = () => Date.parse(artifact.expires_at); }, /unexpired/u],
    ['an altered archive', ({ artifact }) => { artifact.digest = `sha256:${'1'.repeat(64)}`; }, /verified Prepare Candidate/u],
    ['a release manifest with a forged preparation timestamp', ({ options }) => {
      options.candidate = { ...candidate, prepared_at: '2020-01-01T00:00:00Z' };
      options.manifest = Buffer.from(JSON.stringify(options.candidate));
    }, /verified Prepare Candidate/u],
  ])('rejects %s', async (_name, change, error) => {
    const fixture = originFixture();
    change(fixture);
    await expect(verifyCandidateOrigin(fixture.options)).rejects.toThrow(error);
  });

  it('downloads the triggering release assets by their event IDs and verifies their bytes', async () => {
    const repository = 'dichovsky/testrail-mcp';
    const names = ['candidate.json', 'candidate.tgz', 'qualification.json'];
    const bytes = names.map((name) => new TextEncoder().encode(name));
    const assets = names.map((name, index) => ({
      name, id: index + 1, state: 'uploaded', size: bytes[index]!.length,
      digest: `sha256:${createHash('sha256').update(bytes[index]!).digest('hex')}`,
    }));
    const release = { id: 5, tag_name: 'release/2.0.0', draft: false, prerelease: false, published_at: '2026-11-25T00:00:00Z', body: 'Release', assets };
    const event = { repository: { full_name: repository }, release: structuredClone(release) };
    const requests: string[] = [];
    const request: typeof fetch = (input) => {
      const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
      requests.push(url);
      const id = /\/assets\/(\d+)$/u.exec(url)?.[1];
      return Promise.resolve(id === undefined ? Response.json(release) : new Response(bytes[Number(id) - 1]));
    };
    const options = { repository, event, token: 'synthetic-token', request };
    await expect(downloadReleaseAssets(options)).resolves.toEqual(Object.fromEntries(names.map((name) => [name, Buffer.from(name)])));
    expect(requests).toEqual([`https://api.github.com/repos/${repository}/releases/5`, ...assets.map(({ id }) => `https://api.github.com/repos/${repository}/releases/assets/${id}`)]);
    assets[1]!.id = 8;
    await expect(downloadReleaseAssets(options)).rejects.toThrow(/exactly one verified/u);
  });
});
