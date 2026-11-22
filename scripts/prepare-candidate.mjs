// Pack the built, clean release checkout without running package lifecycle scripts.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { npmCommand } from './npm-command.mjs';

export const RELEASE_NODE = '26.13.1';
export const RELEASE_NPM = '11.20.0';
export const PACKAGE_NAME = '@dichovsky/testrail-mcp';
export const DRIVER_NAME = '@dichovsky/testrail-api-client';
export const SHA_PATTERN = /^[a-f0-9]{40}$/u;
export const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
export const INTEGRITY_PATTERN = /^sha512-[A-Za-z0-9+/]{86}==$/u;

export const sha512Integrity = (bytes) => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;

async function copyDist(source, destination) {
  await mkdir(destination);
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory()) await copyDist(from, to);
    else if (entry.isFile()) await copyFile(from, to);
    else throw new Error('The built dist must contain only regular files and directories');
  }
}

export async function packCandidate({ root, output, sourceCommit, preparationRun, preparedAt = new Date().toISOString() }) {
  if (!SHA_PATTERN.test(sourceCommit)) throw new Error('Invalid source commit for the release candidate');
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const driver = manifest.dependencies?.[DRIVER_NAME];
  if (manifest.name !== PACKAGE_NAME || !VERSION_PATTERN.test(manifest.version) || !VERSION_PATTERN.test(driver)) {
    throw new Error('The candidate requires a stable package version and an exact stable driver pin');
  }
  if (manifest.gitHead !== undefined) throw new Error('gitHead must come from the verified candidate source');
  const [command, prefix] = npmCommand();
  const stage = await mkdtemp(join(tmpdir(), 'testrail-candidate-'));
  try {
    const packed = join(stage, 'packed');
    const packageRoot = join(stage, 'package');
    await mkdir(packageRoot);
    await mkdir(packed);
    await copyDist(join(root, 'dist'), join(packageRoot, 'dist'));
    await chmod(join(packageRoot, 'dist/cli.js'), 0o755);
    for (const name of ['README.md', 'LICENSE']) await copyFile(join(root, name), join(packageRoot, name));
    await writeFile(join(packageRoot, 'package.json'), `${JSON.stringify({ ...manifest, gitHead: sourceCommit }, null, 2)}\n`);
    const result = JSON.parse(execFileSync(command, [...prefix, 'pack', '--offline', '--ignore-scripts', '--json', '--pack-destination', packed], {
      cwd: packageRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 45_000,
    }));
    const [report, extra] = Array.isArray(result) ? result : Object.values(result);
    if (extra !== undefined || report?.name !== PACKAGE_NAME || report.version !== manifest.version
      || typeof report.filename !== 'string' || basename(report.filename) !== report.filename) {
      throw new Error('npm did not pack the expected candidate');
    }
    const bytes = await readFile(join(packed, report.filename));
    const integrity = sha512Integrity(bytes);
    if (integrity !== report.integrity) throw new Error('Candidate bytes disagree with npm pack integrity');
    const candidate = {
      schema_version: 1,
      package_name: PACKAGE_NAME,
      package_version: manifest.version,
      source_commit: sourceCommit,
      integrity,
      driver_version: driver,
      prepared_at: preparedAt,
      ...(preparationRun === undefined ? {} : { prepare_run_id: preparationRun.id, prepare_run_attempt: preparationRun.attempt }),
      node_version: RELEASE_NODE,
      npm_version: RELEASE_NPM,
    };
    await mkdir(output, { recursive: true });
    await writeFile(join(output, 'candidate.tgz'), bytes, { flag: 'wx' });
    await writeFile(join(output, 'candidate.json'), `${JSON.stringify(candidate, null, 2)}\n`, { flag: 'wx' });
    return candidate;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

function cleanCommit(root) {
  const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  if (git(['status', '--porcelain', '--untracked-files=no']) !== '') {
    throw new Error('The tracked candidate checkout must be clean');
  }
  return git(['rev-parse', '--verify', 'HEAD^{commit}']);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [output, runId, attempt, extra] = process.argv.slice(2);
  const usage = 'Usage: node scripts/prepare-candidate.mjs <output-directory> [run-id run-attempt]';
  if (output === undefined || extra !== undefined || (runId === undefined) !== (attempt === undefined)) throw new Error(usage);
  const preparationRun = runId === undefined ? undefined : { id: Number(runId), attempt: Number(attempt) };
  if (preparationRun !== undefined && ![preparationRun.id, preparationRun.attempt].every((value) => Number.isSafeInteger(value) && value > 0)) {
    throw new Error(usage);
  }
  const [command, prefix] = npmCommand();
  const npmVersion = execFileSync(command, [...prefix, '--version'], { encoding: 'utf8' }).trim();
  if (process.versions.node !== RELEASE_NODE || npmVersion !== RELEASE_NPM) {
    throw new Error(`Candidate packaging requires Node ${RELEASE_NODE} and npm ${RELEASE_NPM}`);
  }
  const root = fileURLToPath(new URL('../', import.meta.url));
  const candidate = await packCandidate({ root, output: resolve(output), sourceCommit: cleanCommit(root), preparationRun });
  console.log(`Packed ${candidate.package_name}@${candidate.package_version}: ${candidate.integrity}`);
}
