import { ConfigurationError } from './errors.js';

const MiB = 1_048_576;

export interface Limits {
  readonly max_active_calls: number;
  readonly max_json_response_bytes: number;
  readonly max_file_bytes: number;
  readonly max_data_bytes: number;
  readonly max_result_bytes: number;
  readonly max_all_items: number;
  readonly max_all_pages: number;
  readonly max_all_bytes: number;
  readonly max_all_duration_ms: number;
}

export const DEFAULT_LIMITS: Limits = Object.freeze({
  max_active_calls: 4,
  max_json_response_bytes: 10 * MiB,
  max_file_bytes: 100 * MiB,
  max_data_bytes: MiB,
  max_result_bytes: 2_621_440,
  max_all_items: 1_000,
  max_all_pages: 20,
  max_all_bytes: MiB,
  max_all_duration_ms: 45_000,
});

export const LIMIT_CEILINGS: Limits = Object.freeze({
  max_active_calls: 4,
  max_json_response_bytes: 64 * MiB,
  max_file_bytes: 100 * MiB,
  max_data_bytes: 8 * MiB,
  max_result_bytes: 24 * MiB,
  max_all_items: 10_000,
  max_all_pages: 100,
  max_all_bytes: 8 * MiB,
  max_all_duration_ms: 45_000,
});

export const FIXED_BUDGETS = Object.freeze({
  max_binary_downloads: 1,
  max_error_bytes: 16_384,
  response_wait_ms: 60_000,
  shutdown_drain_ms: 5_000,
});

export function parseLimits(raw: string | undefined): Limits {
  if (raw === undefined) return DEFAULT_LIMITS;
  const invalid = () => new ConfigurationError('TESTRAIL_MCP_LIMITS');
  let candidate: unknown;
  try {
    candidate = JSON.parse(raw);
  } catch {
    throw invalid();
  }
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw invalid();
  }
  const limits = { ...DEFAULT_LIMITS };
  for (const [key, value] of Object.entries(candidate)) {
    if (!Object.hasOwn(LIMIT_CEILINGS, key)) throw invalid();
    const name = key as keyof Limits;
    if (!Number.isSafeInteger(value) || typeof value !== 'number' || value < 1 || value > LIMIT_CEILINGS[name]) {
      throw invalid();
    }
    limits[name] = value;
  }
  if (limits.max_all_bytes > limits.max_data_bytes) throw invalid();
  return Object.freeze(limits);
}
