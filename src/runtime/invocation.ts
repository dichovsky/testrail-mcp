import type { TestRailClient } from '@dichovsky/testrail-api-client';
import { FIXED_BUDGETS, type Limits } from '../config/limits.js';
import { RuntimeError } from './errors.js';

export interface InvokeOptions {
  /** Reserve the single binary-download slot before the request is issued. */
  readonly binary?: boolean;
  readonly signal?: AbortSignal;
  /**
   * Adapter-owned follow-up, such as F07 staged-file cleanup. Capacity is held until
   * this finishes as well, so a slot never returns while local work still owns a file.
   */
  readonly cleanup?: () => Promise<void>;
}

export interface RuntimeStats {
  readonly active: number;
  readonly binary: number;
  readonly accepting: boolean;
}

export interface Runtime {
  invoke: <T>(call: (client: TestRailClient) => Promise<T>, options?: InvokeOptions) => Promise<T>;
  shutdown: () => Promise<void>;
  stats: () => RuntimeStats;
}

/** Cancellable wait. Injected in tests so the 60s watchdog needs no real clock. */
export interface Delay {
  readonly promise: Promise<void>;
  readonly cancel: () => void;
}

export interface RuntimeDependencies {
  readonly client: TestRailClient;
  readonly limits: Limits;
  readonly delay?: (ms: number) => Delay;
}

function timerDelay(ms: number): Delay {
  let cancel: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    // Never keep the process alive for a watchdog or drain window.
    timer.unref?.();
    cancel = () => { clearTimeout(timer); };
  });
  return { promise, cancel };
}

function abortSignalRace(signal: AbortSignal | undefined): { promise: Promise<never>; dispose: () => void } | undefined {
  if (signal === undefined) return undefined;
  let dispose: () => void = () => undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    const onAbort = () => { reject(new RuntimeError('CANCELLED', 'Call cancelled.')); };
    signal.addEventListener('abort', onAbort, { once: true });
    dispose = () => { signal.removeEventListener('abort', onAbort); };
  });
  return { promise, dispose };
}

export function createRuntime({ client, limits, delay = timerDelay }: RuntimeDependencies): Runtime {
  let active = 0;
  let binary = 0;
  let accepting = true;
  let destroyed = false;
  const retained = new Set<Promise<void>>();

  async function invoke<T>(
    call: (client: TestRailClient) => Promise<T>,
    options: InvokeOptions = {},
  ): Promise<T> {
    const wantsBinary = options.binary === true;
    // Admission decides before anything is dispatched, so a rejected call makes no
    // upstream request at all. There is no queue: excess load is refused, not buffered.
    if (!accepting) throw new RuntimeError('BUSY', 'Server is shutting down.');
    if (active >= limits.max_active_calls) throw new RuntimeError('BUSY', 'No execution capacity.');
    if (wantsBinary && binary >= FIXED_BUDGETS.max_binary_downloads) {
      throw new RuntimeError('BUSY', 'No download capacity.');
    }
    if (options.signal?.aborted === true) throw new RuntimeError('CANCELLED', 'Call cancelled before dispatch.');

    active += 1;
    if (wantsBinary) binary += 1;

    const handle = client.trackOperation(() => call(client));

    /*
     * Capacity follows `settled`, never `result`. An aggregate can reject at its own
     * deadline, and the watchdog below can reject independently, while DNS, a fetch or a
     * body read is still running. Releasing on either would let the next call start work
     * the previous one has not finished, which is exactly what the slot limit prevents.
     */
    const slot = (async () => {
      try {
        await handle.settled;
        await options.cleanup?.();
      } catch {
        // Observed, never surfaced. A late descendant failure or a cleanup fault must
        // not escape as an unhandled rejection and terminate the server.
      }
    })().finally(() => {
      active -= 1;
      if (wantsBinary) binary -= 1;
    });
    retained.add(slot);
    void slot.finally(() => retained.delete(slot));

    const watchdog = delay(FIXED_BUDGETS.response_wait_ms);
    const cancellation = abortSignalRace(options.signal);
    const contenders: Promise<T>[] = [
      handle.result,
      watchdog.promise.then<never>(() => { throw new RuntimeError('TIMEOUT', 'Response wait expired.'); }),
    ];
    if (cancellation !== undefined) contenders.push(cancellation.promise);
    try {
      return await Promise.race(contenders);
    } finally {
      watchdog.cancel();
      cancellation?.dispose();
      // A late result rejection is observed, never surfaced and never unhandled.
      void handle.result.catch(() => undefined);
    }
  }

  async function shutdown(): Promise<void> {
    accepting = false;
    if (retained.size > 0) {
      const drain = delay(FIXED_BUDGETS.shutdown_drain_ms);
      await Promise.race([Promise.allSettled([...retained]).then(() => undefined), drain.promise]);
      drain.cancel();
    }
    // Shutdown is idempotent: stdin closure, SIGINT and SIGTERM can all fire, and
    // destroy zeroes the shared credential, so it must run exactly once.
    if (!destroyed) {
      destroyed = true;
      client.destroy();
    }
  }

  return {
    invoke,
    shutdown,
    stats: () => ({ active, binary, accepting }),
  };
}
