# TestRail MCP server

A local stdio MCP server for the complete TestRail 10.7.0 API, powered by [`@dichovsky/testrail-api-client`](https://github.com/dichovsky/testrail-api-client).

It exposes **133 tools, one per TestRail REST endpoint**, across all 28 API resources, every one enabled by default, including writes, administration and deletes. It preserves TestRail's own field names and custom fields, pages lists with bounded fetch-all, uploads attachment and BDD files only from directories you configure, and saves downloaded attachments only to the directory you name. It targets Codex desktop and CLI, Claude Code and GitHub Copilot CLI. It covers TestRail's 10.7.0 API, and TestRail 10.8.1, the version its live qualification runs against, is the baseline; older versions are best effort.

## Status

| Area | State |
| --- | --- |
| Endpoint tools | All 133 registered, each with a complete independent parameter manifest ([coverage reports](docs/coverage-reports.md)) |
| Offline verification | Fixture contracts for every endpoint, both MCP protocol eras (legacy `initialize` and 2026-07-28), and the packed executable on Node 24 across Linux, macOS and Windows |
| Client qualification | Pending: [R02](https://github.com/dichovsky/testrail-mcp/issues/23) |
| Live TestRail 10.8.1 qualification and npm release | Pending: [R03](https://github.com/dichovsky/testrail-mcp/issues/24). The [live run](docs/evidence/live/testrail-10.8.1.json) on 10.8.1 has no failures: 98 tools pass, 27 are blocked by the instance's licence or the API user's permissions, and 8 were left out. **No release is on npm yet**; the only version there is a deprecated placeholder, `0.0.0-bootstrap.0` |

## Install

Node 24 is tested. The package's engine range also admits Node 22.13 or later in the 22 series and later majors; those are untested and best effort.

Until the first npm release, install from a packed checkout. `npm pack` prints the tarball's file name; install that file by name, since Windows shells do not expand a `*` wildcard:

```sh
npm ci
npm pack
npm install --global ./dichovsky-testrail-mcp-<version>.tgz
testrail-mcp --version
```

After the first release, install an exact version from npm, for example `npm install --global @dichovsky/testrail-mcp@<version>`. [Releases](docs/release.md) covers versioning, upgrading, rolling back and uninstalling.

## Configure

The server reads its configuration from the environment of the process that launches it, usually the MCP client. It never reads a `.env` file, and never accepts credentials, hosts or URLs in tool arguments.

| Variable | Required | Meaning |
| --- | --- | --- |
| `TESTRAIL_BASE_URL` | Required | Your TestRail instance URL, such as `https://example.testrail.io`. Installation subpaths are kept. Embedded credentials, queries and fragments are refused. HTTPS unless `TESTRAIL_ALLOW_INSECURE` is `true`. |
| `TESTRAIL_EMAIL` | Required | The TestRail user the server acts as. |
| `TESTRAIL_API_KEY` | Required | That user's API key. It is never printed. |
| `TESTRAIL_MCP_UPLOAD_ROOTS` | Required | A JSON array of existing absolute directories that upload tools may read from, such as `["/home/me/testrail-uploads"]`. On Windows, JSON needs forward slashes or doubled backslashes: `["C:/Users/me/testrail-uploads"]`. `[]` allows no uploads; the tools stay registered. |
| `TESTRAIL_MCP_DOWNLOAD_DIR` | Required | An existing, writable absolute directory where downloaded attachments are kept. |
| `TESTRAIL_MCP_LIMITS` | Optional | A strict JSON object overriding the limits below, such as `{"max_all_items": 5000}`. Unknown keys and out-of-range values stop startup. |
| `TESTRAIL_ALLOW_PRIVATE_HOSTS` | Optional | `true` to reach an instance on a private or loopback network. Default `false`. |
| `TESTRAIL_ALLOW_INSECURE` | Optional | `true` to allow plain HTTP. Default `false`. |

A missing or invalid value stops startup with a message naming the variable, never its value. TestRail's own permissions for the configured user still apply to every call.

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

`max_all_bytes` may not exceed `max_data_bytes`. Each TestRail request has its own 15-second request and body timeouts, and a request that passes either is reported as `TIMEOUT`. A call that gets no answer within 60 seconds is reported as `TIMEOUT` too, while its request finishes in the background.

## Connect a client

[Client configuration](docs/client-compatibility.md) has examples for Codex desktop and CLI, Claude Code and GitHub Copilot CLI. Give the client a 120-second tool-call timeout, and keep every tool enabled: leave allow and deny filters unset, or, in Copilot CLI, set `tools: ["*"]` as its example does.

The client passes the variables under [Configure](#configure) to the server, so they must be in the environment the client itself was launched with, and `node` must be on that environment's path. A desktop app may not inherit what a terminal exports; how each app is set up is recorded under [R02](https://github.com/dichovsky/testrail-mcp/issues/23).

## How the tools behave

- **Results.** A result is `{data}`, with `pagination` on a paged list and `warnings` when there are any. `data` is TestRail's reply with its own field names, custom fields included. `warnings` flags fields that differ from the expected shape; the data is still passed through. See [results and errors](docs/results-and-errors.md).
- **Errors.** Every error carries a fixed code, such as `INVALID_ARGUMENT`, `NOT_FOUND`, `PERMISSION_DENIED`, `RATE_LIMITED`, `TIMEOUT` or `PAGINATION_LIMIT`. On a write, `write_outcome` says whether the change reached TestRail: `not_started`, `acknowledged` or `unknown`. Check before retrying an `unknown` write.
- **Lists.** 24 lists are paged. 18 of them return one page of 50 by default, and up to 250 on request. On any of the 24, set `_mcp.pagination` to `"all"` for a bounded complete fetch, as far as TestRail's replies link on. It stops with `PAGINATION_LIMIT`, and no partial data, if it would pass a bound. Other lists, such as `testrail_get_statuses` and `testrail_get_users`, return TestRail's whole reply and take no `_mcp` settings.
  - Six lists choose their own pages and take no page size or offset: `testrail_get_variables`, `testrail_get_datasets`, `testrail_get_shared_step_history`, `testrail_get_roles`, `testrail_get_groups` and `testrail_get_case_statuses`.
  - Their later pages are reachable only through `"all"`.
  - See [pagination](docs/pagination.md).
- **Files.** Uploads read a local path that must resolve inside an upload root. The server sends a copy it makes in a private directory under the system's temporary directory (on Windows, only as private as that temporary directory), and removes the copy once the request has settled. Each download writes a new file to the download directory and never overwrites one, so its tools are marked as not read-only. The server never deletes a completed download. See [local files](docs/local-files.md).
- **Side effects.** Every tool carries MCP annotations describing its effect. Report runs generate a report, and may send the template's configured email, so don't call them repeatedly. The server adds no confirmation step of its own; your client's approval settings apply.
- **Cancellation.** Cancelling a call stops the server waiting for it, and the client gets no result for that call. A request already sent to TestRail may still complete, so treat a cancelled write as possibly applied and check before retrying it. One exception comes from the MCP SDK: on a 2026-07-28 connection, cancelling the first ordinary request, whose id is 0, is ignored, and that call completes and answers normally. See [runtime lifetime](docs/runtime-lifetime.md) and [stdio transport](docs/transport.md).

## Development

```sh
npm ci
npm run check
```

`npm run check` runs these steps, and none of them need TestRail credentials:
1. builds from a clean output directory, after checking that each direct dependency is installed at the version `package-lock.json` records. If one is not, for example after a pull that changed a pin, the build stops and names it; run `npm ci`;
2. checks the registry against the pinned [operation inventory](docs/operation-inventory.json) and the generated [operation reference](docs/operation-reference.md);
3. typechecks and lints;
4. runs every test;
5. packs and installs the tarball into a clean directory, then drives the installed executable over MCP in both protocol eras against a local stand-in for TestRail.

`npm run test:coverage` runs the same tests and fails if source coverage of `src/` drops below 99% for lines, statements, functions or branches; the thresholds live in `vitest.config.ts`. CI does the same on Node 24 across Linux, macOS and Windows, enforces those thresholds on Linux, and publishes the [coverage reports](docs/coverage-reports.md) as artifacts. Source layout follows the [component boundaries](src/README.md).

## Documents

- [Implementation plan and GitHub work items](docs/implementation-plan.md), [architecture](docs/architecture.md) and [implementation contracts](docs/implementation-contracts.md)
- [Endpoint coverage](docs/api-coverage.md), [machine-readable inventory](docs/operation-inventory.json), [operation reference](docs/operation-reference.md) and [coverage reports](docs/coverage-reports.md)
- [Registry authoring](docs/registry-authoring.md) and [parameter fixtures](docs/parameter-manifest.md)
- [Startup configuration](docs/startup-configuration.md), [runtime lifetime](docs/runtime-lifetime.md), [results and errors](docs/results-and-errors.md), [pagination](docs/pagination.md), [local files](docs/local-files.md) and [stdio transport](docs/transport.md)
- [Driver qualification](docs/driver-qualification.md) and [client configuration and verification](docs/client-compatibility.md)
- [Releases and compatibility policy](docs/release.md), [changelog](CHANGELOG.md) and [live TestRail qualification](docs/live-qualification.md)
- [Domain glossary](CONTEXT.md), [design decision](docs/adr/0001-endpoint-tools.md) and [research sources](docs/research-notes.md)
