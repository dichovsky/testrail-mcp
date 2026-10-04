// Release preflight for the Publish workflow, ported from @dichovsky/testrail-api-client's
// scripts/release-preflight.ts so both packages release the same way.
//
//   node scripts/release-preflight.mjs context    # the release's identity, before any gate
//   node scripts/release-preflight.mjs registry   # npm's state, after every gate
//
// `context` checks that a published, stable GitHub Release for the tag release/<version>,
// the checked-out commit, the event's commit and the tag all name one commit on main, and
// that package.json and the lockfile name this package at that version. `registry` then
// asks npm, with an isolated configuration, whether the version is already published. It
// writes `already-published=true` only for an identical release: same gitHead, `latest`,
// SLSA provenance and packed files. A new version must be newer than `latest` and than
// every published stable version. Any other registry answer stops the release.
//
// One rule differs from the driver's: until this package's first stable release, npm's
// `latest` is the deprecated pre-release placeholder 0.0.0-bootstrap.0. A pre-release
// `latest` is accepted only while no stable version is published, and the candidate must
// still be newer than it.
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXPECTED_PACKAGE_NAME = '@dichovsky/testrail-mcp';
export const NPM_REGISTRY = 'https://registry.npmjs.org/';
export const SLSA_PROVENANCE_PREDICATE = 'https://slsa.dev/provenance/v1';

const STABLE_SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

function requireString(record, key, source) {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${source} must contain a non-empty string ${key}`);
  return value;
}

/** The release identity in package.json, read without trusting unchecked JSON. */
export function parsePackageIdentity(value, source) {
  if (!isRecord(value)) throw new Error(`${source} must contain a JSON object`);
  return { name: requireString(value, 'name', source), version: requireString(value, 'version', source) };
}

/** The root package identity in package-lock.json, which its two copies must agree on. */
export function parseLockfileIdentity(value) {
  if (!isRecord(value) || !isRecord(value.packages) || !isRecord(value.packages[''])) {
    throw new Error('package-lock.json must contain a root packages[""] object');
  }
  const topLevel = parsePackageIdentity(value, 'package-lock.json');
  const root = parsePackageIdentity(value.packages[''], 'package-lock.json root package');
  if (topLevel.name !== root.name || topLevel.version !== root.version) {
    throw new Error('package-lock.json top-level and root package identities must match');
  }
  return root;
}

function normalizeSha(value, label) {
  const normalized = value.toLowerCase();
  if (!COMMIT_SHA_PATTERN.test(normalized)) throw new Error(`${label} must be a full 40-character commit SHA`);
  return normalized;
}

/**
 * Every identity boundary a GitHub `release: published` event supplies, checked before
 * the workflow can reach the npm publish step.
 */
export function validateReleaseContext(input) {
  const { packageIdentity, lockfileIdentity } = input;
  if (packageIdentity.name !== EXPECTED_PACKAGE_NAME) throw new Error(`package.json name must be ${EXPECTED_PACKAGE_NAME}`);
  if (lockfileIdentity.name !== packageIdentity.name) throw new Error('package-lock.json package name does not match package.json');
  if (!STABLE_SEMVER_PATTERN.test(packageIdentity.version)) throw new Error('package.json version must be a stable semantic version');
  if (lockfileIdentity.version !== packageIdentity.version) throw new Error('package-lock.json package version does not match package.json');
  if (input.eventName !== 'release' || input.releaseAction !== 'published') {
    throw new Error('publish is allowed only for a published GitHub Release event');
  }
  if (input.releaseDraft !== 'false' || input.releasePrerelease !== 'false') {
    throw new Error('draft and prerelease GitHub Releases cannot publish to the stable npm channel');
  }
  const expectedTag = `release/${packageIdentity.version}`;
  if (input.releaseTag !== expectedTag) throw new Error(`release tag must exactly match ${expectedTag}`);
  if (input.githubRef !== `refs/tags/${expectedTag}`) throw new Error('GitHub release ref does not match the validated release tag');
  const githubSha = normalizeSha(input.githubSha, 'GITHUB_SHA');
  const headSha = normalizeSha(input.headSha, 'checked-out HEAD');
  const tagSha = normalizeSha(input.tagSha, 'release tag target');
  if (githubSha !== headSha || githubSha !== tagSha) {
    throw new Error('release tag, checked-out HEAD, and GITHUB_SHA must identify the same commit');
  }
  if (!input.mainContainsRelease) throw new Error('release SHA must be reachable from origin/main');
  return packageIdentity;
}

function parseJson(output, label) {
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(`npm returned invalid JSON for ${label}`);
  }
}

/** npm's version-dependent scalar-or-array JSON output, as a list of strings. */
export function parseNpmStringList(output, label) {
  const value = parseJson(output, label);
  if (typeof value === 'string') return [value];
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) return [...value];
  throw new Error(`npm returned an unexpected value for ${label}`);
}

function parsePublishedMetadata(output) {
  const parsed = parseJson(output, 'published version metadata');
  let value = parsed;
  if (Array.isArray(parsed)) {
    if (parsed.length !== 1) throw new Error('npm returned unexpected published version metadata');
    value = parsed[0];
  }
  if (!isRecord(value)) throw new Error('npm returned unexpected published version metadata');
  const version = requireString(value, 'version', 'published npm metadata');
  const gitHead = value.gitHead;
  const latestVersion = value['dist-tags.latest'];
  const attestations = value['dist.attestations'];
  let provenancePredicate;
  if (isRecord(attestations) && isRecord(attestations.provenance) && typeof attestations.provenance.predicateType === 'string') {
    provenancePredicate = attestations.provenance.predicateType;
  }
  if (gitHead !== undefined && (typeof gitHead !== 'string' || gitHead.length === 0)) {
    throw new Error('published npm metadata contains an invalid gitHead');
  }
  if (latestVersion !== undefined && (typeof latestVersion !== 'string' || latestVersion.length === 0)) {
    throw new Error('published npm metadata contains an invalid latest dist-tag');
  }
  return {
    version,
    ...(typeof gitHead === 'string' ? { gitHead } : {}),
    ...(typeof latestVersion === 'string' ? { latestVersion } : {}),
    ...(provenancePredicate === undefined ? {} : { provenancePredicate }),
  };
}

/**
 * One exact-version `npm view`. Only an explicit registry E404 means the immutable version
 * is absent; every other failure blocks.
 */
export function parseNpmViewResult(status, output) {
  if (status === 0) return parsePublishedMetadata(output);
  const parsed = parseJson(output, 'registry error');
  if (isRecord(parsed) && isRecord(parsed.error) && parsed.error.code === 'E404') return null;
  throw new Error('npm registry lookup failed without an exact E404; refusing to publish');
}

function atLeast(version, [major, minor, patch], what) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(version);
  if (match === null) throw new Error(`${what} version is not valid semantic version output`);
  const [, a, b, c] = match.map(Number);
  if (!(a > major || (a === major && (b > minor || (b === minor && c >= patch))))) {
    throw new Error(`${what} >= ${String(major)}.${String(minor)}.${String(patch)} is required for Trusted Publishing`);
  }
}

/** npm's minimum version for OIDC trusted publishing. */
export function validateTrustedPublishingNpmVersion(version) {
  atLeast(version, [11, 5, 1], 'npm');
}

/** The Node runtime npm's OIDC trusted publishing supports. */
export function validateTrustedPublishingNodeVersion(version) {
  atLeast(version, [22, 14, 0], 'Node');
}

/** A version's numeric core, and whether it is a pre-release. */
function semver(version, label) {
  const match = SEMVER_PATTERN.exec(version);
  if (match === null) throw new Error(`${label} must be a semantic version`);
  return { core: [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])], prerelease: match[4] !== undefined };
}

function compareCores(left, right) {
  for (const index of [0, 1, 2]) {
    if (left[index] > right[index]) return 1;
    if (left[index] < right[index]) return -1;
  }
  return 0;
}

/** Whether a stable candidate takes precedence over a version, which may be a pre-release. */
function newerThan(candidate, version, label) {
  const { core, prerelease } = semver(version, label);
  const order = compareCores(semver(candidate, 'candidate package version').core, core);
  return order > 0 || (order === 0 && prerelease);
}

/**
 * A new stable version must advance both `latest` and every published stable version. A
 * pre-release `latest` is the placeholder before the first stable release, and is
 * accepted only while no stable version is published.
 */
export function validateNewStableVersion({ candidateVersion, publishedVersions, latestVersion }) {
  if (!STABLE_SEMVER_PATTERN.test(candidateVersion)) throw new Error('candidate package version must be a stable semantic version');
  if (publishedVersions.length === 0) throw new Error('npm returned no published versions for the existing package');
  if (!publishedVersions.includes(latestVersion)) throw new Error('npm latest version is absent from the published version list');
  const stableVersions = publishedVersions.filter((version) => STABLE_SEMVER_PATTERN.test(version));
  if (!STABLE_SEMVER_PATTERN.test(latestVersion)) {
    semver(latestVersion, 'npm latest version');
    if (stableVersions.length > 0) throw new Error('npm latest is a pre-release although stable versions are published');
  } else if (stableVersions.length === 0) {
    throw new Error('npm returned no stable published versions');
  }
  if (!newerThan(candidateVersion, latestVersion, 'npm latest version') || !stableVersions.every((version) => newerThan(candidateVersion, version, 'published version'))) {
    throw new Error('new package version must be newer than npm latest and every published stable version');
  }
}

/** `npm diff` exits zero even for differences, so its output must be empty as well. */
export function validateNpmDiffResult(status, output) {
  if (status !== 0 || output.trim().length !== 0) {
    throw new Error('published npm package content differs from the prepared release; refusing to skip');
  }
}

/**
 * Whether an existing immutable npm version is this same current release. A historical
 * release fails this once `latest` advances, so only the active release can re-run green.
 */
export function shouldSkipPublishedVersion({ packageVersion, releaseSha, publishedMetadata }) {
  if (publishedMetadata === null) return false;
  if (publishedMetadata.version !== packageVersion) {
    throw new Error('npm reports the requested version as published but returned a different version identity');
  }
  if (publishedMetadata.gitHead === undefined || publishedMetadata.gitHead.length === 0) {
    throw new Error('npm reports the requested version as published without a gitHead; refusing to skip');
  }
  if (publishedMetadata.latestVersion !== packageVersion) {
    throw new Error('npm latest dist-tag does not identify the requested version; refusing to skip');
  }
  if (publishedMetadata.provenancePredicate !== SLSA_PROVENANCE_PREDICATE) {
    throw new Error('npm reports the requested version without SLSA provenance; refusing to skip');
  }
  if (normalizeSha(publishedMetadata.gitHead, 'published npm gitHead') !== normalizeSha(releaseSha, 'release SHA')) {
    throw new Error('published npm gitHead does not match the release SHA; refusing to skip');
  }
  return true;
}

function parseJsonFile(filePath) {
  const contents = readFileSync(filePath, 'utf8');
  try {
    return JSON.parse(contents);
  } catch {
    throw new Error(`${filePath} contains invalid JSON`);
  }
}

function requireEnv(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function runCommand(command, args, label) {
  const result = spawnSync(command, args, { cwd: process.cwd(), encoding: 'utf8', shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error !== undefined || result.status !== 0 || typeof result.stdout !== 'string') throw new Error(`${label} failed; refusing to publish`);
  return result.stdout.trim();
}

/** The environment without any npm configuration or token a step may have set. */
function sanitizedNpmEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => {
    const normalized = name.toUpperCase();
    return !normalized.startsWith('NPM_CONFIG_') && normalized !== 'NODE_AUTH_TOKEN' && normalized !== 'NPM_TOKEN' && normalized !== 'NPM_ID_TOKEN';
  }));
}

function withNpmIsolation(callback) {
  const cwd = mkdtempSync(join(tmpdir(), 'testrail-mcp-release-preflight-'));
  const userConfig = join(cwd, 'user.npmrc');
  const globalConfig = join(cwd, 'global.npmrc');
  writeFileSync(userConfig, '', 'utf8');
  writeFileSync(globalConfig, '', 'utf8');
  try {
    return callback({ cwd, userConfig, globalConfig, env: sanitizedNpmEnvironment() });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

const isolatedNpmArgs = (args, isolation) => [...args, `--userconfig=${isolation.userConfig}`, `--globalconfig=${isolation.globalConfig}`, `--registry=${NPM_REGISTRY}`];

function isolatedNpm(args, isolation) {
  return spawnSync('npm', isolatedNpmArgs(args, isolation), {
    cwd: isolation.cwd, env: isolation.env, encoding: 'utf8', shell: false, stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function queryPublishedMetadata(spec, isolation) {
  const result = isolatedNpm(['view', spec, 'version', 'gitHead', 'dist-tags.latest', 'dist.attestations', '--json'], isolation);
  if (result.error !== undefined || result.status === null || typeof result.stdout !== 'string') throw new Error('npm registry lookup failed; refusing to publish');
  return parseNpmViewResult(result.status, result.stdout.trim());
}

function requirePublishedContentMatch(spec, isolation) {
  const result = isolatedNpm(['diff', `--diff=${REPOSITORY_ROOT}`, `--diff=${spec}`, '--diff-name-only', '--ignore-scripts'], isolation);
  if (result.error !== undefined || result.status === null || typeof result.stdout !== 'string') {
    throw new Error('npm package content comparison failed; refusing to publish');
  }
  validateNpmDiffResult(result.status, result.stdout);
}

function npmView(args, label, isolation) {
  const result = isolatedNpm(['view', ...args], isolation);
  if (result.error !== undefined || result.status !== 0 || typeof result.stdout !== 'string') throw new Error(`${label} failed; refusing to publish`);
  return result.stdout.trim();
}

function singleNpmString(output, label) {
  const values = parseNpmStringList(output, label);
  if (values.length !== 1) throw new Error(`npm returned ${String(values.length)} values for ${label}`);
  return values[0];
}

function loadAndValidateContext() {
  const packageIdentity = parsePackageIdentity(parseJsonFile(resolve('package.json')), 'package.json');
  const lockfileIdentity = parseLockfileIdentity(parseJsonFile(resolve('package-lock.json')));
  const releaseTag = requireEnv('RELEASE_TAG');
  const headSha = runCommand('git', ['rev-parse', '--verify', 'HEAD^{commit}'], 'resolving checked-out HEAD');
  const tagSha = runCommand('git', ['rev-parse', '--verify', `refs/tags/${releaseTag}^{commit}`], 'resolving release tag');
  runCommand('git', ['merge-base', '--is-ancestor', headSha, 'origin/main'], 'verifying release ancestry on origin/main');
  validateTrustedPublishingNodeVersion(process.versions.node);
  validateTrustedPublishingNpmVersion(runCommand('npm', ['--version'], 'checking npm version'));
  return validateReleaseContext({
    packageIdentity,
    lockfileIdentity,
    eventName: requireEnv('GITHUB_EVENT_NAME'),
    releaseAction: requireEnv('RELEASE_ACTION'),
    releaseDraft: requireEnv('RELEASE_DRAFT'),
    releasePrerelease: requireEnv('RELEASE_PRERELEASE'),
    releaseTag,
    githubRef: requireEnv('GITHUB_REF'),
    githubSha: requireEnv('GITHUB_SHA'),
    headSha,
    tagSha,
    mainContainsRelease: true,
  });
}

function runContextCheck() {
  const identity = loadAndValidateContext();
  process.stdout.write(`Verified ${identity.name}@${identity.version} release identity.\n`);
}

function runRegistryCheck() {
  const identity = loadAndValidateContext();
  const spec = `${identity.name}@${identity.version}`;
  const alreadyPublished = withNpmIsolation((isolation) => {
    const published = shouldSkipPublishedVersion({
      packageVersion: identity.version,
      releaseSha: requireEnv('GITHUB_SHA'),
      publishedMetadata: queryPublishedMetadata(spec, isolation),
    });
    if (published) {
      requirePublishedContentMatch(spec, isolation);
    } else {
      validateNewStableVersion({
        candidateVersion: identity.version,
        publishedVersions: parseNpmStringList(npmView([identity.name, 'versions', '--json'], 'looking up published npm versions', isolation), 'published versions'),
        latestVersion: singleNpmString(npmView([identity.name, 'dist-tags.latest', '--json'], 'looking up npm latest', isolation), 'npm latest'),
      });
    }
    return published;
  });
  appendFileSync(requireEnv('GITHUB_OUTPUT'), `already-published=${String(alreadyPublished)}\n`, 'utf8');
  process.stdout.write(alreadyPublished
    ? `::notice::Verified identical ${identity.name}@${identity.version}; skipping publish.\n`
    : `Verified ${identity.name}@${identity.version} is not present on npm.\n`);
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  try {
    const mode = process.argv[2];
    if (mode === 'context') runContextCheck();
    else if (mode === 'registry') runRegistryCheck();
    else throw new Error('usage: release-preflight.mjs <context|registry>');
  } catch (error) {
    process.stderr.write(`Release preflight failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
