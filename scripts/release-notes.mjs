#!/usr/bin/env node
/*
 * Print the CHANGELOG section for a release tag, for the GitHub Release's notes. It fails
 * when the tag does not match package.json, when the section is missing, or when it is
 * still marked Unreleased, so a release cannot go out with notes for another version. A
 * release page resolves no link against the repository, so relative links are pointed at
 * the tagged tree of the GitHub repository package.json names.
 *
 *   node scripts/release-notes.mjs release/1.0.0 [--changelog CHANGELOG.md] [--package package.json]
 */
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export function releaseNotes(changelog, version, repository) {
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
  const notes = `${body}\n`;
  if (repository === undefined) return notes;
  // A target with a scheme, an anchor or a root path is left as it is.
  return notes.replace(/\]\((?![a-z][a-z\d+.-]*:|[#/])([^)\s]+)\)/giu, (_link, target) => `](${repository}/blob/release/${version}/${target})`);
}

/** The GitHub repository a package.json names, as https://github.com/owner/name. */
export function githubRepository(packageJson) {
  const { repository } = packageJson;
  const url = typeof repository === 'string' ? repository : repository?.url;
  return typeof url === 'string' ? /^(?:git\+)?(https:\/\/github\.com\/[^/]+\/[^/]+?)(?:\.git)?$/u.exec(url)?.[1] : undefined;
}

// Compared through the real path, so a symlinked invocation still runs the gate.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const root = new URL('../', import.meta.url);
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { changelog: { type: 'string' }, package: { type: 'string' } },
  });
  try {
    const [tag] = positionals;
    if (tag === undefined || !/^release\/\d+\.\d+\.\d+$/u.test(tag)) throw new Error('Give the release tag, such as release/1.0.0.');
    const packageJson = JSON.parse(await readFile(values.package ?? new URL('package.json', root), 'utf8'));
    if (`release/${packageJson.version}` !== tag) throw new Error(`Tag ${tag} does not match package.json version ${packageJson.version}.`);
    process.stdout.write(releaseNotes(await readFile(values.changelog ?? new URL('CHANGELOG.md', root), 'utf8'), packageJson.version, githubRepository(packageJson)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
