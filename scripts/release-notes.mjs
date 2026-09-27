#!/usr/bin/env node
/*
 * Print the CHANGELOG section for a release tag, for the GitHub release notes. It fails
 * when the tag does not match package.json, when the section is missing, or when it is
 * still marked Unreleased, so a release cannot go out with notes for another version.
 *
 *   node scripts/release-notes.mjs v1.0.0 [--changelog CHANGELOG.md] [--package package.json]
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export function releaseNotes(changelog, version) {
  const lines = changelog.split(/\r?\n/u);
  const start = lines.findIndex((line) => line.startsWith(`## [${version}]`));
  if (start === -1) throw new Error(`CHANGELOG.md has no section for ${version}.`);
  const heading = lines[start] ?? '';
  if (!/^## \[[^\]]+\] - \d{4}-\d{2}-\d{2}$/u.test(heading)) {
    throw new Error(`The ${version} section must be dated "## [${version}] - YYYY-MM-DD" before release, not "${heading}".`);
  }
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  const body = lines.slice(start + 1, end === -1 ? undefined : end).join('\n').trim();
  if (body.length === 0) throw new Error(`The ${version} section is empty.`);
  return `${body}\n`;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = new URL('../', import.meta.url);
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { changelog: { type: 'string' }, package: { type: 'string' } },
  });
  try {
    const [tag] = positionals;
    if (tag === undefined || !/^v\d+\.\d+\.\d+$/u.test(tag)) throw new Error('Give the release tag, such as v1.0.0.');
    const packageJson = JSON.parse(await readFile(values.package ?? new URL('package.json', root), 'utf8'));
    if (`v${packageJson.version}` !== tag) throw new Error(`Tag ${tag} does not match package.json version ${packageJson.version}.`);
    process.stdout.write(releaseNotes(await readFile(values.changelog ?? new URL('CHANGELOG.md', root), 'utf8'), packageJson.version));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
