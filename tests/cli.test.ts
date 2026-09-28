import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const metadata: unknown = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);
if (metadata === null || typeof metadata !== 'object' || !('version' in metadata)) {
  throw new Error('Package version missing');
}
const version = metadata.version;
const environment = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith('TESTRAIL')),
);

function invoke(args: string[], env = environment, options: { input?: string; cwd?: string } = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    env,
    encoding: 'utf8',
    timeout: 5_000,
    ...options,
  });
}

const workspace = mkdtempSync(join(tmpdir(), 'testrail-mcp-cli-'));
afterAll(() => { rmSync(workspace, { recursive: true, force: true }); });

/** A complete, valid launch environment, so each case below breaks exactly one key. */
const valid = {
  ...environment,
  TESTRAIL_BASE_URL: 'https://example.testrail.io',
  TESTRAIL_EMAIL: 'user@example.com',
  TESTRAIL_API_KEY: 'synthetic-key',
  TESTRAIL_MCP_UPLOAD_ROOTS: '[]',
  TESTRAIL_MCP_DOWNLOAD_DIR: workspace,
};

const OPENING = `${JSON.stringify({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'cli-test', version: '1.0.0' } },
})}\n`;

describe('packaged executable', () => {
  it.each(['--help', '-h'])('shows %s without TestRail configuration', (flag) => {
    const result = invoke([flag]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('Usage: testrail-mcp');
    expect(result.stdout).toContain('protocol messages only');
  });

  it.each(['--version', '-v'])('prints the package version for %s', (flag) => {
    const result = invoke([flag]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe(`${String(version)}\n`);
  });

  it('does not load invalid or sensitive TestRail configuration for informational flags', () => {
    for (const flag of ['--help', '--version']) {
      const result = invoke([flag], {
        ...environment,
        TESTRAIL_BASE_URL: 'not-a-url',
        TESTRAIL_API_KEY: 'synthetic-secret-must-not-appear',
        TESTRAIL_MCP_UPLOAD_ROOTS: 'not-json',
      });
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).not.toContain('synthetic-secret');
    }
  });

  it('rejects unrecognized or combined arguments without echoing their values', () => {
    for (const args of [['--api-key=synthetic-secret'], ['--help', '--version']]) {
      const result = invoke(args);
      expect(result.status).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('Unknown arguments. Run testrail-mcp --help for usage.\n');
    }
  });

  it('fails before serving when required configuration is missing, naming only the key', () => {
    const result = invoke([]);
    expect(result.status).toBe(1);
    // Nothing reaches stdout: a server that cannot start must not emit a protocol
    // message it has no means to honour.
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('Invalid configuration: TESTRAIL_BASE_URL.\n');
  });

  it('reports a startup failure without echoing any configured value', () => {
    const result = invoke([], {
      ...environment,
      TESTRAIL_BASE_URL: 'https://example.testrail.io',
      TESTRAIL_EMAIL: 'user@example.com',
      TESTRAIL_API_KEY: 'synthetic-secret-must-not-appear',
      TESTRAIL_MCP_UPLOAD_ROOTS: 'not-json',
      TESTRAIL_MCP_DOWNLOAD_DIR: '/nonexistent-download-directory',
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('Invalid configuration: TESTRAIL_MCP_UPLOAD_ROOTS.\n');
    expect(result.stderr).not.toContain('synthetic-secret');
  });

  /*
   * A host writes `initialize` as soon as it spawns the server. Sending it here is what
   * makes "before serving" observable: a server that started serving first would answer
   * it on stdout before failing, while one that refuses first writes nothing there.
   */
  it.each([
    ['missing', environment, 'TESTRAIL_BASE_URL'],
    ['invalid', { ...valid, TESTRAIL_EMAIL: 'not-an-email' }, 'TESTRAIL_EMAIL'],
  ] as const)('refuses %s configuration before answering a client that is already talking', (_label, env, key) => {
    const result = invoke([], env, { input: OPENING });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(`Invalid configuration: ${key}.\n`);
  });

  it.each([
    ['TESTRAIL_BASE_URL', 'https://user:synthetic-secret@example.testrail.io'],
    ['TESTRAIL_EMAIL', 'synthetic-secret-not-an-email'],
    ['TESTRAIL_API_KEY', ' '],
    ['TESTRAIL_ALLOW_INSECURE', 'synthetic-secret'],
    ['TESTRAIL_ALLOW_PRIVATE_HOSTS', 'synthetic-secret'],
    ['TESTRAIL_MCP_LIMITS', '{"synthetic-secret":1}'],
    ['TESTRAIL_MCP_UPLOAD_ROOTS', '["relative/synthetic-secret"]'],
    ['TESTRAIL_MCP_DOWNLOAD_DIR', join(workspace, 'missing', 'synthetic-secret')],
  ])('names only %s, never its value, when it is invalid', (key, value) => {
    const result = invoke([], { ...valid, [key]: value }, { input: OPENING });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    // The exact line, so a value written anywhere else on stderr fails too.
    expect(result.stderr).toBe(`Invalid configuration: ${key}.\n`);
  });

  it('reads no .env file: configuration comes from the launch environment alone', () => {
    const cwd = mkdtempSync(join(workspace, 'dotenv-'));
    writeFileSync(join(cwd, '.env'), Object.entries(valid)
      .filter(([name]) => name.startsWith('TESTRAIL'))
      .map(([name, value]) => `${name}=${value}`)
      .join('\n'));
    const result = invoke([], environment, { input: OPENING, cwd });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('Invalid configuration: TESTRAIL_BASE_URL.\n');
  });
});
