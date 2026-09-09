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

describe('executable before server implementation', () => {
  it.each(['--help', '-h'])('shows %s without TestRail configuration', (flag) => {
    const result = invoke([flag]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('Usage: testrail-mcp');
    expect(result.stdout).toContain('does not yet serve MCP');
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

  it('does not pretend to expose an empty MCP catalog before the runtime is implemented', () => {
    const result = invoke([]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('This development build does not yet serve MCP.\n');
  });
});
