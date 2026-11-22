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
  node_version: string;
  npm_version: string;
}
interface ToolEvidence { status: string; steps: { status: string; reason?: string; code?: string }[] }
interface ValidationOptions {
  candidate: Candidate;
  tools: string[];
  publishedAt: string;
  releaseNotes: string;
  dependencies: Record<string, string>;
}
const { packCandidate, sha512Integrity } = (await import(new URL('../scripts/prepare-candidate.mjs', import.meta.url).href)) as {
  packCandidate: (input: { root: string; output: string; sourceCommit: string }) => Promise<Candidate>;
  sha512Integrity: (bytes: Buffer) => string;
};
const { downloadReleaseAssets, renderLiveLimitations, validateCandidateTarball, validateQualification } =
  (await import(new URL('../scripts/release-evidence.mjs', import.meta.url).href)) as {
    downloadReleaseAssets: (input: { event: unknown; repository: string; token: string; request: typeof fetch }) => Promise<Record<string, Buffer>>;
    renderLiveLimitations: (tools: Record<string, ToolEvidence>) => string;
    validateCandidateTarball: (input: { candidate: Candidate; rebuilt: Candidate; tarball: Buffer; sourceCommit: string; tag: string }) => Candidate;
    validateQualification: (value: unknown, options: ValidationOptions) => void;
  };

const { operations } = JSON.parse(await readFile(new URL('../docs/operation-inventory.json', import.meta.url), 'utf8')) as { operations: { tool: string }[] };
const tools = operations.map(({ tool }) => tool).sort();
const driver = '@dichovsky/testrail-api-client';
const dependencies = { [driver]: '10.0.0', zod: '4.6.7' };
const packageName = '@dichovsky/testrail-mcp';
const catalog = { count: 133, sorted_names_sha256: createHash('sha256').update(tools.join('\n')).digest('hex') };
const sourceCommit = '1'.repeat(40);
const tarball = Buffer.from('synthetic candidate bytes');
const candidate = {
  schema_version: 1, package_name: packageName, package_version: '2.0.0', source_commit: sourceCommit, integrity: sha512Integrity(tarball),
  driver_version: '10.0.0', prepared_at: '2026-11-23T12:00:00.000Z', node_version: '26.13.1', npm_version: '11.20.0',
};

function qualification() {
  const identity = {
    source_commit: candidate.source_commit, integrity: candidate.integrity,
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
  const results: Record<string, ToolEvidence> = Object.fromEntries(tools.map((name) => [name, { status: 'pass', steps: [{ status: 'pass' }] }]));
  results.testrail_add_case_field = { status: 'not_run', steps: [{ status: 'not_run', reason: 'needs --instance-writes' }] };
  const live = {
    ...identity, schema_version: 2, provenance: 'live_testrail', testrail_version: '10.8.1.1024', stopped: null, tools: results,
    server: { ...server, node_version: '26.13.1', production_dependencies: { ...dependencies } },
    summary: { pass: 132, blocked: 0, not_run: 1, fail: 0 },
    cleanup: { project: 'deleted', project_verified_absent: true, verified: { gone: 1, present: 0, unverified: 0 }, residue: [] },
  };
  const options = {
    candidate, tools, publishedAt: '2026-11-25T00:00:00Z', releaseNotes: `Changes\n\n${renderLiveLimitations(results)}`, dependencies,
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
    ['different integrity', ({ value }) => { value.live.integrity = sha512Integrity(Buffer.from('different')); }],
    ['run predating the candidate', ({ value }) => { value.live.started_at = '2026-11-22T16:00:00Z'; }],
    ['run after the release', ({ value }) => { value.live.finished_at = '2026-11-26T16:00:00Z'; }],
    ['fixture evidence', ({ value }) => { value.live.provenance = 'fixture_stand_in'; }],
    ['different TestRail', ({ value }) => { value.live.testrail_version = '10.8.2'; }],
    ['absent cleanup proof', ({ value }) => { value.live.cleanup.project_verified_absent = false; }],
    ['project never created', ({ value }) => { value.live.cleanup.project = 'not_created'; }],
    ['wrong installed production driver', ({ value }) => { value.live.server.production_dependencies[driver] = '9.0.0'; }],
    ['wrong counts', ({ value }) => { value.live.summary.pass += 1; }],
    ['missing limitations in notes', ({ options }) => { options.releaseNotes = 'Changes'; }],
  ])('rejects %s', (_label, change) => {
    const input = qualification();
    change(input);
    expect(() => validateQualification(input.value, input.options)).toThrow();
  });
});

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
      const first = await packCandidate({ root, output: join(root, 'first'), sourceCommit });
      const second = await packCandidate({ root, output: join(root, 'second'), sourceCommit });
      const firstBytes = await readFile(join(root, 'first/candidate.tgz'));
      expect(firstBytes.equals(await readFile(join(root, 'second/candidate.tgz')))).toBe(true);
      expect(validateCandidateTarball({ candidate: first, rebuilt: second, tarball: firstBytes, sourceCommit, tag: 'release/2.0.0' })).toEqual(first);
      expect(() => validateCandidateTarball({ candidate: first, rebuilt: second, tarball, sourceCommit, tag: 'release/2.0.0' })).toThrow(/does not match/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);

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
