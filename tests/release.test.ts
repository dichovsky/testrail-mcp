import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
 * with the registry and drives it over MCP. A publish typed by hand from the working tree
 * cannot publish the development version or put a pre-release under `latest`, and a build
 * against an install older than the lockfile stops and says so.
 */

// Windows checkouts may carry CRLF line endings; the checks read files as LF.
const lf = (text: string): string => text.replace(/\r\n/gu, '\n');
const read = async (path: string): Promise<string> => lf(await readFile(new URL(path, import.meta.url), 'utf8'));
const run = promisify(execFile);
const release = await read('../.github/workflows/release.yml');
const releaseDoc = await read('../docs/release.md');
const changelog = await read('../CHANGELOG.md');
const packageJson = JSON.parse(await read('../package.json')) as { name: string; version: string; dependencies: Record<string, string>; scripts: Record<string, string> };
const lockfile = JSON.parse(await read('../package-lock.json')) as { packages: Record<string, { version?: string; dev?: boolean; devOptional?: boolean }> };
const script = (name: string): string => fileURLToPath(new URL(`../scripts/${name}`, import.meta.url));
const projectRoot = fileURLToPath(new URL('..', import.meta.url));

interface Registry {
  checkRegistry: (options: { spec: string; integrity?: string; requireProvenance?: boolean; view: (spec: string, field: string) => unknown; waits: number[] }) => Promise<void>;
  viewField: (spec: string, field: string) => unknown;
}
const { checkRegistry, viewField } = (await import(new URL('../scripts/verify-published.mjs', import.meta.url).href)) as Registry;
const { publishRefusal } = (await import(new URL('../scripts/check-publish.mjs', import.meta.url).href)) as { publishRefusal: (version: string, tag: string | undefined) => string | undefined };
const { staleDependencies } = (await import(new URL('../scripts/check-install.mjs', import.meta.url).href)) as { staleDependencies: (root?: URL) => string[] };
const { npmCommand } = (await import(new URL('../scripts/npm-command.mjs', import.meta.url).href)) as { npmCommand: () => [string, string[]] };

/** The lines of one job, from its key to the next key at a job's indent or less, comments aside. */
function job(workflow: string, name: string): string {
  const lines = workflow.split('\n');
  const start = lines.indexOf(`  ${name}:`);
  if (start === -1) return '';
  const end = lines.findIndex((line, index) => index > start && /^ {0,2}[^\s#]/u.test(line));
  return lines.slice(start, end === -1 ? undefined : end).join('\n');
}

/** The keys a block sets at an indent, in order. */
const keys = (block: string, indent: number): string[] =>
  [...block.matchAll(new RegExp(`^ {${String(indent)}}([^\\s#-][^:]*):`, 'gmu'))].map(([, key]) => key ?? '');

/**
 * What the `permissions:` key at an indent grants, as written: an inline value such as
 * `write-all` whole, or each entry of the block. Undefined when there is no such key.
 */
function permissions(block: string, indent: number): string[] | undefined {
  const key = `${' '.repeat(indent)}permissions:`;
  const lines = block.split('\n');
  const start = lines.findIndex((line) => line.startsWith(key));
  if (start === -1) return undefined;
  const inline = (lines[start] ?? '').slice(key.length).trim();
  if (inline !== '') return [inline];
  const entries: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\s*(?:#.*)?$/u.test(line)) continue;
    if (!line.startsWith(' '.repeat(indent + 1))) break;
    entries.push(line.trim());
  }
  return entries;
}

/** Each job the workflow may have, with the only permissions it may hold. */
const JOBS: Record<string, string[] | undefined> = {
  verify: undefined,
  build: undefined,
  publish: ['id-token: write'],
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
    expect(keys(release.slice(release.indexOf('\njobs:\n')), 2)).toEqual(Object.keys(JOBS));
    for (const [name, granted] of Object.entries(JOBS)) expect(permissions(job(release, name), 4), name).toEqual(granted);
    // Nowhere else, in any form: the workflow's grant and the two jobs' own are all there are.
    expect(release.match(/permissions\s*:/gu)).toHaveLength(3);
    expect(Object.keys(JOBS).filter((name) => keys(job(release, name), 4).includes('environment'))).toEqual(['publish']);
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
    expect(publish).toContain("registry-url: 'https://registry.npmjs.org'");
    /*
     * The job that can mint an npm token does exactly this and nothing else: it fetches the
     * built files, sets up Node, checks npm's version and publishes. It checks out, installs
     * and runs no package code. Changing what it runs means changing this list.
     */
    expect(keys(publish, 4)).toEqual(['name', 'needs', 'runs-on', 'timeout-minutes', 'environment', 'permissions', 'steps']);
    const steps = publish.slice(publish.indexOf('\n    steps:\n')).split(/\n {6}- /u).slice(1);
    expect(steps.map((step) => /^name: (.+)$/mu.exec(step)?.[1])).toEqual([
      'Fetch the release files', 'Set up Node.js', 'Require an npm that supports trusted publishing', 'Publish the packed tarball, with provenance, once',
    ]);
    expect(steps.map((step) => /^ {8}uses: ([^@\s]+)@/mu.exec(step)?.[1])).toEqual(['actions/download-artifact', 'actions/setup-node', undefined, undefined]);
    expect(steps.map((step) => [/^([^\s:]+):/u.exec(step)?.[1], ...keys(step, 8)])).toEqual([
      ['name', 'uses', 'with'], ['name', 'uses', 'with'], ['name', 'run'], ['name', 'env', 'run'],
    ]);
    expect(steps.map((step) => /^ {8}env:\n((?: {10}.*\n)*)/mu.exec(`${step}\n`)?.[1]?.split('\n').map((line) => line.trim()).filter(Boolean))).toEqual([
      undefined, undefined, undefined,
      ['TARBALL: ${{ needs.build.outputs.tarball }}', 'INTEGRITY: ${{ needs.build.outputs.integrity }}', 'VERSION: ${{ needs.build.outputs.version }}'],
    ]);
    const scripts = steps.map((step) => {
      const [, inline = '', block = ''] = /^ {8}run: (.*)\n((?: {10}.*\n| *\n)*)/mu.exec(`${step}\n`) ?? [];
      return [inline, ...block.split('\n')].map((line) => line.trim()).filter((line) => !['', '|', '>', '>-'].includes(line));
    });
    expect(scripts).toEqual([
      [],
      [],
      [`node -e "const [a,b,c]=process.argv[1].split('.').map(Number); if (a<11||(a===11&&(b<5||(b===5&&c<1)))) { console.error('npm '+process.argv[1]+' is older than 11.5.1'); process.exit(1); }" "$(npm --version)"`],
      [
        'served="$(npm view "@dichovsky/testrail-mcp@$VERSION" dist.integrity 2>/dev/null || true)"',
        'if [ -n "$served" ]; then',
        'if [ "$served" = "$INTEGRITY" ]; then echo "$VERSION is already published from this tarball."; exit 0; fi',
        'echo "::error::$VERSION is already published from a different tarball."; exit 1',
        'fi',
        'npm publish "./$TARBALL" --access public --provenance --ignore-scripts',
      ],
    ]);
  });

  it('builds the notes, tarball and inventory before publishing, and checks the published package before the release', () => {
    const verify = job(release, 'verify');
    expect(verify).toContain('os: [ubuntu-latest, macos-latest, windows-latest]');
    expect(verify).toContain("node: ['24']");
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
      /*
       * An npm stand-in that answers only the one lookup the step should make: the integrity
       * the registry serves, or E404 for a version it does not have. `publish` is recorded;
       * anything else fails.
       */
      await writeFile(join(base, 'npm'), [
        '#!/bin/sh',
        'if [ "$*" = "view @dichovsky/testrail-mcp@1.0.0 dist.integrity" ]; then',
        '  if [ -z "$SERVED" ]; then echo "npm error code E404" >&2; exit 1; fi',
        '  printf "%s\\n" "$SERVED"; exit 0',
        'fi',
        'if [ "$1" = publish ]; then echo "$@" >> "$PUBLISHED"; exit 0; fi',
        'echo "unexpected npm $*" >&2; exit 1',
        '',
      ].join('\n'));
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

  /**
   * What CI requires of a version and its changelog: for a release version, the notes the
   * release will carry; for a dev build, an undated next release.
   */
  const readiness = async (version: string, log: string): Promise<void> => {
    if (/^\d+\.\d+\.\d+$/u.test(version)) {
      await notes(`v${version}`, log, version);
      return;
    }
    expect(version).toMatch(/-dev\.\d+$/u);
    expect(log).toMatch(/^## \[\d+\.\d+\.\d+\] - Unreleased$/mu);
  };

  it('holds the repository to what its version needs', async () => {
    await readiness(packageJson.version, changelog);
  });

  it('lets the checklist\'s version pull request pass, and refuses one that leaves its section undated', async () => {
    const planned = '# Changelog\n\n## [1.0.0] - Unreleased\n\n### Added\n\n- One.\n';
    const released = planned.replace('Unreleased', '2026-10-01');
    await readiness('1.0.0-dev.0', planned);
    await readiness('1.0.0', released);
    await expect(readiness('1.0.0', planned)).rejects.toMatchObject({ stderr: expect.stringMatching(/must be dated/u) as unknown });
    // After the release, the next dev build opens the next section.
    await readiness('1.1.0-dev.0', `# Changelog\n\n## [1.1.0] - Unreleased\n\n- Next.\n${released.slice('# Changelog\n'.length)}`);
    await expect(readiness('1.1.0-dev.0', released)).rejects.toThrow();
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
    const other = registry([{ 'dist.integrity': 'sha512-other', 'dist.attestations': { provenance: {} } }]);
    await expect(checkRegistry({ spec: 's', integrity: INTEGRITY, requireProvenance: true, view: other.view, waits: [0, 0, 0] })).rejects.toThrow(/serves a different tarball/u);
    expect(other.reads()).toBe(1);
    const bare = registry([{ 'dist.integrity': INTEGRITY }]);
    await expect(checkRegistry({ spec: 's', integrity: INTEGRITY, requireProvenance: true, view: bare.view, waits: [0, 0, 0] })).rejects.toThrow(/no provenance attestation/u);
    expect(bare.reads()).toBe(1);
  });

  it('reads a field through npm: a missing version or field as nothing, any other failure as an error', async () => {
    const base = await mkdtemp(join(tmpdir(), 'testrail-mcp-view-'));
    const saved = process.env.npm_execpath;
    // An npm stand-in, run as npm's own entry point is: this Node with the script.
    const npmAs = async (name: string, body: string) => {
      await mkdir(join(base, name));
      await writeFile(join(base, name, 'npm-cli.js'), body);
      process.env.npm_execpath = join(base, name, 'npm-cli.js');
    };
    try {
      const args = join(base, 'args.json');
      await npmAs('served', `require('fs').writeFileSync(${JSON.stringify(args)}, JSON.stringify(process.argv.slice(2))); process.stdout.write('"sha512-served"\\n');`);
      expect(viewField('@dichovsky/testrail-mcp@1.0.0', 'dist.integrity')).toBe('sha512-served');
      expect(JSON.parse(await readFile(args, 'utf8'))).toEqual(['view', '@dichovsky/testrail-mcp@1.0.0', 'dist.integrity', '--json', '--prefer-online']);
      // As npm reports a version it does not have: E404, and a failure.
      await npmAs('missing-version', `process.stdout.write('{"error":{"code":"E404"}}\\n'); process.stderr.write('npm error code E404\\n'); process.exit(1);`);
      expect(viewField('@dichovsky/testrail-mcp@1.0.0', 'dist.integrity')).toBeUndefined();
      // And a field the version lacks: nothing, and success.
      await npmAs('missing-field', '');
      expect(viewField('@dichovsky/testrail-mcp@1.0.0', 'dist.attestations')).toBeUndefined();
      await npmAs('refused', `process.stderr.write('npm error code E403\\n'); process.exit(1);`);
      expect(() => viewField('@dichovsky/testrail-mcp@1.0.0', 'dist.integrity')).toThrow(/npm view failed[\s\S]*E403/u);
    } finally {
      if (saved === undefined) delete process.env.npm_execpath;
      else process.env.npm_execpath = saved;
      await rm(base, { recursive: true, force: true });
    }
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


describe('a publish by hand from the working tree', () => {
  const development = /is this repository's development version and is never published/u;
  const untagged = /is a pre-release\. Publish it with a --tag other than latest/u;

  it('refuses the development version under any tag, and a pre-release without a tag other than latest', () => {
    const cases: [version: string, tag: string | undefined, refusal: RegExp | undefined][] = [
      ['0.1.0-dev.0', undefined, development],
      ['0.1.0-dev.0', 'next', development],
      ['1.0.0-dev', 'latest', development],
      ['0.0.0-bootstrap.0', undefined, untagged],
      ['0.0.0-bootstrap.0', 'latest', untagged],
      ['1.0.0-rc.1+build.5', undefined, untagged],
      ['0.0.0-bootstrap.0', 'bootstrap', undefined],
      ['1.0.0-rc.1+build.5', 'next', undefined],
      ['1.0.0-development.1', 'next', undefined],
      ['1.0.0', undefined, undefined],
      ['1.0.0', 'latest', undefined],
      ['1.0.0+build.5', undefined, undefined],
    ];
    for (const [version, tag, refusal] of cases) {
      const outcome = publishRefusal(version, tag);
      if (refusal === undefined) expect(outcome, `${version} --tag ${String(tag)}`).toBeUndefined();
      else expect(outcome, `${version} --tag ${String(tag)}`).toMatch(refusal);
    }
  });

  it('runs as npm\'s prepublishOnly, with the tag npm was given, before anything is built', async () => {
    expect(packageJson.scripts.prepublishOnly).toBe('node scripts/check-publish.mjs');
    const base = await mkdtemp(join(tmpdir(), 'testrail-mcp-prepublish-'));
    try {
      await mkdir(join(base, 'scripts'));
      await copyFile(script('check-publish.mjs'), join(base, 'scripts', 'check-publish.mjs'));
      const built = join(base, 'built');
      const [command, prefix] = npmCommand();
      // Only this test's settings reach npm, whatever npm ran the tests.
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_config_/iu.test(key)));
      /*
       * A dry run, against a registry nothing listens on, of a tree whose build records that
       * it ran and then fails. npm 11 contacts the registry once its own checks pass, so a
       * publish the guard allows stops at the build, before any registry.
       */
      const publish = async (version: string, ...args: string[]) => {
        await writeFile(join(base, 'package.json'), JSON.stringify({
          name: packageJson.name,
          version,
          scripts: { prepublishOnly: packageJson.scripts.prepublishOnly, prepack: 'node -e "require(\'fs\').writeFileSync(\'built\', \'\'); process.exit(3)"' },
        }));
        await rm(built, { force: true });
        const outcome = await run(command, [...prefix, 'publish', '--dry-run', '--registry', 'http://127.0.0.1:9/', '--fetch-retries', '0', ...args], { cwd: base, env })
          .then(() => 'published', ({ stderr }: { stderr: string }) => stderr);
        return { outcome, built: existsSync(built) };
      };
      expect(await publish('0.1.0-dev.0', '--tag', 'next')).toEqual({ outcome: expect.stringMatching(development) as unknown, built: false });
      expect(await publish('1.0.0-rc.1')).toEqual({ outcome: expect.stringMatching(untagged) as unknown, built: false });
      expect(await publish('1.0.0-rc.1', '--tag', 'latest')).toEqual({ outcome: expect.stringMatching(untagged) as unknown, built: false });
      // Allowed, so npm goes on to the build, which stops it.
      expect(await publish('1.0.0-rc.1', '--tag', 'next')).toEqual({ outcome: expect.not.stringMatching(/pre-release|development/u) as unknown, built: true });
      expect(await publish('1.0.0')).toEqual({ outcome: expect.not.stringMatching(/pre-release|development/u) as unknown, built: true });
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  }, 120_000);
});

describe('a build from the working tree', () => {
  /** A tree with these pins, lockfile entries and installed versions; undefined leaves one out. */
  async function tree(base: string, packages: Record<string, { pinned?: 'dependencies' | 'devDependencies'; locked?: string; installed?: string }>): Promise<URL> {
    const manifest: Record<string, Record<string, string>> = { dependencies: {}, devDependencies: {} };
    const lock: Record<string, { version: string }> = {};
    for (const [name, { pinned, locked, installed }] of Object.entries(packages)) {
      if (pinned !== undefined && manifest[pinned] !== undefined) manifest[pinned][name] = locked ?? installed ?? '0.0.0';
      if (locked !== undefined) lock[`node_modules/${name}`] = { version: locked };
      if (installed !== undefined) {
        await mkdir(join(base, 'node_modules', name), { recursive: true });
        await writeFile(join(base, 'node_modules', name, 'package.json'), JSON.stringify({ name, version: installed }));
      }
    }
    await writeFile(join(base, 'package.json'), JSON.stringify({ name: 'tree', version: '1.0.0', ...manifest }));
    await writeFile(join(base, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': { name: 'tree' }, ...lock } }));
    return pathToFileURL(join(base, 'package.json'));
  }

  it('finds this repository installed as its lockfile records', () => {
    expect(staleDependencies()).toEqual([]);
  });

  it('names each direct dependency, production or development, installed at a version other than the lockfile\'s', async () => {
    const base = await mkdtemp(join(tmpdir(), 'testrail-mcp-install-'));
    try {
      const root = await tree(base, {
        '@scope/current': { pinned: 'dependencies', locked: '1.0.0', installed: '1.0.0' },
        '@scope/behind': { pinned: 'dependencies', locked: '7.2.0', installed: '7.1.0' },
        ahead: { pinned: 'devDependencies', locked: '2.0.0', installed: '2.1.0' },
        missing: { pinned: 'devDependencies', locked: '3.0.0' },
        unlocked: { pinned: 'dependencies', installed: '4.0.0' },
        // Installed and locked, but nothing pins it directly: npm ci's business, not this check's.
        transitive: { locked: '5.0.0', installed: '4.0.0' },
      });
      expect(staleDependencies(root)).toEqual([
        '@scope/behind: installed 7.1.0, package-lock.json has 7.2.0',
        'ahead: installed 2.1.0, package-lock.json has 2.0.0',
        'missing: not installed, package-lock.json has 3.0.0',
        'unlocked: not in package-lock.json',
      ]);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('stops before it removes the previous build, and says to run npm ci', async () => {
    const base = await mkdtemp(join(tmpdir(), 'testrail-mcp-build-'));
    try {
      await mkdir(join(base, 'scripts'));
      for (const name of ['build.mjs', 'check-install.mjs']) await copyFile(script(name), join(base, 'scripts', name));
      await mkdir(join(base, 'dist'));
      await writeFile(join(base, 'dist', 'cli.js'), 'the previous build');
      await tree(base, { '@dichovsky/testrail-api-client': { pinned: 'dependencies', locked: '7.2.0', installed: '7.1.0' } });
      await expect(run(process.execPath, [join(base, 'scripts', 'build.mjs')], { cwd: base })).rejects.toMatchObject({
        stderr: 'The installed dependencies do not match package-lock.json:\n  @dichovsky/testrail-api-client: installed 7.1.0, package-lock.json has 7.2.0\nRun npm ci, then try again.\n',
      });
      expect(await readFile(join(base, 'dist', 'cli.js'), 'utf8')).toBe('the previous build');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
