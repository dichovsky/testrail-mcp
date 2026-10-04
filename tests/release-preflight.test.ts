import { describe, expect, it } from 'vitest';

/*
 * The Publish workflow's preflight, ported from @dichovsky/testrail-api-client with its
 * tests. `context` accepts only one exact, stable release identity; `registry` fails closed
 * on every npm answer but an explicit E404 or an identical current release, and allows a
 * new version only when it advances npm's `latest` and every published stable version.
 * Unlike the driver, a pre-release `latest`, which this package's placeholder is until
 * 1.0.0, is accepted while no stable version is published.
 */

interface PackageIdentity { name: string; version: string }
interface ReleaseContextInput {
  packageIdentity: PackageIdentity;
  lockfileIdentity: PackageIdentity;
  eventName: string;
  releaseAction: string;
  releaseDraft: string;
  releasePrerelease: string;
  releaseTag: string;
  githubRef: string;
  githubSha: string;
  headSha: string;
  tagSha: string;
  mainContainsRelease: boolean;
}
interface PublishedVersionMetadata { version: string; gitHead?: string; latestVersion?: string; provenancePredicate?: string }
interface Preflight {
  EXPECTED_PACKAGE_NAME: string;
  SLSA_PROVENANCE_PREDICATE: string;
  parseLockfileIdentity: (value: unknown) => PackageIdentity;
  parseNpmStringList: (output: string, label: string) => string[];
  parseNpmViewResult: (status: number, output: string) => PublishedVersionMetadata | null;
  parsePackageIdentity: (value: unknown, source: string) => PackageIdentity;
  shouldSkipPublishedVersion: (input: { packageVersion: string; releaseSha: string; publishedMetadata: PublishedVersionMetadata | null }) => boolean;
  validateNewStableVersion: (input: { candidateVersion: string; publishedVersions: readonly string[]; latestVersion: string }) => void;
  validateNpmDiffResult: (status: number, output: string) => void;
  validateReleaseContext: (input: ReleaseContextInput) => PackageIdentity;
  validateTrustedPublishingNodeVersion: (version: string) => void;
  validateTrustedPublishingNpmVersion: (version: string) => void;
}

const {
  EXPECTED_PACKAGE_NAME, SLSA_PROVENANCE_PREDICATE, parseLockfileIdentity, parseNpmStringList, parseNpmViewResult, parsePackageIdentity,
  shouldSkipPublishedVersion, validateNewStableVersion, validateNpmDiffResult, validateReleaseContext, validateTrustedPublishingNodeVersion,
  validateTrustedPublishingNpmVersion,
} = (await import(new URL('../scripts/release-preflight.mjs', import.meta.url).href)) as Preflight;

const VERSION = '1.0.0';
const RELEASE_SHA = '1234567890abcdef1234567890abcdef12345678';
const IDENTICAL_PUBLISHED_METADATA = { version: VERSION, gitHead: RELEASE_SHA, latestVersion: VERSION, provenancePredicate: SLSA_PROVENANCE_PREDICATE } as const;

function validContext(overrides: Partial<ReleaseContextInput> = {}): ReleaseContextInput {
  return {
    packageIdentity: { name: EXPECTED_PACKAGE_NAME, version: VERSION },
    lockfileIdentity: { name: EXPECTED_PACKAGE_NAME, version: VERSION },
    eventName: 'release',
    releaseAction: 'published',
    releaseDraft: 'false',
    releasePrerelease: 'false',
    releaseTag: `release/${VERSION}`,
    githubRef: `refs/tags/release/${VERSION}`,
    githubSha: RELEASE_SHA,
    headSha: RELEASE_SHA,
    tagSha: RELEASE_SHA,
    mainContainsRelease: true,
    ...overrides,
  };
}

describe('the release context', () => {
  it('names this package', () => {
    expect(EXPECTED_PACKAGE_NAME).toBe('@dichovsky/testrail-mcp');
  });

  it('accepts one exact stable release identity', () => {
    expect(validateReleaseContext(validContext())).toEqual({ name: EXPECTED_PACKAGE_NAME, version: VERSION });
    // A commit SHA in capitals names the same commit.
    expect(validateReleaseContext(validContext({ githubSha: RELEASE_SHA.toUpperCase() }))).toEqual({ name: EXPECTED_PACKAGE_NAME, version: VERSION });
  });

  it.each([
    ['package name', { packageIdentity: { name: '@dichovsky/testrail-api-client', version: VERSION } }],
    ['lockfile name', { lockfileIdentity: { name: '@example/other', version: VERSION } }],
    ['lockfile version', { lockfileIdentity: { name: EXPECTED_PACKAGE_NAME, version: '0.9.0' } }],
    ['development package version', { packageIdentity: { name: EXPECTED_PACKAGE_NAME, version: '1.1.0-dev.0' } }],
    ['event name', { eventName: 'workflow_dispatch' }],
    ['event action', { releaseAction: 'created' }],
    ['draft release', { releaseDraft: 'true' }],
    ['prerelease release', { releasePrerelease: 'true' }],
    ['release tag', { releaseTag: 'v1.0.0' }],
    ['GitHub ref', { githubRef: 'refs/heads/main' }],
    ['GitHub SHA', { githubSha: '1234' }],
    ['checked-out SHA', { headSha: 'a'.repeat(40) }],
    ['tag target SHA', { tagSha: 'b'.repeat(40) }],
    ['origin/main ancestry', { mainContainsRelease: false }],
  ])('rejects a mismatched %s', (_label, overrides) => {
    expect(() => validateReleaseContext(validContext(overrides))).toThrow();
  });
});

describe('the release manifests', () => {
  it('reads the package and lockfile identities from unknown JSON values', () => {
    expect(parsePackageIdentity({ name: EXPECTED_PACKAGE_NAME, version: VERSION }, 'package.json')).toEqual({ name: EXPECTED_PACKAGE_NAME, version: VERSION });
    expect(parseLockfileIdentity({ name: EXPECTED_PACKAGE_NAME, version: VERSION, packages: { '': { name: EXPECTED_PACKAGE_NAME, version: VERSION } } }))
      .toEqual({ name: EXPECTED_PACKAGE_NAME, version: VERSION });
  });

  it.each([
    null,
    [],
    {},
    { packages: {} },
    { name: EXPECTED_PACKAGE_NAME, version: VERSION, packages: { '': { name: EXPECTED_PACKAGE_NAME } } },
    { name: EXPECTED_PACKAGE_NAME, version: '0.9.0', packages: { '': { name: EXPECTED_PACKAGE_NAME, version: VERSION } } },
  ])('rejects malformed lockfile identity %#', (value) => {
    expect(() => parseLockfileIdentity(value)).toThrow();
  });

  it.each([null, [], { name: EXPECTED_PACKAGE_NAME }, { name: '', version: VERSION }])('rejects malformed package identity %#', (value) => {
    expect(() => parsePackageIdentity(value, 'package.json')).toThrow();
  });
});

describe('the npm registry preflight', () => {
  it('normalizes npm scalar and array JSON output', () => {
    expect(parseNpmStringList(JSON.stringify(VERSION), 'version')).toEqual([VERSION]);
    expect(parseNpmStringList(JSON.stringify(['0.0.0-bootstrap.0', VERSION]), 'versions')).toEqual(['0.0.0-bootstrap.0', VERSION]);
    for (const output of ['not-json', '1', JSON.stringify([1])]) expect(() => parseNpmStringList(output, 'versions'), output).toThrow();
  });

  it('accepts the npm and Node versions that support trusted publishing, and nothing older', () => {
    for (const version of ['11.5.1', '11.6.0', '12.0.2']) expect(() => validateTrustedPublishingNpmVersion(version), version).not.toThrow();
    for (const version of ['11.5.0', '10.9.9', '11.5.1-beta.1', 'not-a-version']) expect(() => validateTrustedPublishingNpmVersion(version), version).toThrow();
    for (const version of ['22.14.0', '24.19.0']) expect(() => validateTrustedPublishingNodeVersion(version), version).not.toThrow();
    for (const version of ['22.13.9', '20.19.0', '22.14.0-rc.1', 'not-a-version']) expect(() => validateTrustedPublishingNodeVersion(version), version).toThrow();
  });

  it('parses present metadata and treats only an exact E404 as absence', () => {
    expect(parseNpmViewResult(0, JSON.stringify([{
      version: VERSION, gitHead: RELEASE_SHA, 'dist-tags.latest': VERSION, 'dist.attestations': { provenance: { predicateType: SLSA_PROVENANCE_PREDICATE } },
    }]))).toEqual(IDENTICAL_PUBLISHED_METADATA);
    expect(parseNpmViewResult(0, JSON.stringify({ version: VERSION }))).toEqual({ version: VERSION });
    expect(parseNpmViewResult(1, JSON.stringify({ error: { code: 'E404' } }))).toBeNull();
  });

  it.each([
    [1, JSON.stringify({ error: { code: 'E403' } })],
    [1, JSON.stringify({ error: { code: 'ETIMEDOUT' } })],
    [1, 'not-json'],
    [0, ''],
    [0, JSON.stringify([{ version: VERSION }, { version: VERSION }])],
    [0, JSON.stringify({ version: VERSION, gitHead: '' })],
    [0, JSON.stringify({ version: VERSION, 'dist-tags.latest': 1 })],
  ])('fails closed for npm status %i and output %j', (status, output) => {
    expect(() => parseNpmViewResult(status, output)).toThrow();
  });

  it('allows only a version newer than latest and every published stable version', () => {
    for (const [candidateVersion, publishedVersions, latestVersion] of [
      ['1.0.1', ['0.0.0-bootstrap.0', '1.0.0'], '1.0.0'],
      ['2.0.0', ['1.0.0', '1.1.0', '2.0.0-rc.1'], '1.1.0'],
      ['9007199254740993.0.0', ['9007199254740992.999999999999999999.999999999999999999'], '9007199254740992.999999999999999999.999999999999999999'],
    ] as const) {
      expect(() => validateNewStableVersion({ candidateVersion, publishedVersions, latestVersion }), candidateVersion).not.toThrow();
    }
  });

  it('allows the first stable release over a pre-release latest while no stable version is published', () => {
    expect(() => validateNewStableVersion({ candidateVersion: '1.0.0', publishedVersions: ['0.0.0-bootstrap.0'], latestVersion: '0.0.0-bootstrap.0' })).not.toThrow();
    expect(() => validateNewStableVersion({ candidateVersion: '1.0.0', publishedVersions: ['0.0.0-bootstrap.0', '1.0.0-rc.1'], latestVersion: '1.0.0-rc.1' })).not.toThrow();
  });

  it.each([
    ['equal latest', '1.0.0', ['0.0.0-bootstrap.0', '1.0.0'], '1.0.0'],
    ['below latest', '1.0.0', ['0.0.0-bootstrap.0', '1.1.0'], '1.1.0'],
    ['below hidden stable', '5.4.0', ['5.3.0', '6.0.0'], '5.3.0'],
    ['empty versions', VERSION, [], '0.0.0-bootstrap.0'],
    ['missing latest', VERSION, ['0.0.0-bootstrap.0'], '0.0.1'],
    ['prerelease latest after a stable release', '6.0.0', ['5.3.0', '6.0.0-rc.1'], '6.0.0-rc.1'],
    ['below a prerelease latest', '1.0.0', ['2.0.0-rc.1'], '2.0.0-rc.1'],
    ['a prerelease candidate', '1.0.0-rc.2', ['1.0.0-rc.1'], '1.0.0-rc.1'],
    ['a latest that is not a version', '1.0.0', ['latest'], 'latest'],
  ])('blocks a non-monotonic registry state: %s', (_label, candidateVersion, publishedVersions, latestVersion) => {
    expect(() => validateNewStableVersion({ candidateVersion, publishedVersions, latestVersion })).toThrow();
  });

  it('requires an empty, successful npm diff for an idempotent skip', () => {
    expect(() => validateNpmDiffResult(0, '')).not.toThrow();
    expect(() => validateNpmDiffResult(0, '\n')).not.toThrow();
    expect(() => validateNpmDiffResult(0, 'dist/cli.js\n')).toThrow();
    expect(() => validateNpmDiffResult(1, '')).toThrow();
  });

  it('publishes when the exact version is absent, and skips only an identical immutable release', () => {
    expect(shouldSkipPublishedVersion({ packageVersion: VERSION, releaseSha: RELEASE_SHA, publishedMetadata: null })).toBe(false);
    expect(shouldSkipPublishedVersion({ packageVersion: VERSION, releaseSha: RELEASE_SHA, publishedMetadata: IDENTICAL_PUBLISHED_METADATA })).toBe(true);
  });

  it.each([
    ['missing gitHead', { version: VERSION, latestVersion: VERSION, provenancePredicate: SLSA_PROVENANCE_PREDICATE }],
    ['different gitHead', { ...IDENTICAL_PUBLISHED_METADATA, gitHead: 'a'.repeat(40) }],
    ['short gitHead', { ...IDENTICAL_PUBLISHED_METADATA, gitHead: '1234' }],
    ['different version', { ...IDENTICAL_PUBLISHED_METADATA, version: '0.9.0' }],
    ['missing latest', { version: VERSION, gitHead: RELEASE_SHA, provenancePredicate: SLSA_PROVENANCE_PREDICATE }],
    ['different latest', { ...IDENTICAL_PUBLISHED_METADATA, latestVersion: '0.9.0' }],
    ['missing provenance', { version: VERSION, gitHead: RELEASE_SHA, latestVersion: VERSION }],
    ['different provenance', { ...IDENTICAL_PUBLISHED_METADATA, provenancePredicate: 'other' }],
  ])('blocks an unsafe duplicate with %s', (_label, metadata) => {
    expect(() => shouldSkipPublishedVersion({ packageVersion: VERSION, releaseSha: RELEASE_SHA, publishedMetadata: metadata })).toThrow();
  });
});
