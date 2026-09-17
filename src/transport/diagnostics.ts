import { randomUUID } from 'node:crypto';

export type EventCode =
  | 'server_started' | 'server_stopping' | 'server_stopped'
  | 'tool_call' | 'staging_recovered' | 'transport_error';

export interface DiagnosticFields {
  readonly correlation?: string;
  readonly tool?: string;
  readonly outcome?: 'success' | 'error';
  /** A code from the fixed error taxonomy, never a driver message. */
  readonly code?: string;
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
