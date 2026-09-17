import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

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

function invoke(args: string[], env = environment) {
  return spawnSync(process.execPath, [cli, ...args], {
    env,
    encoding: 'utf8',
    timeout: 5_000,
  });
}

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
});
