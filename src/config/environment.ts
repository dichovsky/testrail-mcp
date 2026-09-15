import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { access, open, realpath, stat, unlink } from 'node:fs/promises';
import { isAbsolute, join, parse } from 'node:path';
import { TestRailConfigSchema } from '@dichovsky/testrail-api-client';
import { ConfigurationError, type ConfigurationKey } from './errors.js';
import { parseLimits, type Limits } from './limits.js';

export { ConfigurationError } from './errors.js';
export type Environment = Readonly<Record<string, string | undefined>>;

export interface Configuration {
  readonly baseUrl: string;
  readonly email: string;
  readonly apiKey: string;
  readonly allowPrivateHosts: boolean;
  readonly allowInsecure: boolean;
  readonly uploadRoots: readonly string[];
  readonly downloadDirectory: string;
  readonly limits: Limits;
}

function required(environment: Environment, key: ConfigurationKey): string {
  const value = environment[key];
  if (value === undefined || value.trim().length === 0) throw new ConfigurationError(key);
  return value;
}

function boolean(environment: Environment, key: ConfigurationKey): boolean {
  const value = environment[key];
  if (value === undefined || value === 'false') return false;
  if (value === 'true') return true;
  throw new ConfigurationError(key);
}

function instanceUrl(value: string, allowInsecure: boolean): string {
  try {
    // WHATWG URL parsing silently drops whitespace and normalizes backslashes.
    // Reject those spellings, empty query/fragment delimiters and empty userinfo too.
    const hasControl = [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
    if (/[\s\\?#]/u.test(value) || hasControl || !/^https?:\/\//iu.test(value)) {
      throw new Error();
    }
    const url = new URL(value);
    const authority = value.slice(value.indexOf('://') + 3).split('/')[0];
    if (
      !authority || url.username !== '' || url.password !== '' || authority.includes('@') ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && allowInsecure))
    ) {
      throw new Error();
    }
    return value;
  } catch {
    throw new ConfigurationError('TESTRAIL_BASE_URL');
  }
}

async function directory(value: unknown, key: ConfigurationKey, writable = false): Promise<string> {
  try {
    if (typeof value !== 'string' || !isAbsolute(value)) throw new Error();
    // On Windows, isAbsolute also accepts paths rooted on the *current* drive.
    // Require a drive-qualified or UNC directory rather than inheriting that authority.
    if (process.platform === 'win32' && /^[\\/]$/u.test(parse(value).root)) throw new Error();
    const resolved = await realpath(value);
    if (!(await stat(resolved)).isDirectory()) throw new Error();
    if (writable) await verifyWritable(resolved);
    return resolved;
  } catch {
    throw new ConfigurationError(key);
  }
}

async function verifyWritable(directory: string): Promise<void> {
  await access(directory, constants.W_OK | constants.X_OK);
  // access() does not check Windows ACLs. Exercise creation, writing and removal
  // with an exclusive private probe; never remove a path unless we created it.
  const probe = join(directory, `.testrail-mcp-write-check-${randomUUID()}`);
  const handle = await open(probe, 'wx', 0o600);
  try {
    await handle.writeFile(new Uint8Array([0]));
  } finally {
    try {
      await handle.close();
    } finally {
      await unlink(probe);
    }
  }
}

async function uploadRoots(raw: string): Promise<readonly string[]> {
  let paths: unknown;
  try {
    paths = JSON.parse(raw);
  } catch {
    throw new ConfigurationError('TESTRAIL_MCP_UPLOAD_ROOTS');
  }
  if (!Array.isArray(paths)) throw new ConfigurationError('TESTRAIL_MCP_UPLOAD_ROOTS');
  const resolved: string[] = [];
  for (const path of paths) {
    resolved.push(await directory(path, 'TESTRAIL_MCP_UPLOAD_ROOTS'));
  }
  return Object.freeze([...new Set(resolved)]);
}

/** Read explicit keys and validate local directories; no .env or network access. */
export async function loadConfiguration(environment: Environment): Promise<Configuration> {
  const allowPrivateHosts = boolean(environment, 'TESTRAIL_ALLOW_PRIVATE_HOSTS');
  const allowInsecure = boolean(environment, 'TESTRAIL_ALLOW_INSECURE');
  const baseUrl = instanceUrl(required(environment, 'TESTRAIL_BASE_URL'), allowInsecure);
  const email = required(environment, 'TESTRAIL_EMAIL');
  if (!TestRailConfigSchema.shape.email.safeParse(email).success) {
    throw new ConfigurationError('TESTRAIL_EMAIL');
  }
  const apiKey = required(environment, 'TESTRAIL_API_KEY');
  const limits = parseLimits(environment.TESTRAIL_MCP_LIMITS);
  const rawRoots = required(environment, 'TESTRAIL_MCP_UPLOAD_ROOTS');
  const downloadPath = required(environment, 'TESTRAIL_MCP_DOWNLOAD_DIR');
  const roots = await uploadRoots(rawRoots);
  const downloadDirectory = await directory(
    downloadPath, 'TESTRAIL_MCP_DOWNLOAD_DIR', true,
  );
  return Object.freeze({ baseUrl, email, apiKey, allowPrivateHosts, allowInsecure,
    uploadRoots: roots, downloadDirectory, limits });
}
