import { randomUUID } from 'node:crypto';
import type { WriteOutcome } from '../contracts/errors.js';

export type EventCode =
  | 'server_started' | 'server_stopping' | 'server_stopped'
  | 'tool_call' | 'staging_recovered' | 'transport_error';

export interface DiagnosticFields {
  readonly correlation?: string;
  readonly tool?: string;
  readonly outcome?: 'success' | 'error';
  /** A code from the fixed error taxonomy, never a driver message. */
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
 * Fields are restricted to fixed codes, tool names, counts and durations. Tool
 * results legitimately contain TestRail data and local file paths; diagnostics must
 * not, which is why arguments, response bodies and paths are never accepted here.
 */
export function logEvent(event: EventCode, fields: DiagnosticFields = {}): void {
  process.stderr.write(`${JSON.stringify({ event, ...fields })}\n`);
}
