import * as fileSystem from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, expectTypeOf, it, vi, type MockInstance } from 'vitest';
import { ConfigurationError, loadConfiguration } from '../src/config/environment.js';

// Preserve real filesystem behavior while permitting portable failure fixtures.
vi.mock('node:fs/promises', { spy: true });

type Environment = Record<string, string | undefined>;
type ProbeSpies = {
  writeFile: MockInstance<fileSystem.FileHandle['writeFile']>;
  close: MockInstance<fileSystem.FileHandle['close']>;
};

// Keep contract expectations independent of the implementation's exported constants.
const defaults = {
  max_active_calls: 4,
  max_json_response_bytes: 10_485_760,
  max_file_bytes: 104_857_600,
  max_data_bytes: 1_048_576,
  max_result_bytes: 2_621_440,
  max_all_items: 1_000,
  max_all_pages: 20,
  max_all_bytes: 1_048_576,
  max_all_duration_ms: 45_000,
} as const;
const ceilings = {
  max_active_calls: 4,
  max_json_response_bytes: 67_108_864,
  max_file_bytes: 104_857_600,
  max_data_bytes: 8_388_608,
  max_result_bytes: 25_165_824,
  max_all_items: 10_000,
  max_all_pages: 100,
  max_all_bytes: 8_388_608,
  max_all_duration_ms: 45_000,
} as const;
const requiredKeys = [
  'TESTRAIL_BASE_URL',
  'TESTRAIL_EMAIL',
  'TESTRAIL_API_KEY',
  'TESTRAIL_MCP_UPLOAD_ROOTS',
  'TESTRAIL_MCP_DOWNLOAD_DIR',
] as const;

let directory: string;
let uploadDirectory: string;
let downloadDirectory: string;
let ordinaryFile: string;
let environment: Environment;

beforeAll(async () => {
  directory = await fileSystem.mkdtemp(join(tmpdir(), 'testrail-config-synthetic-local-authority-'));
  uploadDirectory = join(directory, 'upload directory');
  downloadDirectory = join(directory, 'download');
  ordinaryFile = join(directory, 'ordinary-file');
  await fileSystem.mkdir(uploadDirectory);
  await fileSystem.mkdir(downloadDirectory);
  await fileSystem.writeFile(ordinaryFile, 'fixture');
  environment = {
    TESTRAIL_BASE_URL: 'https://testrail.example.test/installation/testrail/',
    TESTRAIL_EMAIL: 'configured.user+automation@example.test',
    TESTRAIL_API_KEY: 'synthetic-secret-must-not-appear',
    TESTRAIL_MCP_UPLOAD_ROOTS: JSON.stringify([uploadDirectory]),
    TESTRAIL_MCP_DOWNLOAD_DIR: downloadDirectory,
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  if (directory !== undefined) await fileSystem.rm(directory, { recursive: true, force: true });
});

async function rejectsConfiguration(key: string, value: string | undefined): Promise<void> {
  let failure: unknown;
  try {
    await loadConfiguration({ ...environment, [key]: value });
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(ConfigurationError);
  if (!(failure instanceof ConfigurationError)) throw new Error('Expected configuration failure.');
  expect(failure.key).toBe(key);
  expect(failure.message).toBe(`Invalid configuration: ${key}.`);
  expect(failure).not.toHaveProperty('cause');
  const diagnostics = [String(failure), JSON.stringify(failure), failure.stack ?? ''].join('\n');
  expect(diagnostics).not.toContain('synthetic-secret');
  expect(diagnostics).not.toContain('synthetic-local-authority');
  expect(diagnostics).not.toContain('testrail.example.test');
  expect(diagnostics).not.toContain('configured.user');
}

describe('launch environment configuration', () => {
  it('preserves configured identity, API key and installation URL with explicit default budgets', async () => {
    const configuration = await loadConfiguration(environment);
    expect(configuration).toEqual({
      baseUrl: environment.TESTRAIL_BASE_URL,
      email: environment.TESTRAIL_EMAIL,
      apiKey: environment.TESTRAIL_API_KEY,
      allowPrivateHosts: false,
      allowInsecure: false,
      uploadRoots: [await fileSystem.realpath(uploadDirectory)],
      downloadDirectory: await fileSystem.realpath(downloadDirectory),
      limits: defaults,
    });
  });

  it.each(requiredKeys)('requires %s without exposing supplied values', async (key) => {
    for (const value of [undefined, '', ' \t\n ']) await rejectsConfiguration(key, value);
  });

  it('reads only the supplied launch environment', async () => {
    for (const key of requiredKeys) vi.stubEnv(key, environment[key]);
    await expect(loadConfiguration({})).rejects.toMatchObject({
      key: 'TESTRAIL_BASE_URL',
      message: 'Invalid configuration: TESTRAIL_BASE_URL.',
    });
  });

  it('preserves a real secret exactly, including surrounding spaces', async () => {
    const apiKey = '  synthetic-secret-with-significant-padding \t';
    const configuration = await loadConfiguration({ ...environment, TESTRAIL_API_KEY: apiKey });
    expect(configuration.apiKey).toBe(apiKey);
  });

  it('accepts the public driver identity format rather than imposing a narrower email format', async () => {
    const email = 'local!part@internal.instance.test';
    const configuration = await loadConfiguration({ ...environment, TESTRAIL_EMAIL: email });
    expect(configuration.email).toBe(email);
  });

  it.each([
    'not-an-email', 'user@example', '@example.test', 'user@',
    'user@@example.test', 'user name@example.test', ' user@example.test',
    'user@example.test ', 'user@example.test\n',
  ])('rejects an invalid configured identity %j', async (email) => {
    await rejectsConfiguration('TESTRAIL_EMAIL', email);
  });

  it('returns a deeply frozen independent snapshot with readonly types', async () => {
    const mutableEnvironment = { ...environment };
    const pending = loadConfiguration(mutableEnvironment);
    mutableEnvironment.TESTRAIL_API_KEY = 'replacement-secret';
    mutableEnvironment.TESTRAIL_MCP_UPLOAD_ROOTS = '[]';
    mutableEnvironment.TESTRAIL_MCP_DOWNLOAD_DIR = ordinaryFile;
    const configuration = await pending;
    expectTypeOf(configuration).toEqualTypeOf<Readonly<typeof configuration>>();
    expectTypeOf(configuration.uploadRoots).toEqualTypeOf<readonly string[]>();
    expectTypeOf(configuration.limits).toEqualTypeOf<Readonly<typeof configuration.limits>>();
    expect(Object.isFrozen(configuration)).toBe(true);
    expect(Object.isFrozen(configuration.uploadRoots)).toBe(true);
    expect(Object.isFrozen(configuration.limits)).toBe(true);
    expect(Reflect.set(configuration, 'baseUrl', 'https://changed.example.test')).toBe(false);
    expect(Reflect.set(configuration.uploadRoots, '0', directory)).toBe(false);
    expect(Reflect.set(configuration.limits, 'max_active_calls', 1)).toBe(false);
    expect(configuration.apiKey).toBe(environment.TESTRAIL_API_KEY);
    expect(configuration.uploadRoots).toEqual([await fileSystem.realpath(uploadDirectory)]);
    expect(configuration.downloadDirectory).toBe(await fileSystem.realpath(downloadDirectory));
  });
});

describe('literal boolean and instance URL configuration', () => {
  it.each(['TESTRAIL_ALLOW_PRIVATE_HOSTS', 'TESTRAIL_ALLOW_INSECURE'] as const)(
    'accepts only literal true and false for %s', async (key) => {
      const property = key === 'TESTRAIL_ALLOW_PRIVATE_HOSTS' ? 'allowPrivateHosts' : 'allowInsecure';
      for (const value of ['true', 'false']) {
        const configuration = await loadConfiguration({ ...environment, [key]: value });
        expect(configuration[property]).toBe(value === 'true');
      }
      for (const value of ['', 'TRUE', 'False', '1', '0', ' true', 'false ', 'true\n', 'null']) {
        await rejectsConfiguration(key, value);
      }
    },
  );

  it.each([
    'https://testrail.example.test',
    'https://testrail.example.test:8443/testrail/index.php',
    'https://testrail.example.test/installation%20path/',
  ])('retains the supplied supported URL %s', async (baseUrl) => {
    const configuration = await loadConfiguration({ ...environment, TESTRAIL_BASE_URL: baseUrl });
    expect(configuration.baseUrl).toBe(baseUrl);
  });

  it('requires explicit insecure opt-in for HTTP independently of private-host opt-in', async () => {
    const baseUrl = 'http://testrail.example.test/installation/';
    await rejectsConfiguration('TESTRAIL_BASE_URL', baseUrl);
    await expect(loadConfiguration({
      ...environment,
      TESTRAIL_BASE_URL: baseUrl,
      TESTRAIL_ALLOW_PRIVATE_HOSTS: 'true',
    })).rejects.toMatchObject({ key: 'TESTRAIL_BASE_URL' });
    const configuration = await loadConfiguration({
      ...environment,
      TESTRAIL_BASE_URL: baseUrl,
      TESTRAIL_ALLOW_INSECURE: 'true',
    });
    expect(configuration.baseUrl).toBe(baseUrl);
    expect(configuration.allowInsecure).toBe(true);
    expect(configuration.allowPrivateHosts).toBe(false);
  });

  it.each([
    'not-a-url', '/relative/install', '//testrail.example.test/install',
    'https:///testrail.example.test', 'https:////@testrail.example.test',
    'ftp://testrail.example.test', 'file:///testrail', 'data:text/plain,testrail',
    ' https://testrail.example.test', 'https://testrail.example.test ',
    'https://testrail.example.test/in stall', 'https://testrail.example.test/\tinstall',
    'https://testrail.example.test/\ninstall', 'https://testrail.example.test/\u0000install',
    'https://testrail.example.test/\u007finstall', 'https://testrail.example.test\\install',
    'https://user:synthetic-secret@testrail.example.test',
    'https://user@testrail.example.test', 'https://@testrail.example.test',
    'https://:@testrail.example.test',
    'https://testrail.example.test?secret=synthetic-secret',
    'https://testrail.example.test?', 'https://testrail.example.test#fragment',
    'https://testrail.example.test#',
  ])('rejects malformed or disallowed URL %j with a fixed diagnostic', async (baseUrl) => {
    await rejectsConfiguration('TESTRAIL_BASE_URL', baseUrl);
  });
});

describe('configured local directory authority', () => {
  it('allows an explicit empty upload-root list', async () => {
    const configuration = await loadConfiguration({ ...environment, TESTRAIL_MCP_UPLOAD_ROOTS: '[]' });
    expect(configuration.uploadRoots).toEqual([]);
  });

  it('resolves symlinks and dot segments and deduplicates canonical roots', async () => {
    const alias = join(directory, 'upload-alias');
    const downloadAlias = join(directory, 'download-alias');
    await fileSystem.symlink(uploadDirectory, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await fileSystem.symlink(downloadDirectory, downloadAlias, process.platform === 'win32' ? 'junction' : 'dir');
    const configuration = await loadConfiguration({
      ...environment,
      TESTRAIL_MCP_UPLOAD_ROOTS: JSON.stringify([
        uploadDirectory, alias, `${uploadDirectory}${sep}..${sep}upload directory`, downloadDirectory,
      ]),
      TESTRAIL_MCP_DOWNLOAD_DIR: downloadAlias,
    });
    expect(configuration.uploadRoots).toEqual([
      await fileSystem.realpath(uploadDirectory), await fileSystem.realpath(downloadDirectory),
    ]);
    expect(configuration.downloadDirectory).toBe(await fileSystem.realpath(downloadDirectory));
  });

  it.each(['not-json', '{}', 'null', 'false', '1', '"/tmp"', '[null]', '[1]', '[true]', '[{}]', '[[]]'])(
    'rejects a non-directory-list upload-root value %s', async (roots) => {
      await rejectsConfiguration('TESTRAIL_MCP_UPLOAD_ROOTS', roots);
    },
  );

  it('rejects relative, missing, file and null-byte paths for both authorities', async () => {
    for (const invalidPath of ['.', 'relative-directory', join(directory, 'missing'), ordinaryFile, `${uploadDirectory}\u0000`]) {
      await rejectsConfiguration('TESTRAIL_MCP_UPLOAD_ROOTS', JSON.stringify([invalidPath]));
      await rejectsConfiguration('TESTRAIL_MCP_DOWNLOAD_DIR', invalidPath);
    }
    await rejectsConfiguration('TESTRAIL_MCP_UPLOAD_ROOTS', JSON.stringify([uploadDirectory, ordinaryFile]));
    if (process.platform === 'win32') {
      const realpath = vi.spyOn(fileSystem, 'realpath');
      for (const invalidPath of ['\\root-relative', '/root-relative']) {
        realpath.mockClear();
        await rejectsConfiguration('TESTRAIL_MCP_UPLOAD_ROOTS', JSON.stringify([invalidPath]));
        expect(realpath).not.toHaveBeenCalled();
        realpath.mockClear();
        await expect(loadConfiguration({
          ...environment,
          TESTRAIL_MCP_UPLOAD_ROOTS: '[]',
          TESTRAIL_MCP_DOWNLOAD_DIR: invalidPath,
        })).rejects.toMatchObject({
          key: 'TESTRAIL_MCP_DOWNLOAD_DIR',
          message: 'Invalid configuration: TESTRAIL_MCP_DOWNLOAD_DIR.',
        });
        expect(realpath).not.toHaveBeenCalled();
      }
    }
  });

  it('rejects dangling directory symlinks', async () => {
    const dangling = join(directory, 'dangling');
    await fileSystem.symlink(join(directory, 'missing-target'), dangling, process.platform === 'win32' ? 'junction' : 'dir');
    await rejectsConfiguration('TESTRAIL_MCP_UPLOAD_ROOTS', JSON.stringify([dangling]));
    await rejectsConfiguration('TESTRAIL_MCP_DOWNLOAD_DIR', dangling);
  });

  it('verifies a real exclusive, restrictive write and removes its owned probe', async () => {
    const actualFileSystem = await vi.importActual<typeof fileSystem>('node:fs/promises');
    const before = await fileSystem.readdir(downloadDirectory);
    const access = vi.spyOn(fileSystem, 'access');
    const unlink = vi.spyOn(fileSystem, 'unlink');
    let probe: ProbeSpies | undefined;
    let written: Buffer | undefined;
    let closeActual: (() => Promise<void>) | undefined;
    const open = vi.spyOn(fileSystem, 'open').mockImplementationOnce(async (...args) => {
      const handle = await actualFileSystem.open(...args);
      closeActual = handle.close.bind(handle);
      const writeActual = handle.writeFile.bind(handle);
      const writeFile = vi.spyOn(handle, 'writeFile').mockImplementationOnce(async (...writeArgs) => {
        await writeActual(...writeArgs);
        written = await actualFileSystem.readFile(args[0]);
      });
      probe = { writeFile, close: vi.spyOn(handle, 'close') };
      return handle;
    });
    let configuration;
    try {
      configuration = await loadConfiguration(environment);
      expect(probe).toBeDefined();
      if (probe === undefined) throw new Error('Expected an owned probe handle.');
      expect(probe.writeFile).toHaveBeenCalledOnce();
      expect(probe.close).toHaveBeenCalledOnce();
      expect(written).toEqual(Buffer.from([0]));
    } finally {
      await closeActual?.();
    }
    expect(access).toHaveBeenCalledWith(configuration.downloadDirectory, expect.any(Number));
    expect(access.mock.calls.some(([path, mode]) =>
      path === configuration.downloadDirectory && ((mode ?? 0) & constants.W_OK) === constants.W_OK,
    )).toBe(true);
    expect(open).toHaveBeenCalledExactlyOnceWith(
      expect.stringMatching(/\.testrail-mcp-write-check-[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/u),
      'wx', 0o600,
    );
    const probePath = open.mock.calls[0]?.[0];
    expect(typeof probePath).toBe('string');
    if (typeof probePath !== 'string') throw new Error('Expected an absolute probe path.');
    expect(dirname(probePath)).toBe(configuration.downloadDirectory);
    expect(unlink).toHaveBeenCalledExactlyOnceWith(probePath);
    expect(await fileSystem.readdir(downloadDirectory)).toEqual(before);
  });

  it('redacts an underlying download permission error on every platform', async () => {
    const underlying = Object.assign(new Error(`EACCES synthetic-secret ${resolve(downloadDirectory)}`), { code: 'EACCES' });
    vi.spyOn(fileSystem, 'access').mockRejectedValueOnce(underlying);
    const open = vi.spyOn(fileSystem, 'open');
    await rejectsConfiguration('TESTRAIL_MCP_DOWNLOAD_DIR', downloadDirectory);
    expect(open).not.toHaveBeenCalled();
  });

  it.each(['EACCES', 'EEXIST'])('rejects failed probe creation (%s) without deleting an unowned path', async (code) => {
    const before = await fileSystem.readdir(downloadDirectory);
    const underlying = Object.assign(new Error(`${code} synthetic-secret ${downloadDirectory}`), { code });
    const access = vi.spyOn(fileSystem, 'access');
    const open = vi.spyOn(fileSystem, 'open').mockRejectedValueOnce(underlying);
    const unlink = vi.spyOn(fileSystem, 'unlink');
    await rejectsConfiguration('TESTRAIL_MCP_DOWNLOAD_DIR', downloadDirectory);
    expect(access).toHaveBeenCalled();
    expect(open).toHaveBeenCalledOnce();
    expect(unlink).not.toHaveBeenCalled();
    expect(await fileSystem.readdir(downloadDirectory)).toEqual(before);
  });

  it.each(['write', 'close', 'write-and-close'])(
    'redacts probe %s errors, closes its handle and attempts removal', async (stage) => {
      const actualFileSystem = await vi.importActual<typeof fileSystem>('node:fs/promises');
      const before = await fileSystem.readdir(downloadDirectory);
      const underlying = new Error(`synthetic-secret ${downloadDirectory}`);
      let probe: ProbeSpies | undefined;
      let closeActual: (() => Promise<void>) | undefined;
      const open = vi.spyOn(fileSystem, 'open').mockImplementationOnce(async (...args) => {
        const handle = await actualFileSystem.open(...args);
        closeActual = handle.close.bind(handle);
        const actualClose = closeActual;
        const writeFile = vi.spyOn(handle, 'writeFile');
        if (stage !== 'close') writeFile.mockRejectedValueOnce(underlying);
        const close = vi.spyOn(handle, 'close');
        if (stage !== 'write') close.mockImplementationOnce(async () => {
          // Release the actual OS handle before injecting the error so this fixture
          // can also check removal on Windows without leaking a test descriptor.
          await actualClose();
          throw underlying;
        });
        probe = { writeFile, close };
        return handle;
      });
      const unlink = vi.spyOn(fileSystem, 'unlink');
      try {
        await rejectsConfiguration('TESTRAIL_MCP_DOWNLOAD_DIR', downloadDirectory);
        expect(probe).toBeDefined();
        if (probe === undefined) throw new Error('Expected an owned probe handle.');
        expect(probe.writeFile).toHaveBeenCalledOnce();
        expect(probe.close).toHaveBeenCalledOnce();
        expect(unlink).toHaveBeenCalledExactlyOnceWith(open.mock.calls[0]?.[0]);
        expect(await fileSystem.readdir(downloadDirectory)).toEqual(before);
      } finally {
        await closeActual?.();
      }
    },
  );

  it('rejects and redacts failure to remove a completed probe', async () => {
    const actualFileSystem = await vi.importActual<typeof fileSystem>('node:fs/promises');
    const before = await fileSystem.readdir(downloadDirectory);
    const underlying = new Error(`synthetic-secret ${downloadDirectory}`);
    const open = vi.spyOn(fileSystem, 'open');
    const unlink = vi.spyOn(fileSystem, 'unlink').mockRejectedValueOnce(underlying);
    try {
      await rejectsConfiguration('TESTRAIL_MCP_DOWNLOAD_DIR', downloadDirectory);
      expect(unlink).toHaveBeenCalledExactlyOnceWith(open.mock.calls[0]?.[0]);
    } finally {
      const probePath = open.mock.calls[0]?.[0];
      if (probePath !== undefined) await actualFileSystem.unlink(probePath);
    }
    expect(await fileSystem.readdir(downloadDirectory)).toEqual(before);
  });
});

describe('strict runtime limits', () => {
  it('accepts an empty object and preserves defaults for omitted overrides', async () => {
    const empty = await loadConfiguration({ ...environment, TESTRAIL_MCP_LIMITS: '{}' });
    expect(empty.limits).toEqual(defaults);
    const configured = await loadConfiguration({
      ...environment,
      TESTRAIL_MCP_LIMITS: '{"max_active_calls":2,"max_all_pages":7}',
    });
    expect(configured.limits).toEqual({ ...defaults, max_active_calls: 2, max_all_pages: 7 });
  });

  it('accepts exactly the independent minimum and ceiling values without clamping', async () => {
    const minimums = Object.fromEntries(Object.keys(ceilings).map((key) => [key, 1]));
    for (const limits of [minimums, ceilings]) {
      const configuration = await loadConfiguration({ ...environment, TESTRAIL_MCP_LIMITS: JSON.stringify(limits) });
      expect(configuration.limits).toEqual(limits);
    }
  });

  it.each(Object.entries(ceilings))('rejects values outside the safe positive integer range for %s', async (key, ceiling) => {
    for (const value of [0, -1, 1.5, ceiling + 1, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, '1', true, false, null, [], {}]) {
      await rejectsConfiguration('TESTRAIL_MCP_LIMITS', JSON.stringify({ [key]: value }));
    }
  });

  it.each([
    '', ' ', 'not-json', 'null', '[]', 'true', '1', '"object"',
    '{"max_all_items":NaN}', '{"max_all_items":Infinity}', '{"max_all_items":1e309}',
    '{"max_all_items":-1e309}', '{"max_all_items":1,}',
    '{"unexpected":1}', '{"max_active_calls":1,"unexpected":1}',
    '{"__proto__":{"max_active_calls":1}}', '{"__proto__":1}',
    '{"constructor":1}', '{"prototype":1}', '{"toString":1}',
    '{"max_binary_downloads":1}', '{"max_error_bytes":16384}',
    '{"response_wait_ms":60000}', '{"shutdown_drain_ms":5000}',
  ])('rejects invalid JSON, unknown or fixed-only keys: %s', async (limits) => {
    await rejectsConfiguration('TESTRAIL_MCP_LIMITS', limits);
  });

  it('rejects aggregate bytes greater than the configured data bound, including conflicting defaults', async () => {
    for (const limits of [
      { max_all_bytes: 1_048_577 },
      { max_data_bytes: 1_048_575 },
      { max_data_bytes: 100, max_all_bytes: 101 },
    ]) {
      await rejectsConfiguration('TESTRAIL_MCP_LIMITS', JSON.stringify(limits));
    }
    const configuration = await loadConfiguration({
      ...environment,
      TESTRAIL_MCP_LIMITS: '{"max_data_bytes":100,"max_all_bytes":100}',
    });
    expect(configuration.limits.max_data_bytes).toBe(100);
    expect(configuration.limits.max_all_bytes).toBe(100);
  });
});
