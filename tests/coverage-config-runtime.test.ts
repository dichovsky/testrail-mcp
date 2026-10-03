import * as fileSystem from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TestRailClient, TestRailConfigSchema } from '@dichovsky/testrail-api-client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { parseCommandLine } from '../src/config/command-line.js';
import { ConfigurationError, loadConfiguration, type Configuration } from '../src/config/environment.js';
import { DriverSettingsError } from '../src/config/errors.js';
import { DEFAULT_LIMITS, FIXED_BUDGETS } from '../src/config/limits.js';
import { createConfiguredDriver } from '../src/driver/configuration.js';
import { RuntimeError } from '../src/runtime/errors.js';
import { createRuntime } from '../src/runtime/invocation.js';

// Preserve real filesystem behavior while letting a case prove no path was resolved.
vi.mock('node:fs/promises', { spy: true });

let directory: string;
let uploadDirectory: string;
let downloadDirectory: string;

beforeAll(async () => {
  directory = await fileSystem.mkdtemp(join(tmpdir(), 'testrail-mcp-coverage-config-'));
  uploadDirectory = join(directory, 'upload');
  downloadDirectory = join(directory, 'download');
  await fileSystem.mkdir(uploadDirectory);
  await fileSystem.mkdir(downloadDirectory);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

afterAll(async () => {
  await fileSystem.rm(directory, { recursive: true, force: true });
});

function environment(overrides: Record<string, string> = {}) {
  return {
    TESTRAIL_BASE_URL: 'https://example.testrail.io/installation',
    TESTRAIL_EMAIL: 'user@example.com',
    TESTRAIL_API_KEY: 'synthetic-secret',
    TESTRAIL_MCP_UPLOAD_ROOTS: JSON.stringify([uploadDirectory]),
    TESTRAIL_MCP_DOWNLOAD_DIR: downloadDirectory,
    ...overrides,
  };
}

describe('command-line parsing', () => {
  it('serves when given no arguments', () => {
    expect(parseCommandLine([])).toBe('serve');
  });

  it.each(['--help', '-h'])('selects help for %s', (flag) => {
    expect(parseCommandLine([flag])).toBe('help');
  });

  it.each(['--version', '-v'])('selects version for %s', (flag) => {
    expect(parseCommandLine([flag])).toBe('version');
  });

  it.each([
    [['--api-key=synthetic']],
    [['help']],
    [['-H']],
    [['']],
    [['--']],
  ])('rejects the unknown single argument %j', (args) => {
    expect(parseCommandLine(args)).toBe('invalid');
  });

  it.each([
    [['--help', '--version']],
    [['--help', '--help']],
    [['-v', 'extra']],
  ])('rejects more than one argument, even known flags: %j', (args) => {
    expect(parseCommandLine(args)).toBe('invalid');
  });
});

describe('Windows drive-relative directory refusal', () => {
  /*
   * On Windows, isAbsolute accepts "\\dir", which is rooted on whatever drive is current.
   * The loader refuses such a root before resolving anything. node:path keeps the host's
   * flavour, so on POSIX hosts every absolute path parses with root "/", which is exactly
   * the drive-relative shape this guard exists to refuse once the platform is win32.
   */
  function onPlatform(platform: NodeJS.Platform): void {
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
  }

  it('refuses an upload root rooted on the current drive without resolving it', async () => {
    onPlatform('win32');
    await expect(loadConfiguration(environment())).rejects.toEqual(
      new ConfigurationError('TESTRAIL_MCP_UPLOAD_ROOTS'),
    );
    expect(fileSystem.realpath).not.toHaveBeenCalled();
  });

  it('refuses a download directory rooted on the current drive without probing it', async () => {
    onPlatform('win32');
    await expect(loadConfiguration(environment({ TESTRAIL_MCP_UPLOAD_ROOTS: '[]' }))).rejects.toEqual(
      new ConfigurationError('TESTRAIL_MCP_DOWNLOAD_DIR'),
    );
    expect(fileSystem.realpath).not.toHaveBeenCalled();
    expect(fileSystem.open).not.toHaveBeenCalled();
  });

  it('accepts the same rooted directories on a POSIX platform', async () => {
    onPlatform('linux');
    const configuration = await loadConfiguration(environment());
    expect(configuration.uploadRoots).toEqual([await fileSystem.realpath(uploadDirectory)]);
    expect(configuration.downloadDirectory).toBe(await fileSystem.realpath(downloadDirectory));
  });
});

describe('driver rejection attribution', () => {
  it('skips a root-level schema issue and attributes the first operator-keyed field', async () => {
    const configuration: Configuration = await loadConfiguration(environment());
    // The driver's public schema has no root-level refinement today; this pins the
    // attribution behavior should one appear: an issue with an empty path names no key.
    const safeParse = vi.spyOn(TestRailConfigSchema, 'safeParse').mockReturnValue(
      { success: false, error: { issues: [{ path: [] }, { path: ['email'] }] } } as never,
    );
    // An adapter-supplied seam the driver rejects makes construction fail validation.
    const bad = { fetch: 'not-a-function' } as never;
    expect(() => createConfiguredDriver(configuration, bad)).toThrow(new ConfigurationError('TESTRAIL_EMAIL'));
    expect(safeParse).toHaveBeenCalledTimes(1);
  });

  it('reports a root-only schema issue as an adapter settings fault, not operator configuration', async () => {
    const configuration: Configuration = await loadConfiguration(environment());
    vi.spyOn(TestRailConfigSchema, 'safeParse').mockReturnValue(
      { success: false, error: { issues: [{ path: [] }] } } as never,
    );
    const bad = { fetch: 'not-a-function' } as never;
    expect(() => createConfiguredDriver(configuration, bad)).toThrow(DriverSettingsError);
  });
});

describe('default runtime timer and cancellation hooks under host faults', () => {
  function client(): TestRailClient {
    return new TestRailClient({
      baseUrl: 'https://runtime.testrail.io', email: 'user@example.com', apiKey: 'synthetic',
      fetch: () => Promise.reject(new Error('Unexpected fetch')),
      dnsLookup: () => Promise.resolve([{ address: '203.0.113.10', family: 4 }]),
      registerProcessHandlers: false, maxRetries: 0,
    });
  }

  function deferred() {
    let resolve: (value: string) => void = () => undefined;
    const promise = new Promise<string>((done) => { resolve = done; });
    return { promise, resolve };
  }

  async function waitFor(condition: () => boolean, label: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
      await new Promise((resolve) => { setTimeout(resolve, 5); });
    }
  }

  it('fails the call when the watchdog timer cannot be armed, and still releases its slot', async () => {
    const driver = client();
    const runtime = createRuntime({ client: driver, limits: DEFAULT_LIMITS });
    const realSetTimeout = globalThis.setTimeout;
    const armFailure = new Error('timer unavailable');
    const timers = vi.spyOn(globalThis, 'setTimeout').mockImplementation((handler, ms) => {
      if (ms === FIXED_BUDGETS.response_wait_ms) throw armFailure;
      return realSetTimeout(handler, ms);
    });
    const clearTimers = vi.spyOn(globalThis, 'clearTimeout');
    const upstream = deferred();

    // The watchdog is the only bound on the wait: without it the call must not proceed.
    await expect(runtime.invoke(() => upstream.promise)).rejects.toBe(armFailure);
    expect(timers).toHaveBeenCalledWith(expect.any(Function), FIXED_BUDGETS.response_wait_ms);
    // No timer was created, so cancelling the watchdog clears nothing.
    expect(clearTimers).not.toHaveBeenCalled();
    // Capacity follows the operation, which is still running.
    expect(runtime.stats().active).toBe(1);

    timers.mockRestore();
    upstream.resolve('done');
    await waitFor(() => runtime.stats().active === 0, 'slot release');
    await runtime.shutdown();
  });

  it('fails the call when its abort listener cannot be registered, without removing one', async () => {
    const driver = client();
    const runtime = createRuntime({ client: driver, limits: DEFAULT_LIMITS });
    const controller = new AbortController();
    const registrationFailure = new Error('listener registration failed');
    vi.spyOn(controller.signal, 'addEventListener').mockImplementation(() => { throw registrationFailure; });
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const upstream = deferred();

    await expect(runtime.invoke(() => upstream.promise, { signal: controller.signal }))
      .rejects.toBe(registrationFailure);
    // Nothing was registered, so disposal must not touch the signal.
    expect(remove).not.toHaveBeenCalled();
    expect(runtime.stats().active).toBe(1);

    upstream.resolve('done');
    await waitFor(() => runtime.stats().active === 0, 'slot release');
    // A later abort has no listener left behind to reject anything.
    controller.abort();
    await runtime.shutdown();
  });

  it('answers with the operation result through the default timer and signal hooks', async () => {
    const runtime = createRuntime({ client: client(), limits: DEFAULT_LIMITS });
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    await expect(runtime.invoke(() => Promise.resolve('value'), { signal: controller.signal }))
      .resolves.toBe('value');
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    await runtime.shutdown();
    await expect(runtime.invoke(() => Promise.resolve('late'))).rejects.toEqual(
      new RuntimeError('BUSY', 'Server is shutting down.'),
    );
  });
});
