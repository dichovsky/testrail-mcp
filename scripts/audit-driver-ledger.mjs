// Re-check every entry of tests/fixtures/driver-releases.json against its sources: each
// git blob ID against a clone of the driver, and each integrity and shipped-file SHA-256
// against the tarball npm serves. This needs git, npm and a network, so it is a manual
// audit rather than part of `npm run check`, which holds only the installed release.
//
// Usage: node scripts/audit-driver-ledger.mjs <path to a clone of testrail-api-client>
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [clone] = process.argv.slice(2);
if (clone === undefined) throw new Error('Pass the path to a clone of the driver repository');
const ledger = JSON.parse(await readFile(new URL('../tests/fixtures/driver-releases.json', import.meta.url), 'utf8'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const mismatches = [];
let checked = 0;

function blob(commit, path) {
  try {
    return execFileSync('git', ['-C', clone, 'rev-parse', '-q', '--verify', `${commit}:${path}`], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

for (const release of ledger.releases) {
  const work = await mkdtemp(join(tmpdir(), 'driver-ledger-'));
  try {
    const report = JSON.parse(execFileSync(npm, ['pack', '--json', '--pack-destination', work, `@dichovsky/testrail-api-client@${release.version}`], {
      encoding: 'utf8', shell: process.platform === 'win32',
    }));
    // npm 12 keys the JSON report by package name; npm 10/11 return an array.
    const reports = Array.isArray(report) ? report : Object.values(report);
    const packed = reports.length === 1 ? reports[0] : undefined;
    if (packed?.name !== '@dichovsky/testrail-api-client' || packed.version !== release.version) {
      throw new Error(`npm pack did not report exactly @dichovsky/testrail-api-client@${release.version}`);
    }
    const tarball = join(work, packed.filename);
    const integrity = `sha512-${createHash('sha512').update(await readFile(tarball)).digest('base64')}`;
    if (integrity !== release.integrity) mismatches.push(`${release.version}: integrity ${integrity}`);
    execFileSync('tar', ['-xzf', tarball, '-C', work]);
    for (const [path, file] of Object.entries(release.files)) {
      checked += 1;
      const actualBlob = blob(release.commit, path);
      if (actualBlob !== file.git_blob) mismatches.push(`${release.version} ${path}: git blob ${actualBlob}`);
      let sha = null;
      try {
        sha = createHash('sha256').update(await readFile(join(work, 'package', file.package_file))).digest('hex');
      } catch {
        sha = null;
      }
      if (sha !== file.package_sha256) mismatches.push(`${release.version} ${path}: ${file.package_file} SHA-256 ${sha}`);
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

if (mismatches.length > 0) {
  console.error(mismatches.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Driver ledger matches: ${ledger.releases.length} releases, ${checked} files, blob IDs, shipped-file hashes and integrities.`);
}
