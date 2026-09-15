export type ConfigurationKey =
  | 'TESTRAIL_BASE_URL'
  | 'TESTRAIL_EMAIL'
  | 'TESTRAIL_API_KEY'
  | 'TESTRAIL_MCP_UPLOAD_ROOTS'
  | 'TESTRAIL_MCP_DOWNLOAD_DIR'
  | 'TESTRAIL_ALLOW_PRIVATE_HOSTS'
  | 'TESTRAIL_ALLOW_INSECURE'
  | 'TESTRAIL_MCP_LIMITS';

/** Never retain a source error: filesystem and driver errors may contain secrets or paths. */
export class ConfigurationError extends Error {
  constructor(readonly key: ConfigurationKey) {
    super(`Invalid configuration: ${key}.`);
    this.name = 'ConfigurationError';
  }
}
