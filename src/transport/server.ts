import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio, type StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import { loadConfiguration, type Configuration, type Environment } from '../config/environment.js';
import { createConfiguredDriver } from '../driver/configuration.js';
import { createStagingArea, recoverAbandonedStaging } from '../files/staging.js';
import { operationRegistry } from '../operations/catalog.js';
import type { Operation, OperationRegistry } from '../operations/registry.js';
import { createRuntime, type Runtime } from '../runtime/invocation.js';
import { logEvent } from './diagnostics.js';
import { executeToolCall } from './tool-call.js';

/**
 * Cross-tool rules a model needs before its first call. The essentials are in the
 * first 512 characters because hosts may truncate; the whole stays under 2 KiB.
 */
export const SERVER_INSTRUCTIONS = `Each tool is one TestRail API endpoint, called as the configured TestRail user, so that user's permissions and licence still apply. Lists return one page of 50 by default: set _mcp.pagination to "all" for a bounded complete fetch, and never treat one page as the whole dataset. Results are {data, pagination, warnings} keeping TestRail's own field names, including custom_* fields. Errors carry a fixed code, and write_outcome says whether a change reached TestRail.

A write whose outcome is "unknown" may already have been applied: check before retrying it. "not_started" means nothing was sent. "acknowledged" means TestRail accepted the change but its response could not be delivered, so do not repeat the write to see its output.

Running a report generates it and may send the template's configured email, so never call one repeatedly to poll. Downloading an attachment writes a new local file every time and never overwrites one. Uploads read a local path that must sit inside a configured directory.

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
    }, (async (args: unknown, ctx: { mcpReq: { signal: AbortSignal } }) => executeToolCall(operation, args, {
      runtime: dependencies.runtime,
      configuration: dependencies.configuration,
      signal: ctx.mcpReq.signal,
      stagingDirectory: dependencies.stagingDirectory,
    })) as never);
  }
  return server;
}

export interface StartedServer {
  readonly handle: StdioServerHandle;
  readonly shutdown: () => Promise<void>;
}

/**
 * Compose configuration, driver, runtime and transport, and own their lifetimes.
 *
 * Configuration failures happen before any transport exists, so a misconfigured
 * server never writes a protocol message it cannot honour.
 */
export async function startServer(
  environment: Environment,
  options: { readonly registry?: OperationRegistry; readonly registerSignals?: boolean } = {},
): Promise<StartedServer> {
  const configuration = await loadConfiguration(environment);

  const removed = await recoverAbandonedStaging(tmpdir());
  if (removed > 0) logEvent('staging_recovered', { removed });

  const client = createConfiguredDriver(configuration);
  const runtime = createRuntime({ client, limits: configuration.limits });
  const registry = options.registry ?? operationRegistry;

  // Created on first upload so a server that never uploads leaves no directory behind.
  let staging: Promise<{ directory: string; dispose: () => Promise<void> }> | undefined;
  const stagingArea = (): Promise<{ directory: string; dispose: () => Promise<void> }> => {
    staging ??= createStagingArea(tmpdir());
    return staging;
  };

  const handle = serveStdio(
    () => buildServer({
      configuration, runtime, registry,
      stagingDirectory: async () => (await stagingArea()).directory,
    }),
    { onerror: (error: Error) => { logEvent('transport_error', { code: error.name }); } },
  );

  let stopped = false;
  const shutdown = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    logEvent('server_stopping');
    await handle.close().catch(() => undefined);
    await runtime.shutdown();
    if (staging !== undefined) await (await staging).dispose();
    logEvent('server_stopped');
  };

  if (options.registerSignals !== false) {
    // The driver registers none of its own, so the composition root coordinates
    // cleanup once however the host ends the session.
    const stop = (): void => { void shutdown(); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    process.stdin.once('end', stop);
    process.stdin.once('close', stop);
  }

  logEvent('server_started', { tools: registry.entries.length });
  return { handle, shutdown };
}
