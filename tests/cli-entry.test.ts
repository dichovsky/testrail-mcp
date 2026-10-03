import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

/*
 * The packaged executable is exercised as a subprocess in cli.test.ts, which v8 coverage
 * cannot observe. These tests run the same entry module in-process: each case resets the
 * module registry, sets argv and re-imports src/cli.ts, whose top-level await finishes the
 * selected command before the import resolves.
 */

const metadata: unknown = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
if (metadata === null || typeof metadata !== 'object' || !('version' in metadata) || typeof metadata.version !== 'string') {
  throw new Error('Package version missing');
}
const version = metadata.version;

const startServer = vi.fn<(environment: NodeJS.ProcessEnv) => Promise<unknown>>();

let originalArgv: string[];
let originalExitCode: typeof process.exitCode;
let stdout: MockInstance<typeof process.stdout.write>;
let stderr: MockInstance<typeof process.stderr.write>;

function written(spy: MockInstance<typeof process.stdout.write>): string {
  return spy.mock.calls.map(([chunk]) => String(chunk)).join('');
}

/** Run the entry module once with the given arguments; the server module is always a stub. */
async function run(args: string[], readPackage?: (...parameters: unknown[]) => string): Promise<void> {
  process.argv = [process.execPath, '/installed/bin/testrail-mcp', ...args];
  vi.doMock('../src/transport/server.js', () => ({ startServer }));
  if (readPackage !== undefined) {
    vi.doMock('node:fs', async (importOriginal) => ({
      ...await importOriginal<typeof import('node:fs')>(),
      readFileSync: vi.fn(readPackage),
    }));
  }
  await import('../src/cli.js');
}

beforeEach(() => {
  vi.resetModules();
  originalArgv = process.argv;
  originalExitCode = process.exitCode;
  process.exitCode = undefined;
  stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  vi.doUnmock('../src/transport/server.js');
  vi.doUnmock('node:fs');
  vi.restoreAllMocks();
  startServer.mockReset();
});

describe('in-process executable entry', () => {
  it.each(['--help', '-h'])('prints usage for %s without starting the server', async (flag) => {
    await run([flag]);
    expect(written(stdout)).toContain('Usage: testrail-mcp [--help | --version]');
    expect(written(stdout)).toContain('Standard output carries\nprotocol messages only');
    expect(written(stderr)).toBe('');
    expect(startServer).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it.each(['--version', '-v'])('prints the installed package version for %s', async (flag) => {
    await run([flag]);
    expect(written(stdout)).toBe(`${version}\n`);
    expect(written(stderr)).toBe('');
    expect(startServer).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it.each([
    ['null metadata', 'null'],
    ['non-object metadata', '"0.1.0"'],
    ['metadata without a version', '{"name":"testrail-mcp"}'],
    ['a non-string version', '{"version":1}'],
    ['unparseable metadata', '{not json'],
  ])('reports %s as an unreadable version with exit code 1', async (_label, contents) => {
    await run(['--version'], () => contents);
    expect(written(stdout)).toBe('');
    expect(written(stderr)).toBe('Unable to read package version.\n');
    expect(process.exitCode).toBe(1);
  });

  it('reports a package read failure without echoing the filesystem error', async () => {
    const readPackage = vi.fn((): string => {
      throw new Error('EACCES: /synthetic/secret/path/package.json');
    });
    await run(['--version'], readPackage);
    // The entry reads the package.json beside the installed module, not the cwd.
    const [location] = readPackage.mock.calls[0] as unknown as [URL];
    expect(location).toBeInstanceOf(URL);
    expect(location.pathname.endsWith('/package.json')).toBe(true);
    expect(written(stdout)).toBe('');
    expect(written(stderr)).toBe('Unable to read package version.\n');
    expect(written(stderr)).not.toContain('synthetic');
    expect(process.exitCode).toBe(1);
  });

  it('serves with the launch environment when given no arguments', async () => {
    startServer.mockResolvedValue({});
    await run([]);
    expect(startServer).toHaveBeenCalledTimes(1);
    expect(startServer).toHaveBeenCalledWith(process.env);
    // Standard output belongs to the protocol: the entry itself writes nothing there.
    expect(written(stdout)).toBe('');
    expect(written(stderr)).toBe('');
    expect(process.exitCode).toBeUndefined();
  });

  it('reports a configuration failure by naming only its key', async () => {
    // Import after the registry reset so the entry sees this very class, as it would
    // when the real server module rejects.
    const { ConfigurationError } = await import('../src/config/errors.js');
    startServer.mockRejectedValue(new ConfigurationError('TESTRAIL_EMAIL'));
    await run([]);
    expect(written(stdout)).toBe('');
    expect(written(stderr)).toBe('Invalid configuration: TESTRAIL_EMAIL.\n');
    expect(process.exitCode).toBe(1);
  });

  it.each([
    ['an Error', new Error('getaddrinfo ENOTFOUND synthetic-secret.testrail.io')],
    ['a non-Error value', 'synthetic-secret thrown as a string'],
  ])('reports any other startup failure (%s) without its message', async (_label, failure) => {
    startServer.mockRejectedValue(failure);
    await run([]);
    expect(written(stdout)).toBe('');
    expect(written(stderr)).toBe('Unable to start the server.\n');
    expect(written(stderr)).not.toContain('synthetic-secret');
    expect(process.exitCode).toBe(1);
  });

  it.each([
    [['--api-key=synthetic-secret']],
    [['--help', '--version']],
  ])('rejects %j with usage exit code 2 and never echoes the arguments', async (args) => {
    await run(args);
    expect(written(stdout)).toBe('');
    expect(written(stderr)).toBe('Unknown arguments. Run testrail-mcp --help for usage.\n');
    expect(startServer).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
  });
});
