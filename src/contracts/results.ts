import type { z } from 'zod';
import { FIXED_BUDGETS, type Limits } from '../config/limits.js';
import { MAX_WARNINGS, type ResultWarning } from './drift.js';
import { AdapterError, type SafeError } from './errors.js';

export interface ResultWrapper {
  readonly data: unknown;
  readonly pagination?: Readonly<Record<string, unknown>>;
  readonly warnings?: readonly ResultWarning[];
}

export interface ToolResult {
  readonly content: readonly { readonly type: 'text'; readonly text: string }[];
  readonly structuredContent: Readonly<Record<string, unknown>>;
  readonly isError?: true;
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** JSON.stringify returns undefined for undefined and throws on BigInt or a cycle. */
function serialize(value: unknown): string {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch {
    throw new AdapterError('INVALID_RESPONSE');
  }
  if (text === undefined) throw new AdapterError('INVALID_RESPONSE');
  return text;
}

/**
 * Strict outer validation, separate from advisory entity validation. An unusable
 * structure is an error; field-level drift inside a usable structure is a warning.
 */
export function validateOuter(outerSchema: z.ZodType, value: unknown): void {
  if (!outerSchema.safeParse(value).success) throw new AdapterError('INVALID_RESPONSE');
}

/**
 * Build the MCP result for a successful call.
 *
 * Both budgets are measured, because they are not the same thing: the text block
 * duplicates the payload and escapes it, so a `data` value that fits its own budget
 * can still overflow the complete result. Overflow is reported, never silently
 * truncated — a caller can narrow a read, and a caller whose write already
 * succeeded must not be told to repeat it just to retrieve output.
 */
export function successResult(wrapper: ResultWrapper, limits: Limits): ToolResult {
  if ((wrapper.warnings?.length ?? 0) > MAX_WARNINGS) throw new AdapterError('INTERNAL_ERROR');

  // A resolved void method carries no value; the wrapper still requires `data`.
  const data = wrapper.data === undefined ? null : wrapper.data;
  if (utf8Bytes(serialize(data)) > limits.max_data_bytes) throw new AdapterError('RESPONSE_TOO_LARGE');

  const payload: Record<string, unknown> = { data };
  if (wrapper.pagination !== undefined) payload.pagination = wrapper.pagination;
  if (wrapper.warnings !== undefined && wrapper.warnings.length > 0) payload.warnings = wrapper.warnings;

  const text = serialize(payload);
  const result: ToolResult = { content: [{ type: 'text' as const, text }], structuredContent: payload };
  if (utf8Bytes(serialize(result)) > limits.max_result_bytes) throw new AdapterError('RESPONSE_TOO_LARGE');
  return Object.freeze(result);
}

/**
 * Build the MCP result for a failed call. The envelope stays within its fixed budget:
 * an error that cannot be delivered is worse than one delivered without its metadata,
 * so the optional fields are dropped before the code and message are.
 */
export function errorResult(error: SafeError): ToolResult {
  const build = (payload: Record<string, unknown>): ToolResult => {
    const text = serialize(payload);
    return Object.freeze({ content: [{ type: 'text' as const, text }], structuredContent: payload, isError: true });
  };
  const full = build({ error: { ...error } });
  if (utf8Bytes(serialize(full)) <= FIXED_BUDGETS.max_error_bytes) return full;
  return build({
    error: {
      code: error.code,
      message: error.message,
      ...(error.write_outcome === undefined ? {} : { write_outcome: error.write_outcome }),
    },
  });
}
