import {
  TestRailClient,
  TestRailValidationError,
  type TestRailConfig,
} from '@dichovsky/testrail-api-client';
import { ConfigurationError, type Configuration } from '../config/environment.js';

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

/** Internal preparation; runtime ownership requires the driver qualified by F01. */
export function createConfiguredDriver(configuration: Configuration): TestRailClient {
  const options = driverOptions(configuration);
  try {
    return new TestRailClient(options);
  } catch (error) {
    // Environment parsing has already validated the public schema. The driver
    // adds URL network policy; its diagnostic may contain the configured host.
    if (error instanceof TestRailValidationError) {
      throw new ConfigurationError('TESTRAIL_BASE_URL');
    }
    throw error;
  }
}
