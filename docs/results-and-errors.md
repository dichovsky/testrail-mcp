# Results, warnings and errors

`src/contracts/results.ts`, `drift.ts` and `errors.ts` implement F05's success wrapper, advisory drift warnings and error taxonomy. Pagination metadata is built by F06; tool registration and SDK wiring by F08.

## Preserved data

The wrapper is `{ data, pagination?, warnings? }`. `data` is the value the driver returned, unchanged: unknown fields, flat `custom_*` properties and future TestRail additions all survive, because renaming or relocating them would lose information the caller asked for. A resolved void method carries `data: null` rather than omitting the key. Raw text results stay text, including a valid empty string. Optional keys are omitted entirely when empty rather than emitted as `null` or `[]`.

The same wrapper is returned as MCP `structuredContent` and as one text block containing exactly `JSON.stringify(wrapper)`, so an older consumer reads the same bytes a structured consumer does.

## Two budgets, not one

Both the serialized `data` and the **complete** tool-result object are measured, because they are different quantities. The text block duplicates the payload and escapes it, so everything counts twice, and escapes add more: each time a quote, a backslash or a newline is escaped it grows by one byte, and another control character or a lone surrogate by up to five. A `data` value comfortably inside its own budget can still overflow the result budget. Well-formed non-ASCII text is not escaped; it is simply larger in UTF-8. The tests exercise quotes, backslashes and non-ASCII text. Bytes are counted as UTF-8, not UTF-16 code units, so an emoji costs four rather than two. The defaults are 1 MiB for `data` and 2.5 MiB for the complete result, each accepted up to and including its limit.

An error envelope has a fixed budget of 16 KiB, measured the same way on the complete result, text block included. Past it, the optional metadata is dropped before the code, message and write outcome are; an envelope still over the budget without its metadata is an internal fault rather than a truncated message.

Overflow is reported, never silently truncated. A caller can narrow a read with smaller pages or tighter filters. A caller whose write already succeeded must never be told to repeat it merely to retrieve the output.

## Strict outer, advisory entity

Outer structure is validated strictly: a record that is not a record, or a collection missing required keys, is `INVALID_RESPONSE`. Entity fields are validated separately and advisorily — drift inside a usable structure returns the original value with `warnings: [{ code: "SCHEMA_DRIFT", count: N }]`. TestRail adding or retyping a field is not an outage.

A soft-delete preview is the one reply whose meaning depends on the input. `delete_case`, `delete_cases`, `delete_section`, `delete_suite` and `delete_run` delete when called plainly, and with `query.soft: true` ask TestRail what the delete would remove. After a delete the result is `data: null` and nothing is checked. After a preview the counts are returned as sent and checked advisorily against the driver's own preview schema, so a count that arrives as a string is reported as `SCHEMA_DRIFT`. A preview reply that carries none of the seven affected-entity counts with a value (an empty body, `{}`, only unknown keys, or only `null` counts) is not reported as a preview of nothing: a TestRail that ignores the flag deletes and answers just the same. It is `INVALID_RESPONSE` with `write_outcome: "unknown"`, after exactly one request, so the caller learns the rows may be gone rather than that none would be affected. The tools stay annotated as destructive, because a preview is chosen per call and the annotation describes the tool.

The parsed output is deliberately discarded. A schema that would strip unknown keys or apply a default must not alter what the caller receives; validation observes, it does not repair.

Validation that observes must also never fail the call. A schema can still throw from inside a refinement or transform, and `safeParse` rethrows that, so a throw counts as one issue with that item: a good reply, or a write TestRail accepted, is returned with a warning rather than turned into an `INTERNAL_ERROR`. No driver `onSchemaMismatch` hook is installed.

Only a bounded count crosses the boundary: a count is capped at 1 000, and a result carries at most ten warning entries, more being an internal fault. Field names, schema paths and values stay out — they are instance data. Warnings are computed per caller as a plain function of the value, not through a shared driver hook: coalesced GET joiners do not each trigger such a hook, so two concurrent callers of one request would otherwise not each get their own warnings.

## Errors say only what is known

Codes come from a fixed set, messages are fixed text, and metadata is an allowlist. A driver message, status text or response body is never forwarded: any of them can embed the configured host, a local path or instance data.

Subclass precedence is load-bearing, because the driver's own hierarchy makes the general case also match the specific one. `TestRailLicenseError` extends `TestRailApiError`, so a license restriction must be recognised before a plain 403 permission denial. `TestRailPaginationError` extends `TestRailValidationError`, so an aggregate stop must be recognised before generic validation — and within it, a safety bound (`max_pages`, `max_items`, `max_bytes`, `max_duration`) is `PAGINATION_LIMIT` while a structural fault (`invalid_page`, `invalid_continuation`, `non_progress`) is `INVALID_RESPONSE`.

A 404 is `NOT_FOUND`, and its message says only that the resource does not exist. Nothing infers an unsupported TestRail version from a reply: an older TestRail's `400` for an unknown method stays TestRail's own error, `UPSTREAM_ERROR` with its status.

Status 0 and status 200 both map to `INVALID_RESPONSE`. A status-zero failure is not automatically a transport failure; malformed success JSON reaches the adapter the same way.

An aggregate's duration bound is always `PAGINATION_LIMIT` with reason `max_duration`, however the driver raises it. Usually the aggregate raises its own stop. But each request inside it is bounded by timers set to the budget that remains: the request's abort timer, a race against the deadline, and the body read. Any of them can fire a moment before the wall clock reaches the deadline, and the aggregate then rethrows that timer's own error: `408 Request timeout after Nms`, `408 Aggregate request deadline exceeded`, or a status-0 `Body read timeout`. In local loops that happened in a few percent of runs. The 408s reached the caller as `UPSTREAM_ERROR` with `http_status: 408`, claiming TestRail had answered when no response arrived, and the body timeout as `INVALID_RESPONSE`.

They are recognised only on an all-mode call, and only when the driver itself raised them. An error built from a received response always carries its body text, so a real 408 with any reason phrase keeps its status. A request or body timeout counts only when the driver clipped it below its full 15 seconds, which only the aggregate budget does; an unclipped one is an ordinary slow request. The recognition reads the pinned driver's fixed status texts and timeout messages, so a driver upgrade must keep `tests/runtime-lifetime.test.ts` passing. That suite freezes the clock to force each ordering through `testrail_get_projects`, and checks each look-alike that must not match.

## Truthful write outcomes

Every error on an operation that mutates TestRail or initiates report generation carries a `write_outcome`, and it is never inferred from MCP annotations — an attachment download has local file effects but does not mutate TestRail, so it carries none.

- `not_started` — the adapter can prove nothing was dispatched: input validation, capacity rejection, cancellation before invocation. It is derived only from what the adapter observed, never from the error code: a pre-dispatch code reaching a post-dispatch failure must not be allowed to claim nothing was sent.
- `unknown` — invocation began and failed without a usable acknowledgment. This never claims no change occurred and never advises an unconditional retry. The driver itself re-sends a write only after a 429, so a JSON write whose reply is lost to a network error, a 5xx or an unusable 200 is sent exactly once.
- `acknowledged` — the driver resolved and a later adapter stage failed. It records acknowledgment, not atomic success of every item in a bulk call.

## Verification

`tests/results.test.ts` covers preservation, both budgets under quote and non-ASCII load, strict-versus-advisory validation, per-caller warnings on a shared value, the full status map, subclass precedence and every write outcome. Leakage is asserted directly: a driver error carrying a host, an API key and a local path produces an envelope containing none of them.

`tests/result-contract.test.ts` holds the contract through registered tools. A client connected to the full catalog calls every one of the 133 tools, and each of the 24 paged lists in both modes, with an accepted fixture's reply from its manifest. Every result must validate against the output schema that tool advertises, carry exactly the structured wrapper in its one text block, and include `pagination` only where the tool pages. The advertised schema is held to the documented wrapper in turn rather than trusted: it must require `data`, accept `pagination` only as an object and `warnings` only as an array of objects, and leave entity fields unconstrained. Error results keep the same parity for a refused argument, an upstream 404, a write refused with a 500 and an aggregate stopped at a bound, which also names that bound. A success reply that is not JSON, or is the wrong outer shape, fails a record, array, page or aggregate read as `INVALID_RESPONSE` with no data and no write outcome, and so does an aggregate page answering an offset it was not asked for. Two identical reads that the driver joins into one request each receive the same warnings, a concurrent clean read receives none, and a later identical read whose reply is clean inherits nothing. A result over `max_result_bytes` is refused as `RESPONSE_TOO_LARGE` whole, never truncated, and reported as `acknowledged` when it was a write TestRail accepted.

The F05 acceptance audit added evidence the sweep could not give. Every accepted fixture's `data` must equal the manifest's hand-written driver result, its items for a page and `null` for a void method, for every tool but the attachment download, which returns the written file's description. Other cases:
- Three joiners of one drifted read each get exactly `count: 1`. Two different operations drifting at once get their own counts, and a later drift its own.
- A schema that throws, on a read and on an accepted write, still returns the data with one warning. A coercing, defaulting and transforming schema leaves a record, list, page or aggregate reply unchanged.
- The adapter's own page and aggregate checks refuse a malformed value the driver never saw.
- A 404 message never mentions a version, and a `400` unknown-method reply stays `UPSTREAM_ERROR`.
- A JSON write whose reply is lost is `unknown` and sent once, with the production retry settings.
- The configured data budget is enforced through a tool.
- Each call logs one `tool_call` diagnostic, carrying no argument, response body, path, host or key. A refused upload's error never names its local path.

`tests/results.test.ts` holds each budget to its exact byte: 1 MiB of data accepted and one more byte refused, and the result budget met exactly and missed by one. Escaping counts beyond duplication alone, UTF-8 bytes count rather than code units, and the error envelope is capped at exactly 16 384 bytes.

The invariants are mutation-checked. Dropping the complete-result budget, measuring either budget in code units instead of UTF-8 bytes, checking `TestRailApiError` before its license subclass, and reporting `not_started` for an ambiguous post-dispatch failure each fail a test. Through the tools, an output schema that demands more than the wrapper or less (no longer requiring `data`, or no longer typing `pagination` or `warnings`), text that differs from the structured content on success or on error, a skipped outer check in single or page mode, a lenient aggregate check, warnings cached across calls or replayed for a repeated identical call, a drift count reused from another call, a throwing advisory schema, parsed output merged into `data` or put back into the caller's list, an unusable aggregate page reported as a bound, an ignored complete-result budget, and a `pagination` field on every result each fail the end-to-end suite.
