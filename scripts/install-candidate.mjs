import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { npmCommand } from './npm-command.mjs';

const PACKAGE = '@dichovsky/testrail-mcp';
const DRIVER = '@dichovsky/testrail-api-client';
const run = promisify(execFile);
const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));

function dependencyVersions(dependencies, prefix = '') {
  return Object.entries(dependencies ?? {}).flatMap(([name, entry]) => [
    [`${prefix}${name}`, entry.version],
    ...dependencyVersions(entry.dependencies, `${prefix}${name}/node_modules/`),
  ]);
}

/** Install exactly the archive named in the candidate record and describe the running package. */
export async function installCandidate(candidateFile, tarballFile, prefix, env = process.env) {
  const candidate = await readJson(candidateFile);
  const tarball = await readFile(tarballFile);
  const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`;
  if (candidate.schema_version !== 1 || candidate.package_name !== PACKAGE || candidate.integrity !== integrity
    || !/^[a-f0-9]{40}$/u.test(candidate.source_commit) || process.versions.node.split('.')[0] !== '26'
    || !Number.isSafeInteger(candidate.prepare_run_id) || candidate.prepare_run_id < 1
    || !Number.isSafeInteger(candidate.prepare_run_attempt) || candidate.prepare_run_attempt < 1) {
    throw new Error('Expected the declared release candidate tarball, Prepare Candidate run, and a Node 26 runtime.');
  }

  await mkdir(prefix);
  const installRoot = await realpath(prefix);
  const archive = join(installRoot, 'candidate.tgz');
  await writeFile(archive, tarball, { flag: 'wx' });
  const [command, args] = npmCommand(env);
  const cleanEnvironment = Object.fromEntries(Object.entries(env).filter(([key]) => !/^TESTRAIL/iu.test(key)));
  await run(command, [...args, 'install', '--prefix', installRoot, '--ignore-scripts', '--engine-strict',
    '--no-audit', '--no-fund', archive], { cwd: installRoot, env: cleanEnvironment, timeout: 180_000 });

  const packagePath = join(installRoot, 'node_modules', PACKAGE, 'package.json');
  const pkg = await readJson(packagePath);
  const driver = await readJson(createRequire(packagePath).resolve(`${DRIVER}/package.json`));
  if (pkg.name !== PACKAGE || pkg.version !== candidate.package_version || pkg.gitHead !== candidate.source_commit
    || driver.name !== DRIVER || driver.version !== candidate.driver_version) {
    throw new Error('Installed package or driver differs from the release candidate.');
  }

  const { stdout } = await run(command, [...args, 'ls', '--offline', '--all', '--omit=dev', '--json'],
    { cwd: installRoot, env: cleanEnvironment, timeout: 30_000 });
  const installedTree = JSON.parse(stdout).dependencies?.[PACKAGE]?.dependencies;
  const productionDependencies = Object.fromEntries(dependencyVersions(installedTree));
  if (productionDependencies[DRIVER] !== driver.version) throw new Error('Could not identify the candidate dependency tree.');
  return {
    command: process.execPath,
    args: [join(installRoot, 'node_modules', PACKAGE, 'dist', 'cli.js')],
    source_commit: candidate.source_commit,
    prepare_run_id: candidate.prepare_run_id,
    prepare_run_attempt: candidate.prepare_run_attempt,
    integrity,
    package_version: pkg.version,
    driver_version: driver.version,
    node_version: process.versions.node,
    production_dependencies: productionDependencies,
  };
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const [candidate, tarball, prefix, ...extra] = process.argv.slice(2);
  if (candidate === undefined || tarball === undefined || prefix === undefined || extra.length !== 0) {
    process.stderr.write('Usage: node scripts/install-candidate.mjs <candidate.json> <candidate.tgz> <new-install-directory>\n');
    process.exitCode = 2;
  } else {
    try {
      process.stdout.write(`${JSON.stringify(await installCandidate(candidate, tarball, resolve(prefix)), null, 2)}\n`);
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  }
}
