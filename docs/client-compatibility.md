# MCP client setup and release verification

Status: the server is implemented, and all 133 tools are verified offline (see [coverage reports](coverage-reports.md)). No client compatibility test has run yet; that is [R02](https://github.com/dichovsky/testrail-mcp/issues/23). The client research below dates from 2026-09-09. The configuration examples are release documentation, not changes to your client settings.

## Required surfaces and evidence

The release targets local stdio connections from Codex desktop, Codex CLI, Claude Code, and GitHub Copilot CLI. Copilot CLI replaces the earlier VS Code assumption. Claude Desktop, Copilot in VS Code, hosted agents, and remote HTTP deployment are outside this release verification matrix.

| Surface | Existing observation | Release verification |
| --- | --- | --- |
| Codex desktop | App is available; build/version not recorded | Pending |
| Codex CLI | Local read-only check reported `codex-cli 0.149.0` | Pending |
| Claude Code | Executable is available; version not recorded | Pending |
| GitHub Copilot CLI | Local read-only check reported `1.0.67` | Pending |

An installed executable is not evidence of authentication, an available model, or compatibility. Before release, replace the pending results with records naming the exact client version/build, operating system, Node version, model/provider, relevant host settings, package version/integrity, driver version, negotiated MCP revision, test date, and evidence location. Codex desktop and CLI need separate records even when they share configuration. Do not promise support for every historical client version or every provider based on one successful run.

Keep all 133 endpoint tools registered and enabled. Host deferral controls when definitions enter model context; it must not reduce the server's `tools/list` catalog. Host permission prompts remain the host's responsibility and are not evidence that the server added a confirmation requirement.

## SDK and protocol baseline

The npm registry reported `@modelcontextprotocol/server@2.0.0` and `@modelcontextprotocol/client@2.0.0` as their respective `latest` packages during this check. Both specify Node >=20; the selected runtime must also satisfy the stricter TestRail driver requirement. Pin the verified dependencies and retain a lockfile. Sources: [server registry metadata](https://registry.npmjs.org/@modelcontextprotocol%2fserver/latest), [client registry metadata](https://registry.npmjs.org/@modelcontextprotocol%2fclient/latest).

Use `serveStdio(factory)` from `@modelcontextprotocol/server/stdio`. The released implementation accepts legacy clients by default and also serves MCP 2026-07-28. Do not set `legacy: 'reject'`. Modern discovery and legacy initialization must both be tested; installing SDK v2 does not imply that every host uses the modern protocol. Source: [released v2 stdio implementation](https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/@modelcontextprotocol%2Fserver@2.0.0/packages/server/src/server/serveStdio.ts).

## Shared installation and environment

Package: `@dichovsky/testrail-mcp`. Executable: `testrail-mcp`. No release is on npm yet, only a deprecated placeholder; until the first release, install it from a packed checkout as the [README](../README.md#install) describes.

For release verification, build and pack the candidate, install that tarball into an isolated prefix, and use the installed executable. Verify the published, exact version through npm once publication is part of the release workflow. The examples below assume `testrail-mcp` is on the host's executable path. When it is not, replace `command` with the absolute path of that same installed executable; check this separately for the desktop launch environment.

Supply these variables to the client process before launching it. The client forwards them to its server subprocess. References below are placeholders; the server does not automatically read a `.env` file merely because one exists.

| Variable | Expected value |
| --- | --- |
| `TESTRAIL_BASE_URL` | The configured instance URL, for example `https://example.testrail.io` |
| `TESTRAIL_EMAIL` | The configured user's TestRail email address |
| `TESTRAIL_API_KEY` | That user's API key, supplied privately through the launch environment |
| `TESTRAIL_MCP_UPLOAD_ROOTS` | A JSON array of absolute directories, for example `["/absolute/path/to/testrail-uploads"]` |
| `TESTRAIL_MCP_DOWNLOAD_DIR` | An absolute directory, for example `/absolute/path/to/testrail-downloads` |

These optional variables are only needed when you use them. When you do, add them to the client's forwarding list or `env` map as well:

| Variable | Expected value |
| --- | --- |
| `TESTRAIL_MCP_LIMITS` | A JSON object overriding limits, for example `{"max_all_items": 5000}`; the README lists the keys and their ranges |
| `TESTRAIL_ALLOW_PRIVATE_HOSTS` | `true` for an instance on a private or loopback network; default `false` |
| `TESTRAIL_ALLOW_INSECURE` | `true` to allow plain HTTP; default `false` |

Replace the example directories with existing locations accessible to the local server and consumer. Do not store actual credentials in committed configuration or evidence. A desktop application may not inherit variables exported in an unrelated terminal; test the environment delivered to its subprocess without printing values.

Set client tool-call timeouts to 120 seconds. The server uses separate 15-second driver request and body timeouts, a 45-second aggregation budget and a 60-second response-wait watchdog. DNS and retries can add time; the watchdog does not abort an already-running driver request, whose operation handle retains its execution slot until actual descendant settlement. An internal driver deadline may reject the public result first; F01 supplies the required independent settlement signal. The client timeout provides headroom for the server to return its own result or error; it does not extend the server's limits. Verify actual elapsed behavior, including retries and the driver's handling of an already-running request when a budget expires.

## Codex desktop and CLI

Merge this table into the applicable Codex host configuration, usually `~/.codex/config.toml`; preserve unrelated entries. The five variables must exist in the host environment. Leave tool allow/deny filters unset so the complete catalog remains available.

```toml
[mcp_servers.testrail]
command = "testrail-mcp"
args = []
env_vars = [
  "TESTRAIL_BASE_URL",
  "TESTRAIL_EMAIL",
  "TESTRAIL_API_KEY",
  "TESTRAIL_MCP_UPLOAD_ROOTS",
  "TESTRAIL_MCP_DOWNLOAD_DIR",
]
startup_timeout_sec = 30
tool_timeout_sec = 120
enabled = true
```

Codex documents shared MCP configuration for local desktop/CLI surfaces, command-launched stdio, environment forwarding, and configurable startup/call timeouts. Reconnect or restart the client after changes. Check server state with `/mcp`, and record the actual automatic tool-discovery behavior rather than assuming a specific model context strategy. Keep the first 512 characters of server instructions self-contained. Source: [official Codex MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

## Claude Code

This is a project `.mcp.json` example. Use the equivalent user/local scope when appropriate; configuration files contain environment references only. Complete the host's normal workspace/server trust setup before measuring compatibility.

```json
{
  "mcpServers": {
    "testrail": {
      "type": "stdio",
      "command": "testrail-mcp",
      "args": [],
      "timeout": 120000,
      "env": {
        "TESTRAIL_BASE_URL": "${TESTRAIL_BASE_URL}",
        "TESTRAIL_EMAIL": "${TESTRAIL_EMAIL}",
        "TESTRAIL_API_KEY": "${TESTRAIL_API_KEY}",
        "TESTRAIL_MCP_UPLOAD_ROOTS": "${TESTRAIL_MCP_UPLOAD_ROOTS}",
        "TESTRAIL_MCP_DOWNLOAD_DIR": "${TESTRAIL_MCP_DOWNLOAD_DIR}"
      }
    }
  }
}
```

Use normal automatic discovery: leave `alwaysLoad` and `ENABLE_TOOL_SEARCH` unset. Current docs describe default deferred search, subject to model/provider/settings exceptions, and no fixed per-server tool cap. Keep individual tool descriptions and server instructions under 2 KiB. Check the connected catalog in `/mcp`. The per-server `timeout` is in milliseconds.

First test the client's default stdio negotiation. Where the installed runtime supports it, additionally test `MCP_PROTOCOL_NEGOTIATION=auto` on the Claude process. Record the negotiated revision instead of inferring it from the runtime version. Current docs distinguish the v2 runtime from its separate stdio protocol-probing setting. Source: [Claude Code MCP reference](https://code.claude.com/docs/en/mcp).

## GitHub Copilot CLI

Merge this entry into `~/.copilot/mcp-config.json`. Unlike Codex's forwarding list, the `env` map explicitly references the client's environment.

```json
{
  "mcpServers": {
    "testrail": {
      "type": "stdio",
      "command": "testrail-mcp",
      "args": [],
      "tools": ["*"],
      "deferTools": "auto",
      "timeout": 120000,
      "env": {
        "TESTRAIL_BASE_URL": "${TESTRAIL_BASE_URL}",
        "TESTRAIL_EMAIL": "${TESTRAIL_EMAIL}",
        "TESTRAIL_API_KEY": "${TESTRAIL_API_KEY}",
        "TESTRAIL_MCP_UPLOAD_ROOTS": "${TESTRAIL_MCP_UPLOAD_ROOTS}",
        "TESTRAIL_MCP_DOWNLOAD_DIR": "${TESTRAIL_MCP_DOWNLOAD_DIR}"
      }
    }
  }
}
```

The CLI documents this configuration, variable expansion, and a millisecond timeout covering discovery and calls. Its local tool snapshot can precede live discovery, so cold-start verification must force live discovery in an isolated test configuration, then separately exercise normal cached startup. Do not use VS Code configuration or settings. Source: [Copilot CLI command reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference).

Keep personal `toolSearch` at its automatic default and use a supported model. Current docs activate search at approximately 30 tools and defer external definitions; `deferTools: "never"` and named custom-agent tool declarations can defeat this behavior. Test the ordinary agent first. No CLI-specific fixed catalog cap was established in this research; do not import VS Code's 128-tools-per-request restriction or claim unlimited capacity. Source: [Copilot CLI tool search](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/tool-search).

The observed 1.0.67 binary is not a minimum-supported-version commitment. Model support can change between releases: Haiku tool search was added in the later 1.0.72-0 prerelease. Select and record a model supported by the tested CLI release. Source: [official release note](https://github.com/github/copilot-cli/releases/tag/v1.0.72-0).

Copilot CLI can move large tool output to a temporary file and present a preview. Verify that the model can read the full result there, including pagination and drift warnings; distinguish this host file from an attachment downloaded by the TestRail server. Source: [Copilot CLI context management](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/context-management).

## Verification stages

### 1. Deterministic protocol and package checks

Run these in CI without real TestRail credentials or upstream network access. [R01](issues/R01.md) records where each one is:
- the packaged-executable protocol checks, in `scripts/package-protocol.mjs`;
- the catalog and registry gates, in `tests/regression-gates.test.ts` and `npm run registry:check`;
- the fixture contracts, in `tests/registered-parameters.test.ts`, and the result wrapper, in `tests/result-contract.test.ts`;
- the stdout, shutdown and cancellation checks, in `tests/transport/`.

Item 3 differs from its wording in one way. Every fixture runs through the registered tool's driver call and the real driver, not the server. One accepted fixture per tool also runs through a connected client and the server, where the result wrapper is checked.

1. Install the packed candidate and spawn its executable with fixture credentials. Initialization/discovery and `tools/list` must not require a TestRail request. Validate the installed executable rather than only a source-development runner.
2. Enumerate the complete catalog over legacy initialization and MCP 2026-07-28 discovery using the pinned SDK clients. Compare the exact 133 names with the versioned coverage matrix; detect missing, additional, duplicate, or incorrectly mapped operations. Verify stable ordering, input/output schemas, descriptions, and annotations.
3. Run every operation's contract fixtures through the same server factory and real driver, using the driver's injected `fetch`/DNS seam. This test launcher is a development harness, not an extra production credential, transport, or unrestricted URL option. Verify exact arguments/route/payload, preserved fields, wrapper, and expected failures. Fixture-backed mutation tests must never contact real TestRail.
4. Assert that stdout contains only MCP messages, startup failures are actionable and redacted, and shutdown releases subprocess resources. Exercise cancellation against delayed driver fixtures with the limitations specified in the architecture; a disconnected client is not proof that an upstream write was rolled back.

Protocol success establishes the adapter contract. It does not substitute for host discovery or model-driven usage checks.

### 2. Required-client checks

Use an isolated client configuration and the fixture-backed test launcher for repeatable host checks. Then perform the packaged production-executable smoke checks against a designated TestRail 10.7.0 test instance as part of release verification. Keep fixture and live evidence separate. Any unavailable account, client surface, or instance remains explicitly unverified.

#### The fixture-backed kit

The kit lets you run every scenario below with no TestRail account. It needs a clone of this repository with `npm ci` run in it.

1. **Start the stand-in.** Run `node scripts/fixture-testrail.mjs` in the clone. It prints the variables the client needs, with synthetic credentials.
   - `--pages 3` makes every paged list hold three pages, for C04 and C05: 150 items, read 50 at a time, for a list that takes a page size, and 6 items, 2 at a time, for a list that chooses its own pages. A larger page size or `"all"` reads the same list.
   - `--log requests.jsonl` records each request's method, endpoint and status, one line per request when its reply is ready, and marks a request as `abandoned` when the client had already given up, as the driver does at its request timeout. It never records the credentials. It appends, so give each session its own file. The stand-in refuses to start if it cannot write the file, and if a later write fails it still sends that reply, then stops with an error.
   - The stand-in answers every one of the 133 endpoints, at every path the fixtures show the driver sending, with that endpoint's reply from its parameter manifest. It accepts any ID, except the reserved ones below.
2. **Launch the client with those variables.** The stand-in is plain HTTP on the loopback interface, so add `TESTRAIL_ALLOW_INSECURE` and `TESTRAIL_ALLOW_PRIVATE_HOSTS` to the client's forwarding list or `env` map, as the optional variables above describe. Also set `TESTRAIL_MCP_UPLOAD_ROOTS` and `TESTRAIL_MCP_DOWNLOAD_DIR` to directories you create. Otherwise leave the client's configuration as the examples above give it.
3. **Check the catalog for C01.** Run `node scripts/catalog-hash.mjs --command testrail-mcp`. For each protocol era it prints the revision the session negotiated, and the count and hash of the catalog the server you installed lists. A record names the era, not the date: `legacy` for a session that began with `initialize`, whatever revision it negotiated, and `2026-07-28` for the current protocol. The expected catalog is 133 tools, sorted-name SHA-256 `a423193aa71240cb0cca5bd0ed54c30fdadfdadb3d61ac297a9afb4afd111724`.
4. **Run the C03 tasks.** Type each prompt from [`tests/fixtures/clients/c03-corpus.json`](../tests/fixtures/clients/c03-corpus.json) into the client. Compare the tool and arguments the client chose with the task's expected ones. Record wrong selections and retries.

Reserved IDs work as any numeric path ID of the 112 routes that take a path ID, and as the project ID of `testrail_get_users`. A plan entry's ID is a GUID, so it takes none, and a route without a path ID, such as `testrail_get_projects`, has no scenario.

| Path ID | Stand-in reply | Routes | What the client should show |
| --- | --- | --- | --- |
| `990404` | 404 | the 112 routes that take a path ID | `NOT_FOUND` (C06) |
| `990400` | 400, TestRail's reply to an ID it will not serve | the 112 routes that take a path ID | `UPSTREAM_ERROR` with `http_status` 400 |
| `990401` | 401 | the 112 routes that take a path ID | `AUTHENTICATION_FAILED` |
| `990403` | 403 | the 112 routes that take a path ID | `PERMISSION_DENIED` |
| `990500` | 500 | the 71 among them that change TestRail or start a report: 69 writes and 2 report runs | `UPSTREAM_ERROR` with `http_status` 500 and `write_outcome: "unknown"` (C07) |
| `990001` | The entity, or a list's first item, with every top-level text turned into a number and every number into text | the 40 GET routes that return JSON records. `testrail_get_bdds` rows are open records, so they cannot drift | The data plus a `SCHEMA_DRIFT` warning (C06) |
| `990002` | A JSON string where the entity belongs | all 41 GET routes that return JSON, which leaves out the text of `testrail_get_bdd` and the file of `testrail_get_attachment` | `INVALID_RESPONSE`, no data (C06) |
| `990020` | The reply after 20 seconds | any route with a path ID; the kit's test uses `testrail_get_project` | The driver's 15-second request timeout: `UPSTREAM_ERROR` with `http_status` 408. Four such calls hold every slot until then, so a fifth gets `BUSY` (C10) |
| `990045` | Each reply after 14 seconds, and a paged list of ten pages of any size | any route with a path ID, and its paged lists for `"all"`; the kit's test uses `testrail_get_cases` | A page after 14 seconds. `"all"` passes the 45-second budget on the fourth page: `PAGINATION_LIMIT` with reason `max_duration`, and no partial data (C05, C10) |
| `990900` | A single list page of about 700 KB | the 20 paged lists that take a path ID | A large result within the default budgets, read as a page or with `"all"` (C09) |
| `990901` | A single list page of about 3 MB | the 20 paged lists that take a path ID | Read as a page, `RESPONSE_TOO_LARGE`. With `"all"`, the byte budget stops it first: `PAGINATION_LIMIT` with reason `max_bytes`. Never truncated, and no partial data (C09) |

No stand-in delay reaches the 60-second response wait: the driver's own 15-second request and body timeouts end every stalled request first. `tests/runtime-lifetime.test.ts` holds the wait, and `TIMEOUT`, with a watchdog fired by hand.

`tests/fixture-testrail.test.ts` starts the stand-in as a tester would. It drives the production tool pipeline at it in-process, through its ordinary configuration, with the real driver over real HTTP; only the driver's rate limit is raised for the sweeps.
- Every one of the 133 tools gets its fixture's reply, with no warning: a record, each item of a generated page, and the bytes of a download.
- Each reserved ID produces the outcome above on every route the table gives it, in each of the route's numeric path IDs; the two delay rows run on the one route each names. Each row of the table, its reply, routes and outcome, equals the test's own table, and the stand-in's replies are checked against the reply column: the drift, the JSON string, and the sizes.
- Every paged list spans its pages, and reads the same list whatever its page size.
- The 20-second reply runs in real time. The slow pages run scaled down, with the duration budget scaled the same way; their unscaled delay and page count are held against the driver's request timeout and the 45-second budget.
- The request log holds each request's method, endpoint, status and whether it was abandoned. A log that fails once the stand-in is serving still gets the reply sent, then stops the stand-in.

The client itself is the one thing the kit cannot test.

#### Recording results

Record each surface's results in its file under [`docs/evidence/clients/`](evidence/clients/): Codex desktop, Codex CLI, Claude Code and GitHub Copilot CLI. Every scenario starts `not_run`. `tests/client-kit.test.ts` refuses a record that claims more than it shows:
- A scenario that passed or failed needs its own evidence, and a failure or block needs notes saying why. A scenario not run cites no evidence.
- A record of nothing run states nothing else: every other field stays empty, its limitations and every scenario's notes included.
- Any attempted scenario, a blocked one included, names the test date, the tester, the client version and the OS.
- Once a scenario has passed or failed, the record also names:
  - the client's Node, model and provider;
  - the package version, tarball integrity and driver version;
  - the discovery mode and the provenance.
- A pass names the negotiated protocol. Claude Code also names its `MCP_PROTOCOL_NEGOTIATION=auto` negotiation, or `unsupported` where the installed runtime has none.
- A C01 pass requires the full 133-tool catalog with the hash above.
- Live evidence names the TestRail version.
- Records hold variable names only, the `TESTRAIL_` variables and `MCP_PROTOCOL_NEGOTIATION`, never values. They hold no credential header, email address, local path, variable value or key-like token, and no link that carries a credential. Links, package specs, repository paths and versions are fine.

The status table at the top of this guide must read `Pending` for a surface with no run scenario. Otherwise it must link that surface's record.

Run the following scenarios for each required surface, starting with automatic discovery and its normal built-in tools enabled. Do not force all schemas into context to make a discovery test pass.

| ID | Scenario | Required evidence |
| --- | --- | --- |
| C01 | Cold launch with configured environment | Server connects; full 133-name discovery matches the registry; credentials never appear in output. |
| C02 | Deferred discovery | Every canonical tool name can be found through the client's available discovery mechanism. A smaller initially loaded context is acceptable; dropped or unreachable endpoints are not. |
| C03 | Natural-language selection | One fixed representative task per each of the 28 resource groups selects the intended tool and valid arguments. Include overlapping case/test/result names and uncommon administrative operations. Capture wrong selections and retries. |
| C04 | Basic read and page continuation | Data wrapper, IDs, custom fields, page boundary, and continuation information survive the host rendering. Include one caller-controlled list and one list without manual continuation. |
| C05 | Bounded fetch-all | Success is complete; budget exhaustion is explicit. The call returns within the configured client timeout without turning an incomplete aggregate into success. |
| C06 | Validation and schema drift | Invalid input never invokes the driver. Usable entity drift returns an advisory warning; structurally unusable data returns the specified error. |
| C07 | Mutation outcomes | Creation, update, bulk, close, and delete fixtures use their own schemas and annotations. API rejection and indeterminate writes remain distinguishable. Record any host retry and verify that the adapter does not introduce blind mutation retries. |
| C08 | Attachment round trip | Upload is inside an allowed root. Download path/ID/byte count is accessible and complete; repeated calls create distinct retained files and restart preserves them. Download hints are readOnly false, destructive false and idempotent false, reflecting local file creation. Failed downloads leave no incomplete file. |
| C09 | Large result | Verify the host's actual truncation, preview, or file handling. Full required data, warnings, and continuation can be recovered with the documented setup; missing information is never presented as a complete result. |
| C10 | Timeout and cancellation | Delayed fixtures exercise the 15-second request and 45-second aggregate budgets, including result rejection while DNS/fetch/body cancellation remains pending. Four unsettled scopes keep capacity occupied and further calls return BUSY until the driver settlement signals complete. With 120-second client timeouts, server failures remain intelligible. Cancelling prevents further adapter work where possible and makes no rollback promise. |
| C11 | Restart and warm discovery | No orphan subprocesses or stale catalog persist after reconnect. Test Copilot's snapshot startup followed by live refresh separately from C01. |
| C12 | Host coexistence | Repeat read/discovery with a documented additional MCP server enabled. Catalog collisions and reduced discovery capacity are reported rather than concealed by removing TestRail tools. |

For C03, keep expected operation names and fixture arguments in the test corpus, not in the natural-language prompt. For C02 and C07, fixture-backed execution provides exhaustive coverage without destructive live tests. Live smoke tests use only designated disposable entities and keep their cleanup/reconciliation record; endpoint-specific contract tests remain exhaustive independently of which operations the test instance's permissions or license allow.

Host output limits can differ from the server's byte budgets. When a host truncates a result, document and verify its retrieval path or an explicit client output-budget setting before claiming support for that result size. Do not silently truncate the server response, remove endpoint tools, or weaken structural validation to pass a client test.

### 3. Release evidence and acceptance

Store a sanitized record for each matrix row using this structure:

```text
Client surface and exact version/build:
OS / architecture / Node:
Package version / tarball integrity / driver version:
Model and provider:
Relevant configuration and environment variable names (no secrets):
Automatic discovery mode observed:
Negotiated MCP revision:
Server catalog count and sorted-name hash:
C01-C12 results and evidence links:
Fixture vs live-test provenance / TestRail version:
Known limitations and required client settings:
Test date / tester:
```

The first release requires passing deterministic checks for all 133 endpoints and passing required-client checks with recorded evidence. Host-imposed settings and limitations must be explicit. A blocked or unavailable verification surface is not a pass. Claims apply to the recorded versions and settings; SDK support, a configuration example, or a registered tool count alone is insufficient.

No real credentials, customer data, raw authorization headers, or unredacted request/response dumps belong in committed test artifacts. Fixtures should contain synthetic data. Keep successful attachment paths and file evidence scoped to disposable test directories.
