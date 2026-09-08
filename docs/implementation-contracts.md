# Implementation contracts

Status: implementation plan agreed on 2026-09-09. These are requirements for the implementation; they are not claims of passing tests. Product scope is in [architecture](architecture.md), endpoint assignments in [the inventory](operation-inventory.json), and execution order in [the plan](implementation-plan.md).

## Package and driver boundary

Publish `@dichovsky/testrail-mcp` with executable `testrail-mcp`. Use TypeScript, ESM, strict type checking, npm and a committed lockfile. Declare Node `^22.13.0 || >=24`; certify Node 22 and 24 on Linux, macOS and Windows. Later Node majors satisfy the engine range but are best effort until certified.

Pin `@modelcontextprotocol/server` to `2.0.0` initially, the test client to `@modelcontextprotocol/client@2.0.0`, and compatible Zod 4 dependencies exactly. Use public SDK entry points and public root exports of `@dichovsky/testrail-api-client`. No shelling out to its CLI, copying its HTTP engine, importing private registries, or adding direct TestRail fetches.

The verified development driver baseline is exactly `7.0.0`, release commit `71a80d984aea14713d8eeaf6ac9a0d41c1fba12b`. Its 133 operations and 48 additional helpers match the inspected main inventory at `89f636e276ea701412bb06039e3b963d83126ea1`. Its runtime does **not** include that main revision's network-guard fixes. Before a production release, qualify and pin an exact published driver release that includes those fixes and the report-execution change below. Update the lockfile, provenance and regression evidence together; do not guess a future version number.

`run_report` and `run_cross_project_report` are GET endpoints with side effects. Their public driver methods must use `retry: 'none'` and `bypassCache: true`, which must bypass both result caching and in-flight GET coalescing. Require upstream tests proving separate sequential and concurrent calls execute separately and network/429/5xx failures are not retried. The MCP adapter continues to call the public report methods. This prerequisite can proceed alongside adapter development, but blocks report qualification and production release. Report execution can send template-configured email and returns a URL before the file is ready; describe those effects and never poll by executing the report again. Sources: [driver report methods](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/reports.ts), [TestRail report API](https://support.testrail.com/hc/en-us/articles/7077825062036-Reports-and-Cross-Project-Reports).

## Startup configuration

Configuration comes from the launch environment. Do not read `.env` automatically or accept credentials, alternate hosts, proxy routes, or raw URLs in tool arguments. `--help` and `--version` work without credentials and exit before starting stdio. A normal start validates configuration locally, registers every tool, and makes no TestRail request until a tool is called.

| Variable | Contract |
| --- | --- |
| `TESTRAIL_BASE_URL` | Required instance URL; retain supported installation subpaths. Reject embedded credentials, query strings and fragments. Use the driver's URL validation and network guards. |
| `TESTRAIL_EMAIL` | Required nonempty configured user identity. |
| `TESTRAIL_API_KEY` | Required nonempty secret; never print or put it into command arguments. |
| `TESTRAIL_MCP_UPLOAD_ROOTS` | Required JSON array of absolute, existing directories. An empty array grants no file-read roots; tools remain registered and enabled. Resolve roots at startup. |
| `TESTRAIL_MCP_DOWNLOAD_DIR` | Required absolute, existing writable directory; resolve at startup. Completed downloads persist here. |
| `TESTRAIL_ALLOW_PRIVATE_HOSTS` | Optional literal `true` or `false`, default `false`; map to driver `allowPrivateHosts` for a private-network instance. |
| `TESTRAIL_ALLOW_INSECURE` | Optional literal `true` or `false`, default `false`; map to driver `allowInsecure`. HTTPS remains the default. |
| `TESTRAIL_MCP_LIMITS` | Optional strict JSON object with the configurable keys and ranges below. Unknown keys and invalid/fractional/nonfinite values fail startup. |

A missing/invalid required value exits nonzero with a fixed diagnostic naming the configuration key, never its value. File configuration is local filesystem authority, not a read/write operation toggle. Do not infer upload roots or download destinations from the current working directory. Server startup and installers do not edit host approval policies.

## Runtime budgets and lifetime

One process owns one shared TestRail client with `registerProcessHandlers: false`, `enableCache: false`, 15,000 ms request timeout, 15,000 ms body timeout, three driver retries, and a driver rate budget of 100 requests per 60,000 ms. Ordinary read coalescing may still occur with caching disabled. The server adds no retry layer. Retain the driver's distinction between ordinary GET retries, JSON-write 429 retries, and non-retried multipart uploads; report execution uses the upstream exception above.

All sizes below are bytes, measured as UTF-8 for JSON/text. MiB means 1,048,576 bytes. Configurable values are positive safe integers and may be adjusted within the listed ceilings. Aggregate overrides are bounded by the configured server maximum, never silently clamped.

| Budget | Default | Startup key / ceiling |
| --- | ---: | --- |
| Active tool executions | 4 | `max_active_calls` / 4 |
| Active binary downloads, within the overall limit | 1 | Fixed |
| Driver JSON/text response body | 10 MiB | `max_json_response_bytes` / 64 MiB |
| Upload or binary download, per file | 100 MiB | `max_file_bytes` / 100 MiB; map download bound to `maxBinaryResponseBytes` |
| Serialized success `data` | 1 MiB | `max_data_bytes` / 8 MiB |
| Serialized complete MCP tool-result object | 2.5 MiB (2,621,440) | `max_result_bytes` / 24 MiB |
| Serialized error tool-result object | 16 KiB | Fixed |
| Aggregate items | 1,000 | `max_all_items` / 10,000 |
| Aggregate pages | 20 | `max_all_pages` / 100 |
| Aggregate driver byte budget | 1 MiB | `max_all_bytes` / 8 MiB, no higher than `max_data_bytes` |
| Aggregate duration | 45,000 ms | `max_all_duration_ms` / 45,000 ms |
| Handler response-wait watchdog | 60,000 ms | Fixed |
| Graceful shutdown drain | 5,000 ms | Fixed |

Reject new calls with `BUSY` when capacity is exhausted; no unbounded queue. Reserve the download slot before a binary request. Release slots only when the underlying driver/file work actually settles, including after cancellation or a handler timeout. A watchdog or `Promise.race` must not release capacity while the request continues.

The request timeout starts after DNS resolution, body timeout is separate, and retries add time. These settings do not promise a hard 30-second upstream deadline. The 60-second watchdog bounds the adapter's response wait under normal event-loop operation; it does not abort upstream work. The driver has no public per-request `AbortSignal`. Before invocation, an aborted call starts no upstream request. After invocation, stop adapter-scheduled follow-up work and discard cancelled delivery, observe late completion/rejection, retain capacity and staged-file ownership until actual settlement, and record the possibility of an already-applied write. Driver-internal aggregation may still run until its own budget; do not claim cancellation stops it immediately.

On stdin closure, SIGINT or SIGTERM, stop accepting work, drain for up to five seconds, clean up owned unfinished local artifacts when safe, call `destroy()` once, and exit. Driver destruction does not guarantee abort. Unresolved mutations remain of unknown outcome; shutdown is not rollback. Successful downloads are never deleted during shutdown. Slow/hung requests can exhaust the four slots until they settle or the process restarts; this limitation must be documented and tested.

## Operation registry and inputs

Keep one reviewed declarative entry per endpoint. Each entry includes the REST method/route/token, exact tool name, family, public driver binding, input schema, explicit argument map, required outer response shape, advisory entity schema, pagination capability, file behavior and side-effect annotations. Use the same registry to register tools and generate references and parity checks, but compare it with the independent pinned inventory and independent parameter fixtures.

Expose exactly `testrail_<REST operation token>`. Do not create tools for page/all helpers or a generic resource dispatcher. Every tool remains enabled, including administration, bulk writes, close and delete. Inputs follow these rules:

- Path arguments are top-level REST names such as `case_id`, `project_id` and `entry_id`.
- REST filters are in a strict `query` object, using REST spelling. Explicitly map them to driver option names; do not use a generic snake/camel converter. For repeated wire parameters such as `refs[]`, expose a documented JSON `refs` string/array union and bind it to the driver's supported serialization. Preserve all supported scalar/list variants, including sentinel values where the endpoint permits them.
- JSON mutation payloads are in `body`, preserving wire field names. Validate exported driver payload schemas at the MCP boundary and supplement missing constraints. Reject unknown ordinary fields; permit flat `custom_*` fields on payloads that support them and preserve their JSON values. Do not strip, coerce or move them to `custom_fields`. Field-definition maps or other documented open objects have explicit endpoint-specific rules.
- Multipart tools use `file_path` with optional `filename` and `content_type` where accepted by the public driver. Validate `filename` without control characters or path components; validate `content_type` as a media type (its slash is valid), rejecting CR/LF and other control characters. BDD uploads require the multipart filename to end in `.feature` and follow the shared file policy.
- Add `_mcp` only to the 24 list tools with page/all helpers. Its contract is below. It is never forwarded upstream.

Omitted and explicit `null` are distinct. Empty arrays, booleans, IDs, UUID entry IDs, numeric/UUID attachment IDs, timestamps, string/list filters and bulk size constraints must follow each endpoint's documented domain. Do not apply a blanket positive-integer rule to every number: zero/null can mean unassigned or no parent. Path IDs use their actual endpoint constraints. Pure validation failures must occur before driver invocation. Generated JSON Schema must match runtime acceptance and preserve supported custom-field extension points.

Descriptions include effects, required identifiers, pagination limitations and file semantics as applicable, under 2 KiB each. Annotations are explicit: ordinary reads are read-only/idempotent; mutations are read-only false, with conservative destructive/idempotent hints reviewed individually. Both report generators are read-only false and idempotent false despite GET. All operations interact with an external TestRail instance (`openWorldHint: true`). Hints do not grant permissions or add confirmation checks.

## Pagination inputs and results

For controlled page mode, accept `query.limit` (default 50, supported maximum 250) and nonnegative `query.offset` (default 0), plus endpoint filters. `_mcp` may be absent or `{ "pagination": "page" }`. Reject aggregate-only fields in page mode. Invoke the public page helper, not the convenience method that discards metadata.

Explicit all mode is `{ "_mcp": { "pagination": "all", "page_size": 50, "start_offset": 0 } }`, with optional lower `max_items`, `max_pages`, `max_bytes`, `max_duration_ms`. Reject `query.limit` and `query.offset` in all mode. Map the controls to the public `getAll*` helper's `pageSize`, `startOffset`, `maxItems`, `maxPages`, `maxBytes`, `maxDurationMs`; preserve endpoint filters on every page. All means every remaining match from `start_offset`, which defaults to zero, not a transactional snapshot.

The six response-driven lists are variables, datasets, shared-step history, roles, groups and case statuses. They accept neither `query.limit/offset` nor `_mcp.page_size/start_offset`. Page mode returns the server-selected first page. All mode accepts only the four safety limits and the operation's supported filters/IDs. Do not synthesize a cursor or expose a driver continuation URL as a caller-controlled request target.

Successful page tools place the driver page's item collection in `data`. `pagination` contains `mode: "page"`, `source: "envelope" | "legacy_array"`, `returned`, `has_more`, `manual_continuation`, and available validated `limit`/`offset`. Map `kind: "legacy-array"` to `source: "legacy_array"`; derive `returned` from `items.length` and keep driver `size` separately. For envelopes, `has_more` is `_links.next !== null`. Set `next_offset` only after validating a controllable continuation, and `next_action: "page" | "all" | "none"`. A response-driven nonterminal page uses `manual_continuation: false` and `next_action: "all"`. A terminal legacy array has `source: "legacy_array"`, `has_more: false`, `next_action: "none"`; this describes the observed response and is not independent proof of the upstream dataset's completeness. Preserve any other driver page metadata under `pagination.driver`, including returned links; these are data, never fetch authority.

The public page type supplies `_links`, not parsed continuation controls. Implement a small metadata-only parser in the MCP pagination adapter: use URL/URLSearchParams to collect offset/limit from both conventional query links and TestRail path-style `&limit=...&offset=...` links. Require exactly one canonical nonnegative safe-integer offset, at most one canonical positive limit no greater than 250, reject duplicates across both forms, and require an advancing, non-overlapping offset (`next > current` and `next - current >= items.length`). Expose validated controls only; discard host/path as request authority and retain original caller filters. Do not import the driver's unexported parser or implement a fetch loop. The public driver all helper still owns aggregation.

Successful aggregation uses `pagination: { "mode": "all", "returned": N, "complete": true, "start_offset": 0 }` (use the actual effective `start_offset`, not always zero; omit it on response-driven lists). Emit pages-fetched or byte counts only if the public driver exposes them. The final aggregate must also meet the data/result budgets. A driver safety stop returns `PAGINATION_LIMIT` with allowlisted reason and available numeric progress counts, no partial `data`. Map only driver `max_pages`, `max_items`, `max_bytes` and `max_duration` reasons to `PAGINATION_LIMIT`; map `invalid_page`, `invalid_continuation` and `non_progress` to `INVALID_RESPONSE`. Lists without helper support have no invented `_mcp` options and retain their supported one-response shape.

## Results, drift and errors

Successful tools return a stable wrapper with required `data` and optional `pagination`/`warnings`. `data` preserves the value returned by the driver, except documented page projection and binary-download metadata. For resolved void methods use `data: null`. Singular `get_bdd` returns raw text in `data`, including a valid empty string; plural `get_bdds` returns JSON entries. Retain any preview/summary payload a driver method actually returns instead of dropping it based on its verb.

Return the wrapper as MCP `structuredContent` and one text content block containing exactly `JSON.stringify(wrapper)` for older consumers. Measure both the serialized `data` and the **complete** tool-result object after duplication and escaping. Do not assume a 1 MiB data value always fits the result limit. Reject oversized responses instead of silently truncating text, fields or collections. An oversized read can be retried with smaller pages/filters or adjusted startup limits. An oversized mutation response must report the outcome below so the model does not repeat a successful write to retrieve output.

Strictly validate required outer structures: record vs array vs text, page/envelope metadata, and required collection keys. Advisory entity validation is separate. Validate the value for **each caller** against that operation's entity schema without using the parsed/transformed result. Return the original value on usable field-level drift with `warnings: [{ "code": "SCHEMA_DRIFT", "count": N }]`, using a bounded positive issue count. At most ten warning entries; warning codes are from a fixed registry. Do not include raw values, arbitrary response field names or arbitrary Zod paths. A shared `onSchemaMismatch` hook plus async context is insufficient because coalesced GET joiners do not necessarily trigger the hook; two concurrent callers must each receive their own correct warnings. Optional hook diagnostics must be nonthrowing and supplementary.

Output schemas strictly describe wrapper/outer variants while allowing arbitrary JSON entity fields; they must not reintroduce strict entity validation and turn advisory drift into a transport failure. Tool errors use `isError: true` and the same structured/text representation of `{ "error": { "code": "...", "message": "..." } }`, with allowlisted optional `http_status`, `retry_after_ms`, pagination `reason`/numeric progress, and mutation `write_outcome`. Verify SDK behavior for error results separately from success output-schema validation.

| Code | Meaning / behavior |
| --- | --- |
| `INVALID_ARGUMENT` | Runtime input validation failed. |
| `FILE_ACCESS_DENIED`, `FILE_TOO_LARGE` | A configured local boundary or file limit failed. |
| `BUSY` | No execution/download capacity; no new driver invocation. |
| `AUTHENTICATION_FAILED`, `PERMISSION_DENIED`, `LICENSE_REQUIRED` | Proven auth/permission/license classification; keep license subclass precedence. |
| `NOT_FOUND` | A returned missing-resource status; do not guess that it proves an unsupported TestRail version. |
| `RATE_LIMITED` | Driver or upstream rate limit; include only validated retry metadata when supplied. |
| `PAGINATION_LIMIT` | Aggregate safety bound reached; handle pagination errors before generic validation errors. |
| `INVALID_RESPONSE` | Required outer structure or JSON response unusable. |
| `RESPONSE_TOO_LARGE` | Adapter data/result budget exceeded. |
| `TIMEOUT`, `CANCELLED` | Response wait expired or cancellation observed; downstream work may still be running. Cancellation notification need not receive a tool response when the protocol suppresses it. |
| `UPSTREAM_ERROR`, `INTERNAL_ERROR` | Remaining upstream and adapter failures, respectively. |

Use fixed safe messages and metadata derived from explicit typed fields or adapter state. Do not forward raw driver `message`, `statusText`, response, error details, credentials or stack traces. Unrecognized status-zero errors are not automatically transport failures; malformed success JSON can also cause them. Error envelopes remain within 16 KiB.

For every operation with effects, including report generation, attach `write_outcome` to tool errors:

- `not_started`: the adapter can prove driver invocation never occurred (input/file validation, capacity rejection, pre-invocation cancellation).
- `unknown`: driver invocation began and rejected/timed out/cancelled without a usable acknowledgment. Conservatively retain this for ambiguous HTTP/status/parse failures; do not infer no change from a failed response.
- `acknowledged`: the public driver resolved, then adapter structural validation, file/result processing or serialization failed. This records acknowledgment, not atomic success of every item in a bulk operation.

No automatic retry instruction for an unknown or acknowledged write. Bulk calls invoke the driver's supported bulk method once and preserve its item-level result/summary. Do not split requests or invent transactions, rollback, deduplication or idempotency guarantees.

Diagnostics go to stderr and contain only fixed event codes, tool names, a generated correlation ID, durations, safe counts and outcome classes. Never log input bodies, response bodies, configured secrets or local paths. Tool results intentionally contain requested TestRail data and file paths; redact diagnostics without corrupting those results.

## Shared local file layer

Apply this layer to every attachment upload/download and to BDD add/update uploads. Resolve the requested absolute source and allowed roots, check containment by path components, reject escapes/symlink targets outside a root, require a regular file, and enforce the byte limit while copying, not only by initial stat. Open and inspect the actual file handle; use no-follow options where available and recheck path/identity as supported. Do not claim isolation from a malicious process running as the same OS user.

Copy the validated source through an owned handle into an exclusively created file in a private staging directory with restrictive permissions. This bounded staging copy decouples upload bytes from subsequent source-path replacement. Close adapter-owned source handles exactly once. Give the driver a staged `{ path: ... }` upload input, with the approved filename/content type where applicable, and retain the staged file until the actual driver promise settles. Do not pass an adapter-owned descriptor to the driver: early DNS failures and platform fallback behavior make descriptor ownership difficult to guarantee. Clean up staging on success, failure, cancellation after settlement, and startup recovery for this server's safely identified abandoned staging files. Recovery requires a server-owned marker, unique process directory and owner-PID metadata; delete only artifacts whose recorded owner is definitely absent. Treat permission errors, uncertain ownership and a reused/live PID as live, accepting a possible orphan. Recovery never inspects or removes completed download files.

Downloads are buffered by the driver within `max_file_bytes`. Generate a unique filename (for example a random UUID plus `.bin`) in the configured real directory, create exclusively, write completely, close, and only then return `data: { "attachment_id": <original validated ID>, "file_path": <absolute path>, "bytes": N }`. Verify containment at creation; never accept a caller download destination or overwrite an existing file. Remove incomplete output on write/close failure. Once committed, keep the file even if delivery fails; diagnostic events may record its count but not its path. Completed files persist across process exit and restart until user removal. Do not invent an original name/MIME type; the driver returns only bytes. Binary contents never appear as inline base64.

Tests cover resolved-root traversal, symlink escape, non-regular files, source replacement after staging, oversized/growing files, early driver rejection, concurrent name collisions, failed writes/close, cancellation with pending driver work, no descriptor leaks, Windows staging and persistence after restart. File tests use disposable directories and never the user's configured TestRail paths.

## Protocol and release evidence

Use `serveStdio(factory)` with default legacy compatibility. Test legacy initialization and modern MCP 2026-07-28 discovery independently. Keep stdout protocol-only, discovery deterministic and complete, unknown tools/malformed protocol messages as protocol errors, and domain failures as tool errors. Do not register fabricated MCP resources/prompts just to mirror endpoint tools.

The implementation gate compares exact method+route+tool+driver bindings against all 133 inventory entries, plus a reviewed per-endpoint parameter manifest. Independent fixtures must exercise every supported path/query/body/file parameter and important valid unions, not merely count tools or regenerate expected values from the same registry. Invoke the actual driver with injected `fetch`/DNS in offline contract tests; production configuration cannot inject them.

Pack and install the candidate in isolation. Run the OS/runtime matrix, protocol tests, full catalog/schema-size checks, cancellation/error/output/file tests and all endpoint contract cases. Run required-host scenarios in [client compatibility](client-compatibility.md), including every resource family, deferred discovery and large outputs. Record actual client versions/models and protocol revisions. Live TestRail 10.7.0 qualification uses a dedicated disposable instance/project with required licensed features and permission profiles. Record unavailable features as unverified; endpoint fixture coverage is not proof that a live feature passed. Final qualification cannot claim full baseline live verification while required feature tests remain unverified.

Sources and inspected revisions are recorded in [research notes](research-notes.md) and [inventory provenance](operation-inventory.json). Any newly discovered driver gap becomes an explicit upstream/release dependency, never a silently missing tool or private HTTP workaround.
