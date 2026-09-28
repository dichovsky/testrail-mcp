import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/*
 * R03's release pipeline, held before it ever runs. The release workflow may publish only
 * from a version tag, through npm trusted publishing in the protected environment the npm
 * configuration names, with no stored token, and once. Each job holds only the permission
 * it needs, and the one that can mint an npm token installs and runs no package code.
 * Every action in every workflow is pinned to a commit. The release notes come from a
 * dated changelog section for exactly the tagged version. The dependency inventory lists
 * what a user's install gets. The post-publish check installs the artifact, compares it
 * with the registry and drives it over MCP.
 */

// Windows checkouts may carry CRLF line endings; the checks read files as LF.
const lf = (text: string): string => text.replace(/\r\n/gu, '\n');
const read = async (path: string): Promise<string> => lf(await readFile(new URL(path, import.meta.url), 'utf8'));
const run = promisify(execFile);
const release = await read('../.github/workflows/release.yml');
const releaseDoc = await read('../docs/release.md');
const changelog = await read('../CHANGELOG.md');
const packageJson = JSON.parse(await read('../package.json')) as { version: string; dependencies: Record<string, string> };
const lockfile = JSON.parse(await read('../package-lock.json')) as { packages: Record<string, { version?: string; dev?: boolean; devOptional?: boolean }> };
const script = (name: string): string => fileURLToPath(new URL(`../scripts/${name}`, import.meta.url));
const projectRoot = fileURLToPath(new URL('..', import.meta.url));

interface Registry { checkRegistry: (options: { spec: string; integrity?: string; requireProvenance?: boolean; view: (spec: string, field: string) => unknown; waits: number[] }) => Promise<void> }
const { checkRegistry } = (await import(new URL('../scripts/verify-published.mjs', import.meta.url).href)) as Registry;

/** The lines of one job, from its key to the next job or the end. */
function job(workflow: string, name: string): string {
  const lines = workflow.split('\n');
  const start = lines.indexOf(`  ${name}:`);
  if (start === -1) return '';
  const end = lines.findIndex((line, index) => index > start && /^ {2}[a-z-]+:$/u.test(line));
  return lines.slice(start, end === -1 ? undefined : end).join('\n');
}

/** The entries of the `permissions:` block at an indent, or undefined when there is none. */
function permissions(block: string, indent: number): string[] | undefined {
  const lines = block.split('\n');
  const start = lines.indexOf(`${' '.repeat(indent)}permissions:`);
  if (start === -1) return undefined;
  const entries: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!new RegExp(`^ {${String(indent + 2)}}[a-z-]+: `, 'u').test(line)) break;
    entries.push(line.trim());
  }
  return entries;
}

/** Each job the workflow may have, with the only permissions it may hold. */
const JOBS: Record<string, string[] | undefined> = {
  verify: undefined,
  build: undefined,
  publish: ['contents: read', 'id-token: write'],
  'verify-published': undefined,
  release: ['contents: write'],
};

describe('the release workflow', () => {
  it('runs only for a version tag', () => {
    expect(release).toMatch(/^on:\n {2}push:\n {4}tags: \['v\[0-9\]\+\.\[0-9\]\+\.\[0-9\]\+'\]\n\n/mu);
    expect(release).not.toMatch(/pull_request|workflow_dispatch|branches:/u);
  });

  it('gives each job only the permissions it needs, and the environment to the publish job alone', () => {
    expect(permissions(release, 0)).toEqual(['contents: read']);
    const jobs = [...release.slice(release.indexOf('\njobs:\n')).matchAll(/^ {2}([a-z-]+):$/gmu)].map(([, name]) => name);
    expect(jobs).toEqual(Object.keys(JOBS));
    for (const [name, granted] of Object.entries(JOBS)) expect(permissions(job(release, name), 4), name).toEqual(granted);
    expect([...release.matchAll(/^ {4}environment: (.+)$/gmu)].map(([, name]) => name)).toEqual(['npm-release']);
    expect(job(release, 'publish')).toMatch(/^ {4}environment: npm-release$/mu);
  });

  it('runs the jobs in order: verify, build, publish, check the published package, then the release', () => {
    expect(job(release, 'verify')).not.toMatch(/^ {4}needs:/mu);
    expect(job(release, 'build')).toMatch(/^ {4}needs: verify$/mu);
    expect(job(release, 'publish')).toMatch(/^ {4}needs: build$/mu);
    expect(job(release, 'verify-published')).toMatch(/^ {4}needs: \[build, publish\]$/mu);
    expect(job(release, 'release')).toMatch(/^ {4}needs: \[build, verify-published\]$/mu);
  });

  it('publishes through trusted publishing with provenance, never a stored token, and runs no package code while it can', () => {
    expect(release).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN|secrets\./u);
    const publish = job(release, 'publish');
    expect(publish).toContain('npm publish "./$TARBALL" --access public --provenance --ignore-scripts');
    // The job that can mint an npm token checks out nothing, installs nothing and runs no script.
    expect(publish).not.toMatch(/actions\/checkout|npm ci|npm install|scripts\//u);
    expect(publish.match(/npm publish/gu)).toHaveLength(1);
  });

  it('builds the notes, tarball and inventory before publishing, and checks the published package before the release', () => {
    const verify = job(release, 'verify');
    expect(verify).toContain('os: [ubuntu-latest, macos-latest, windows-latest]');
    expect(verify).toContain("node: ['22', '24']");
    expect(verify).toContain('run: npm run check');
    const build = job(release, 'build');
    const order = ['scripts/release-notes.mjs "$GITHUB_REF_NAME"', 'npm pack --json', 'scripts/release-sbom.mjs', 'actions/upload-artifact'].map((step) => build.indexOf(step));
    expect(order.every((position) => position >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((left, right) => left - right));
    expect(job(release, 'verify-published')).toMatch(/scripts\/verify-published\.mjs "@dichovsky\/testrail-mcp@\$VERSION"\n\s+--version "\$VERSION" --integrity "\$INTEGRITY" --require-provenance/u);
    expect(job(release, 'release')).toContain('gh release create "$GITHUB_REF_NAME" --repo "$GITHUB_REPOSITORY" --verify-tag');
  });

  it('refuses an npm older than 11.5.1, which trusted publishing needs', async () => {
    const check = /node -e "(.+)" "\$\(npm --version\)"/u.exec(job(release, 'publish'))?.[1];
    if (check === undefined) throw new Error('no npm version check');
    for (const version of ['10.9.7', '11.4.9', '11.5.0']) {
      await expect(run(process.execPath, ['-e', check, version]), version).rejects.toMatchObject({ stderr: expect.stringContaining('older than 11.5.1') as unknown });
    }
    for (const version of ['11.5.1', '11.6.0', '12.0.0']) await expect(run(process.execPath, ['-e', check, version]), version).resolves.toBeDefined();
  });

  it.skipIf(process.platform === 'win32')('publishes a version once: a re-run with the same tarball goes on, and a different one stops', async () => {
    const step = /- name: Publish the packed tarball, with provenance, once\n[\s\S]*?run: \|\n([\s\S]*?)\n\n/u.exec(`${job(release, 'publish')}\n\n`)?.[1];
    if (step === undefined) throw new Error('no publish step');
    const base = await mkdtemp(join(tmpdir(), 'testrail-mcp-publish-'));
    try {
      // An npm stand-in: `view` prints what the registry serves; `publish` is recorded.
      await writeFile(join(base, 'npm'), '#!/bin/sh\nif [ "$1" = view ]; then printf "%s" "$SERVED"; exit 0; fi\necho "$@" >> "$PUBLISHED"\n');
      await chmod(join(base, 'npm'), 0o755);
      const publishes = async (served: string) => {
        const published = join(base, `published-${String(Math.random()).slice(2)}`);
        await writeFile(published, '');
        const env = { PATH: `${base}:${process.env.PATH ?? ''}`, SERVED: served, PUBLISHED: published, TARBALL: 'x.tgz', INTEGRITY: 'sha512-this', VERSION: '1.0.0' };
        const outcome = await run('bash', ['-e', '-c', step.replace(/^ {10}/gmu, '')], { env }).then(() => 'ok', () => 'failed');
        return { outcome, published: (await readFile(published, 'utf8')).trim() };
      };
      expect(await publishes('')).toEqual({ outcome: 'ok', published: 'publish ./x.tgz --access public --provenance --ignore-scripts' });
      expect(await publishes('sha512-this')).toEqual({ outcome: 'ok', published: '' });
      expect(await publishes('sha512-other')).toEqual({ outcome: 'failed', published: '' });
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('names the workflow file and environment that the npm setup in docs/release.md names', () => {
    expect(releaseDoc).toContain('| Workflow filename | `release.yml` |');
    expect(releaseDoc).toContain('| Environment name | `npm-release` |');
    expect(releaseDoc).toContain('| Repository | `testrail-mcp` |');
  });
});

describe('every workflow', () => {
  it('pins each action to a full commit, with the version it stands for', async () => {
    const directory = new URL('../.github/workflows/', import.meta.url);
    const workflows = (await readdir(directory)).filter((name) => /\.ya?ml$/u.test(name));
    expect(workflows.sort()).toEqual(['ci.yml', 'release.yml']);
    for (const name of workflows) {
      const text = lf(await readFile(new URL(name, directory), 'utf8'));
      const uses = [...text.matchAll(/^\s*(?:- )?uses: (\S+)(.*)$/gmu)];
      expect(uses.length, name).toBeGreaterThan(0);
      for (const [line, target = '', comment = ''] of uses) {
        expect(target, `${name}: ${line}`).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/u);
        expect(comment, `${name}: ${line}`).toMatch(/^ # v\d+\.\d+\.\d+$/u);
      }
      // Checkouts never leave the token in the repository's git configuration.
      expect([...text.matchAll(/uses: actions\/checkout@/gu)].length).toBe([...text.matchAll(/persist-credentials: false/gu)].length);
    }
  });
});

describe('the release notes', () => {
  let base: string;
  beforeAll(async () => { base = await mkdtemp(join(tmpdir(), 'testrail-mcp-release-')); });
  afterAll(async () => { await rm(base, { recursive: true, force: true }); });

  const notes = async (tag: string, log: string, version: string, via = script('release-notes.mjs')) => {
    await writeFile(join(base, 'CHANGELOG.md'), log);
    await writeFile(join(base, 'package.json'), JSON.stringify({ version }));
    return run(process.execPath, [via, tag, '--changelog', join(base, 'CHANGELOG.md'), '--package', join(base, 'package.json')]);
  };
  const dated = '# Changelog\n\n## [2.0.0] - 2026-10-01\n\n### Added\n\n- Two.\n\n## [1.0.0] - 2026-09-30\n\n- One.\n';

  it('prints exactly the tagged version\'s dated section', async () => {
    await expect(notes('v2.0.0', dated, '2.0.0')).resolves.toMatchObject({ stdout: '### Added\n\n- Two.\n' });
    await expect(notes('v1.0.0', dated, '1.0.0')).resolves.toMatchObject({ stdout: '- One.\n' });
    // Neither a longer version nor a mention of this one in a later section is its heading.
    const near = '## [1.0.10] - 2026-10-03\n\n- Ten.\n\n## [1.0.2] - 2026-10-02\n\n- Replaces 1.0.1.\n\n## [1.0.1] - 2026-10-01\n\n- One.\n';
    await expect(notes('v1.0.1', near, '1.0.1')).resolves.toMatchObject({ stdout: '- One.\n' });
  });

  it.each([
    ['a tag that does not match package.json', 'v2.0.0', dated, '1.0.0', /does not match package\.json version 1\.0\.0/u],
    ['a version with no section', 'v3.0.0', dated, '3.0.0', /no section for 3\.0\.0/u],
    ['an undated section', 'v1.0.0', '## [1.0.0] - Unreleased\n\n- One.\n', '1.0.0', /must be dated/u],
    ['an empty section', 'v1.0.0', '## [1.0.0] - 2026-09-30\n\n## [0.9.0] - 2026-09-01\n\n- Old.\n', '1.0.0', /is empty/u],
    ['a tag that is not a version', 'release-1', dated, '1.0.0', /Give the release tag/u],
  ])('refuses %s', async (_label, tag, log, version, message) => {
    await expect(notes(tag, log, version)).rejects.toMatchObject({ stderr: expect.stringMatching(message) as unknown });
  });

  it.skipIf(process.platform === 'win32')('still refuses when run through a symlinked path', async () => {
    const link = join(base, 'linked-scripts');
    await symlink(fileURLToPath(new URL('../scripts/', import.meta.url)), link);
    await expect(notes('v2.0.0', dated, '1.0.0', join(link, 'release-notes.mjs'))).rejects.toMatchObject({ stderr: expect.stringMatching(/does not match/u) as unknown });
  });

  /** What CI requires of the version and changelog, so that the version pull request can pass. */
  const readiness = async (version: string, log: string): Promise<void> => {
    if (/^\d+\.\d+\.\d+$/u.test(version)) {
      // A release version: the notes the release will carry must come out of the changelog.
      await notes(`v${version}`, log, version);
      return;
    }
    expect(version).toMatch(/-dev\.\d+$/u);
    expect(log).toMatch(/^## \[\d+\.\d+\.\d+\] - Unreleased$/mu);
  };

  it('holds the repository to what its version needs: a dated section for a release, an undated next release for a dev build', async () => {
    await readiness(packageJson.version, changelog);
    // The checklist's version pull request: the version set and its section dated.
    await readiness('1.0.0', changelog.replace('## [1.0.0] - Unreleased', '## [1.0.0] - 2026-10-01'));
    await expect(readiness('1.0.0', changelog)).rejects.toMatchObject({ stderr: expect.stringMatching(/must be dated/u) as unknown });
  });
});

describe('the registry checks', () => {
  const INTEGRITY = 'sha512-built';
  const registry = (entries: Record<string, unknown>[]) => {
    let reads = 0;
    const view = (_spec: string, field: string) => {
      const entry = entries[Math.min(reads, entries.length - 1)] ?? {};
      if (field === 'dist.integrity') reads += 1;
      return entry[field];
    };
    return { view, reads: () => reads };
  };
  const check = (entries: Record<string, unknown>[], requireProvenance = true) =>
    checkRegistry({ spec: '@dichovsky/testrail-mcp@1.0.0', integrity: INTEGRITY, requireProvenance, view: registry(entries).view, waits: [0, 0, 0] });

  it('accepts the tarball the release built, with its provenance attestation', async () => {
    await expect(check([{ 'dist.integrity': INTEGRITY, 'dist.attestations': { provenance: { predicateType: 'https://slsa.dev/provenance/v1' } } }])).resolves.toBeUndefined();
  });

  it('waits for a version the registry does not show yet, and gives up after the last wait', async () => {
    const lagging = registry([{}, {}, { 'dist.integrity': INTEGRITY, 'dist.attestations': { provenance: {} } }]);
    await expect(checkRegistry({ spec: 's', integrity: INTEGRITY, requireProvenance: true, view: lagging.view, waits: [0, 0, 0] })).resolves.toBeUndefined();
    expect(lagging.reads()).toBe(3);
    await expect(check([{}])).rejects.toThrow(/does not serve/u);
  });

  it('refuses a different tarball, and a version without an attestation, at once', async () => {
    await expect(check([{ 'dist.integrity': 'sha512-other', 'dist.attestations': { provenance: {} } }])).rejects.toThrow(/serves a different tarball/u);
    const bare = registry([{ 'dist.integrity': INTEGRITY }]);
    await expect(checkRegistry({ spec: 's', integrity: INTEGRITY, requireProvenance: true, view: bare.view, waits: [0, 0, 0] })).rejects.toThrow(/no provenance attestation/u);
    expect(bare.reads()).toBe(1);
  });
});

describe('the release files', () => {
  let base: string;
  let tarball: string;
  let version: string;
  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), 'testrail-mcp-published-'));
    const packed = JSON.parse((await run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', base],
      { cwd: projectRoot, shell: process.platform === 'win32' })).stdout) as unknown;
    const [report] = (Array.isArray(packed) ? packed : Object.values(packed as object)) as { filename: string; version: string }[];
    if (report === undefined) throw new Error('npm pack reported nothing');
    tarball = report.filename;
    version = report.version;
  }, 120_000);
  afterAll(async () => { await rm(base, { recursive: true, force: true }); });

  it('installs a release tarball, from a relative path, and drives its executable over MCP in both eras', async () => {
    const { stdout } = await run(process.execPath, [script('verify-published.mjs'), `./${tarball}`, '--version', version], { cwd: base, timeout: 240_000 });
    expect(stdout).toContain(`Published package verified: @dichovsky/testrail-mcp@${version}; MCP over stdio (legacy: 133 tools, 2026-07-28: 133 tools`);
    // A tarball of another version is refused, and so are registry checks on a tarball.
    await expect(run(process.execPath, [script('verify-published.mjs'), join(base, tarball), '--version', '9.9.9'], { timeout: 240_000 }))
      .rejects.toMatchObject({ stderr: expect.stringContaining('9.9.9') as unknown });
    for (const flags of [['--integrity', 'sha512-x'], ['--require-provenance']]) {
      await expect(run(process.execPath, [script('verify-published.mjs'), join(base, tarball), '--version', version, ...flags]))
        .rejects.toMatchObject({ stderr: expect.stringContaining('give a registry spec, not a tarball') as unknown });
    }
  }, 480_000);

  it('inventories exactly the production packages a user\'s install gets, with their dependency graph', async () => {
    const out = join(base, 'sbom.cdx.json');
    await run(process.execPath, [script('release-sbom.mjs'), join(base, tarball), out], { timeout: 300_000 });
    const sbom = JSON.parse(await readFile(out, 'utf8')) as {
      metadata: { component: { name: string; version: string; 'bom-ref': string } };
      components: { name: string; version: string }[];
      dependencies: { ref: string; dependsOn?: string[] }[];
    };
    const production = Object.entries(lockfile.packages)
      .filter(([path, entry]) => path !== '' && entry.dev !== true && entry.devOptional !== true)
      .map(([path, entry]) => `${path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length)}@${String(entry.version)}`);
    expect(sbom.components.map(({ name, version: at }) => `${name}@${at}`).sort()).toEqual(production.sort());
    // Among them, the two a dev dependency also needs, which `npm sbom --omit dev` leaves out.
    expect(production.map((entry) => entry.replace(/@[^@]+$/u, ''))).toEqual(expect.arrayContaining(['zod', '@modelcontextprotocol/core']));
    expect(sbom.metadata.component).toMatchObject({ name: '@dichovsky/testrail-mcp', version });
    const direct = sbom.dependencies.find(({ ref }) => ref === sbom.metadata.component['bom-ref'])?.dependsOn ?? [];
    expect(direct.sort()).toEqual(Object.entries(packageJson.dependencies).map(([name, at]) => `${name}@${at}`).sort());
  }, 300_000);
});

