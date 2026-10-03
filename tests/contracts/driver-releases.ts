import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';

const commit = z.string().regex(/^[0-9a-f]{40}$/);

/**
 * One driver file as a release holds it: its git blob ID at the release's tag commit, and
 * the file the published package ships for it with that file's SHA-256. Null means the
 * file is absent at that commit or from that package.
 */
const releaseFileSchema = z.strictObject({
  git_blob: z.string().regex(/^[0-9a-f]{40}$/).nullable(),
  package_file: z.string().min(1),
  package_sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
});

/**
 * A reviewed fixture's record of each driver advance: one step per advance, chained from
 * its authored_commit to its driver_commit. Each step names every driver file the fixture
 * cites and whether it changed; the audit checks the claim against the recorded release
 * hashes rather than taking it on trust. Parameter manifests and the shared domain
 * library both carry it.
 */
export const provenanceEvidenceSchema = z.array(z.strictObject({
  from_commit: commit,
  to_commit: commit,
  reviewed_on: z.iso.date(),
  files: z.array(z.strictObject({
    path: z.string().min(1),
    changed: z.boolean(),
    note: z.string().min(1).optional(),
  })).min(1),
})).min(1);

export const DriverReleasesSchema = z.strictObject({
  schema_version: z.literal(1),
  repository: z.url(),
  releases: z.array(z.strictObject({
    version: z.string().min(1),
    commit,
    integrity: z.string().regex(/^sha512-[A-Za-z0-9+/]+=*$/),
    files: z.record(z.string().min(1), releaseFileSchema),
  })).min(1),
});

export type DriverReleases = z.infer<typeof DriverReleasesSchema>;
export type DriverRelease = DriverReleases['releases'][number];
export type DriverReleaseFile = z.infer<typeof releaseFileSchema>;

/**
 * The driver releases fixtures have been reviewed against, recorded from the driver's
 * git history and its published tarballs rather than from anything this repository
 * generates. It is what a manifest's `review.evidence` is checked against, so a claim
 * that a cited file did not change between two commits is compared with recorded
 * hashes instead of being taken on trust.
 */
export async function loadDriverReleases(): Promise<DriverReleases> {
  const raw: unknown = JSON.parse(await readFile(new URL('../fixtures/driver-releases.json', import.meta.url), 'utf8'));
  return DriverReleasesSchema.parse(raw);
}

/** Whether a file differs between two releases, in its source or in what the package ships. */
export function fileChanged(from: DriverReleaseFile, to: DriverReleaseFile): boolean {
  return from.git_blob !== to.git_blob || from.package_sha256 !== to.package_sha256;
}

/**
 * The file the published package ships for a driver source path: a TypeScript module
 * under src/ is compiled to the same path under dist/, and a file the package ships
 * verbatim, such as skill/SKILL.md, is its own counterpart. Undefined for any other path.
 */
export function shippedPath(path: string): string | undefined {
  const module = /^src\/(.+)\.ts$/.exec(path);
  if (module) return `dist/${module[1] ?? ''}.js`;
  return path.startsWith('skill/') ? path : undefined;
}

/** The installed driver as the gate can see it without a network: its version, locked integrity and files. */
export interface InstalledDriver {
  version: string;
  integrity: string;
  /** The bytes of a package file, or undefined when the package has no such file. */
  read(path: string): Buffer | undefined;
}

/**
 * Hold the ledger to the installed package. Git blob IDs cannot be recomputed offline,
 * since the package ships no sources, but the installed release's integrity and every
 * shipped file the ledger names can, so the entry the manifests are checked against is
 * the release actually installed rather than one copied from another.
 */
export function auditDriverReleases(ledger: DriverReleases, installed: InstalledDriver): string[] {
  const errors: string[] = [];
  for (const key of ['version', 'commit'] as const) {
    const values = ledger.releases.map((release) => release[key]);
    for (const value of new Set(values.filter((item, index) => values.indexOf(item) !== index))) {
      errors.push(`Duplicate release ${key}: ${value}`);
    }
  }
  // Releases are listed oldest first, which is what lets an evidence step be told
  // apart from a downgrade.
  const numeric = (version: string): number[] => version.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  for (const [index, release] of ledger.releases.entries()) {
    const previous = ledger.releases[index - 1];
    if (previous === undefined) continue;
    const [a, b] = [numeric(previous.version), numeric(release.version)];
    const later = a.findIndex((part, at) => part !== (b[at] ?? 0));
    if (later === -1 || (a[later] ?? 0) > (b[later] ?? 0)) errors.push(`Release ${release.version} is not listed after ${previous.version}`);
  }
  for (const release of ledger.releases) {
    for (const [path, file] of Object.entries(release.files)) {
      const expected = shippedPath(path);
      if (file.package_file !== expected) {
        errors.push(`${release.version} ${path}: package_file ${file.package_file} is not the file the package ships for it (${expected ?? 'none known'})`);
      }
    }
  }
  const release = ledger.releases.find(({ version }) => version === installed.version);
  if (release === undefined) {
    errors.push(`No recorded release for installed driver ${installed.version}`);
    return errors;
  }
  if (release.integrity !== installed.integrity) {
    errors.push(`Release ${release.version} integrity disagrees with the locked package`);
  }
  for (const [path, file] of Object.entries(release.files)) {
    const bytes = installed.read(file.package_file);
    if (file.package_sha256 === null) {
      if (bytes !== undefined) errors.push(`${path}: ${file.package_file} is installed but recorded as absent`);
    } else if (bytes === undefined) {
      errors.push(`${path}: ${file.package_file} is recorded but not installed`);
    } else if (createHash('sha256').update(bytes).digest('hex') !== file.package_sha256) {
      errors.push(`${path}: installed ${file.package_file} does not match its recorded SHA-256`);
    }
  }
  return errors;
}
