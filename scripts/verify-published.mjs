#!/usr/bin/env node
/*
 * Verify a published release as users will receive it. Install the package from its
 * source into a clean prefix, with no TestRail variables, and confirm:
 * - the installed name and version;
 * - with --integrity, that the registry serves exactly the tarball the release built;
 * - with --require-provenance, that the registry holds a provenance attestation;
 * - that the installed executable serves all 133 tools over MCP in both protocol eras,
 *   against the loopback stand-in used by the package check.
 * The source is a registry spec such as @dichovsky/testrail-mcp@1.0.0, or a local tarball
 * path, which is how the test exercises it without a registry.
 *
 *   node scripts/verify-published.mjs <spec-or-tarball> --version 1.0.0 [--integrity sha512-...] [--require-provenance]
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { verifyProtocol } from './package-protocol.mjs';

const NAME = '@dichovsky/testrail-mcp';
const root = new URL('../', import.meta.url);
const cleanEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^TESTRAIL/iu.test(key)));

function npm(args, cwd) {
  const npmExecutable = process.env.npm_execpath;
  const [command, prefix] = npmExecutable === undefined ? ['npm', []] : [process.execPath, [npmExecutable]];
  const result = spawnSync(command, [...prefix, ...args], {
    cwd, env: cleanEnvironment, encoding: 'utf8', timeout: 180_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
    shell: npmExecutable === undefined && process.platform === 'win32',
  });
  if (result.error || result.status !== 0) {
    throw new Error(`npm ${args[0]} failed (exit ${result.status}).\n${[result.error?.message, result.stderr].filter(Boolean).join('\n').slice(0, 4000)}`);
  }
  return result.stdout;
}

/** The registry can lag a publish by some seconds; retry a read a few times before failing. */
async function eventually(read) {
  let last;
  for (const wait of [0, 5_000, 10_000, 20_000, 40_000]) {
    if (wait > 0) await new Promise((resolve) => { setTimeout(resolve, wait); });
    try { return read(); } catch (error) { last = error; }
  }
  throw last;
}

export async function verifyPublished({ source, version, integrity, requireProvenance = false }) {
  const directory = mkdtempSync(join(tmpdir(), 'testrail-mcp-published-'));
  try {
    const registry = !source.endsWith('.tgz');
    if (registry && integrity !== undefined) {
      const served = await eventually(() => JSON.parse(npm(['view', source, 'dist.integrity', '--json'], directory)));
      assert.equal(served, integrity, 'The registry serves a different tarball from the one this release built.');
    }
    if (registry && requireProvenance) {
      const attestations = await eventually(() => JSON.parse(npm(['view', source, 'dist.attestations', '--json'], directory)));
      assert.ok(attestations && typeof attestations === 'object' && attestations.provenance, 'The published version has no provenance attestation.');
    }
    const prefix = join(directory, 'install');
    mkdirSync(prefix);
    await eventually(() => npm(['install', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', source], directory));
    const installed = join(prefix, 'node_modules', '@dichovsky', 'testrail-mcp');
    const manifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
    assert.equal(manifest.name, NAME);
    assert.equal(manifest.version, version);
    const inventory = JSON.parse(readFileSync(new URL('docs/operation-inventory.json', root), 'utf8'));
    const downloadDirectory = join(directory, 'downloads');
    mkdirSync(downloadDirectory);
    const eras = await verifyProtocol({
      command: process.execPath,
      args: [join(installed, 'dist', 'cli.js')],
      env: cleanEnvironment,
      downloadDirectory,
      tools: inventory.operations.map(({ tool }) => tool),
    });
    return { name: manifest.name, version: manifest.version, eras };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { version: { type: 'string' }, integrity: { type: 'string' }, 'require-provenance': { type: 'boolean', default: false } },
  });
  const [source] = positionals;
  if (source === undefined || values.version === undefined) {
    process.stderr.write('Usage: verify-published.mjs <spec-or-tarball> --version X.Y.Z [--integrity sha512-...] [--require-provenance]\n');
    process.exit(2);
  }
  verifyPublished({
    source, version: values.version, requireProvenance: values['require-provenance'],
    ...(values.integrity === undefined ? {} : { integrity: values.integrity }),
  }).then(
    ({ name, version, eras }) => { process.stdout.write(`Published package verified: ${name}@${version}; MCP over stdio (${eras.join(', ')}).\n`); },
    (error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exit(1); },
  );
}
