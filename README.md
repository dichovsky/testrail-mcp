# TestRail MCP server

A local stdio MCP server for the complete TestRail 10.7.0 API, powered by [`@dichovsky/testrail-api-client`](https://github.com/dichovsky/testrail-api-client).

It exposes **133 tools, one per TestRail REST endpoint**, across all 28 API resources. Every tool is enabled by default, including writes, administration and deletes. The server does these things:

- It preserves TestRail's own field names and custom fields.
- It pages lists with bounded fetch-all.
- It uploads attachment and BDD files only from directories that you configure.
- It saves downloaded attachments only to the directory that you name.

It targets Codex desktop and CLI, Claude Code and GitHub Copilot CLI. It covers the TestRail 10.7.0 API. TestRail 10.8.1 is the baseline, because the live qualification runs against that version. Older versions are best effort.

## Status

| Area | State |
| --- | --- |
| Endpoint tools | All 133 registered, each with a complete independent parameter manifest ([coverage reports](docs/coverage-reports.md)) |
| Offline verification | Fixture contracts for every endpoint, both MCP protocol eras (legacy `initialize` and 2026-07-28), and the packed executable on Node 24 across Linux, macOS and Windows |
| Client qualification | The owner closed it on 2026-10-04: [R02](https://github.com/dichovsky/testrail-mcp/issues/23). Claude Code passed all 12 scenarios against the fixture stand-in ([record](docs/evidence/clients/claude-code.json)). Codex CLI passed 10 of 12, as the owner reported. Codex desktop and Copilot CLI were not tested. [Client configuration](docs/client-compatibility.md#required-surfaces-and-evidence) has the details |
| Live TestRail 10.8.1 qualification and npm release | [R03](https://github.com/dichovsky/testrail-mcp/issues/24). The [live run](docs/evidence/live/testrail-10.8.1.json) on 10.8.1 with the driver of the release, 9.0.0, on 2026-10-04, has no failures. 98 tools pass. 27 tools are blocked by the license of the instance or the permissions of the API user. 8 tools were left out. Those 35 are documented limitations, not passes. The [changelog](CHANGELOG.md) lists them. 1.0.0 is the first npm release. The placeholder before it, `0.0.0-bootstrap.0`, is deprecated |

## Install

Node 24 or later is required. Node 24 is tested. The pinned driver, `@dichovsky/testrail-api-client` 9.0.0, requires Node 24 itself. Later majors satisfy the engine range, but they are untested and best effort.

Install an exact version from npm:

```sh
npm install --global @dichovsky/testrail-mcp@1.0.0
testrail-mcp --version
```

To try an unreleased change, install from a packed checkout. `npm pack` prints the file name of the tarball. Install that file by name, because Windows shells do not expand a `*` wildcard:

```sh
npm ci
npm pack
npm install --global ./dichovsky-testrail-mcp-<version>.tgz
testrail-mcp --version
```

[Releases](docs/release.md) covers versioning, upgrading, rolling back and uninstalling.

To host the server in a Proxmox VE container that clients start over SSH, see [Proxmox VE container](proxmox/README.md).

## Configure

The server reads its configuration from the environment of the process that launches it, usually the MCP client. It never reads a `.env` file. It never accepts credentials, hosts or URLs in tool arguments.

| Variable | Required | Meaning |
| --- | --- | --- |
| `TESTRAIL_BASE_URL` | Required | Your TestRail instance URL, such as `https://example.testrail.io`. The server keeps installation subpaths. It refuses embedded credentials, queries and fragments. HTTPS is required unless `TESTRAIL_ALLOW_INSECURE` is `true`. |
| `TESTRAIL_EMAIL` | Required | The TestRail user the server acts as. |
| `TESTRAIL_API_KEY` | Required | That user's API key. The server never prints it. |
| `TESTRAIL_MCP_UPLOAD_ROOTS` | Required | A JSON array of existing absolute directories that upload tools may read from, such as `["/home/me/testrail-uploads"]`. On Windows, JSON needs forward slashes or doubled backslashes: `["C:/Users/me/testrail-uploads"]`. `[]` allows no uploads. The tools stay registered. |
| `TESTRAIL_MCP_DOWNLOAD_DIR` | Required | An existing, writable absolute directory where the server keeps downloaded attachments. |
| `TESTRAIL_MCP_LIMITS` | Optional | A strict JSON object overriding the limits below, such as `{"max_all_items": 5000}`. Unknown keys and out-of-range values stop startup. |
| `TESTRAIL_ALLOW_PRIVATE_HOSTS` | Optional | `true` to reach an instance on a private or loopback network. Default `false`. |
| `TESTRAIL_ALLOW_INSECURE` | Optional | `true` to allow plain HTTP. Default `false`. |

A missing or invalid value stops startup. The message names the variable and never shows its value. The TestRail permissions of the configured user still apply to every call.

### Limits

| Key | Default | Highest allowed |
| --- | --- | --- |
| `max_active_calls` | 4 | 4 |
| `max_json_response_bytes` | 10485760 (10 MiB) | 67108864 (64 MiB) |
| `max_file_bytes` | 104857600 (100 MiB) | 104857600 (100 MiB) |
| `max_data_bytes` | 1048576 (1 MiB) | 8388608 (8 MiB) |
| `max_result_bytes` | 2621440 (2.5 MiB) | 25165824 (24 MiB) |
| `max_all_items` | 1000 | 10000 |
| `max_all_pages` | 20 | 100 |
| `max_all_bytes` | 1048576 (1 MiB) | 8388608 (8 MiB) |
| `max_all_duration_ms` | 45000 | 45000 |

`max_all_bytes` must not exceed `max_data_bytes`. Each TestRail request has its own 15-second request and body timeouts. The server reports a request that passes either timeout as `TIMEOUT`. A call that gets no answer within 60 seconds is reported as `TIMEOUT` too, while its request finishes in the background.

## Connect a client

[Client configuration](docs/client-compatibility.md) has examples for Codex desktop and CLI, Claude Code and GitHub Copilot CLI. Give the client a 120-second tool-call timeout. Keep every tool enabled: leave allow and deny filters unset. In Copilot CLI, set `tools: ["*"]` instead, as its example does.

The client passes the variables under [Configure](#configure) to the server. Thus, the variables must be in the environment with which the client itself was launched. `node` must be on the path of that environment. A desktop app may not inherit what a terminal exports. Check how your desktop app is launched.

## How the tools behave

- **Results.** A result is `{data}`, with `pagination` on a paged list and `warnings` when there are any. `data` is TestRail's reply with its own field names, custom fields included. `warnings` flags fields that differ from the expected shape. The server still passes the data through. See [results and errors](docs/results-and-errors.md).
- **Errors.** Every error carries a fixed code, such as `INVALID_ARGUMENT`, `NOT_FOUND`, `PERMISSION_DENIED`, `RATE_LIMITED`, `TIMEOUT` or `PAGINATION_LIMIT`. On a write, `write_outcome` says whether the change reached TestRail: `not_started`, `acknowledged` or `unknown`. Check before retrying an `unknown` write.
- **Lists.** 24 lists are paged. 18 of them return one page of 50 by default, and up to 250 on request. On any of the 24, set `_mcp.pagination` to `"all"` for a bounded fetch-all, as far as TestRail's replies link on. If the fetch-all would pass a bound, it stops with `PAGINATION_LIMIT` and returns no partial data. Other lists, such as `testrail_get_statuses` and `testrail_get_users`, return TestRail's whole reply and take no `_mcp` settings.
  - Six lists choose their own pages and take no page size or offset: `testrail_get_variables`, `testrail_get_datasets`, `testrail_get_shared_step_history`, `testrail_get_roles`, `testrail_get_groups` and `testrail_get_case_statuses`.
  - Their later pages are reachable only through `"all"`.
  - See [pagination](docs/pagination.md).
- **Network.** By default the server connects to TestRail directly, to the address the driver's DNS check approved. The server does not use proxy settings (`HTTP_PROXY`, `HTTPS_PROXY`, `NODE_USE_ENV_PROXY`). Thus, the server cannot use an instance that is reachable only through a proxy. If `TESTRAIL_ALLOW_PRIVATE_HOSTS` is `true`, the driver skips that check and the pinning. Then Node's own connection settings apply, a configured proxy included. That proxy then carries the credential. For a private certificate authority, set `NODE_EXTRA_CA_CERTS` before starting the server. DNS resolution counts against each request's 15-second timeout. See [startup configuration](docs/startup-configuration.md).
- **Files.** Uploads read a local path that must resolve inside an upload root. The server makes a copy in a private directory under the system's temporary directory (on Windows, only as private as that temporary directory) and sends that copy. It removes the copy after the request has settled. Each download writes a new file to the download directory and never overwrites one. Thus, the server marks the tools for downloads as not read-only. The server never deletes a completed download. See [local files](docs/local-files.md).
- **Side effects.** Every tool carries MCP annotations describing its effect. Do not call the report-run tools repeatedly. Each report run generates a report and may send the configured email of the template. The server adds no confirmation step of its own. The approval settings of your client apply.
- **Cancellation.** Cancelling a call stops the server waiting for it, and the client gets no result for that call. A request that the server already sent to TestRail may still complete. Thus, treat a cancelled write as possibly applied. Check before you retry it. The MCP SDK causes one exception. On a 2026-07-28 connection, the SDK ignores the cancellation of the first ordinary request, whose id is 0. That call completes and answers normally. See [runtime lifetime](docs/runtime-lifetime.md) and [stdio transport](docs/transport.md).

## Development

```sh
npm ci
npm run check
```

`npm run check` runs these steps. None of them needs TestRail credentials:
1. builds from a clean output directory, after it checks that each direct dependency is installed at the version that `package-lock.json` records. If a dependency is not, for example after a pull that changed a pin, the build stops and names it. Then run `npm ci`;
2. checks the registry against the pinned [operation inventory](docs/operation-inventory.json) and the generated [operation reference](docs/operation-reference.md);
3. typechecks and lints;
4. runs every test;
5. packs and installs the tarball into a clean directory, then drives the installed executable over MCP in both protocol eras against a local stand-in for TestRail.

Passing tests hide their console output and JSON diagnostics. Failing tests show them. Other stderr output remains visible. To see all per-call diagnostics, run `npm test -- --silent=false` (or `npm run test:coverage -- --silent=false`). This option affects test output only. The running server still writes its diagnostics to stderr.

CI runs these steps on Node 24 across Linux, macOS and Windows. On Linux, the test step of CI is `npm run test:coverage` instead. This command runs the same tests. It fails if source coverage of `src/` drops below 99% for lines, statements, functions or branches. The thresholds are in `vitest.config.ts`.

CI also publishes the [coverage reports](docs/coverage-reports.md) as artifacts. Source layout follows the [component boundaries](src/README.md).

## Documents

- [Implementation plan and GitHub work items](docs/implementation-plan.md), [architecture](docs/architecture.md) and [implementation contracts](docs/implementation-contracts.md)
- [Endpoint coverage](docs/api-coverage.md), [machine-readable inventory](docs/operation-inventory.json), [operation reference](docs/operation-reference.md) and [coverage reports](docs/coverage-reports.md)
- [Registry authoring](docs/registry-authoring.md) and [parameter fixtures](docs/parameter-manifest.md)
- [Startup configuration](docs/startup-configuration.md), [runtime lifetime](docs/runtime-lifetime.md), [results and errors](docs/results-and-errors.md), [pagination](docs/pagination.md), [local files](docs/local-files.md) and [stdio transport](docs/transport.md)
- [Driver qualification](docs/driver-qualification.md) and [client configuration and verification](docs/client-compatibility.md)
- [Releases and compatibility policy](docs/release.md), [changelog](CHANGELOG.md) and [live TestRail qualification](docs/live-qualification.md)
- [Domain glossary](CONTEXT.md), [design decision](docs/adr/0001-endpoint-tools.md) and [research sources](docs/research-notes.md)
