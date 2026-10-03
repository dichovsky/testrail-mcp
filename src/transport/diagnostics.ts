import { randomUUID } from 'node:crypto';
import type { WriteOutcome } from '../contracts/errors.js';

export type EventCode =
  | 'server_started' | 'server_stopping' | 'server_stopped'
  | 'tool_call' | 'staging_recovered' | 'transport_error';

export interface DiagnosticFields {
  readonly correlation?: string;
  readonly tool?: string;
  readonly outcome?: 'success' | 'error';
  /**
   * For `tool_call`, a code from the fixed error taxonomy. For `transport_error`, the
   * error's class name, limited to a plain identifier. Never a driver or error message.
   */
  readonly code?: string;
  /**
   * Whether a failed write reached TestRail. It is repeated here because the result that
   * carries it may never be delivered: a write still pending when the server shuts down
   * ends with its connection, and this line is then the only record of it.
   */
  readonly write_outcome?: WriteOutcome;
  readonly duration_ms?: number;
  readonly warnings?: number;
  readonly tools?: number;
  readonly removed?: number;
}

export function correlationId(): string {
  return randomUUID();
}

/**
 * One JSON object per line on stderr.
 *
 * Standard output carries protocol messages only, so nothing here may write there.
 * The fields' names are fixed by `DiagnosticFields`, but `code` and `tool` are typed as
 * any string, so what they carry is up to each caller. Tool results legitimately contain
 * TestRail data and local file paths; diagnostics must not, so callers pass only fixed
 * codes, tool names, counts and durations, never arguments, response bodies or paths.
 * Tests hold each caller to that: tests/result-contract.test.ts for the pipeline's
 * `tool_call`, tests/transport/handler-failure.test.ts for the one the server logs when
 * the pipeline rejects, and tests/transport/diagnostic-events.test.ts for every server
 * lifecycle event.
 */
export function logEvent(event: EventCode, fields: DiagnosticFields = {}): void {
  process.stderr.write(`${JSON.stringify({ event, ...fields })}\n`);
}
