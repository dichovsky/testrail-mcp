# Startup configuration implementation

F03 is implemented. This document covers the environment parser and the driver construction settings. [Runtime lifetime](runtime-lifetime.md) describes the process executor (invocation admission, settlement ownership and shutdown). The default command of the CLI loads this configuration at startup and serves MCP over stdio, as [transport](transport.md) describes.

`loadConfiguration(environment)` reads the explicit environment keys in the [configuration contract](implementation-contracts.md#startup-configuration). It does these steps:

- It snapshots their values before filesystem work.
- It resolves directory symlinks.
- It removes duplicate resolved upload roots.
- It returns a frozen configuration with frozen roots and limits.

It does not read `.env`, discover directories from the working directory or make network requests. An empty upload-root array is valid.

Instance URLs keep installation subpaths. The parser rejects embedded user information, query/fragment delimiters, whitespace, control characters, backslashes and unsupported schemes. HTTP requires the literal `TESTRAIL_ALLOW_INSECURE=true`.

Email validation uses the exported configuration schema of the driver. Credentials are kept as supplied. A required value that is empty or contains only whitespace fails. Booleans accept only the literal strings `true` and `false`.

Upload roots must be absolute directories that exist. Windows paths must identify a drive or UNC share. The parser rejects a path that is rooted on the current drive. The download directory must also pass these checks:

- write and traversal access checks;
- an exclusive one-byte write probe, which is closed and removed immediately.

The probe verifies Windows ACLs that the Node access check alone does not evaluate. A failure reports only the configuration key. If the removal fails, a tiny `.testrail-mcp-write-check-*` probe can stay. Startup fails in that case. These startup checks do not replace the F07 checks when individual files are opened, because permissions and paths can change after startup.

Limits use the exact defaults and ceilings in the [budget table](implementation-contracts.md#runtime-budgets-and-lifetime). The limits object rejects unknown keys, nonnumeric values, nonpositive values, fractions and unsafe integers. The effective `max_all_bytes` must not exceed `max_data_bytes`, also when defaults are used. If you lower `max_data_bytes` below 1 MiB, explicitly lower `max_all_bytes` too. The parser never clamps either value. The environment cannot override the fixed watchdog, shutdown, binary-concurrency and error-size budgets.

`driverOptions(configuration)` maps only the approved settings to the public driver configuration. It sets these values:

- It disables caching and driver process handlers.
- It sets request/body timeouts to 15 seconds.
- It allows three driver retries.
- It sets the rate budget to 100 requests per minute.
- It applies JSON/binary response limits.

`createConfiguredDriver(configuration)` constructs one client for each call with those settings. `startServer` awaits `createOperationExecutor` (`src/execution/executor.ts`) one time. The executor calls `createConfiguredDriver` one time for each process, and it owns destruction through its runtime. `tests/transport/composition.test.ts` shows two protocol consumers that share that one client and one budget.

The optional second argument of `createConfiguredDriver` is the driver's `fetch` and `dnsLookup`. It is a test-only seam that `startServer` forwards through executor startup. The CLI never sets it.

By default, each TestRail request connects directly. It goes through a dispatcher that the driver pins to the DNS answers that its private-host guard approved (driver 9.0.0). Thus, these settings are not used:

- global proxy and agent settings;
- `HTTP_PROXY`/`HTTPS_PROXY` with `NODE_USE_ENV_PROXY`;
- a global Undici dispatcher.

The server injects no transport. Thus, you cannot use an instance that is reachable only through a proxy in this mode. With `TESTRAIL_ALLOW_PRIVATE_HOSTS=true`, the guard does not run and there is nothing to pin. Requests go out through the Node connection settings, a configured proxy included, and that proxy then carries the credential. `tests/driver-configuration.test.ts` holds both halves to the pinned driver.

`NODE_EXTRA_CA_CERTS`, set before the process starts, still adds trust for a private certificate authority. An insecure or private-host opt-in emits the driver's own warning two times during startup. The first warning comes from the configuration probe below, and the second comes from the process client. The probe is a real client, and the driver warns from its constructor.

The public constructor of the driver owns literal-host policy. Its per-request network guards own DNS policy. The driver does not export that constructor policy. Thus, `loadConfiguration` applies it through `assertDriverConfiguration(configuration)` before it returns. As a result, no caller can hold a configuration that skipped the private-host and protocol rules.

The probe client registers no process handlers and sends no request. It is destroyed at once. This destruction zeroes its credential and removes it from the process-wide set of live clients in the driver. Thus, the probe does not stay as a second credential identity. Before this fix, the probe was dropped without destruction. It stayed in that set, credential included, for the life of the process.

Driver rejections are attributed structurally: the adapter runs the exported configuration schema of the driver again. It never reads the thrown message, because that message contains the configured host. The attribution has three cases:

- A rejection that names a field that the operator can set maps to the environment key of that field.
- A rejection where the schema finds no error is the URL network policy, and it maps to `TESTRAIL_BASE_URL`.
- A rejection of a transport setting that this adapter fixes raises `DriverSettingsError`. It does not name a key that the operator cannot correct.

Configuration failures report `Invalid configuration: KEY.` with no source error attached. Unexpected internal errors propagate to the startup boundary of the CLI in `src/cli.ts`. That boundary reports a configuration failure by its key, which `tests/cli.test.ts` checks. It reports all other failures as the fixed `Unable to start the server.` No test reaches that path yet. Never log a configuration object, because configuration objects contain credentials.

The exact dependency is the qualified `@dichovsky/testrail-api-client@10.0.0`. [Driver qualification](driver-qualification.md) records its installed-artifact checks. CLI startup and shutdown are integrated and tested. [Transport](transport.md) describes the suites that drive the executable. [Runtime lifetime](runtime-lifetime.md) lists the suites for admission and settlement ownership.
