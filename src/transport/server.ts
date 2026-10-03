import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio, type StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import { loadConfiguration, type Configuration, type Environment } from '../config/environment.js';
import { AdapterError, classifyError } from '../contracts/errors.js';
import { errorResult, type ToolResult } from '../contracts/results.js';
import { createConfiguredDriver, type DriverSeams } from '../driver/configuration.js';
import { createStagingArea, recoverAbandonedStaging } from '../files/staging.js';
import { operationRegistry } from '../operations/catalog.js';
import type { Operation, OperationRegistry } from '../operations/registry.js';
import { createRuntime, type Runtime } from '../runtime/invocation.js';
import { correlationId, logEvent } from './diagnostics.js';
import { executeToolCall } from './tool-call.js';

/**
 * Cross-tool rules a model needs before its first call. Hosts may truncate to 512
 * characters, so the first paragraph fits within them on its own and holds every rule
 * that prevents harm; the whole stays under 2 KiB.
 */
export const SERVER_INSTRUCTIONS = `Each tool is one TestRail API endpoint, run with the configured user's permissions. Lists that take _mcp return one page by default (50 where a limit applies); never treat it as the whole dataset. _mcp.pagination "all" fetches the rest within bounds, as far as TestRail's replies link on. Results keep TestRail's field names. A write's or report run's error has write_outcome: "unknown" may already be applied, so check before retrying; "acknowledged" was applied, so do not repeat it. Never poll a report.

Results are {data, pagination, warnings}, and field names include custom_* fields. "not_started" means nothing was sent. "acknowledged" means TestRail accepted the change but its response could not be delivered. The user's licence applies as well as their permissions.

Running a report generates it and may send the template's configured email. Downloading an attachment writes a new local file every time and never overwrites one. Uploads read a local path that must sit inside a configured directory.

A warnings entry means TestRail returned fields differing from the expected shape; the data is passed through unchanged and is still usable.`;

/** The wrapper shape, with entity fields deliberately unconstrained. */
const WRAPPER_JSON_SCHEMA = {
  type: 'object',
  properties: {
    data: {},
    pagination: { type: 'object' },
    warnings: { type: 'array', items: { type: 'object' } },
  },
  required: ['data'],
} as const;

/**
 * Advertise an operation's reviewed JSON Schema verbatim.
 *
 * Handing the SDK a Zod schema would re-emit it in a different dialect, so the bytes
 * a client sees would stop matching the schema the parameter gates reviewed. This
 * passes the reviewed document through and accepts every value, because the adapter
 * validates in `executeToolCall` and reports a failure as an INVALID_ARGUMENT tool
 * error. Letting the SDK reject arguments instead would surface a bare protocol
 * error outside the adapter's error taxonomy.
 */
function advertiseInput(schema: Operation['jsonSchema']): never {
  return {
    '~standard': {
      version: 1,
      vendor: 'testrail-mcp',
      jsonSchema: { input: () => schema, output: () => schema },
      validate: (value: unknown) => ({ value }),
    },
  } as never;
}

/**
 * Requires only the wrapper's own shape, so entity drift can never fail it. The SDK
 * skips output validation for error results, so an error envelope is not measured
 * against this either.
 */
function advertiseOutput(): never {
  return {
    '~standard': {
      version: 1,
      vendor: 'testrail-mcp',
      jsonSchema: { input: () => WRAPPER_JSON_SCHEMA, output: () => WRAPPER_JSON_SCHEMA },
      validate: (value: unknown) => (
        typeof value === 'object' && value !== null && Object.hasOwn(value, 'data')
          ? { value }
          : { issues: [{ message: 'Result wrapper requires data' }] }
      ),
    },
  } as never;
}

function packageVersion(): string {
  try {
    const metadata: unknown = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    if (typeof metadata === 'object' && metadata !== null && 'version' in metadata
      && typeof metadata.version === 'string') return metadata.version;
  } catch { /* fall through to the placeholder below */ }
  return '0.0.0';
}

export interface ServerDependencies {
  readonly configuration: Configuration;
  readonly runtime: Runtime;
  readonly registry: OperationRegistry;
  readonly stagingDirectory: () => Promise<string>;
}

/**
 * The answer to a call whose pipeline rejected. `executeToolCall` is built never to
 * reject, so this cannot happen today, but if it ever did the SDK would send the raw
 * error message as the tool result, with no error code and no write outcome. Instead the
 * call fails as an internal fault like any other. Whether the driver was entered is not
 * known here, so a write or report run is reported as `unknown`, the conservative answer,
 * and its diagnostic is logged because the pipeline may not have logged one.
 */
function handlerFailure(operation: Operation, started: number): ToolResult {
  const safe = classifyError(new AdapterError('INTERNAL_ERROR'), {
    mutates: operation.effects.testRail !== 'read', dispatched: true, acknowledged: false,
  });
  logEvent('tool_call', {
    correlation: correlationId(), tool: operation.tool, outcome: 'error',
    code: safe.code, duration_ms: Date.now() - started,
    ...(safe.write_outcome === undefined ? {} : { write_outcome: safe.write_outcome }),
  });
  return errorResult(safe);
}

/**
 * Build one MCP server instance.
 *
 * This is the factory body, and it must stay cheap and side-effect free: the stdio
 * entry calls it per connection and may call it again when an opening falls back to
 * the other protocol era. The driver and runtime are closed over rather than created
 * here, so a second instance cannot mean a second credential or a second rate budget.
 * Registration contacts nothing, so discovery makes no TestRail request.
 */
export function buildServer(dependencies: ServerDependencies): McpServer {
  const server = new McpServer(
    { name: 'testrail-mcp', version: packageVersion() },
    { capabilities: { tools: { listChanged: false } }, instructions: SERVER_INSTRUCTIONS },
  );
  for (const operation of dependencies.registry.entries) {
    server.registerTool(operation.tool, {
      description: operation.description,
      inputSchema: advertiseInput(operation.jsonSchema),
      outputSchema: advertiseOutput(),
      annotations: { ...operation.annotations },
    }, (async (args: unknown, ctx: { mcpReq: { signal: AbortSignal } }) => {
      const started = Date.now();
      try {
        return await executeToolCall(operation, args, {
          runtime: dependencies.runtime,
          configuration: dependencies.configuration,
          signal: ctx.mcpReq.signal,
          stagingDirectory: dependencies.stagingDirectory,
        });
      } catch {
        return handlerFailure(operation, started);
      }
    }) as never);
  }
  return server;
}

export interface StartedServer {
  readonly handle: StdioServerHandle;
  readonly shutdown: () => Promise<void>;
}

export interface StartOptions {
  readonly registry?: OperationRegistry;
  /** Own SIGINT, SIGTERM and stdin closure, and exit once shut down. The CLI does. */
  readonly registerSignals?: boolean;
  /** Test-only: the driver's fetch and resolver. The CLI never sets it. */
  readonly driver?: DriverSeams;
  /** Test-only: the stdio entry, so a test can reach this composition without real stdio. */
  readonly serve?: typeof serveStdio;
}

/**
 * How long to wait, once shut down and stdout has flushed, before forcing the process
 * to exit. The drain is bounded, but a call it gave up on can still hold driver timers
 * of its own, such as a 15-second request timeout, and those would keep the process
 * alive. The timer is unreferenced, so a process with nothing left running exits by
 * itself first.
 */
export const EXIT_GRACE_MS = 250;

/**
 * A transport error's class name, for its diagnostic. The name is whatever the thrower
 * set, so only a plain identifier, such as `SyntaxError` or `ZodError`, is logged; any
 * other name could carry a host, a path or a message, and is logged as `Error`.
 */
function errorClassName(error: unknown): string {
  const name: unknown = typeof error === 'object' && error !== null ? (error as { name?: unknown }).name : undefined;
  return typeof name === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(name) ? name : 'Error';
}

/** Call back once everything already written to stdout has been handed to the host. */
function stdoutFlushed(done: () => void): void {
  // Writes complete in order, so an empty write's callback runs after every earlier
  // one. It runs with an error too (a closed pipe), and that must still let us exit.
  try {
    process.stdout.write('', () => { done(); });
  } catch {
    done();
  }
}

/**
 * Exit once stdout has flushed and the grace has passed, unless the process has already
 * exited by itself. Exiting earlier would cut off responses a slow host has not read
 * yet: process.exit drops whatever stdout still holds.
 */
export function exitAfterGrace(
  exit: () => void = () => { process.exit(); },
  flushed: (done: () => void) => void = stdoutFlushed,
): Promise<NodeJS.Timeout> {
  return new Promise((resolve) => {
    flushed(() => {
      const timer = setTimeout(exit, EXIT_GRACE_MS);
      timer.unref();
      resolve(timer);
    });
  });
}

/**
 * Compose configuration, driver, runtime and transport, and own their lifetimes.
 *
 * Configuration failures happen before any transport exists, so a misconfigured
 * server never writes a protocol message it cannot honour.
 */
export async function startServer(
  environment: Environment,
  options: StartOptions = {},
): Promise<StartedServer> {
  const configuration = await loadConfiguration(environment);

  const removed = await recoverAbandonedStaging(tmpdir());
  if (removed > 0) logEvent('staging_recovered', { removed });

  const client = createConfiguredDriver(configuration, options.driver);
  const runtime = createRuntime({ client, limits: configuration.limits });
  const registry = options.registry ?? operationRegistry;

  // Created on first upload so a server that never uploads leaves no directory behind.
  let staging: Promise<{ directory: string; dispose: () => Promise<void> }> | undefined;
  const stagingArea = (): Promise<{ directory: string; dispose: () => Promise<void> }> => {
    // A failure is forgotten, so the next upload tries again rather than inheriting it,
    // and shutdown never awaits a staging area that was never created.
    staging ??= createStagingArea(tmpdir()).catch((error: unknown) => {
      staging = undefined;
      throw error;
    });
    return staging;
  };

  const handle = (options.serve ?? serveStdio)(
    () => buildServer({
      configuration, runtime, registry,
      stagingDirectory: async () => (await stagingArea()).directory,
    }),
    { onerror: (error: Error) => { logEvent('transport_error', { code: errorClassName(error) }); } },
  );

  // Every caller shares one shutdown, so a second request waits for the first to
  // finish rather than returning early and letting the process exit mid-drain.
  let stopping: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    // No step may reject: a rejected shutdown would reach the process as an unhandled
    // rejection, printing a raw error with local paths on stderr and exiting 1 before
    // the stop is logged or the forced exit is scheduled. A staging directory left
    // behind is removed by the next start's recovery.
    stopping ??= (async () => {
      logEvent('server_stopping');
      await handle.close().catch(() => undefined);
      await runtime.shutdown().catch(() => undefined);
      await staging?.then((area) => area.dispose()).catch(() => undefined);
      logEvent('server_stopped');
    })();
    return stopping;
  };

  if (options.registerSignals !== false) {
    // The driver registers none of its own, so the composition root coordinates
    // cleanup once however the host ends the session. The signal handlers stay
    // installed: with `once`, a second SIGINT or SIGTERM during the drain would take
    // the default action and kill the process before the client is destroyed.
    const stop = (): void => { void shutdown().then(() => exitAfterGrace()); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    process.stdin.once('end', stop);
    process.stdin.once('close', stop);
  }

  logEvent('server_started', { tools: registry.entries.length });
  return { handle, shutdown };
}
