import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/*
 * R03's release pipeline, held before it ever runs. The release workflow may publish only
 * from a version tag, through npm trusted publishing in the protected environment the
 * npm configuration names, with no stored token. Every action in every workflow is
 * pinned to a commit. The release notes come from a dated changelog section for exactly
 * the tagged version. The post-publish check installs the artifact and drives it over MCP.
 */

// Windows checkouts may carry CRLF line endings; the checks read files as LF.
const lf = (text: string): string => text.replace(/\r\n/gu, '\n');
const read = async (path: string): Promise<string> => lf(await readFile(new URL(path, import.meta.url), 'utf8'));
const run = promisify(execFile);
const release = await read('../.github/workflows/release.yml');
const releaseDoc = await read('../docs/release.md');
const changelog = await read('../CHANGELOG.md');
const packageJson = JSON.parse(await read('../package.json')) as { version: string };
const script = (name: string): string => fileURLToPath(new URL(`../scripts/${name}`, import.meta.url));

/** The lines of one job, from its key to the next job or the end. */
function job(workflow: string, name: string): string {
  const lines = workflow.split('\n');
  const start = lines.indexOf(`  ${name}:`);
  if (start === -1) return '';
  const end = lines.findIndex((line, index) => index > start && /^ {2}[a-z-]+:$/u.test(line));
  return lines.slice(start, end === -1 ? undefined : end).join('\n');
}

describe('the release workflow', () => {
  it('runs only for a version tag', () => {
    expect(release).toMatch(/^on:\n {2}push:\n {4}tags: \['v\[0-9\]\+\.\[0-9\]\+\.\[0-9\]\+'\]\n\n/mu);
    expect(release).not.toMatch(/pull_request|workflow_dispatch|branches:/u);
  });

  it('grants write access only to the publish job, in the protected environment', () => {
    expect(release).toMatch(/^permissions:\n {2}contents: read\n/mu);
    const publish = job(release, 'publish');
    expect(publish).toMatch(/^ {4}needs: verify$/mu);
    expect(publish).toMatch(/^ {4}environment: npm-release$/mu);
    expect(publish).toMatch(/^ {4}permissions:\n {6}contents: write\n {6}id-token: write\n/mu);
    expect(job(release, 'verify')).not.toMatch(/permissions:|id-token|environment:/u);
  });

  it('publishes through trusted publishing, never a stored token', () => {
    expect(release).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN|secrets\./u);
    expect(release).toContain('older than 11.5.1');
    expect(job(release, 'publish')).toMatch(/npm publish "\.\/\$\{\{ steps\.pack\.outputs\.tarball \}\}" --access public/u);
  });

  it('verifies every platform before publishing, and the published artifact after', () => {
    const verify = job(release, 'verify');
    expect(verify).toContain("os: [ubuntu-latest, macos-latest, windows-latest]");
    expect(verify).toContain("node: ['22', '24']");
    expect(verify).toContain('run: npm run check');
    const publish = job(release, 'publish');
    const order = ['scripts/release-notes.mjs "$GITHUB_REF_NAME"', 'npm pack --json', 'npm sbom --sbom-format cyclonedx', 'npm publish', 'scripts/verify-published.mjs', 'gh release create']
      .map((step) => publish.indexOf(step));
    expect(order.every((position) => position >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((left, right) => left - right));
    expect(publish).toMatch(/--integrity "\$\{\{ steps\.pack\.outputs\.integrity \}\}"\n\s+--require-provenance/u);
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

  const notes = async (tag: string, log: string, version: string) => {
    await writeFile(join(base, 'CHANGELOG.md'), log);
    await writeFile(join(base, 'package.json'), JSON.stringify({ version }));
    return run(process.execPath, [script('release-notes.mjs'), tag, '--changelog', join(base, 'CHANGELOG.md'), '--package', join(base, 'package.json')]);
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

  it('keeps the unreleased 1.0.0 section undated until the version is set', () => {
    expect(packageJson.version).toMatch(/-dev\.\d+$/u);
    expect(changelog).toMatch(/^## \[1\.0\.0\] - Unreleased$/mu);
  });
});

describe('the published-package check', () => {
  it('installs a release tarball and drives its executable over MCP in both eras', async () => {
    const base = await mkdtemp(join(tmpdir(), 'testrail-mcp-published-'));
    try {
      const packed = JSON.parse((await run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', base],
        { cwd: fileURLToPath(new URL('..', import.meta.url)), shell: process.platform === 'win32' })).stdout) as unknown;
      const [report] = (Array.isArray(packed) ? packed : Object.values(packed as object)) as { filename: string; version: string }[];
      if (report === undefined) throw new Error('npm pack reported nothing');
      const { stdout } = await run(process.execPath, [script('verify-published.mjs'), join(base, report.filename), '--version', report.version], { timeout: 240_000 });
      expect(stdout).toContain(`Published package verified: @dichovsky/testrail-mcp@${report.version}; MCP over stdio (legacy: 133 tools, 2026-07-28: 133 tools`);
      // A tarball of another version is refused.
      await expect(run(process.execPath, [script('verify-published.mjs'), join(base, report.filename), '--version', '9.9.9'], { timeout: 240_000 }))
        .rejects.toMatchObject({ stderr: expect.stringContaining('9.9.9') as unknown });
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  }, 480_000);
});
