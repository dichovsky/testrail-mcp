import type { Page, TestRailClient } from '@dichovsky/testrail-api-client';
import type { Configuration } from '../config/environment.js';
import { advisoryWarnings } from '../contracts/drift.js';
import { AdapterError, classifyError } from '../contracts/errors.js';
import { aggregateMetadata, pageMetadata } from '../contracts/pagination.js';
import { errorResult, successResult, validateOuter, type ToolResult } from '../contracts/results.js';
import { writeDownload } from '../files/download.js';
import { stageUpload, type StagedUpload } from '../files/staging.js';
import type { CallContext, DriverCall } from '../operations/driver-call.js';
import type { Operation } from '../operations/registry.js';
import type { Runtime } from '../runtime/invocation.js';
import { correlationId, logEvent } from './diagnostics.js';

export interface CallDependencies {
  readonly runtime: Runtime;
  readonly configuration: Configuration;
  /** Aborted when the client cancels this request. */
  readonly signal?: AbortSignal;
  /** Created on first use so a server that never uploads makes no staging directory. */
  readonly stagingDirectory?: () => Promise<string>;
}

type Mode = 'single' | 'page' | 'all';

/** Reserved adapter input; never forwarded to TestRail as a parameter. */
interface AdapterControls {
  readonly pagination?: 'page' | 'all';
  readonly start_offset?: number;
}

function controls(input: unknown): AdapterControls {
  if (typeof input !== 'object' || input === null) return {};
  const mcp = (input as { _mcp?: unknown })._mcp;
  return typeof mcp === 'object' && mcp !== null && !Array.isArray(mcp) ? mcp : {};
}

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

function selectMode(operation: Operation, input: unknown): Mode {
  if (operation.pagination.kind === 'none') return 'single';
  return controls(input).pagination === 'all' ? 'all' : 'page';
}

function selectCall(operation: Operation, mode: Mode): DriverCall {
  if (operation.pagination.kind === 'none') return operation.pagination.single;
  return mode === 'all' ? operation.pagination.all : operation.pagination.page;
}

function isPage(value: unknown): value is Page<unknown> {
  return typeof value === 'object' && value !== null && Array.isArray((value as { items?: unknown }).items);
}

/**
 * Run one tool call end to end.
 *
 * This never throws. A tool call that fails is a tool result carrying a classified
 * error, not a protocol error: the protocol is healthy, the operation is not.
 *
 * `dispatched` and `acknowledged` are recorded as they actually happen rather than
 * inferred afterwards, because they decide what the caller is told about a write. The
 * flag is set on entering the driver callback, not once bytes reach the network, which
 * errs toward `unknown` and never toward a false `not_started`.
 */
export async function executeToolCall(
  operation: Operation,
  input: unknown,
  dependencies: CallDependencies,
): Promise<ToolResult> {
  const correlation = correlationId();
  const started = Date.now();
  const { configuration, runtime } = dependencies;
  const limits = configuration.limits;
  const mutates = operation.effects.testRail !== 'read';

  let dispatched = false;
  let acknowledged = false;
  let staged: StagedUpload | undefined;

  try {
    // Validate before anything is staged or dispatched. The original value is kept:
    // a parsed clone may drop keys the caller legitimately sent.
    if (!operation.inputSchema.safeParse(input).success) throw new AdapterError('INVALID_ARGUMENT');

    const mode = selectMode(operation, input);
    const call = selectCall(operation, mode);
    let upload: CallContext['upload'];

    if (operation.files.kind === 'upload') {
      const request = uploadRequest(input);
      if (request === undefined || dependencies.stagingDirectory === undefined) {
        throw new AdapterError('FILE_ACCESS_DENIED');
      }
      staged = await stageUpload(request.path, {
        roots: configuration.uploadRoots,
        maxBytes: limits.max_file_bytes,
        stagingDirectory: await dependencies.stagingDirectory(),
      });
      // A path, never a descriptor: the driver's fallback behaviour makes descriptor
      // ownership impossible to guarantee across platforms.
      upload = { path: staged.path, ...(request.mediaType === undefined ? {} : { type: request.mediaType }) };
    }
    const context: CallContext = upload === undefined ? {} : { upload };

    const value = await runtime.invoke(
      (client: TestRailClient) => {
        dispatched = true;
        return call.invoke(client, input, context);
      },
      {
        binary: operation.files.kind === 'download',
        ...(dependencies.signal === undefined ? {} : { signal: dependencies.signal }),
        // Staging is retained until settlement, not until the result resolves.
        ...(staged === undefined ? {} : { cleanup: staged.dispose }),
      },
    );
    acknowledged = true;

    let data: unknown = value;
    let pagination: object | undefined;

    if (operation.files.kind === 'download') {
      const identifier = attachmentId(input);
      // A download operation whose input carries no identifier cannot honour the
      // result contract. That is an adapter registration fault, not a caller error.
      if (identifier === undefined) throw new AdapterError('INTERNAL_ERROR');
      data = await writeDownload(value as ArrayBuffer, {
        directory: configuration.downloadDirectory,
        maxBytes: limits.max_file_bytes,
        attachmentId: identifier,
      });
    } else if (mode === 'page') {
      validateOuter(operation.response.outerSchema, value);
      if (!isPage(value)) throw new AdapterError('INVALID_RESPONSE');
      data = value.items;
      pagination = pageMetadata(value, { responseDriven: operation.pagination.kind === 'response_driven' });
    } else if (mode === 'all') {
      // The aggregate helper returns a plain array, not the page envelope the
      // operation's outer schema describes, so that schema does not apply here.
      if (!Array.isArray(value)) throw new AdapterError('INVALID_RESPONSE');
      const startOffset = controls(input).start_offset;
      pagination = aggregateMetadata(value, operation.pagination.kind === 'response_driven'
        ? {}
        : { startOffset: startOffset ?? 0 });
    } else {
      validateOuter(operation.response.outerSchema, value);
    }

    const warnings = operation.files.kind === 'download'
      ? []
      : advisoryWarnings(operation.response.entitySchema, operation.response.shape, data);

    const result = successResult({
      data,
      ...(pagination === undefined ? {} : { pagination }),
      ...(warnings.length === 0 ? {} : { warnings }),
    }, limits);

    logEvent('tool_call', {
      correlation, tool: operation.tool, outcome: 'success',
      duration_ms: Date.now() - started, warnings: warnings.length,
    });
    return result;
  } catch (error) {
    /*
     * Dispose the staged copy here as well. The runtime rejects BUSY and
     * pre-dispatch cancellation before it creates the slot that would run cleanup,
     * so a call refused at admission would otherwise leave its copy in the staging
     * directory until the process exits. Disposal is idempotent, so the settled path
     * running it too is harmless.
     */
    if (staged !== undefined) await staged.dispose().catch(() => undefined);
    const safe = classifyError(error, { mutates, dispatched, acknowledged });
    logEvent('tool_call', {
      correlation, tool: operation.tool, outcome: 'error',
      code: safe.code, duration_ms: Date.now() - started,
    });
    return errorResult(safe);
  }
}
