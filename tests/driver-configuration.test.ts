import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TestRailClient, TestRailConfigSchema } from '@dichovsky/testrail-api-client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ConfigurationError, loadConfiguration, type Configuration } from '../src/config/environment.js';
import { createConfiguredDriver, driverOptions } from '../src/driver/configuration.js';

let directory: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'testrail-mcp-driver-'));
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

function configuration(overrides: NodeJS.ProcessEnv = {}) {
  return loadConfiguration({
    TESTRAIL_BASE_URL: 'https://example.testrail.io/installation',
    TESTRAIL_EMAIL: 'user@example.com',
    TESTRAIL_API_KEY: 'synthetic-secret',
    TESTRAIL_MCP_UPLOAD_ROOTS: '[]',
    TESTRAIL_MCP_DOWNLOAD_DIR: directory,
    ...overrides,
  });
}

function listeners() {
  return {
    exit: process.listeners('exit'),
    SIGINT: process.listeners('SIGINT'),
    SIGTERM: process.listeners('SIGTERM'),
  };
}

describe('driver construction preparation', () => {
  it('maps the identity and exact F03 transport budgets through the public options', async () => {
    expect(driverOptions(await configuration())).toEqual({
      baseUrl: 'https://example.testrail.io/installation',
      email: 'user@example.com',
      apiKey: 'synthetic-secret',
      allowPrivateHosts: false,
      allowInsecure: false,
      registerProcessHandlers: false,
      enableCache: false,
      timeout: 15_000,
      bodyTimeout: 15_000,
      maxRetries: 3,
      rateLimiter: { maxRequests: 100, windowMs: 60_000 },
      maxJsonResponseBytes: 10 * 1_048_576,
      maxBinaryResponseBytes: 100 * 1_048_576,
    });
  });

  it('passes configured JSON and file byte bounds to the driver', async () => {
    const config = await configuration({
      TESTRAIL_MCP_LIMITS: JSON.stringify({ max_json_response_bytes: 4096, max_file_bytes: 8192 }),
    });
    expect(driverOptions(config)).toMatchObject({
      maxJsonResponseBytes: 4096,
      maxBinaryResponseBytes: 8192,
    });
  });

  it('constructs the real public driver without starting DNS, fetch or process handlers', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error('Unexpected fetch'));
    const dnsLookup = vi.fn().mockRejectedValue(new Error('Unexpected DNS'));
    const originalListeners = listeners();
    const client = new TestRailClient({ ...driverOptions(await configuration()), fetch, dnsLookup });
    try {
      await Promise.resolve();
      expect(client).toBeInstanceOf(TestRailClient);
      expect(typeof client.projects.getProject).toBe('function');
      expect(typeof client.attachments.getAttachment).toBe('function');
      expect(fetch).not.toHaveBeenCalled();
      expect(dnsLookup).not.toHaveBeenCalled();
      expect(listeners()).toEqual(originalListeners);
    } finally {
      client.destroy();
    }
    expect(listeners()).toEqual(originalListeners);
  });

  it('returns a real client for the eventual runtime owner to destroy', async () => {
    const originalListeners = listeners();
    const client = createConfiguredDriver(await configuration());
    try {
      expect(client).toBeInstanceOf(TestRailClient);
      expect(listeners()).toEqual(originalListeners);
    } finally {
      client.destroy();
    }
    expect(listeners()).toEqual(originalListeners);
  });

  it.each([
    'https://localhost/private-installation',
    'https://127.0.0.1/private-installation',
    'https://10.20.30.40/private-installation',
    'https://[::1]/private-installation',
    'http://example.testrail.io/private-installation',
  ])('reports a fixed configuration diagnostic for URL policy rejection: %s', async (baseUrl) => {
    let failure: unknown;
    try {
      createConfiguredDriver(await configuration({ TESTRAIL_BASE_URL: baseUrl }));
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ConfigurationError);
    expect(failure).toHaveProperty('message', 'Invalid configuration: TESTRAIL_BASE_URL.');
    expect(failure).not.toHaveProperty('cause');
    expect(String(failure)).not.toContain('private-installation');
    expect(String(failure)).not.toContain('synthetic-secret');
  });

  it.each([
    { baseUrl: 'https://localhost/installation', privateHosts: 'true', insecure: 'false' },
    { baseUrl: 'http://example.testrail.io/installation', privateHosts: 'false', insecure: 'true' },
    { baseUrl: 'http://127.0.0.1/installation', privateHosts: 'true', insecure: 'true' },
  ])('honors the explicit network opt-ins for $baseUrl', async ({ baseUrl, privateHosts, insecure }) => {
    vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    const config = await configuration({
      TESTRAIL_BASE_URL: baseUrl,
      TESTRAIL_ALLOW_PRIVATE_HOSTS: privateHosts,
      TESTRAIL_ALLOW_INSECURE: insecure,
    });
    expect(driverOptions(config)).toMatchObject({
      allowPrivateHosts: privateHosts === 'true',
      allowInsecure: insecure === 'true',
    });
    const client = createConfiguredDriver(config);
    client.destroy();
  });

  it.each([
    { TESTRAIL_ALLOW_PRIVATE_HOSTS: 'true' },
    { TESTRAIL_ALLOW_INSECURE: 'true' },
  ])('requires both opt-ins for a private HTTP instance: %j', async (optIn) => {
    await expect(configuration({ TESTRAIL_BASE_URL: 'http://127.0.0.1/installation', ...optIn })
      .then(createConfiguredDriver)).rejects.toThrow('Invalid configuration: TESTRAIL_BASE_URL.');
  });

  it('preserves unrelated constructor failures instead of mislabeling them as configuration', async () => {
    // Load first: configuration load now constructs a probe client, so a spy installed
    // beforehand would fire there instead of at the construction under test.
    const config = await configuration({
      TESTRAIL_BASE_URL: 'http://example.testrail.io/installation',
      TESTRAIL_ALLOW_INSECURE: 'true',
    });
    const failure = new Error('Synthetic warning-system failure');
    vi.spyOn(process, 'emitWarning').mockImplementation(() => { throw failure; });
    expect(() => createConfiguredDriver(config)).toThrow(failure);
  });

  it('applies the driver network policy during configuration load, before any driver is built', async () => {
    await expect(configuration({ TESTRAIL_BASE_URL: 'https://127.0.0.1/installation' }))
      .rejects.toThrow('Invalid configuration: TESTRAIL_BASE_URL.');
    await expect(configuration({ TESTRAIL_BASE_URL: 'https://[::1]/installation' }))
      .rejects.toThrow('Invalid configuration: TESTRAIL_BASE_URL.');
    await expect(configuration({
      TESTRAIL_BASE_URL: 'https://127.0.0.1/installation',
      TESTRAIL_ALLOW_PRIVATE_HOSTS: 'true',
    })).resolves.toMatchObject({ allowPrivateHosts: true });
  });

  it('attributes a driver field rejection to that field own environment key', async () => {
    const loaded = await configuration();
    for (const [override, key] of [
      [{ email: 'not-an-email' }, 'TESTRAIL_EMAIL'],
      [{ apiKey: '' }, 'TESTRAIL_API_KEY'],
    ] as const) {
      const config = { ...loaded, ...override } as Configuration;
      expect(() => createConfiguredDriver(config)).toThrow(`Invalid configuration: ${key}.`);
    }
  });

  it('never relabels an adapter-owned transport rejection as operator configuration', async () => {
    const config = { ...(await configuration()), baseUrl: 'https://127.0.0.1/x' } as Configuration;
    // A driver bump could tighten a field this adapter fixes; the operator cannot correct it.
    vi.spyOn(TestRailConfigSchema, 'safeParse').mockReturnValue(
      { success: false, error: { issues: [{ path: ['timeout'] }] } } as never,
    );
    expect(() => createConfiguredDriver(config)).toThrow('Driver rejected the adapter transport settings.');
    expect(() => createConfiguredDriver(config)).not.toThrow(ConfigurationError);
  });
});
