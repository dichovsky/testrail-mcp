import {
  TestRailApiError,
  TestRailLicenseError,
  TestRailPaginationError,
  TestRailValidationError,
} from '@dichovsky/testrail-api-client';
import { RuntimeError } from '../runtime/errors.js';

export const ERROR_CODES = [
  'INVALID_ARGUMENT', 'FILE_ACCESS_DENIED', 'FILE_TOO_LARGE', 'BUSY',
  'AUTHENTICATION_FAILED', 'PERMISSION_DENIED', 'LICENSE_REQUIRED', 'NOT_FOUND',
  'RATE_LIMITED', 'PAGINATION_LIMIT', 'INVALID_RESPONSE', 'RESPONSE_TOO_LARGE',
  'TIMEOUT', 'CANCELLED', 'UPSTREAM_ERROR', 'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * What the adapter can prove about a TestRail mutation or report generation.
 * Never inferred from MCP annotations: an attachment download has local effects
 * but does not mutate TestRail, so it carries no write outcome at all.
 */
export type WriteOutcome = 'not_started' | 'unknown' | 'acknowledged';

/** Fixed text per code. A driver message may embed the host, a path or instance data. */
const MESSAGES: Readonly<Record<ErrorCode, string>> = {
  INVALID_ARGUMENT: 'The request arguments did not meet this tool\'s contract.',
  FILE_ACCESS_DENIED: 'The local file is outside a configured directory or is not readable.',
  FILE_TOO_LARGE: 'The local file exceeds the configured size limit.',
  BUSY: 'No capacity is available; no request was sent.',
  AUTHENTICATION_FAILED: 'TestRail rejected the configured credentials.',
  PERMISSION_DENIED: 'The configured TestRail user may not perform this operation.',
  LICENSE_REQUIRED: 'This TestRail feature requires a license the instance does not have.',
  NOT_FOUND: 'TestRail reported that the requested resource does not exist.',
  RATE_LIMITED: 'TestRail rate-limited the request.',
  PAGINATION_LIMIT: 'The aggregate stopped at a configured safety bound; no partial data is returned.',
  INVALID_RESPONSE: 'The TestRail response could not be used.',
  RESPONSE_TOO_LARGE: 'The result exceeds the configured size budget; narrow the request.',
  TIMEOUT: 'The response wait expired; upstream work may still be running.',
  CANCELLED: 'The call was cancelled; upstream work may still be running.',
  UPSTREAM_ERROR: 'TestRail returned an error.',
  INTERNAL_ERROR: 'The server failed to complete the call.',
};

/** Only these may accompany an error. Anything else risks leaking instance data. */
export interface SafeError {
  readonly code: ErrorCode;
  readonly message: string;
  readonly http_status?: number;
  /** Allowlisted by the contract; populated only if the driver ever exposes validated retry metadata. */
  readonly retry_after_ms?: number;
  readonly reason?: string;
  readonly pages_fetched?: number;
  readonly items_fetched?: number;
  readonly write_outcome?: WriteOutcome;
}

/** Raised by adapter stages that fail before or after the driver. Retains no cause. */
export class AdapterError extends Error {
  constructor(readonly code: ErrorCode) {
    super(MESSAGES[code]);
    this.name = 'AdapterError';
  }
}

export interface ErrorContext {
  /** The operation mutates TestRail or initiates report generation. */
  readonly mutates: boolean;
  /** The driver method was actually invoked. */
  readonly dispatched: boolean;
  /** The driver's result resolved and a later adapter stage failed. */
  readonly acknowledged: boolean;
}

/** Driver aggregation stops that are a safety bound rather than a broken response. */
const BOUND_REASONS = new Set(['max_pages', 'max_items', 'max_bytes', 'max_duration']);

function classifyApi(error: TestRailApiError): ErrorCode {
  // A usable-looking status with an unusable body is a response problem, not an
  // upstream failure; status zero can equally come from malformed success JSON.
  if (error.status === 0 || error.status === 200) return 'INVALID_RESPONSE';
  if (error.status === 401) return 'AUTHENTICATION_FAILED';
  if (error.status === 403) return 'PERMISSION_DENIED';
  if (error.status === 404) return 'NOT_FOUND';
  if (error.status === 429) return 'RATE_LIMITED';
  return 'UPSTREAM_ERROR';
}

function codeFor(error: unknown): ErrorCode {
  if (error instanceof AdapterError) return error.code;
  if (error instanceof RuntimeError) return error.code;
  // Subclass precedence is required: a license restriction is also an API error,
  // and a pagination stop is also a validation error.
  if (error instanceof TestRailLicenseError) return 'LICENSE_REQUIRED';
  if (error instanceof TestRailPaginationError) {
    return BOUND_REASONS.has(error.reason) ? 'PAGINATION_LIMIT' : 'INVALID_RESPONSE';
  }
  if (error instanceof TestRailApiError) return classifyApi(error);
  // Inputs are validated before invocation, so a driver parameter rejection here
  // means the adapter mapped them wrongly. That is ours, not TestRail's.
  if (error instanceof TestRailValidationError) return 'INTERNAL_ERROR';
  return 'INTERNAL_ERROR';
}

function writeOutcome(context: ErrorContext): WriteOutcome | undefined {
  if (!context.mutates) return undefined;
  // Derived only from what the adapter observed, never keyed off the error code. A
  // code-keyed shortcut would let a post-dispatch failure that happens to carry a
  // pre-dispatch code report that nothing was sent, which is the one claim this
  // classification must never make wrongly. Unknown is the conservative fallback.
  if (!context.dispatched) return 'not_started';
  if (context.acknowledged) return 'acknowledged';
  return 'unknown';
}

export function classifyError(error: unknown, context: ErrorContext): SafeError {
  const code = codeFor(error);
  const safe: {
    -readonly [K in keyof SafeError]: SafeError[K];
  } = { code, message: MESSAGES[code] };

  if (error instanceof TestRailApiError && error.status > 0) safe.http_status = error.status;
  if (error instanceof TestRailPaginationError) {
    safe.reason = error.reason;
    if (Number.isSafeInteger(error.pagesFetched)) safe.pages_fetched = error.pagesFetched;
    if (Number.isSafeInteger(error.itemsFetched)) safe.items_fetched = error.itemsFetched;
  }
  const outcome = writeOutcome(context);
  if (outcome !== undefined) safe.write_outcome = outcome;
  return Object.freeze(safe);
}
