#!/usr/bin/env node
/*
 * Write the CycloneDX dependency inventory of a release: the packages a user's install of
 * the release tarball actually gets.
 *
 * `npm sbom --omit dev` in the repository is not that. npm marks a package as dev when a
 * dev dependency also needs it, so zod and @modelcontextprotocol/core, which the server
 * needs at run time but @modelcontextprotocol/client needs too, would be left out. This
 * installs the packed package's production dependencies alone, from the lockfile, into a
 * scratch copy of the package, and inventories that. Before writing, it checks the
 * inventory lists exactly the lockfile's production packages, at their locked versions.
 *
 *   node scripts/release-sbom.mjs <tarball> <out.cdx.json>
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { npmCommand } from './npm-command.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 300_000, windowsHide: true });
  if (result.error || result.status !== 0) {
    throw new Error(`${[command, ...args].join(' ')} failed (exit ${String(result.status)}).\n${[result.error?.message, result.stderr].filter(Boolean).join('\n').slice(0, 4000)}`);
  }
  return result.stdout;
}

/** The lockfile's production packages, as name@version. */
export function productionPackages(lockfile) {
  return Object.entries(lockfile.packages)
    .filter(([path, entry]) => path !== '' && entry.dev !== true && entry.devOptional !== true)
    .map(([path, entry]) => `${path.replace(/^.*node_modules\//u, '')}@${entry.version}`)
    .sort();
}

export function releaseSbom(tarball) {
  const directory = mkdtempSync(join(tmpdir(), 'testrail-mcp-sbom-'));
  try {
    run('tar', ['-xzf', resolve(tarball), '-C', directory], directory);
    const packageDirectory = join(directory, 'package');
    const manifest = JSON.parse(readFileSync(join(packageDirectory, 'package.json'), 'utf8'));
    const lockfile = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
    if (lockfile.name !== manifest.name || lockfile.packages[''].version !== manifest.version) {
      throw new Error(`The lockfile describes ${String(lockfile.name)}@${String(lockfile.packages[''].version)}, not ${String(manifest.name)}@${String(manifest.version)}.`);
    }
    // The scratch copy declares only what a user's install gets.
    delete manifest.devDependencies;
    writeFileSync(join(packageDirectory, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    copyFileSync(join(root, 'package-lock.json'), join(packageDirectory, 'package-lock.json'));
    const [npm, prefix] = npmCommand();
    run(npm, [...prefix, 'ci', '--omit', 'dev', '--ignore-scripts', '--no-audit', '--no-fund'], packageDirectory);
    const sbom = JSON.parse(run(npm, [...prefix, 'sbom', '--sbom-format', 'cyclonedx'], packageDirectory));
    sbom.metadata.component.name = manifest.name;
    const listed = sbom.components.map(({ name, version }) => `${name}@${version}`).sort();
    const expected = productionPackages(lockfile);
    if (JSON.stringify(listed) !== JSON.stringify(expected)) {
      throw new Error(`The inventory lists ${listed.join(', ')}, not the lockfile's production packages ${expected.join(', ')}.`);
    }
    return sbom;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const [tarball, out] = process.argv.slice(2);
  try {
    if (tarball === undefined || out === undefined) throw new Error('Usage: release-sbom.mjs <tarball> <out.cdx.json>');
    writeFileSync(out, `${JSON.stringify(releaseSbom(tarball), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
