import { tmpdir } from 'node:os';
import type { TestRailClient } from '@dichovsky/testrail-api-client';
import type { Configuration } from '../config/environment.js';
import { FIXED_BUDGETS } from '../config/limits.js';
import { createConfiguredDriver, type DriverSeams } from '../driver/configuration.js';
import { advisoryWarnings } from '../contracts/drift.js';
import { AdapterError, classifyError } from '../contracts/errors.js';
import { errorResult, successResult, validateOuter, type ProtocolResultFields, type ToolResult } from '../contracts/results.js';
import { writeDownload } from '../files/download.js';
import { createStagingArea, recoverAbandonedStaging, stageUpload, type StagedUpload, type StagingArea } from '../files/staging.js';
import type { CallContext, DriverCall } from '../operations/driver-call.js';
import { prepareListCall, type ListResult } from '../operations/lists.js';
import type { Operation } from '../operations/registry.js';
import { createRuntime, type Runtime, type RuntimeDependencies, type RuntimeStats } from '../runtime/invocation.js';
import { correlationId, logEvent } from '../transport/diagnostics.js';

export interface ExecutionOptions {
  /** Include SDK-owned fields before measuring either complete-result budget. */
  readonly protocolResultFields?: ProtocolResultFields;
  readonly signal?: AbortSignal;
}

export interface OperationExecutor {
  readonly execute: (operation: Operation, input: unknown, options?: ExecutionOptions) => Promise<ToolResult>;
  readonly shutdown: () => Promise<void>;
}

/** Production startup recovers abandoned staging before creating the shared driver. */
export async function createOperationExecutor(
  configuration: Configuration,
  driver?: DriverSeams,
): Promise<OperationExecutor> {
  const removed = await recoverAbandonedStaging(tmpdir());
  if (removed > 0) logEvent('staging_recovered', { removed });
  return assembleOperationExecutor(configuration, {
    client: createConfiguredDriver(configuration, driver),
  }).executor;
}

/** Internal construction seam for driver, clock and filesystem fault tests. */
export interface ExecutorDependencies {
  readonly client: TestRailClient;
  readonly delay?: RuntimeDependencies['delay'];
  readonly createStaging?: () => Promise<StagingArea>;
}

/**
 * Own one runtime and staging lifetime. The read-only observation is for internal
 * lifetime tests; transport receives only the executor, never the runtime.
 */
export function assembleOperationExecutor(
  configuration: Configuration,
  dependencies: ExecutorDependencies,
): { executor: OperationExecutor; stats: () => RuntimeStats } {
  const runtime = createRuntime({
    client: dependencies.client, limits: configuration.limits,
    ...(dependencies.delay === undefined ? {} : { delay: dependencies.delay }),
  });
  const createStaging = dependencies.createStaging ?? (() => createStagingArea(tmpdir()));
  let staging: Promise<StagingArea> | undefined;
  const stagingDirectory = async (): Promise<string> => {
    // Share concurrent creation, but retry a failed creation on the next upload.
    staging ??= createStaging().catch((error: unknown) => {
      staging = undefined;
      throw error;
    });
    return (await staging).directory;
  };

  let stopping: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    stopping ??= (async () => {
      const drainStarted = performance.now();
      // Driver destruction can throw. It must not skip staging disposal or escape
      // into the transport's stop/exit sequence.
      await runtime.shutdown().catch(() => undefined);
      if (staging !== undefined) {
        // A late-created area is still disposed and late failures stay observed.
        // Directory removal shares the drain budget; it never truncates a copy.
        const cleanup = staging.then((area) => area.dispose()).catch(() => undefined);
        const remaining = Math.max(0, FIXED_BUDGETS.shutdown_drain_ms - (performance.now() - drainStarted));
        let timer: NodeJS.Timeout | undefined;
        const expired = new Promise<void>((resolve) => {
          timer = setTimeout(resolve, remaining);
          timer.unref();
        });
        try {
          await Promise.race([cleanup, expired]);
        } finally {
          clearTimeout(timer);
        }
      }
    })();
    return stopping;
  };
  return {
    executor: {
      execute: (operation, input, options = {}) => executeOperation(operation, input, {
        runtime, configuration, stagingDirectory,
      }, options),
      shutdown,
    },
    stats: runtime.stats,
  };
}

interface CallDependencies {
  readonly runtime: Runtime;
  readonly configuration: Configuration;
  readonly stagingDirectory: () => Promise<string>;
}

type Mode = 'single' | 'page' | 'all';

/**
 * The registry reserves these as flat top-level inputs for upload operations
 * (`validateInputLayout` allows exactly `file_path`, `filename` and `content_type`),
 * so they are read in that shape rather than as a nested object.
 */
function uploadRequest(input: unknown): { path: string; filename?: string; mediaType?: string } | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const { file_path: path, filename, content_type: mediaType } = input as Record<string, unknown>;
  if (typeof path !== 'string') return undefined;
  return {
    path,
    ...(typeof filename === 'string' ? { filename } : {}),
    ...(typeof mediaType === 'string' ? { mediaType } : {}),
  };
}

/**
 * The caller's validated identifier, unchanged. TestRail accepts a positive integer or
 * a UUID, so a string is as valid as a number and must not be coerced: the download
 * result promises the original id, and substituting a placeholder would break any
 * caller matching a batch of downloads back to what it asked for.
 */
function attachmentId(input: unknown): number | string | undefined {
  const value = typeof input === 'object' && input !== null
    ? (input as { attachment_id?: unknown }).attachment_id
    : undefined;
  return typeof value === 'number' || typeof value === 'string' ? value : undefined;
}

/** Whether a preview reply names at least one of its counters with a value. */
function carriesCount(value: unknown, counters: readonly string[]): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return counters.some((name) => Object.hasOwn(value, name) && (value as Record<string, unknown>)[name] != null);
}

/**
 * Run one tool call end to end.
 *
 * This never throws. A tool call that fails is a tool result carrying a classified
 * error, not a protocol error: the protocol is healthy, the operation is not.
 *
 * `dispatched` and `acknowledged` are recorded as they actually happen rather than
 * inferred afterwards, because they decide what the caller is told about a write. The
 * flag is set immediately before the driver method is called, after any upload staging,
 * not once bytes reach the network, which errs toward `unknown` and never toward a false
 * `not_started`.
 *
 * Upload staging runs inside the runtime's slot, so it is admitted, bounded by the
 * response watchdog and cancellable like the request itself. A call refused at
 * admission copies nothing.
 */
async function executeOperation(
  operation: Operation,
  input: unknown,
  dependencies: CallDependencies,
  options: ExecutionOptions,
): Promise<ToolResult> {
  const correlation = correlationId();
  const started = Date.now();
  const { configuration, runtime } = dependencies;
  const limits = configuration.limits;
  const mutates = operation.effects.testRail !== 'read';

  let mode: Mode = 'single';
  let dispatched = false;
  let acknowledged = false;
  let staged: StagedUpload | undefined;
  // Set once this call has answered with an error, so a download reply arriving after it writes nothing.
  let abandoned = false;
  /*
   * Aborted once this call has answered with an error; `stop` also follows the caller's
   * own cancellation. Staging stops before its next chunk, and an upload whose staging
   * finishes after either is never sent: the caller has been, or is about to be, told
   * that nothing was.
   */
  const abandon = new AbortController();
  const stop = options.signal === undefined
    ? abandon.signal
    : AbortSignal.any([abandon.signal, options.signal]);

  try {
    // Validate before anything is staged or dispatched. Validation never replaces the
    // caller's value, so every later step reads the original JSON, own __proto__ keys included.
    operation.input.validate(input);

    let call: DriverCall;
    let listResult: ((value: unknown) => ListResult) | undefined;
    if (operation.pagination.kind === 'none') {
      call = operation.pagination.single;
    } else {
      const list = prepareListCall(operation.pagination, operation.response.outerSchema, input, limits);
      mode = list.mode;
      call = list.call;
      listResult = list.result;
    }
    let request: ReturnType<typeof uploadRequest>;
    let stagingDirectory: (() => Promise<string>) | undefined;

    if (operation.files.kind === 'upload') {
      request = uploadRequest(input);
      stagingDirectory = dependencies.stagingDirectory;
      if (request === undefined) {
        throw new AdapterError('FILE_ACCESS_DENIED');
      }
    }

    const download = operation.files.kind === 'download';
    const identifier = download ? attachmentId(input) : undefined;
    // A download operation whose input carries no identifier cannot honour the
    // result contract. That is an adapter registration fault, not a caller error.
    if (download && identifier === undefined) throw new AdapterError('INTERNAL_ERROR');

    const value = await runtime.invoke(
      async (client: TestRailClient) => {
        let context: CallContext = { limits };
        if (request !== undefined && stagingDirectory !== undefined) {
          staged = await stageUpload(request.path, {
            roots: configuration.uploadRoots,
            maxBytes: limits.max_file_bytes,
            stagingDirectory: await stagingDirectory(),
            signal: stop,
          });
          // The wait may have ended while the copy finished: sending now would
          // contradict the `not_started` the caller was given. Settlement disposes it.
          if (stop.aborted) throw new AdapterError('CANCELLED');
          // A path, never a descriptor: the driver's fallback behaviour makes descriptor
          // ownership impossible to guarantee across platforms.
          context = {
            upload: { path: staged.path, ...(request.mediaType === undefined ? {} : { type: request.mediaType }) },
            limits,
          };
        }
        dispatched = true;
        const reply = call.invoke(client, input, context);
        if (identifier === undefined) return reply;
        /*
         * The file is written inside the tracked operation, not after it: the runtime holds
         * the download slot until the operation settles, so the next download is refused
         * until this file is written or its write has failed. A reply that arrives after
         * this call has answered with an error writes nothing; a write already under way
         * finishes, and the committed file is kept, as `writeDownload` explains.
         */
        return reply.then((bytes) => abandoned
          ? undefined
          : writeDownload(bytes as ArrayBuffer, {
            directory: configuration.downloadDirectory,
            maxBytes: limits.max_file_bytes,
            attachmentId: identifier,
          }));
      },
      {
        binary: download,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        /*
         * The staged copy is retained until settlement, not until the result resolves,
         * and this is its only disposer. It runs only once the slot exists, so a call
         * refused at admission, which has staged nothing, never needs it.
         */
        ...(request === undefined ? {} : { cleanup: () => staged?.dispose() ?? Promise.resolve() }),
      },
    );
    /*
     * A preview asked what a delete would remove. A reply carrying no count answers
     * nothing, and it is also what a TestRail that ignores the flag sends after really
     * deleting, so it is reported before the reply counts as acknowledged: the caller
     * learns the outcome is unknown rather than that nothing would be affected.
     */
    const preview = operation.response.preview?.requested(input) === true ? operation.response.preview : undefined;
    if (preview !== undefined && !carriesCount(value, preview.counters)) throw new AdapterError('INVALID_RESPONSE');
    acknowledged = true;

    let data: unknown = value;
    let pagination: object | undefined;

    if (download) {
      // The value is already the written file's identifier, path and size: bytes have no envelope to check.
    } else if (listResult !== undefined) {
      ({ data, pagination } = listResult(value));
    } else {
      validateOuter(operation.response.outerSchema, value);
    }

    const warnings = download
      ? []
      : advisoryWarnings(preview?.entitySchema ?? operation.response.entitySchema, operation.response.shape, data);

    const result = successResult({
      data,
      ...(pagination === undefined ? {} : { pagination }),
      ...(warnings.length === 0 ? {} : { warnings }),
    }, limits, options.protocolResultFields);

    logEvent('tool_call', {
      correlation, tool: operation.tool, outcome: 'success',
      duration_ms: Date.now() - started, warnings: warnings.length,
    });
    return result;
  } catch (error) {
    abandoned = true;
    /*
     * Aborted in the same synchronous step that reads `dispatched` below, and the driver
     * callback checks `stop` and sets `dispatched` in one synchronous step too. Whichever
     * runs first decides: an upload is either never sent and reported `not_started`, or
     * already dispatched and reported `unknown`.
     */
    abandon.abort();
    const safe = classifyError(error, { mutates, dispatched, acknowledged, aggregate: mode === 'all', token: operation.token });
    logEvent('tool_call', {
      correlation, tool: operation.tool, outcome: 'error',
      code: safe.code, duration_ms: Date.now() - started,
      ...(safe.write_outcome === undefined ? {} : { write_outcome: safe.write_outcome }),
    });
    return errorResult(safe, options.protocolResultFields);
  }
}
