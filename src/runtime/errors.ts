/** Codes this layer raises. F05 owns the full result taxonomy and wrapper. */
export type RuntimeErrorCode = 'BUSY' | 'TIMEOUT' | 'CANCELLED';

/**
 * Carries a fixed message per code. Like ConfigurationError it retains no cause:
 * a driver or filesystem error may embed the configured host or a local path.
 */
export class RuntimeError extends Error {
  constructor(readonly code: RuntimeErrorCode, message: string) {
    super(message);
    this.name = 'RuntimeError';
  }
}
