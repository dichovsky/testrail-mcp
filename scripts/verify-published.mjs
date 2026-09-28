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
 * path, which is how the test exercises the install and MCP checks without a registry.
 * The integrity and provenance checks read the registry, so they refuse a tarball source.
 *
 *   node scripts/verify-published.mjs <spec-or-tarball> --version 1.0.0 [--integrity sha512-...] [--require-provenance]
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { npmCommand } from './npm-command.mjs';
import { verifyProtocol } from './package-protocol.mjs';

const NAME = '@dichovsky/testrail-mcp';
const root = new URL('../', import.meta.url);
const cleanEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^TESTRAIL/iu.test(key)));

function npm(args, cwd) {
  const [command, prefix] = npmCommand();
  const result = spawnSync(command, [...prefix, ...args], {
    cwd, env: cleanEnvironment, encoding: 'utf8', timeout: 180_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`npm ${args[0]} failed (exit ${String(result.status)}).\n${[result.error?.message, result.stderr].filter(Boolean).join('\n').slice(0, 4000)}`);
  }
  return result.stdout;
}

/** A field of a registry version, or undefined when the version or the field is absent. */
export function viewField(spec, field) {
  let output;
  try {
    output = npm(['view', spec, field, '--json', '--prefer-online'], tmpdir()).trim();
  } catch (error) {
    // A version the registry does not show yet, which npm reports as E404: it is still arriving.
    if (error instanceof Error && /\bE404\b/u.test(error.message)) return undefined;
    throw error;
  }
  // npm prints nothing, and succeeds, when the version exists without the field.
  return output === '' ? undefined : JSON.parse(output);
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * The registry checks. The registry can take some seconds to show a new version, so only
 * its absence is retried; once the version is there, a different tarball or a missing
 * attestation fails at once.
 */
export async function checkRegistry({ spec, integrity, requireProvenance = false, view = viewField, waits = [0, 5_000, 10_000, 20_000, 40_000] }) {
  let served;
  for (const wait of waits) {
    if (wait > 0) await sleep(wait);
    served = view(spec, 'dist.integrity');
    if (served !== undefined) break;
  }
  if (served === undefined) throw new Error(`The registry does not serve ${spec}.`);
  if (integrity !== undefined) assert.equal(served, integrity, 'The registry serves a different tarball from the one this release built.');
  if (requireProvenance) {
    const attestations = view(spec, 'dist.attestations');
    assert.ok(typeof attestations === 'object' && attestations !== null && attestations.provenance !== undefined, 'The published version has no provenance attestation.');
  }
}

export async function verifyPublished({ source, version, integrity, requireProvenance = false }) {
  const tarball = source.endsWith('.tgz');
  if (tarball && (integrity !== undefined || requireProvenance)) {
    throw new Error('--integrity and --require-provenance read the registry; give a registry spec, not a tarball.');
  }
  // A tarball path is the caller's, not the scratch directory's.
  const target = tarball ? resolve(source) : source;
  const directory = mkdtempSync(join(tmpdir(), 'testrail-mcp-published-'));
  try {
    if (!tarball) await checkRegistry({ spec: source, integrity, requireProvenance });
    const prefix = join(directory, 'install');
    mkdirSync(prefix);
    // Online, so a registry spec is resolved from the registry rather than a cached index.
    npm(['install', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', ...(tarball ? [] : ['--prefer-online']), target], directory);
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

// Compared through the real path, so a symlinked invocation still runs the check.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
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
