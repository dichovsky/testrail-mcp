# TestRail MCP server

A local stdio MCP server for the complete TestRail 10.7.0 API, powered by [`@dichovsky/testrail-api-client`](https://github.com/dichovsky/testrail-api-client).

It exposes **133 tools, one per TestRail REST endpoint**, across all 28 API resources, every one enabled by default, including writes, administration and deletes. It preserves TestRail's own field names and custom fields, pages lists with bounded fetch-all, and reads and writes attachment and BDD files only within directories you configure. It targets Codex desktop and CLI, Claude Code and GitHub Copilot CLI. TestRail 10.7.0 is the baseline; older versions are best effort.

## Status

| Area | State |
| --- | --- |
| Endpoint tools | All 133 registered, each with a complete independent parameter manifest ([coverage reports](docs/coverage-reports.md)) |
| Offline verification | Fixture contracts for every endpoint, both MCP protocol eras (legacy `initialize` and 2026-07-28), and the packed executable on Node 22 and 24 across Linux, macOS and Windows |
| Client qualification | Pending: [R02](https://github.com/dichovsky/testrail-mcp/issues/23) |
| Live TestRail 10.7 qualification and npm release | Pending: [R03](https://github.com/dichovsky/testrail-mcp/issues/24). The package is **not yet published to npm** |

## Install

Node 22.13 or later in the 22 series, or Node 24, is required. Other Node majors admitted by the package's engine range are best effort.

Until the first npm release, install from a packed checkout:

```sh
npm ci
npm pack
npm install --global ./dichovsky-testrail-mcp-*.tgz
testrail-mcp --version
```

Once published, install an exact version from npm, for example `npm install --global @dichovsky/testrail-mcp@<version>`.

## Configure

The server reads its configuration from the environment of the process that launches it, usually the MCP client. It never reads a `.env` file, and never accepts credentials, hosts or URLs in tool arguments.

| Variable | Required | Meaning |
| --- | --- | --- |
| `TESTRAIL_BASE_URL` | Required | Your TestRail instance URL, such as `https://example.testrail.io`. Installation subpaths are kept. Embedded credentials, queries and fragments are refused. HTTPS unless `TESTRAIL_ALLOW_INSECURE` is `true`. |
| `TESTRAIL_EMAIL` | Required | The TestRail user the server acts as. |
| `TESTRAIL_API_KEY` | Required | That user's API key. It is never printed. |
| `TESTRAIL_MCP_UPLOAD_ROOTS` | Required | A JSON array of existing absolute directories that upload tools may read from, such as `["/home/me/testrail-uploads"]`. `[]` allows no uploads; the tools stay registered. |
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

`max_all_bytes` may not exceed `max_data_bytes`. Each TestRail request has its own 15-second request and body timeouts, and a call that gets no answer within 60 seconds is reported as `TIMEOUT` while its request finishes in the background.

## Connect a client

[Client configuration](docs/client-compatibility.md) has ready-to-merge examples for Codex desktop and CLI, Claude Code and GitHub Copilot CLI. Give the client a 120-second tool-call timeout, and leave its tool filters unset so the whole catalog stays available.

## How the tools behave

- **Results.** A result is `{data, pagination, warnings}`. `data` is TestRail's reply with its own field names, custom fields included. `warnings` flags fields that differ from the expected shape; the data is still passed through. See [results and errors](docs/results-and-errors.md).
- **Errors.** Every error carries a fixed code, such as `INVALID_ARGUMENT`, `NOT_FOUND`, `PERMISSION_DENIED`, `RATE_LIMITED`, `TIMEOUT`, `CANCELLED` or `PAGINATION_LIMIT`. On a write, `write_outcome` says whether the change reached TestRail: `not_started`, `acknowledged` or `unknown`. Check before retrying an `unknown` write.
- **Lists.** A list returns one page of 50 by default, and up to 250 on request. Set `_mcp.pagination` to `"all"` for a bounded complete fetch. It stops with `PAGINATION_LIMIT`, and no partial data, if it would pass a bound.
  - Six lists choose their own pages and take no page size or offset: `testrail_get_variables`, `testrail_get_datasets`, `testrail_get_shared_step_history`, `testrail_get_roles`, `testrail_get_groups` and `testrail_get_case_statuses`.
  - Their later pages are reachable only through `"all"`.
  - See [pagination](docs/pagination.md).
- **Files.** Uploads read a local path that must resolve inside an upload root. Each download writes a new file to the download directory and never overwrites one, so its tools are marked as not read-only. The server never deletes a completed download. See [local files](docs/local-files.md).
- **Side effects.** Every tool carries MCP annotations describing its effect. Report runs generate a report, and may send the template's configured email, so don't call them repeatedly. The server adds no confirmation step of its own; your client's approval settings apply.
- **Cancellation.** Cancelling a call stops the server waiting for it. A request already sent to TestRail may still complete, so a cancelled write reports `write_outcome: "unknown"`. See [runtime lifetime](docs/runtime-lifetime.md).

## Development

```sh
npm ci
npm run check
```

`npm run check` runs these steps, and none of them need TestRail credentials:
1. builds from a clean output directory;
2. checks the registry against the pinned [operation inventory](docs/operation-inventory.json) and the generated [operation reference](docs/operation-reference.md);
3. typechecks and lints;
4. runs every test;
5. packs and installs the tarball into a clean directory, then drives the installed executable over MCP in both protocol eras against a local stand-in for TestRail.

CI does the same on Node 22 and 24 across Linux, macOS and Windows, and publishes the [coverage reports](docs/coverage-reports.md) as artifacts. Source layout follows the [component boundaries](src/README.md).

## Documents

- [Implementation plan and GitHub work items](docs/implementation-plan.md), [architecture](docs/architecture.md) and [implementation contracts](docs/implementation-contracts.md)
- [Endpoint coverage](docs/api-coverage.md), [machine-readable inventory](docs/operation-inventory.json), [operation reference](docs/operation-reference.md) and [coverage reports](docs/coverage-reports.md)
- [Registry authoring](docs/registry-authoring.md) and [parameter fixtures](docs/parameter-manifest.md)
- [Startup configuration](docs/startup-configuration.md), [runtime lifetime](docs/runtime-lifetime.md), [results and errors](docs/results-and-errors.md), [pagination](docs/pagination.md), [local files](docs/local-files.md) and [stdio transport](docs/transport.md)
- [Driver qualification](docs/driver-qualification.md) and [client configuration and verification](docs/client-compatibility.md)
- [Domain glossary](CONTEXT.md), [design decision](docs/adr/0001-endpoint-tools.md) and [research sources](docs/research-notes.md)
