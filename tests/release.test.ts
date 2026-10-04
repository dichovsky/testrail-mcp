import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/*
 * R03's release pipeline, held before it ever runs. It is the driver's: the Publish
 * workflow runs for a published GitHub Release of a release/X.Y.Z tag, checks that the
 * release, the tag and the checked-out commit are one commit on main before any repository
 * code runs, runs every gate, and hands only the tested build to the job that publishes it
 * through npm trusted publishing in the protected environment, with no stored token. That
 * job runs no repository or dependency code, and checks what npm then serves. Its preflight
 * is held in tests/release-preflight.test.ts. Every action in every workflow is pinned to a
 * commit. The release notes come from a dated changelog section for exactly the tagged
 * version. The post-publication check installs the artifact, compares it with the registry
 * and drives it over MCP. A publish typed by hand from the working tree cannot publish the
 * development version or put a pre-release under `latest`, and a build against an install
 * older than the lockfile stops and says so.
 */

// Windows checkouts may carry CRLF line endings; the checks read files as LF.
const lf = (text: string): string => text.replace(/\r\n/gu, '\n');
const read = async (path: string): Promise<string> => lf(await readFile(new URL(path, import.meta.url), 'utf8'));
const run = promisify(execFile);
const publish = await read('../.github/workflows/publish.yml');
const ci = await read('../.github/workflows/ci.yml');
const driverLedger = await read('../.github/workflows/driver-ledger.yml');
const releaseDoc = await read('../docs/release.md');
const changelog = await read('../CHANGELOG.md');
const packageJson = JSON.parse(await read('../package.json')) as { name: string; version: string; dependencies: Record<string, string>; scripts: Record<string, string> };
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
const { validateNewStableVersion } = (await import(new URL('../scripts/release-preflight.mjs', import.meta.url).href)) as {
  validateNewStableVersion: (input: { candidateVersion: string; publishedVersions: string[]; latestVersion: string }) => void;
};

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

/** Each job the workflow has, with the only permissions it may hold. */
const JOBS: Record<string, string[]> = {
  verify: ['contents: read'],
  publish: ['contents: read', 'id-token: write'],
};

describe('the Publish workflow', () => {
  const verify = job(publish, 'verify');
  const publishJob = job(publish, 'publish');
  const gateOf = (text: string): string | undefined => /- name: Verify source provenance before repository code runs\n([\s\S]*?)\n\n/u.exec(text)?.[1];
  const positions = (text: string, marks: string[]): number[] => marks.map((mark) => text.indexOf(mark));
  const ascending = (values: number[]): boolean => values.every((value, index) => value >= 0 && (index === 0 || value > (values[index - 1] ?? -1)));

  it('runs only for a published GitHub Release', () => {
    expect(publish).toMatch(/^on:\n {2}release:\n {4}types: \[published\]\n\n/mu);
    expect(publish).not.toMatch(/pull_request|workflow_dispatch|branches:|^ {2}push:/mu);
  });

  it('gives each job only the permissions it needs, and the environment to the publish job alone', () => {
    expect(permissions(publish, 0)).toEqual(['contents: read']);
    expect(keys(publish.slice(publish.indexOf('\njobs:\n')), 2)).toEqual(Object.keys(JOBS));
    for (const [name, granted] of Object.entries(JOBS)) expect(permissions(job(publish, name), 4), name).toEqual(granted);
    // Nowhere else, in any form: the workflow's grant and the two jobs' own are all there are.
    expect(publish.match(/permissions\s*:/gu)).toHaveLength(3);
    expect(publish.match(/id-token: write/gu)).toHaveLength(1);
    expect(Object.keys(JOBS).filter((name) => keys(job(publish, name), 4).includes('environment'))).toEqual(['publish']);
    expect(publishJob).toMatch(/^ {4}environment: npm-publish$/mu);
    expect(publishJob).toMatch(/^ {4}needs: verify$/mu);
    expect(publishJob).toMatch(/^ {4}if: needs\.verify\.outputs\.already-published == 'false'$/mu);
    expect(publish).not.toMatch(/secrets\.|NPM_TOKEN:|NODE_AUTH_TOKEN:|attestations: write/u);
  });

  it('checks the release identity in both jobs before any repository code runs', () => {
    const gate = gateOf(verify);
    expect(gate).toContain('if [[ ! "$RELEASE_TAG" =~ ^release/(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$ ]]; then');
    expect(gate).toContain('if [[ "$RELEASE_DRAFT" != \'false\' || "$RELEASE_PRERELEASE" != \'false\' ]]; then');
    expect(gate).toContain('git merge-base --is-ancestor "$GITHUB_SHA" origin/main');
    expect(gateOf(publishJob)).toBe(gate);
    for (const [name, text] of [['verify', verify], ['publish', publishJob]] as const) {
      const before = text.slice(0, text.indexOf('Verify source provenance before repository code runs')).replace(/^\s*#.*$/gmu, '');
      expect(before, name).toContain('ref: ${{ github.sha }}');
      expect(before, name).toContain('fetch-depth: 0');
      expect(before, name).toContain('run: git fetch --no-tags origin main:refs/remotes/origin/main');
      expect(before, name).not.toMatch(/setup-node|npm |node /u);
    }
    expect(publish.match(/node-version: '24\.19\.0'/gu)).toHaveLength(2);
    expect(publish.match(/package-manager-cache: false/gu)).toHaveLength(2);
  });

  it('runs every release gate in the verify job, the TypeScript 7 check before the TypeScript 6 one', () => {
    expect(ascending(positions(verify, [
      'run: npm ci --ignore-scripts --registry=https://registry.npmjs.org/',
      'run: node scripts/release-preflight.mjs context',
      'run: node scripts/release-notes.mjs "$RELEASE_TAG" > /dev/null',
      'run: npm run build',
      'run: npm run registry:check',
      'run: npm run typecheck\n',
      'run: npm run typecheck:ts6',
      'run: npm run lint',
      'run: npm run test:coverage',
      'run: npm audit --omit=dev --audit-level=moderate',
      'run: npm run test:package',
      'run: node scripts/release-preflight.mjs registry',
    ]))).toBe(true);
    // Every check `npm run check` runs is a gate here too, the tests with coverage.
    for (const part of (packageJson.scripts.check ?? '').split(' && ')) expect(verify, part).toContain(`run: ${part === 'npm test' ? 'npm run test:coverage' : part}`);
  });

  it('hands only the tested build to the publish job, with its digest', () => {
    expect(verify).toContain('dist-sha256: ${{ steps.release-artifact.outputs.sha256 }}');
    expect(verify.match(/if: steps\.preflight\.outputs\.already-published == 'false'/gu)).toHaveLength(2);
    // Archived after the last gate that builds, so it is the build the gates tested.
    expect(verify.indexOf('tar -cf release-dist.tar -C dist .')).toBeGreaterThan(verify.indexOf('run: npm run test:package'));
    expect(publish.match(/name: npm-release-dist/gu)).toHaveLength(2);
    expect(verify).toContain('if-no-files-found: error');
    expect(publishJob).toContain('sha256sum .release-artifact/release-dist.tar');
    expect(publish.match(/find dist -mindepth 1 ! -type f ! -type d/gu)).toHaveLength(2);
    expect(publishJob).toContain('test -f dist/cli.js');
  });

  it('runs no repository or dependency code in the job that can mint an npm credential', () => {
    expect(ascending(positions(publishJob, [
      'Verify source provenance before repository code runs', 'actions/download-artifact@', 'Set up the release Node.js', 'npm publish "$GITHUB_WORKSPACE"',
    ]))).toBe(true);
    expect(publishJob).not.toMatch(/npm ci|npm run|node scripts\/|npx /u);
  });

  it('publishes with an isolated npm configuration, and keeps npm\'s own guard on `latest`', () => {
    for (const flag of ['--provenance', '--access=public', '--ignore-scripts', '--registry=https://registry.npmjs.org/', '--userconfig="$USER_CONFIG"', '--globalconfig="$GLOBAL_CONFIG"']) {
      expect(publishJob, flag).toContain(flag);
    }
    const command = publishJob.slice(publishJob.indexOf('npm publish "$GITHUB_WORKSPACE"'), publishJob.indexOf('VERIFIED=false'));
    expect(command).not.toContain('--tag');
    expect(publishJob).toContain('NPM_CONFIG_* | NODE_AUTH_TOKEN | NPM_TOKEN | NPM_ID_TOKEN');
    expect(publishJob).toContain("PACKAGE_NAME='@dichovsky/testrail-mcp'");
    expect(publishJob).toContain('manifest.name !== "@dichovsky/testrail-mcp"');
  });

  it('re-checks the registry right before publishing, then verifies what npm serves', () => {
    expect(ascending(positions(publishJob, ['EXACT_OUTPUT=', 'registry-state.json', 'npm publish "$GITHUB_WORKSPACE"', 'VERIFIED=false', 'DIFF_VERIFIED=false']))).toBe(true);
    expect(publishJob).toContain('timeout --signal=KILL "${METADATA_REMAINING}s" npm view');
    expect(publishJob).toContain('--fetch-retries=0 --fetch-timeout=10000');
    expect(publishJob).toContain('dist-tags.latest dist.attestations');
    expect(publishJob).toContain('https://slsa.dev/provenance/v1');
    expect(publishJob.match(/for ATTEMPT in \{1\.\.10\}; do/gu)).toHaveLength(1);
    expect(publishJob).toContain('--cache="$ISOLATED_NPM_DIRECTORY/npm-diff-cache-$ATTEMPT"');
  });

  /** The workflow's own last-moment version rule, run on a registry state. */
  const registryRule = /registry-state\.json\n\s*EXPECTED_VERSION="\$EXPECTED_VERSION" node --input-type=module --eval '\n([\s\S]*?)\n\s*'\n/u.exec(publishJob)?.[1];

  it.each([
    ['the first stable release after the placeholder', '1.0.0', ['0.0.0-bootstrap.0'], '0.0.0-bootstrap.0', true],
    ['the first stable release after its own release candidate', '1.0.0', ['0.0.0-bootstrap.0', '1.0.0-rc.1'], '1.0.0-rc.1', true],
    ['the next patch', '1.0.1', ['0.0.0-bootstrap.0', '1.0.0'], '1.0.0', true],
    ['numbers beyond double precision', '9007199254740993.0.0', ['9007199254740992.999999999999999999.999999999999999999'], '9007199254740992.999999999999999999.999999999999999999', true],
    ['a version already published', '1.0.0', ['0.0.0-bootstrap.0', '1.0.0'], '1.0.0', false],
    ['a version below latest', '0.9.0', ['0.0.0-bootstrap.0', '1.0.0'], '1.0.0', false],
    ['a version below a stable one latest does not name', '5.4.0', ['5.3.0', '6.0.0'], '5.3.0', false],
    ['a version below a pre-release latest', '1.0.0', ['2.0.0-rc.1'], '2.0.0-rc.1', false],
    ['a pre-release latest once stable versions exist', '6.0.0', ['5.3.0', '6.0.0-rc.1'], '6.0.0-rc.1', false],
    ['a latest missing from the versions', '1.0.0', ['0.0.0-bootstrap.0'], '0.0.1', false],
  ])('agrees with the preflight on %s', async (_label, candidate, versions, latest, valid) => {
    if (registryRule === undefined) throw new Error('no registry rule in the publish job');
    const directory = await mkdtemp(join(tmpdir(), 'testrail-mcp-registry-rule-'));
    try {
      await writeFile(join(directory, 'registry-state.json'), JSON.stringify({ versions, 'dist-tags.latest': latest }));
      const outcome = await run(process.execPath, ['--input-type=module', '--eval', registryRule], { cwd: directory, env: { ...process.env, EXPECTED_VERSION: candidate } }).then(() => true, () => false);
      expect(outcome).toBe(valid);
      const preflight = (() => { try { validateNewStableVersion({ candidateVersion: candidate, publishedVersions: versions, latestVersion: latest }); return true; } catch { return false; } })();
      expect(preflight).toBe(valid);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  /*
   * The workflow's real wait for npm's metadata, run with only npm, timeout and sleep
   * replaced: sleep advances bash's elapsed-time clock, so the five-minute deadline needs
   * no real wait.
   */
  describe.skipIf(process.platform === 'win32')('after npm accepts the publication', () => {
    const verification = publishJob.slice(publishJob.indexOf('VERIFIED=false'), publishJob.indexOf('DIFF_VERIFIED=false'));
    const VERSION = '1.0.0';
    const RELEASE_SHA = '1234567890abcdef1234567890abcdef12345678';
    const metadata = {
      version: VERSION, gitHead: RELEASE_SHA, 'dist-tags.latest': VERSION,
      'dist.attestations': { provenance: { predicateType: 'https://slsa.dev/provenance/v1' } },
    };

    const wait = async (unavailable: number, response: typeof metadata) => {
      const directory = await mkdtemp(join(tmpdir(), 'testrail-mcp-publication-wait-'));
      try {
        const program = `set -euo pipefail
printf '0' > attempts
timeout() {
  [[ "$1" == '--signal=KILL' ]]
  printf '%s\\n' "$2" >> timeouts
  shift 2
  "$@"
}
npm() {
  [[ "$1" == 'view' ]] || return 99
  local calls
  calls="$(cat attempts)"
  calls=$((calls + 1))
  printf '%s' "$calls" > attempts
  if (( calls <= MOCK_UNAVAILABLE_ATTEMPTS )); then return 1; fi
  printf '%s' "$MOCK_METADATA"
}
sleep() { SECONDS=$((SECONDS + $1)); }
${verification}`;
        const env = {
          PATH: process.env.PATH ?? '', EXPECTED_VERSION: VERSION, GITHUB_SHA: RELEASE_SHA, PACKAGE_SPEC: `@dichovsky/testrail-mcp@${VERSION}`,
          USER_CONFIG: '/dev/null', GLOBAL_CONFIG: '/dev/null', MOCK_UNAVAILABLE_ATTEMPTS: String(unavailable), MOCK_METADATA: JSON.stringify(response),
        };
        const { status, stderr } = await run('bash', ['-c', program], { cwd: directory, env, timeout: 30_000 })
          .then(({ stderr: text }) => ({ status: 0, stderr: text }), (error: { code?: number; stderr?: string }) => ({ status: error.code ?? -1, stderr: error.stderr ?? '' }));
        const timeouts = (await readFile(join(directory, 'timeouts'), 'utf8')).trim().split('\n').map((line) => Number(line.slice(0, -1)));
        return { status, stderr, attempts: Number(await readFile(join(directory, 'attempts'), 'utf8')), timeouts };
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    };

    it('accepts matching metadata after more than ten unavailable registry reads', async () => {
      const result = await wait(11, metadata);
      expect(result.status).toBe(0);
      expect(result.attempts).toBe(12);
      expect(result.stderr).toContain('npm accepted the publication');
      expect(result.timeouts.every((seconds) => seconds > 0 && seconds <= 300)).toBe(true);
    }, 60_000);

    it.each([
      ['unavailable metadata', 100, metadata],
      ['a mismatched identity', 0, { ...metadata, gitHead: 'a'.repeat(40) }],
    ])('stops at the deadline for %s without accepting the release', async (_label, unavailable, response) => {
      const result = await wait(unavailable, response);
      expect(result.status).toBe(1);
      expect(result.attempts).toBeGreaterThan(10);
      expect(result.attempts).toBeLessThanOrEqual(30);
      expect(result.timeouts.every((seconds, index) => seconds > 0 && seconds <= 300 && (index === 0 || seconds < (result.timeouts[index - 1] ?? 0)))).toBe(true);
      expect(result.stderr).toContain('metadata did not converge within 300 seconds');
      expect(result.stderr).toContain('rerun the entire workflow, including verify; do not publish again');
    }, 60_000);
  });

  it('names the workflow file and environment that the npm setup in docs/release.md names', () => {
    expect(releaseDoc).toContain('| Workflow filename | `publish.yml` |');
    expect(releaseDoc).toContain('| Environment name | `npm-publish` |');
    expect(releaseDoc).toContain('| Repository | `testrail-mcp` |');
  });
});

/*
 * F10's networked re-check of the driver release ledger. It is the only workflow that
 * reaches the driver's repository or the npm registry for the ledger, it runs only when
 * what it checks changes, and it holds nothing but read access. The last test keeps the
 * ledger audit, and any mention of the driver's repository, out of CI, the Publish
 * workflow and npm's scripts; it does not read the test files `npm test` runs.
 */
describe('the driver ledger workflow', () => {
  /**
   * The lines under a step's `with:`, each trimmed, in order; undefined when the step has
   * no `with:` block. An input added, removed or changed shows, such as a `ref:` or
   * `repository:` that would check out something other than the commit under test.
   */
  const inputs = (step: string): string[] | undefined => {
    const lines = `        ${step}`.split('\n');
    const start = lines.indexOf('        with:');
    if (start === -1) return undefined;
    // Comment lines, at any indentation, neither end the block nor count as inputs.
    const end = lines.findIndex((line, index) => index > start && /^ {0,8}[^\s#]/u.test(line));
    return lines
      .slice(start + 1, end === -1 ? undefined : end)
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'));
  };

  /**
   * Each step's keys, name, action, action inputs and inline run command, in order. The
   * keys are read with the step's first one, so an added `if:` or `continue-on-error:` shows.
   */
  const steps = (text: string) => text.slice(text.indexOf('\n    steps:\n')).split(/\n {6}- /u).slice(1).map((step) => ({
    keys: keys(`        ${step}`, 8),
    name: /^name: (.+)$/mu.exec(step)?.[1],
    uses: /^ {8}uses: (.+)$/mu.exec(step)?.[1],
    with: inputs(step),
    run: /^ {8}run: (.+)$/mu.exec(step)?.[1],
  }));

  it('runs only when the ledger, its audit script or the workflow changes, or by hand', () => {
    const paths = ['    paths:', '      - tests/fixtures/driver-releases.json', '      - scripts/audit-driver-ledger.mjs', '      - .github/workflows/driver-ledger.yml'];
    expect(driverLedger.slice(driverLedger.indexOf('\non:\n') + 1, driverLedger.indexOf('\npermissions:'))).toBe([
      'on:', '  pull_request:', ...paths, '  push:', '    branches: [main]', ...paths, '  workflow_dispatch:', '',
    ].join('\n'));
  });

  it('holds read access alone, and runs one job on Linux', () => {
    expect(keys(driverLedger, 0)).toEqual(['name', 'on', 'permissions', 'concurrency', 'jobs']);
    expect(permissions(driverLedger, 0)).toEqual(['contents: read']);
    expect(driverLedger.match(/permissions\s*:/gu)).toHaveLength(1);
    expect(keys(driverLedger.slice(driverLedger.indexOf('\njobs:\n')), 2)).toEqual(['audit']);
    const audit = job(driverLedger, 'audit');
    expect(keys(audit, 4)).toEqual(['name', 'runs-on', 'timeout-minutes', 'steps']);
    expect(audit).toMatch(/^ {4}runs-on: ubuntu-latest$/mu);
    expect(driverLedger).not.toMatch(/secrets\.|environment:|matrix/u);
  });

  it('pins exactly the action commits CI pins, and audits a blobless driver clone without installing anything', () => {
    const pins = new Set(steps(job(ci, 'verify')).map(({ uses }) => uses).filter((uses) => uses !== undefined));
    const action = ['name', 'uses', 'with'];
    const command = ['name', 'run'];
    expect(steps(job(driverLedger, 'audit'))).toEqual([
      {
        keys: action, name: 'Check out repository', uses: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1',
        with: ['persist-credentials: false'], run: undefined,
      },
      {
        keys: action, name: 'Set up Node.js', uses: 'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0',
        with: ['node-version: \'24\'', 'package-manager-cache: false'], run: undefined,
      },
      {
        keys: command, name: 'Clone the driver without file contents', uses: undefined, with: undefined,
        run: 'git clone --filter=blob:none --no-checkout https://github.com/dichovsky/testrail-api-client.git "$RUNNER_TEMP/driver"',
      },
      {
        keys: command, name: 'Audit the ledger against the driver\'s history and npm', uses: undefined, with: undefined,
        run: 'node scripts/audit-driver-ledger.mjs "$RUNNER_TEMP/driver"',
      },
    ]);
    for (const { uses } of steps(job(driverLedger, 'audit'))) if (uses !== undefined) expect([...pins], uses).toContain(uses);
  });

  it('keeps the ledger audit and the driver clone out of CI, the Publish workflow and npm\'s scripts', () => {
    for (const [name, text] of [['ci.yml', ci], ['publish.yml', publish], ['package.json scripts', JSON.stringify(packageJson.scripts)]] as const) {
      // A clone or checkout of the driver names its repository: an https or ssh URL, with
      // or without `.git`, the checkout action's `repository:`, or `gh repo clone`, with the
      // owner written out or taken from an expression. Only the npm package, which is
      // `@dichovsky/testrail-api-client`, may be named. A name assembled from variables passes.
      expect(text, name).not.toMatch(/audit-driver-ledger|(?<!@dichovsky\/)testrail-api-client(?![\w-])/iu);
    }
  });
});

describe('every workflow', () => {
  it('pins each action to a full commit, with the version it stands for', async () => {
    const directory = new URL('../.github/workflows/', import.meta.url);
    const workflows = (await readdir(directory)).filter((name) => /\.ya?ml$/u.test(name));
    expect(workflows.sort()).toEqual(['ci.yml', 'driver-ledger.yml', 'publish.yml']);
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

  const notes = async (tag: string, log: string, version: string, via = script('release-notes.mjs'), repository?: unknown) => {
    await writeFile(join(base, 'CHANGELOG.md'), log);
    await writeFile(join(base, 'package.json'), JSON.stringify({ version, repository }));
    return run(process.execPath, [via, tag, '--changelog', join(base, 'CHANGELOG.md'), '--package', join(base, 'package.json')]);
  };
  const dated = '# Changelog\n\n## [2.0.0] - 2026-10-01\n\n### Added\n\n- Two.\n\n## [1.0.0] - 2026-09-30\n\n- One.\n';

  it('prints exactly the tagged version\'s dated section', async () => {
    await expect(notes('release/2.0.0', dated, '2.0.0')).resolves.toMatchObject({ stdout: '### Added\n\n- Two.\n' });
    await expect(notes('release/1.0.0', dated, '1.0.0')).resolves.toMatchObject({ stdout: '- One.\n' });
    // Neither a longer version nor a mention of this one in a later section is its heading.
    const near = '## [1.0.10] - 2026-10-03\n\n- Ten.\n\n## [1.0.2] - 2026-10-02\n\n- Replaces 1.0.1.\n\n## [1.0.1] - 2026-10-01\n\n- One.\n';
    await expect(notes('release/1.0.1', near, '1.0.1')).resolves.toMatchObject({ stdout: '- One.\n' });
  });

  it('points relative links at the tagged tree of the repository package.json names', async () => {
    const linked = '## [1.0.0] - 2026-10-04\n\n- See [the guide](docs/guide.md#setup), [the record](docs/record.json), [npm](https://www.npmjs.com/), [below](#notes) and [the root](/README.md).\n';
    const expected = '- See [the guide](https://github.com/owner/repo/blob/release/1.0.0/docs/guide.md#setup), [the record](https://github.com/owner/repo/blob/release/1.0.0/docs/record.json), [npm](https://www.npmjs.com/), [below](#notes) and [the root](/README.md).\n';
    for (const repository of [{ type: 'git', url: 'git+https://github.com/owner/repo.git' }, 'https://github.com/owner/repo']) {
      await expect(notes('release/1.0.0', linked, '1.0.0', script('release-notes.mjs'), repository)).resolves.toMatchObject({ stdout: expected });
    }
    // Without a GitHub repository there is no tree to point at, so the links stay as written.
    for (const repository of [undefined, 'git@example.com:owner/repo.git']) {
      await expect(notes('release/1.0.0', linked, '1.0.0', script('release-notes.mjs'), repository)).resolves.toMatchObject({ stdout: linked.slice(linked.indexOf('- See')) });
    }
  });

  it('points this repository\'s notes at its own tagged tree', async () => {
    const { githubRepository } = (await import(script('release-notes.mjs'))) as { githubRepository: (packageJson: unknown) => string | undefined };
    expect(githubRepository(packageJson)).toBe('https://github.com/dichovsky/testrail-mcp');
  });

  it.each([
    ['a tag that does not match package.json', 'release/2.0.0', dated, '1.0.0', /does not match package\.json version 1\.0\.0/u],
    ['a version with no section', 'release/3.0.0', dated, '3.0.0', /no section for 3\.0\.0/u],
    ['an undated section', 'release/1.0.0', '## [1.0.0] - Unreleased\n\n- One.\n', '1.0.0', /must be dated/u],
    ['an empty section', 'release/1.0.0', '## [1.0.0] - 2026-09-30\n\n## [0.9.0] - 2026-09-01\n\n- Old.\n', '1.0.0', /is empty/u],
    ['a tag that is not a release tag', 'v1.0.0', dated, '1.0.0', /Give the release tag/u],
    ['a tag that is not a version', 'release-1', dated, '1.0.0', /Give the release tag/u],
  ])('refuses %s', async (_label, tag, log, version, message) => {
    await expect(notes(tag, log, version)).rejects.toMatchObject({ stderr: expect.stringMatching(message) as unknown });
  });

  it.skipIf(process.platform === 'win32')('still refuses when run through a symlinked path', async () => {
    const link = join(base, 'linked-scripts');
    await symlink(fileURLToPath(new URL('../scripts/', import.meta.url)), link);
    await expect(notes('release/2.0.0', dated, '1.0.0', join(link, 'release-notes.mjs'))).rejects.toMatchObject({ stderr: expect.stringMatching(/does not match/u) as unknown });
  });

  /**
   * What CI requires of a version and its changelog: for a release version, the notes the
   * release will carry; for a dev build, an undated next release.
   */
  const readiness = async (version: string, log: string): Promise<void> => {
    if (/^\d+\.\d+\.\d+$/u.test(version)) {
      await notes(`release/${version}`, log, version);
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
