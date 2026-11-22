// The release-only gate. It verifies records without contacting TestRail or MCP hosts.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { toolStatus } from './live-qualification.mjs';
import {
  DRIVER_NAME, INTEGRITY_PATTERN, PACKAGE_NAME, RELEASE_NODE, RELEASE_NPM, SHA_PATTERN,
  VERSION_PATTERN, sha512Integrity,
} from './prepare-candidate.mjs';

const ASSETS = { 'candidate.json': 16 * 1024, 'candidate.tgz': 8 * 1024 * 1024, 'qualification.json': 1024 * 1024 };
const RELEASE_SURFACES = ['Claude Code', 'Codex CLI', 'Codex desktop', 'GitHub Copilot CLI'];
const SCENARIOS = Array.from({ length: 12 }, (_, index) => `C${String(index + 1).padStart(2, '0')}`);
const BEGIN_LIMITATIONS = '<!-- testrail-live-limitations:start -->';
const END_LIMITATIONS = '<!-- testrail-live-limitations:end -->';
const nonempty = z.string().trim().min(1);
const runtime = z.string().regex(/^26\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u);
const version = z.string().regex(VERSION_PATTERN);
const revision = z.enum(['legacy', '2025-11-25', '2026-07-28']);
const evidenceTime = z.iso.datetime();
const runIdentity = {
  source_commit: z.string().regex(SHA_PATTERN),
  integrity: z.string().regex(INTEGRITY_PATTERN),
  started_at: evidenceTime,
  finished_at: evidenceTime,
};

export const candidateSchema = z.strictObject({
  schema_version: z.literal(1),
  package_name: z.literal(PACKAGE_NAME),
  package_version: version,
  source_commit: z.string().regex(SHA_PATTERN),
  integrity: z.string().regex(INTEGRITY_PATTERN),
  driver_version: version,
  prepared_at: evidenceTime,
  node_version: z.literal(RELEASE_NODE),
  npm_version: z.literal(RELEASE_NPM),
});

const requestId = z.union([z.int().nonnegative(), nonempty]);
const clientSchema = z.object({
  ...runIdentity,
  schema_version: z.literal(1),
  surface: z.enum(RELEASE_SURFACES),
  provenance: z.literal('fixture_stand_in'),
  client: z.object({ version: nonempty, node_machine_version: runtime }),
  settings: z.object({ negotiated_revisions: z.object({ default: revision }) }),
  server: z.object({ package_version: version, driver_version: version, tarball_integrity: z.string().regex(INTEGRITY_PATTERN) }),
  catalog: z.object({ count: z.literal(133), sorted_names_sha256: z.string().regex(/^[0-9a-f]{64}$/u) }),
  scenarios: z.record(z.enum(SCENARIOS), z.object({ status: z.literal('pass'), evidence: nonempty })),
  c10: z.strictObject({
    admitted: z.literal(4), busy: z.literal(1), busy_upstream_requests: z.literal(0), timed_out: z.literal(4),
    cancelled_request_id: requestId, notification_request_id: requestId, late_reply: z.literal(false), recovered: z.literal(true),
  }),
});

const status = z.enum(['pass', 'blocked', 'not_run', 'fail']);
const liveTool = z.object({
  status,
  steps: z.array(z.object({ status, reason: nonempty.optional(), code: nonempty.optional() })).min(1),
});
const liveSchema = z.object({
  ...runIdentity,
  schema_version: z.literal(2),
  provenance: z.literal('live_testrail'),
  testrail_version: z.string().regex(/^10\.8\.1(?:\.\d+)?$/u),
  stopped: z.null(),
  server: z.object({
    package_version: version,
    driver_version: version,
    node_version: runtime,
    production_dependencies: z.record(nonempty, nonempty),
  }),
  summary: z.strictObject({ pass: z.int().nonnegative(), blocked: z.int().nonnegative(), not_run: z.int().nonnegative(), fail: z.literal(0) }),
  tools: z.record(z.string().regex(/^testrail_[a-z_]+$/u), liveTool),
  cleanup: z.object({
    project: z.enum(['deleted', 'deleted_in_cleanup']),
    project_verified_absent: z.literal(true),
    verified: z.object({ gone: z.int().positive(), present: z.literal(0), unverified: z.literal(0) }),
    residue: z.array(z.never()),
  }),
});
const qualificationSchema = z.strictObject({ schema_version: z.literal(1), clients: z.array(clientSchema).length(4), live: liveSchema });

function requireRunIdentity(run, candidate, publishedAt) {
  const startedAt = Date.parse(run.started_at);
  const finishedAt = Date.parse(run.finished_at);
  if (run.source_commit !== candidate.source_commit || run.integrity !== candidate.integrity
    || run.server.package_version !== candidate.package_version || run.server.driver_version !== candidate.driver_version
    || startedAt < Date.parse(candidate.prepared_at) || finishedAt < startedAt || finishedAt > Date.parse(publishedAt)) {
    throw new Error('Qualification must match the candidate and finish between its preparation and release');
  }
}

export function renderLiveLimitations(tools) {
  const lines = [];
  for (const [name, tool] of Object.entries(tools).sort(([left], [right]) => left.localeCompare(right))) {
    const explanations = tool.steps.filter(({ status: verdict }) => verdict === 'blocked' || verdict === 'not_run').map((step) => {
      const reason = step.reason ?? step.code;
      if (reason === undefined || /[\r\n<>]/u.test(reason)) throw new Error(`Missing or invalid live limitation for ${name}`);
      return `${step.status}: ${reason}`;
    });
    if (explanations.length > 0) lines.push(`- \`${name}\` — ${[...new Set(explanations)].join(', ')}`);
  }
  return [BEGIN_LIMITATIONS, ...(lines.length === 0 ? ['All tools completed without recorded limitations.'] : lines), END_LIMITATIONS].join('\n');
}

export function validateQualification(value, { candidate, tools, publishedAt, releaseNotes, dependencies }) {
  evidenceTime.parse(publishedAt);
  const { clients, live } = qualificationSchema.parse(value);
  const expectedNames = [...tools].sort();
  if (expectedNames.length !== 133 || new Set(expectedNames).size !== 133) throw new Error('Expected all 133 distinct catalog tools');
  const catalogHash = createHash('sha256').update(expectedNames.join('\n')).digest('hex');
  if (new Set(clients.map(({ surface }) => surface)).size !== RELEASE_SURFACES.length) throw new Error('Each required client surface needs one fresh record');
  for (const client of clients) {
    requireRunIdentity(client, candidate, publishedAt);
    if (client.server.tarball_integrity !== candidate.integrity || client.catalog.sorted_names_sha256 !== catalogHash
      || client.c10.cancelled_request_id !== client.c10.notification_request_id) {
      throw new Error(`Candidate, catalog, or C10 trace mismatch for ${client.surface}`);
    }
  }
  requireRunIdentity(live, candidate, publishedAt);
  for (const [name, pinned] of Object.entries(dependencies)) {
    if (live.server.production_dependencies[name] !== pinned) throw new Error(`Live evidence must identify the installed ${name} ${pinned}`);
  }
  if (Object.keys(live.tools).sort().join('\n') !== expectedNames.join('\n')) throw new Error('Live evidence must list every catalog tool');
  const counts = { pass: 0, blocked: 0, not_run: 0, fail: 0 };
  for (const { status: verdict, steps } of Object.values(live.tools)) {
    if (toolStatus(steps) !== verdict) throw new Error('A live tool status disagrees with the recorded steps');
    counts[verdict] += 1;
  }
  if (Object.entries(counts).some(([verdict, count]) => live.summary[verdict] !== count)
    || live.tools.testrail_add_project?.status !== 'pass' || live.tools.testrail_delete_project?.status !== 'pass') {
    throw new Error('Live qualification needs matching counts and a successful project creation and deletion');
  }
  const limitations = renderLiveLimitations(live.tools);
  if (releaseNotes.split(BEGIN_LIMITATIONS).length !== 2 || releaseNotes.split(END_LIMITATIONS).length !== 2
    || !releaseNotes.replaceAll('\r\n', '\n').includes(limitations)) {
    throw new Error('Release notes must include the exact live limitations block');
  }
}

export async function downloadReleaseAssets({ event, repository, token, request = fetch }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository) || repository !== event.repository?.full_name
    || !Number.isSafeInteger(event.release?.id) || event.release.id < 1 || !token) {
    throw new Error('The published GitHub release and repository are required');
  }
  const base = `https://api.github.com/repos/${repository}/releases`;
  async function get(path, accept) {
    const response = await request(`${base}/${path}`, {
      headers: { Accept: accept, Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Reading release metadata or assets failed with HTTP ${response.status}`);
    return response;
  }
  const release = await (await get(String(event.release.id), 'application/vnd.github+json')).json();
  if (release.id !== event.release.id || release.tag_name !== event.release.tag_name || release.draft !== false
    || release.prerelease !== false || release.published_at !== event.release.published_at || release.body !== event.release.body) {
    throw new Error('Published release metadata differs from the triggering release event');
  }
  const assets = {};
  for (const [name, limit] of Object.entries(ASSETS)) {
    const matches = release.assets.filter((asset) => asset.name === name);
    const eventMatches = event.release.assets.filter((asset) => asset.name === name);
    const [asset] = matches;
    if (matches.length !== 1 || eventMatches.length !== 1 || eventMatches[0].id !== asset.id
      || (eventMatches[0].digest != null && eventMatches[0].digest !== asset.digest)
      || !Number.isSafeInteger(asset.id) || asset.id < 1 || asset.state !== 'uploaded'
      || !Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > limit || !/^sha256:[a-f0-9]{64}$/u.test(asset.digest)) {
      throw new Error(`The release event needs exactly one verified ${name} asset`);
    }
    const response = await get(`assets/${asset.id}`, 'application/octet-stream');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length !== asset.size || `sha256:${createHash('sha256').update(bytes).digest('hex')}` !== asset.digest) {
      throw new Error(`GitHub release asset digest mismatch for ${name}`);
    }
    assets[name] = bytes;
  }
  return assets;
}

export function validateCandidateTarball({ candidate, rebuilt, tarball, sourceCommit, tag }) {
  const verified = candidateSchema.parse(candidate);
  const comparison = candidateSchema.parse(rebuilt);
  if (verified.source_commit !== sourceCommit || tag !== `release/${verified.package_version}`
    || comparison.source_commit !== verified.source_commit || comparison.package_version !== verified.package_version
    || comparison.driver_version !== verified.driver_version || comparison.integrity !== verified.integrity
    || sha512Integrity(tarball) !== verified.integrity) {
    throw new Error('The qualified tarball does not match the tagged source build');
  }
  return verified;
}

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));

async function qualificationContext(candidate, publishedAt, releaseNotes) {
  const inventory = await readJson(new URL('../docs/operation-inventory.json', import.meta.url));
  const { dependencies } = await readJson(new URL('../package.json', import.meta.url));
  if (dependencies[DRIVER_NAME] !== candidate.driver_version) throw new Error('Candidate driver pin does not match source');
  return { candidate, tools: inventory.operations.map(({ tool }) => tool), publishedAt, releaseNotes, dependencies };
}

async function verifyReleaseAssets(rebuiltDirectory, output) {
  const event = await readJson(process.env.GITHUB_EVENT_PATH);
  const assets = await downloadReleaseAssets({ event, repository: process.env.GITHUB_REPOSITORY, token: process.env.GH_TOKEN });
  const candidate = validateCandidateTarball({
    candidate: JSON.parse(assets['candidate.json'].toString('utf8')), rebuilt: await readJson(join(rebuiltDirectory, 'candidate.json')),
    tarball: assets['candidate.tgz'], sourceCommit: process.env.GITHUB_SHA, tag: event.release.tag_name,
  });
  validateQualification(JSON.parse(assets['qualification.json'].toString('utf8')),
    await qualificationContext(candidate, event.release.published_at, event.release.body));
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'candidate.tgz'), assets['candidate.tgz'], { flag: 'wx' });
  await writeFile(process.env.GITHUB_OUTPUT, `integrity=${candidate.integrity}\n`, { flag: 'a' });
  console.log(`Verified qualification for ${candidate.package_name}@${candidate.package_version} (${candidate.integrity})`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, input, output, notes] = process.argv.slice(2);
  if (mode === 'limitations' && input !== undefined) {
    const { live } = qualificationSchema.parse(JSON.parse(await readFile(input, 'utf8')));
    console.log(renderLiveLimitations(live.tools));
  } else if (mode === 'verify' && input !== undefined && output !== undefined) {
    await verifyReleaseAssets(input, output);
  } else if (mode === 'check' && input !== undefined && output !== undefined && notes !== undefined) {
    const candidate = candidateSchema.parse(await readJson(join(input, 'candidate.json')));
    if (sha512Integrity(await readFile(join(input, 'candidate.tgz'))) !== candidate.integrity) {
      throw new Error('The local tarball does not match the candidate SHA-512');
    }
    validateQualification(await readJson(output), await qualificationContext(candidate, new Date().toISOString(), await readFile(notes, 'utf8')));
    console.log(`Verified qualification for ${candidate.package_name}@${candidate.package_version} (${candidate.integrity})`);
  } else {
    throw new Error('Usage: release-evidence.mjs <limitations qualification.json|check candidate-directory qualification.json release-notes.md|verify rebuilt-directory output-directory>');
  }
}
