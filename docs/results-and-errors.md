# Results, warnings and errors

`src/contracts/results.ts`, `drift.ts` and `errors.ts` implement F05's success wrapper, advisory drift warnings and error taxonomy. The process executor in `src/execution/executor.ts` applies them to each ordinary call or Attachment transfer. It records dispatch and acknowledgment before it interprets replies. F06 builds the pagination metadata. Tool registration, negotiated result fields and the defensive handler-failure guard belong to F08.

## Preserved data

The wrapper is `{ data, pagination?, warnings? }`. `data` is the value that the driver returned, unchanged. Unknown fields, flat `custom_*` properties and future TestRail additions all survive, because renaming or relocating them would lose information that the caller asked for. A resolved void method carries `data: null` rather than omitting the key. Raw text results stay text, including a valid empty string. The wrapper omits an optional key entirely when the key is empty, rather than emitting `null` or `[]`.

The server returns the same wrapper as MCP `structuredContent` and as one text block that contains exactly `JSON.stringify(wrapper)`. Thus, an older consumer reads the same bytes that a structured consumer does.

## Two budgets, not one

Both the serialized `data` and the **complete** tool-result object are measured, because they are different quantities. The text block duplicates the payload and escapes it, so everything counts twice. Escapes add more. Each time the server escapes a quote, a backslash or a newline, the text grows by one byte. Another control character or a lone surrogate grows by up to five bytes. A `data` value comfortably inside its own budget can still overflow the result budget.

Well-formed non-ASCII text is not escaped. Such text is simply larger in UTF-8. The tests exercise quotes, backslashes and non-ASCII text. The server counts bytes as UTF-8, not UTF-16 code units, so an emoji costs four rather than two. The defaults are 1 MiB for `data` and 2.5 MiB for the complete result, each accepted up to and including its limit.

The complete-result budget includes every field inside the JSON-RPC response's `result`:
- `content`;
- `structuredContent`;
- `isError`, when present;
- the negotiated protocol's fields.

MCP 2026-07-28 adds `resultType: "complete"` and `_meta["io.modelcontextprotocol/serverInfo"]`. The server supplies them before measuring, using its actual registered name and package version, and the SDK preserves them. Legacy responses include neither. The surrounding JSON-RPC `jsonrpc`, `id` and `result` envelope and the stdio newline are excluded. Transport tests capture the encoded result before the client removes wire fields. They accept the exact limit and refuse one byte less, for both protocol eras and for reads and acknowledged writes.

An error envelope has a fixed budget of 16 KiB. The server measures it the same way on the complete result, text block and protocol fields included. Past that budget, the server drops the optional error metadata before it drops the code, message and write outcome. An envelope that is still over the budget without its optional error metadata is an internal fault rather than a truncated message.

Overflow is reported, never silently truncated. A caller can narrow a read with smaller pages or tighter filters. The server must never tell a caller whose write already succeeded to repeat it merely to retrieve the output.

## Strict outer, advisory entity

The server validates outer structure strictly. A record that is not a record, or a collection missing required keys, is `INVALID_RESPONSE`. The server validates entity fields separately and advisorily. Drift inside a usable structure returns the original value with `warnings: [{ code: "SCHEMA_DRIFT", count: N }]`. A field that TestRail adds or retypes is not an outage.

A soft-delete preview is the one reply whose meaning depends on the input. `delete_case`, `delete_cases`, `delete_section`, `delete_suite` and `delete_run` delete when a caller calls them plainly. With `query.soft: true`, they ask TestRail what the delete would remove. After a delete the result is `data: null`, and the server checks nothing. After a preview the server returns the counts as sent. It checks them advisorily against the driver's own preview schema, so a count that arrives as a string is reported as `SCHEMA_DRIFT`.

Some preview replies carry none of the seven affected-entity counts with a value: an empty body, `{}`, only unknown keys, or only `null` counts. Such a reply is not reported as a preview of nothing. A TestRail that ignores the flag deletes and answers just the same. Such a reply is `INVALID_RESPONSE` with `write_outcome: "unknown"`, after exactly one request. Thus, the caller learns that the rows may be gone rather than that none would be affected. The tools stay annotated as destructive, because the caller chooses a preview for each call and the annotation describes the tool.

The server deliberately discards the parsed output. A schema that would strip unknown keys or apply a default must not alter what the caller receives. Validation observes. It does not repair.

Validation that observes must also never fail the call. A schema can still throw from inside a refinement or transform, and `safeParse` rethrows that throw. Thus, a throw counts as one issue with that item. The server returns a good reply, or a write that TestRail accepted, with a warning rather than turning it into an `INTERNAL_ERROR`. The server installs no driver `onSchemaMismatch` hook.

Only a bounded count crosses the boundary. A count is capped at 1 000, and a result carries at most ten warning entries. More entries are an internal fault. Field names, schema paths and values stay out, because they are instance data. The server computes warnings for each caller as a plain function of the value, not through a shared driver hook. Coalesced GET joiners do not each trigger such a hook, so two concurrent callers of one request would otherwise not each get their own warnings.

## Errors say only what is known

Codes come from a fixed set, messages are fixed text, and metadata is an allowlist. The server never forwards a driver message, status text or response body. Any of them can embed the configured host, a local path or instance data.

Subclass precedence is essential, because the driver's own hierarchy makes the general case also match the specific one. `TestRailLicenseError` extends `TestRailApiError`, so the adapter must recognize a license restriction before a plain 403 permission denial. `TestRailPaginationError` extends `TestRailValidationError`, so the adapter must recognize an aggregate stop before generic validation. Within that stop, a safety bound (`max_pages`, `max_items`, `max_bytes`, `max_duration`) is `PAGINATION_LIMIT`, and a structural fault (`invalid_page`, `invalid_continuation`, `non_progress`) is `INVALID_RESPONSE`.

A 404 is `NOT_FOUND`, and its message says only that the resource does not exist. Nothing infers an unsupported TestRail version from a reply. An older TestRail's `400` for an unknown method stays TestRail's own error, `UPSTREAM_ERROR` with its status.

Status 0 and status 200 both map to `INVALID_RESPONSE`. A status-zero failure is not automatically a transport failure. Malformed success JSON reaches the adapter the same way. The one exception is the driver's own body timeout, described below.

Two failures happen before TestRail has answered at all, and the taxonomy has no code for an unreachable TestRail. Adding a code would change what clients receive. Thus, on 2026-10-03 both failures were kept as they were, and this document states them:
- Unless `TESTRAIL_ALLOW_PRIVATE_HOSTS` is set, the driver resolves the TestRail host name before every request. It connects to the address that it approved. A lookup with one of these results is a driver validation error:
  - The lookup fails.
  - The lookup returns no address.
  - The lookup returns a malformed answer.
  - The lookup returns an address in a private, loopback or other non-routable range (from driver 9.0.0 also `198.18.0.0/15`, `224.0.0.0/4` and `240.0.0.0/4`).

  This error reaches the caller as `INTERNAL_ERROR`, whose fixed message says the server failed to complete the call. No request is sent. When `TESTRAIL_ALLOW_PRIVATE_HOSTS` is set, the driver does not look the name up itself. A name that does not resolve then fails when the connection is made, as the next case describes.
- A connection that fails before any response headers arrive, such as one refused or reset, is the driver's status-0 network error. It reaches the caller as `INVALID_RESPONSE`, whose fixed message says the TestRail response could not be used, although none arrived. The error shares that code with the driver's other status-zero errors, all but its body timeout.

In both cases a write or report run carries `write_outcome: "unknown"`. The adapter entered the driver, so the adapter cannot prove that nothing was sent, even though after a failed lookup nothing was. The messages are imprecise. The outcome is not wrong. `tests/transport/tool-call.test.ts` pins the lookup failure exactly, and `tests/result-contract.test.ts` pins the network error on a write sent once.

A lookup that does not answer at all is neither case. From driver 9.0.0 the lookup counts against the 15-second request timeout. It reaches the caller as `TIMEOUT` with no `http_status`, as the request timeout below does. No request is sent, and the call keeps its slot until the lookup settles. `tests/runtime-timing.test.ts` shows this case on a fake clock.

A connection that breaks after the headers arrive is neither case. The decision did not cover it. What follows is what the pinned driver does. A break during an error body loses only the reply's text. The error keeps TestRail's status and is classified by it, as any reply with that status would be. Thus, a 500 is `UPSTREAM_ERROR`, and a 403 is `PERMISSION_DENIED` even when the text that the error lost was a license restriction.

A break during a success body reaches the adapter as the raw fetch error. The adapter reports `INTERNAL_ERROR`. A write carries `write_outcome: "unknown"` in both cases. `tests/result-contract.test.ts` pins these three on a write sent once. An error body that stalls instead of breaking, or runs over the driver's JSON size limit, loses its status as well. The description comes below, after the driver's own timeouts.

A tool call whose pipeline rejects is answered within the taxonomy too. The pipeline is built never to reject. If the pipeline did reject, the SDK would send the raw error message as the tool result, with no code and no write outcome. The server catches the rejection and answers `INTERNAL_ERROR` with its fixed message and one `tool_call` diagnostic. On a write or report run, the answer also carries `write_outcome: "unknown"`, since whether the driver was entered is not known.

An aggregate's duration bound is always `PAGINATION_LIMIT` with reason `max_duration`, however the driver raises it. Usually the aggregate raises its own stop. But timers bound each request inside the aggregate, and they are set to the budget that remains:
- the request's abort timer;
- a race against the deadline;
- the body read.

Any of these timers can fire a moment before the wall clock reaches the deadline. The aggregate then rethrows that timer's own error: `408 Request timeout after Nms`, `408 Aggregate request deadline exceeded`, or a status-0 `Body read timeout`. In local loops on driver 8.0.0 that sequence happened in a few percent of runs. From 9.0.0 the driver labels its abort timer and deadline race as the duration stop itself, so only the clipped body read timeout still escapes. The two 408 spellings stay recognized as a guard.

The caller received the 408s as `UPSTREAM_ERROR` with `http_status: 408`, which claimed that TestRail had answered when no response arrived. The caller received the body timeout as `INVALID_RESPONSE`.

The adapter recognizes these errors only on an all-mode call, and only when the driver itself raised them. An error that the driver builds from a received response always carries a response text, its body or `Unknown error` when the body broke. Thus, a real 408 with any reason phrase keeps its status. A real 408 whose body stalls or runs over the JSON limit is not such an error. The driver replaces it with its own body timeout or size error, which is classified like any other.

A request or body timeout counts only when the driver clipped it below its full 15 seconds, which only the aggregate budget does. An unclipped one is that request's own timeout, described next. The recognition reads the pinned driver's fixed status texts and timeout messages, so a driver upgrade must keep `tests/runtime-lifetime.test.ts` passing. That suite freezes the clock to force each ordering through `testrail_get_projects`, and it checks each look-alike that must not match.

Outside that bound, a request that the driver gave up waiting on is `TIMEOUT`, with no `http_status`. When a request waits its full 15 seconds for headers, the driver aborts it and raises `408 Request timeout after 15000ms`. From driver 9.0.0 this wait includes resolving the host name. When a body that has started does not finish within its own 15 seconds, the driver raises a status-0 `Body read timeout`. TestRail sent neither status.

Until 2026-10-03 the first error reached the caller as `UPSTREAM_ERROR` with `http_status: 408`, exactly as a real 408 reply would. The second error reached the caller as `INVALID_RESPONSE`. On that day both were decided to be `TIMEOUT`. This code says what happened: the wait expired, and upstream work may still be running.

A write's `write_outcome` is `unknown`, as before, and the driver retries neither. A 408 that TestRail did send stays `UPSTREAM_ERROR` with `http_status: 408` whatever its reason phrase. This stays true unless the driver stops reading its body at one of its own limits, as the paragraph that begins "An error reply keeps TestRail's status" explains. Inside an aggregate, an unclipped request or body timeout is `TIMEOUT` too.

The recognition reads the same fixed driver texts, matching any timeout length. Thus, a driver upgrade must keep passing the tests that put the real driver's errors through the recognition:
- `tests/runtime-timing.test.ts`, which holds both timeouts on a fake clock with the production driver options;
- `tests/families/t12.test.ts`, for a download's header and body timeouts and an upload's header timeout;
- `tests/families/t11.test.ts`, for a report run's header timeout and the stalled and oversized bodies that the paragraph beginning "An error reply keeps TestRail's status" describes;
- the R02 stand-in's slow ID in `tests/fixture-testrail.test.ts`, for the header timeout over HTTP.

The look-alike cases in `tests/results.test.ts` build the driver's errors by hand. They keep the match narrow, so that a real 408 or another status-zero error is not taken for a timeout. They cannot notice a change in the driver's texts.

An error reply keeps TestRail's status unless the driver stops reading its body at one of its own limits. The pinned driver then raises its own status-0 error in place of the reply, before it decides whether to retry.

A body that stalls past the body timeout becomes `Body read timeout`. The caller then gets `TIMEOUT` with no `http_status`, for a 408 or a 429 as for any other status. A body over the JSON size limit becomes `Response body too large`, which is `INVALID_RESPONSE`, also with no `http_status`. Neither is retried, not even a 429, or a 5xx on a read, which the driver otherwise retries. A write's `write_outcome` stays `unknown`.

`tests/families/t11.test.ts` holds this through the real driver. The test "T11 what a run returns > %s reports a %i reply whose body stalls as TIMEOUT with no status, and an unknown outcome" sends a 200, a 408 and a 500 to each report run. The test "T11 every report run reaches TestRail exactly once > does not retry an ordinary template read whose %i reply's body %s, and reports %s with no status" sends a 500 and a 429 that stall and a 500 over the limit to a template read, each once. The test "> retries an ordinary template read after the same 500" sends that read twice.

## Truthful write outcomes

Every error on an operation that mutates TestRail or initiates report generation carries a `write_outcome`. The server never infers the `write_outcome` from MCP annotations. An attachment download has local file effects but does not mutate TestRail, so it carries none.

- `not_started`: the adapter can prove that nothing was dispatched. These cases apply:
  - input validation;
  - capacity rejection;
  - cancellation before invocation;
  - an upload whose staging failed;
  - a wait that ended, by the watchdog or by cancellation, while an upload was still being staged.

  Staging fails as `FILE_ACCESS_DENIED` or `FILE_TOO_LARGE` when the file is refused or cannot be copied, and as `INTERNAL_ERROR` when the staging area cannot be created. `tests/transport/lifecycle.test.ts` > "packaged server shutdown after a staging failure > retries staging on the next upload, and still shuts down cleanly and exits 0" holds that last case through the packaged server, as `INTERNAL_ERROR` with `not_started` and nothing sent. A wait that ended during staging is `TIMEOUT` or `CANCELLED`, whose fixed message says upstream work may still be running. `not_started` is what says nothing was sent. The adapter derives `not_started` only from what it observed, never from the error code. A pre-dispatch code that reaches a post-dispatch failure must not be allowed to claim that nothing was sent.
- `unknown`: invocation began and failed without a usable acknowledgment. This outcome never claims that no change occurred, and it never advises an unconditional retry. The driver itself re-sends a write only after a 429. Thus, a JSON write whose reply is lost to a network error, a 5xx or an unusable 200 is sent exactly once.
- `acknowledged`: the driver resolved and a later adapter stage failed. It records acknowledgment, not atomic success of every item in a bulk call.

## Verification

`tests/results.test.ts` covers these topics:
- preservation;
- both budgets under quote and non-ASCII load;
- strict-versus-advisory validation;
- per-caller warnings on a shared value;
- the full status map;
- subclass precedence;
- every write outcome.

The tests assert leakage directly. A driver error that carries a host, an API key and a local path produces an envelope that contains none of them.

`tests/result-contract.test.ts` holds the contract through registered tools. A client connected to the full catalog calls every one of the 133 tools, and each of the 24 paged lists in both modes. Each call uses an accepted fixture's reply from its manifest. Every result must meet these conditions:
- It validates against the output schema that the tool advertises.
- It carries exactly the structured wrapper in its one text block.
- It includes `pagination` only where the tool pages.

The test holds the advertised schema to the documented wrapper in turn, rather than trusting it. The schema must require `data`, accept `pagination` only as an object and `warnings` only as an array of objects, and leave entity fields unconstrained. Error results keep the same parity for these cases:
- a refused argument;
- an upstream 404;
- a write refused with a 500;
- an aggregate stopped at a bound, where the error also names that bound.

These further cases apply:
- A success reply that is not JSON, or is the wrong outer shape, fails a record, array, page or aggregate read. The read is `INVALID_RESPONSE` with no data and no write outcome. So does an aggregate page that answers an offset that it was not asked for.
- Two identical reads that the driver joins into one request each receive the same warnings. A concurrent clean read receives none. A later identical read whose reply is clean inherits nothing.
- A result over `max_result_bytes` is refused as `RESPONSE_TOO_LARGE` whole, never truncated. It is reported as `acknowledged` when it was a write that TestRail accepted.

The F05 acceptance audit added evidence that the sweep could not give. For one accepted fixture for each tool and call mode, `data` must equal the hand-written driver result of the manifest. For a page, the expected value is its items, and for a void method it is `null`. This applies to every tool but the attachment download, which returns the description of the written file. Other cases:
- Three joiners of one drifted read each get exactly `count: 1`. Two different operations drifting at once get their own counts, and a later drift gets its own.
- A schema that throws, on a read and on an accepted write, still returns the data with one warning. A coercing, defaulting and transforming schema leaves a record, list, page or aggregate reply unchanged.
- The adapter's own page and aggregate checks refuse a malformed value the driver never saw.
- A 404 message never mentions a version, and a `400` unknown-method reply stays `UPSTREAM_ERROR`.
- A JSON write whose reply is lost is `unknown` and sent once, with the production retry settings.
- The configured data budget is enforced through a tool.
- Each call logs one `tool_call` diagnostic, carrying no argument, response body, path, host or key. A refused upload's error never names its local path.

`tests/results.test.ts` holds each budget to its exact byte. It accepts 1 MiB of data and refuses one more byte, and it meets the result budget exactly and misses it by one. Escaping counts beyond duplication alone, UTF-8 bytes count rather than code units, and the error envelope is capped at exactly 16 384 bytes.

The F05 closing work on 2026-10-03 added four more:
- The sweep through every tool adds a key that no driver schema names to every object in the reply, nested ones included. It requires `data` to keep the key wherever the reply had it.

  For a reply that matches its schema, the driver returns its own parsed output. Thus, this check holds that the driver keeps unknown fields on every object that it returns for these fixtures. Of the 157 calls, 133 carry the key into `data`. The other 24 return nothing that could keep it: 22 void methods, whose reply the driver discards, the BDD text and the downloaded file. The replies of the five uploads pass no driver schema, so for them the check holds only that the adapter keeps the key.

  An upgrade re-records the hashes of the release ledger, so the ledger cannot tell whether a new schema stopped passing unknown keys. Making the milestone, report-result, version or history-change schema of the driver strip unknown keys fails the ten cases that return those objects. The sweep without the key passes all of these cases. Marking only the objects that carry an `id` would miss the last three. Leaving the key out of the expected data, or out of the reply, fails all 133, so the check is not vacuous.
- `tests/results.test.ts` reports the driver's header and body timeouts, each at 15 seconds and at 100 ms, as `TIMEOUT` with no status. It reports `unknown` on a write. A 408 that carries a body, or another reason phrase, and a status-0 body timeout or size cap with other detail keep their codes. Each of these mutations fails a test:
  - treating every 408 as a timeout;
  - dropping the no-response check;
  - keeping `http_status` on a timeout;
  - matching only a 15-second body timeout;
  - dropping the mapping.
- `tests/transport/handler-failure.test.ts` replaces the pipeline with one that rejects with a message that carries a key, a host and a path. It calls a write, a report run and a read through a real client. Each call gets exactly the `INTERNAL_ERROR` envelope above and one `tool_call` line. None of the three appears in the result or on stderr. Each of these mutations fails the test:
  - removing the guard;
  - answering `not_started` or no write outcome for the write;
  - treating a report run as a read;
  - putting the error's message in the text;
  - logging nothing.
- The lost-write case in `tests/result-contract.test.ts` sends a 500 and a 403 license reply whose bodies break after the headers, and a 200 whose body breaks. It uses the production driver options. The first two keep their status, and the adapter classifies them by it, with the license text lost. The third is `INTERNAL_ERROR`. Each is `unknown` and sent once. The report-run and upload failure tables in `tests/families/t11.test.ts` and `tests/families/t12.test.ts` now pin each code as well as the outcome. Thus, a real 408 sent through the pinned driver is held as `UPSTREAM_ERROR` 408. The driver's own timeout, a row of the upload table and a case of its own for a report run, is held as `TIMEOUT` with no status.

The invariants are mutation-checked. Each of these mutations fails a test:
- dropping the complete-result budget;
- measuring either budget in code units instead of UTF-8 bytes;
- checking `TestRailApiError` before its license subclass;
- reporting `not_started` for an ambiguous post-dispatch failure.

Through the tools, each of these mutations fails the end-to-end suite:
- an output schema that demands more than the wrapper or less (no longer requiring `data`, or no longer typing `pagination` or `warnings`);
- text that differs from the structured content on success or on error;
- a skipped outer check in single or page mode;
- a lenient aggregate check;
- warnings cached across calls or replayed for a repeated identical call;
- a drift count reused from another call;
- a throwing advisory schema;
- parsed output merged into `data` or put back into the caller's list;
- an unusable aggregate page reported as a bound;
- an ignored complete-result budget;
- a `pagination` field on every result.
