# Implementation contracts

Status: implementation plan agreed on 2026-09-09. These are requirements for the implementation. They are not claims of passing tests. Product scope is in [architecture](architecture.md). Endpoint assignments are in [the inventory](operation-inventory.json). Execution order is in [the plan](implementation-plan.md).

## Package and driver boundary

Publish `@dichovsky/testrail-mcp` with executable `testrail-mcp`. Use TypeScript, ESM, strict type checking, npm and a committed lockfile. Declare Node `>=24`, the floor that the pinned driver 9.0.0 also declares. Certify Node 24 on Linux, macOS and Windows. Later majors satisfy the engine range but are best effort until certified.

Pin these dependencies exactly:
- `@modelcontextprotocol/server` (initially `2.0.0`, now `2.3.0`);
- the test client, to the matching `@modelcontextprotocol/client` release;
- compatible Zod 4 dependencies.

Use public SDK entry points and public root exports of `@dichovsky/testrail-api-client`. Do not run the driver's CLI, copy its HTTP engine, import private registries, or add direct TestRail fetches.

The qualified driver is exactly `9.0.0`, release commit `a5ccffbfa176e9c6675bd81fff61859bd7b6be5d`, pinned in the package and lockfile. It carries the network-guard fixes, independent report execution and the operation-settlement API below. Its 133 operations and 48 additional helpers match the versioned inventory. Its acceptance checks run as standing tests against the installed artifact.

One deviation is recorded in [driver qualification](driver-qualification.md): the driver still retries a rate-limited report generation. Update provenance and regression evidence with any future dependency change. Do not guess a version number.

`run_report` and `run_cross_project_report` are GET endpoints with side effects. Their public driver methods must bypass both result caching and in-flight GET coalescing, and must not retry a network error or 5xx. The baseline asked for `retry: 'none'` and `bypassCache: true`. 7.2.0 declared `bypassCache: true` with a rate-limit-only retry. 8.0.0 derives the same behavior from the methods' `side-effecting-read` intent, which 9.0.0 keeps. Require upstream tests that prove that separate sequential and concurrent calls execute separately. Require upstream tests that prove that network and 5xx failures are not retried.

A rate-limited (429) response is exempt. TestRail rejects it before it handles the request, so a re-send cannot generate the report twice or send a duplicate template-configured email. A 5xx is not exempt, because the server may already have begun generating.

The MCP adapter continues to call the public report methods. This prerequisite can proceed alongside adapter development, but it blocks report qualification and production release. Report execution can send template-configured email and returns a URL before the file is ready. Describe those effects, and never poll by executing the report again.

Sources:
- [driver report methods at the original baseline](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/reports.ts);
- [8.0.0 report methods](https://github.com/dichovsky/testrail-api-client/blob/7680ab6c0d1973749e3178016a3d133af27bfb0a/src/modules/reports.ts);
- [8.0.0 cache bypass](https://github.com/dichovsky/testrail-api-client/blob/7680ab6c0d1973749e3178016a3d133af27bfb0a/src/client-core.ts) and [retry derivation](https://github.com/dichovsky/testrail-api-client/blob/7680ab6c0d1973749e3178016a3d133af27bfb0a/src/retry-policy.ts);
- [TestRail report API](https://support.testrail.com/hc/en-us/articles/7077825062036-Reports-and-Cross-Project-Reports).

The inspected driver can reject a public method at an internal deadline while DNS, fetch or response-body cleanup is still pending. Observing only that method's promise, or a fetch wrapper that resolves at response headers, cannot prove resource settlement. Require a public per-operation handle from the driver. The proposed API contract is `client.trackOperation(() => client.projects.getAllProjects(...))`, which returns `{ result: Promise<T>, settled: Promise<void> }`. The qualified 7.2.0 driver exports this API. It was not present in 7.0.0.

`result` retains the normal method value/error/deadline semantics. `settled` resolves only after the callback has finished and every started or joined descendant has settled or been conclusively stopped:
- DNS;
- fetch attempts;
- body reads and cancellation completion;
- upload streams;
- retry timers;
- shared/coalesced requests.

A requested abort/cancel alone is not settlement. Late failures are observed and do not produce unhandled rejections. The same handle continues to own any later descendants. The driver owns this accounting, so the adapter does not copy the driver's transport engine.

F01 tests must show these results:
- An aggregate result rejects at its deadline while `settled` remains pending for deferred DNS/fetch/body cancellation.
- Releasing those tasks eventually settles the handle.
- Late DNS must not start a new fetch after the deadline.

F03 tests fill all four invocation slots with such handles and receive deadline errors. They prove that subsequent calls are `BUSY` with no new DNS/fetch work until genuine settlement releases capacity. Include coalesced callers and multipart cleanup. The four-slot limit bounds owned invocation scopes. It is not a claim that each invocation uses only one network primitive. The driver still bounds retries and aggregate pages within a scope.

## Startup configuration

Configuration comes from the launch environment. Do not read `.env` automatically. Do not accept credentials, alternate hosts, proxy routes, or raw URLs in tool arguments. `--help` and `--version` work without credentials and exit before starting stdio. A normal start validates configuration locally, registers every tool, and makes no TestRail request until a tool is called.

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

A missing/invalid required value exits nonzero with a fixed diagnostic that names the configuration key, never its value. File configuration is local filesystem authority, not a read/write operation toggle. Do not infer upload roots or download destinations from the current working directory. Server startup and installers do not edit host approval policies.

## Runtime budgets and lifetime

One process owns one shared TestRail client with these settings:
- `registerProcessHandlers: false`;
- `enableCache: false`;
- 15,000 ms request timeout;
- 15,000 ms body timeout;
- three driver retries;
- a driver rate budget of 100 requests per 60,000 ms.

Ordinary read coalescing may still occur with caching disabled. The server adds no retry layer. Retain the driver's distinction between ordinary GET retries, JSON-write 429 retries, and non-retried multipart uploads. Report execution uses the upstream exception above.

All sizes below are bytes, measured as UTF-8 for JSON/text. MiB means 1,048,576 bytes. Configurable values are positive safe integers and may be adjusted within the listed ceilings. Aggregate overrides are bounded by the configured server maximum, never silently clamped.

| Budget | Default | Startup key / ceiling |
| --- | ---: | --- |
| Active tool executions | 4 | `max_active_calls` / 4 |
| Active binary downloads, within the overall limit | 1 | Fixed |
| Driver JSON/text response body | 10 MiB | `max_json_response_bytes` / 64 MiB |
| Upload or binary download, per file | 100 MiB | `max_file_bytes` / 100 MiB. Map the download bound to `maxBinaryResponseBytes`. |
| Serialized success `data` | 1 MiB | `max_data_bytes` / 8 MiB |
| Serialized complete MCP tool-result object | 2.5 MiB (2,621,440) | `max_result_bytes` / 24 MiB |
| Serialized error tool-result object | 16 KiB | Fixed |
| Aggregate items | 1,000 | `max_all_items` / 10,000 |
| Aggregate pages | 20 | `max_all_pages` / 100 |
| Aggregate driver byte budget | 1 MiB | `max_all_bytes` / 8 MiB, no higher than `max_data_bytes` |
| Aggregate duration | 45,000 ms | `max_all_duration_ms` / 45,000 ms |
| Handler response-wait watchdog | 60,000 ms | Fixed |
| Graceful shutdown drain | 5,000 ms | Fixed |

When capacity is exhausted, reject new calls with `BUSY`. Do not add an unbounded queue. Reserve the download slot before a binary request.

Invoke each public method through the qualified driver's operation handle. Use `result` for response/error and TestRail acknowledgment classification. Retain slots until both `settled` and adapter-owned file work finish. This applies even when an aggregate's own deadline rejects before the adapter watchdog. Neither the public method result nor a watchdog/`Promise.race` rejection may release capacity while descendants continue.

The request timeout includes DNS resolution (from driver 9.0.0, which starts the timeout before the lookup). A lookup cannot be cancelled, so its slot is held until the lookup settles. The body timeout is separate, and retries add time. These settings do not promise a hard 30-second upstream deadline.

The 60-second watchdog bounds the adapter's response wait under normal event-loop operation. It does not abort upstream work. The driver has no public per-request `AbortSignal`.

Before invocation, an aborted call starts no upstream request. After invocation, do these steps:
- Stop adapter-scheduled follow-up work.
- Discard cancelled delivery.
- Observe late completion/rejection.
- Retain capacity and staged-file ownership until actual settlement.
- Record the possibility of an already-applied write.

Driver-internal aggregation may still run until its own budget. Do not claim that cancellation stops it immediately.

On stdin closure, SIGINT or SIGTERM, do these steps:

1. Stop accepting work.
2. Drain for up to five seconds.
3. Clean up owned unfinished local artifacts when safe.
4. Call `destroy()` once.
5. Exit.

Driver destruction does not guarantee abort. Unresolved mutations remain of unknown outcome. Shutdown is not rollback. Successful downloads are never deleted during shutdown. Slow/hung requests can exhaust the four slots until they settle or the process restarts. This limitation must be documented and tested.

## Operation registry and inputs

Keep one reviewed declarative entry for each endpoint. Each entry includes these items:
- the REST method/route/token;
- the exact tool name;
- the family;
- the public driver binding;
- the input schema;
- the explicit argument map;
- the required outer response shape;
- the advisory entity schema;
- the pagination capability;
- the file behavior;
- the TestRail mutation classification;
- the MCP side-effect annotations.

Keep TestRail mutation classification separate from local filesystem effects. Use the same registry to register tools and to generate references and parity checks. Compare the registry with the independent pinned inventory and independent parameter fixtures.

Expose exactly `testrail_<REST operation token>`. Do not create tools for page/all helpers or a generic resource dispatcher. Every tool remains enabled, including administration, bulk writes, close and delete. Inputs follow these rules:

- Path arguments are top-level REST names such as `case_id`, `project_id` and `entry_id`.
- REST filters are in a strict `query` object, using REST spelling. Explicitly map them to driver option names. Do not use a generic snake/camel converter. For repeated wire parameters such as `refs[]`, expose a documented JSON `refs` string/array union and bind the union to the driver's supported serialization. Preserve all supported scalar/list variants, including sentinel values where the endpoint permits them.
- JSON mutation payloads are in `body`, preserving wire field names. Validate exported driver payload schemas at the MCP boundary and supplement missing constraints. Reject unknown ordinary fields. Permit flat `custom_*` fields on payloads that support them, and preserve their JSON values. Do not strip, coerce or move these fields to `custom_fields`. Field-definition maps or other documented open objects have explicit endpoint-specific rules.
- Multipart tools use `file_path` with optional `filename` and `content_type` where accepted by the public driver. Validate `filename` without control characters or path components. Validate `content_type` as a media type (its slash is valid), and reject CR/LF and other control characters. BDD uploads require the multipart filename to end in `.feature`, and they follow the shared file policy.
- Add `_mcp` only to the 24 list tools with page/all helpers. The contract of `_mcp` is below. The server never forwards `_mcp` upstream.

Omitted and explicit `null` are distinct. These items must follow each endpoint's documented domain:
- empty arrays;
- booleans;
- IDs;
- UUID entry IDs;
- numeric/UUID attachment IDs;
- timestamps;
- string/list filters;
- bulk size constraints.

Do not apply a blanket positive-integer rule to every number, because zero/null can mean unassigned or no parent. Path IDs use their actual endpoint constraints. Pure validation failures must occur before driver invocation. Generated JSON Schema must match runtime acceptance and preserve supported custom-field extension points.

Descriptions include effects, required identifiers, pagination limitations and file semantics as applicable, under 2 KiB each. Annotations describe the entire tool, including local effects. Reads without persistent local changes are read-only/idempotent. Mutations are read-only false, with conservative destructive/idempotent hints reviewed individually. Both report generators are read-only false and idempotent false despite GET.

`testrail_get_attachment` uses `readOnlyHint: false`, `destructiveHint: false` and `idempotentHint: false`: each successful call creates a new persistent local file without overwriting existing files. Its TestRail request retains the ordinary GET retry policy. MCP effect hints do not select upstream retry policy. All operations interact with an external TestRail instance (`openWorldHint: true`). Hints do not grant permissions or add confirmation checks.

## Pagination inputs and results

For controlled page mode, accept `query.limit` (default 50, supported maximum 250) and nonnegative `query.offset` (default 0), plus endpoint filters. `_mcp` may be absent or `{ "pagination": "page" }`. Reject aggregate-only fields in page mode. Invoke the public page helper, not the convenience method that discards metadata.

Explicit all mode is `{ "_mcp": { "pagination": "all", "page_size": 50, "start_offset": 0 } }`, with optional lower `max_items`, `max_pages`, `max_bytes` and `max_duration_ms`. A stated bound above its configured limit is `INVALID_ARGUMENT`. Reject `query.limit` and `query.offset` in all mode. Map the controls to the public `getAll*` helper's `pageSize`, `startOffset`, `maxItems`, `maxPages`, `maxBytes` and `maxDurationMs`.

Preserve endpoint filters on every page. All means every remaining match from `start_offset`, which defaults to zero. All mode is not a transactional snapshot.

The six response-driven lists are variables, datasets, shared-step history, roles, groups and case statuses. They accept neither `query.limit/offset` nor `_mcp.page_size/start_offset`. Page mode returns the server-selected first page. All mode accepts only the four safety limits and the operation's supported filters/IDs. Do not synthesize a cursor or expose a driver continuation URL as a caller-controlled request target.

Successful page tools place the driver page's item collection in `data`. `pagination` contains these fields:
- `mode: "page"`;
- `source: "envelope" | "legacy_array"`;
- `returned`;
- `has_more`;
- `manual_continuation`;
- available validated `limit`/`offset`.

Map `kind: "legacy-array"` to `source: "legacy_array"`. Derive `returned` from `items.length`, and keep driver `size` separately. For envelopes, `has_more` is `_links.next !== null`. Set `next_offset` only after validating a controllable continuation, and `next_action: "page" | "all" | "none"`.

A response-driven nonterminal page uses `manual_continuation: false`, and `next_action: "all"` when its continuation validates. A nonterminal page of either kind whose continuation fails validation uses `manual_continuation: false` and `next_action: "none"`. The reason is that the driver's aggregate refuses the same link. A terminal legacy array has `source: "legacy_array"`, `has_more: false` and `next_action: "none"`. These values describe the observed response and are not independent proof of the upstream dataset's completeness.

Preserve any other driver page metadata under `pagination.driver`, including returned links. These links are data, never fetch authority.

The public page type supplies `_links`, not parsed continuation controls. Implement a small metadata-only parser in the MCP pagination adapter. Use URL/URLSearchParams to collect offset/limit from both conventional query links and TestRail path-style `&limit=...&offset=...` links. Apply these rules:
- Require exactly one canonical nonnegative safe-integer offset.
- Require at most one canonical positive limit no greater than 250.
- Reject duplicates across both forms.
- Require an advancing, non-overlapping offset (`next > current` and `next - current >= items.length`).

Expose validated controls only. Discard host/path as request authority, and retain original caller filters. Do not import the driver's unexported parser or implement a fetch loop. The public driver all helper still owns aggregation.

Successful aggregation uses `pagination: { "mode": "all", "returned": N, "complete": true, "start_offset": 0 }` (use the actual effective `start_offset`, not always zero; omit it on response-driven lists). Emit pages-fetched or byte counts only if the public driver exposes them. The final aggregate must also meet the data/result budgets.

A driver safety stop returns `PAGINATION_LIMIT` with allowlisted reason and available numeric progress counts, and with no partial `data`. Map only driver `max_pages`, `max_items`, `max_bytes` and `max_duration` reasons to `PAGINATION_LIMIT`. Map `invalid_page`, `invalid_continuation` and `non_progress` to `INVALID_RESPONSE`. Lists without helper support have no invented `_mcp` options and retain their supported one-response shape.

## Results, drift and errors

Successful tools return a stable wrapper with required `data` and optional `pagination`/`warnings`. `data` preserves the value returned by the driver, except documented page projection and binary-download metadata. For resolved void methods use `data: null`. Singular `get_bdd` returns raw text in `data`, including a valid empty string. Plural `get_bdds` returns JSON entries. Retain any preview/summary payload a driver method actually returns instead of dropping it based on its verb.

Return the wrapper as MCP `structuredContent` and one text content block containing exactly `JSON.stringify(wrapper)` for older consumers. Measure both the serialized `data` and the **complete** tool-result object after duplication and escaping. Do not assume a 1 MiB data value always fits the result limit. Reject oversized responses instead of silently truncating text, fields or collections. An oversized read can be retried with smaller pages/filters or adjusted startup limits. An oversized mutation response must report the outcome below so the model does not repeat a successful write to retrieve output.

Strictly validate required outer structures:
- record vs array vs text;
- page/envelope metadata;
- required collection keys.

Advisory entity validation is separate. Validate the value for **each caller** against that operation's entity schema without using the parsed/transformed result. Return the original value on usable field-level drift with `warnings: [{ "code": "SCHEMA_DRIFT", "count": N }]`, using a bounded positive issue count. Include at most ten warning entries. Warning codes come from a fixed registry. Do not include raw values, arbitrary response field names or arbitrary Zod paths.

A shared `onSchemaMismatch` hook plus async context is insufficient, because coalesced GET joiners do not necessarily trigger the hook. Two concurrent callers must each receive their own correct warnings. Optional hook diagnostics must be nonthrowing and supplementary.

Output schemas strictly describe wrapper/outer variants while allowing arbitrary JSON entity fields. They must not reintroduce strict entity validation and turn advisory drift into a transport failure. Tool errors use `isError: true` and the same structured/text representation of `{ "error": { "code": "...", "message": "..." } }`. They carry these allowlisted optional fields:
- `http_status`;
- `retry_after_ms`;
- pagination `reason`/numeric progress;
- mutation `write_outcome`.

Verify SDK behavior for error results separately from success output-schema validation.

| Code | Meaning / behavior |
| --- | --- |
| `INVALID_ARGUMENT` | Runtime input validation failed. |
| `FILE_ACCESS_DENIED`, `FILE_TOO_LARGE` | A configured local boundary or file limit failed. |
| `BUSY` | No execution/download capacity. No new driver invocation. |
| `AUTHENTICATION_FAILED`, `PERMISSION_DENIED`, `LICENSE_REQUIRED` | Proven auth/permission/license classification. Keep license subclass precedence. |
| `NOT_FOUND` | A returned missing-resource status. Do not guess that the status proves an unsupported TestRail version. |
| `RATE_LIMITED` | Driver or upstream rate limit. Include only validated retry metadata when supplied. |
| `PAGINATION_LIMIT` | Aggregate safety bound reached. Handle pagination errors before generic validation errors. |
| `INVALID_RESPONSE` | Required outer structure or JSON response unusable. |
| `RESPONSE_TOO_LARGE` | Adapter data/result budget exceeded. |
| `TIMEOUT`, `CANCELLED` | Response wait expired or cancellation observed. Downstream work may still be running. Cancellation notification need not receive a tool response when the protocol suppresses it. |
| `UPSTREAM_ERROR`, `INTERNAL_ERROR` | Remaining upstream and adapter failures, respectively. |

Use fixed safe messages and metadata derived from explicit typed fields or adapter state. Do not forward raw driver `message`, `statusText`, response, error details, credentials or stack traces. Unrecognized status-zero errors are not automatically transport failures. Malformed success JSON can also cause them. Error envelopes remain within 16 KiB.

For every operation that mutates TestRail or initiates report generation, attach `write_outcome` to tool errors. Do not derive this classification solely from MCP `readOnlyHint`. Attachment downloads have local file effects but do not mutate TestRail, so their errors do not receive a TestRail `write_outcome`.

- `not_started`: the adapter can prove driver invocation never occurred (input/file validation, capacity rejection, pre-invocation cancellation).
- `unknown`: driver invocation began and rejected/timed out/cancelled without a usable acknowledgment. Conservatively retain this value for ambiguous HTTP/status/parse failures. Do not infer no change from a failed response.
- `acknowledged`: the public driver resolved, then adapter structural validation, file/result processing or serialization failed. This records acknowledgment, not atomic success of every item in a bulk operation.

Do not include an automatic retry instruction for an unknown or acknowledged write. Bulk calls invoke the driver's supported bulk method once and preserve its item-level result/summary. Do not split requests or invent transactions, rollback, deduplication or idempotency guarantees.

Diagnostics go to stderr and contain only these items:
- fixed event codes;
- tool names;
- a generated correlation ID;
- durations;
- safe counts;
- outcome classes.

Never log input bodies, response bodies, configured secrets or local paths. Tool results intentionally contain requested TestRail data and file paths. Redact diagnostics without corrupting those results.

## Shared local file layer

Apply this layer to every attachment upload/download and to BDD add/update uploads. Do these steps:

1. Resolve the requested absolute source and allowed roots.
2. Check containment by path components.
3. Reject escapes/symlink targets outside a root.
4. Require a regular file.
5. Enforce the byte limit while copying, not only by initial stat.

Open and inspect the actual file handle. Use no-follow options where available, and recheck path/identity as supported. Do not claim isolation from a malicious process running as the same OS user.

Copy the validated source through an owned handle into an exclusively created file. Put that file in a private staging directory with restrictive permissions. This bounded staging copy decouples upload bytes from subsequent source-path replacement. Close adapter-owned source handles exactly once.

Give the driver a staged `{ path: ... }` upload input, with the approved filename/content type where applicable. Retain the staged file until the operation handle's `settled` signal completes, even if `result` already rejected. Do not pass an adapter-owned descriptor to the driver. Early DNS failures and platform fallback behavior make descriptor ownership difficult to guarantee.

Clean up staging in these cases:
- success;
- failure;
- cancellation after settlement;
- startup recovery for this server's safely identified abandoned staging files.

Recovery requires a server-owned marker, unique process directory and owner-PID metadata. Delete only artifacts whose recorded owner is definitely absent. Treat permission errors, uncertain ownership and a reused/live PID as live. This accepts a possible orphan. Recovery never inspects or removes completed download files.

The driver buffers downloads within `max_file_bytes`. Do these steps in order:

1. Generate a unique filename (for example a random UUID plus `.bin`) in the configured real directory.
2. Create the file exclusively.
3. Write the file completely.
4. Close the file.
5. Only then return `data: { "attachment_id": <original validated ID>, "file_path": <absolute path>, "bytes": N }`.

Verify containment at creation. Never accept a caller download destination or overwrite an existing file. Remove incomplete output on write/close failure. Once committed, keep the file even if delivery fails. Diagnostic events may record its count but not its path.

Completed files persist across process exit and restart until user removal. Do not invent an original name/MIME type, because the driver returns only bytes. Binary contents never appear as inline base64. Repeating a download creates another distinct retained file. Descriptions and annotations must disclose this local additive effect.

Tests cover these topics:
- resolved-root traversal;
- symlink escape;
- non-regular files;
- source replacement after staging;
- oversized/growing files;
- early driver rejection;
- concurrent name collisions;
- failed writes/close;
- cancellation with pending driver work;
- no descriptor leaks;
- Windows staging;
- persistence after restart.

File tests use disposable directories and never the user's configured TestRail paths.

## Protocol and release evidence

Use `serveStdio(factory)` with default legacy compatibility. Test legacy initialization and modern MCP 2026-07-28 discovery independently. Keep these properties:
- stdout is protocol-only;
- discovery is deterministic and complete;
- unknown tools/malformed protocol messages are protocol errors;
- domain failures are tool errors.

Do not register fabricated MCP resources/prompts just to mirror endpoint tools.

The implementation gate compares exact method+route+tool+driver bindings against all 133 inventory entries, plus a reviewed per-endpoint parameter manifest. Independent fixtures must exercise every supported path/query/body/file parameter and important valid unions, not merely count tools or regenerate expected values from the same registry. Invoke the actual driver with injected `fetch`/DNS in offline contract tests. Production configuration cannot inject them.

Pack and install the candidate in isolation. Run these items:
- the OS/runtime matrix;
- protocol tests;
- full catalog/schema-size checks;
- cancellation/error/output/file tests;
- all endpoint contract cases.

Run required-host scenarios in [client compatibility](client-compatibility.md), including every resource family, deferred discovery and large outputs. Record actual client versions/models and protocol revisions.

Live TestRail 10.8.1 qualification uses a dedicated disposable project, on an instance with as many of the licensed features and permission profiles as are available. Record unavailable features as unverified. Endpoint fixture coverage is not proof that a live feature passed. Final qualification cannot claim full baseline live verification while required feature tests remain unverified. By the owner's decision of 2026-10-03, recorded in [R03](issues/R03.md), such tools are documented limitations of the release, listed in its release notes, rather than blockers.

Sources and inspected revisions are recorded in [research notes](research-notes.md) and [inventory provenance](operation-inventory.json). Any newly discovered driver gap becomes an explicit upstream/release dependency, never a silently missing tool or private HTTP workaround.
