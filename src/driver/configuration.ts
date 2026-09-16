import {
  TestRailClient,
  TestRailConfigSchema,
  TestRailValidationError,
  type TestRailConfig,
} from '@dichovsky/testrail-api-client';
import { ConfigurationError, DriverSettingsError, type ConfigurationKey } from '../config/errors.js';
import type { Configuration } from '../config/environment.js';

export function driverOptions(configuration: Configuration): TestRailConfig {
  return {
    baseUrl: configuration.baseUrl,
    email: configuration.email,
    apiKey: configuration.apiKey,
    allowPrivateHosts: configuration.allowPrivateHosts,
    allowInsecure: configuration.allowInsecure,
    registerProcessHandlers: false,
    enableCache: false,
    timeout: 15_000,
    bodyTimeout: 15_000,
    maxRetries: 3,
    rateLimiter: { maxRequests: 100, windowMs: 60_000 },
    maxJsonResponseBytes: configuration.limits.max_json_response_bytes,
    maxBinaryResponseBytes: configuration.limits.max_file_bytes,
  };
}

/** Driver option names that an operator can actually correct, by environment key. */
const operatorKeys: Readonly<Record<string, ConfigurationKey>> = {
  baseUrl: 'TESTRAIL_BASE_URL',
  email: 'TESTRAIL_EMAIL',
  apiKey: 'TESTRAIL_API_KEY',
  allowPrivateHosts: 'TESTRAIL_ALLOW_PRIVATE_HOSTS',
  allowInsecure: 'TESTRAIL_ALLOW_INSECURE',
  maxJsonResponseBytes: 'TESTRAIL_MCP_LIMITS',
  maxBinaryResponseBytes: 'TESTRAIL_MCP_LIMITS',
};

/**
 * Attribute a driver rejection to the environment key that caused it. Re-running the
 * driver's public schema names the offending field structurally; its thrown message
 * cannot be inspected because it embeds the configured host. A schema-clean option set
 * that still fails construction failed the driver's URL network policy, which only
 * TESTRAIL_BASE_URL and its two allow-flags can influence.
 */
function rejectedKey(options: TestRailConfig): ConfigurationKey | undefined {
  const parsed = TestRailConfigSchema.safeParse(options);
  if (parsed.success) return 'TESTRAIL_BASE_URL';
  for (const issue of parsed.error.issues) {
    const key = operatorKeys[String(issue.path[0] ?? '')];
    if (key !== undefined) return key;
  }
  return undefined; // A field this adapter fixes was rejected: not an operator error.
}

export function createConfiguredDriver(configuration: Configuration): TestRailClient {
  const options = driverOptions(configuration);
  try {
    return new TestRailClient(options);
  } catch (error) {
    if (error instanceof TestRailValidationError) {
      const key = rejectedKey(options);
      if (key !== undefined) throw new ConfigurationError(key);
      // Never relabel an adapter-owned transport setting as operator configuration.
      // Like ConfigurationError, this retains no cause: the driver's message embeds the host.
      throw new DriverSettingsError();
    }
    throw error;
  }
}

/**
 * Apply the driver's URL network policy at configuration load. The private/loopback
 * host and protocol rules live in the driver's constructor and are not exported, so
 * this is the only way to enforce them without duplicating them here. The probe client
 * registers no process handlers and issues no request; it is discarded immediately, so
 * it never becomes a second credential identity.
 */
export function assertDriverConfiguration(configuration: Configuration): void {
  createConfiguredDriver(configuration);
}
