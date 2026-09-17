# Results, warnings and errors

`src/contracts/results.ts`, `drift.ts` and `errors.ts` implement F05's success wrapper, advisory drift warnings and error taxonomy. Pagination metadata is built by F06; tool registration and SDK wiring by F08.

## Preserved data

The wrapper is `{ data, pagination?, warnings? }`. `data` is the value the driver returned, unchanged: unknown fields, flat `custom_*` properties and future TestRail additions all survive, because renaming or relocating them would lose information the caller asked for. A resolved void method carries `data: null` rather than omitting the key. Raw text results stay text, including a valid empty string. Optional keys are omitted entirely when empty rather than emitted as `null` or `[]`.

The same wrapper is returned as MCP `structuredContent` and as one text block containing exactly `JSON.stringify(wrapper)`, so an older consumer reads the same bytes a structured consumer does.

## Two budgets, not one

Both the serialized `data` and the **complete** tool-result object are measured, because they are different quantities. The text block duplicates the payload and escapes it, so quote-heavy or non-ASCII content roughly doubles again — a `data` value comfortably inside its own budget can still overflow the result budget. Bytes are counted as UTF-8, not UTF-16 code units, so an emoji costs four rather than two.

Overflow is reported, never silently truncated. A caller can narrow a read with smaller pages or tighter filters. A caller whose write already succeeded must never be told to repeat it merely to retrieve the output.

## Strict outer, advisory entity

Outer structure is validated strictly: a record that is not a record, or a collection missing required keys, is `INVALID_RESPONSE`. Entity fields are validated separately and advisorily — drift inside a usable structure returns the original value with `warnings: [{ code: "SCHEMA_DRIFT", count: N }]`. TestRail adding or retyping a field is not an outage.

The parsed output is deliberately discarded. A schema that would strip unknown keys or apply a default must not alter what the caller receives; validation observes, it does not repair.

Only a bounded count crosses the boundary. Field names, schema paths and values stay out — they are instance data. Warnings are computed per caller as a plain function of the value, not through a shared driver hook: coalesced GET joiners do not each trigger such a hook, so two concurrent callers of one request would otherwise not each get their own warnings.

## Errors say only what is known

Codes come from a fixed set, messages are fixed text, and metadata is an allowlist. A driver message, status text or response body is never forwarded: any of them can embed the configured host, a local path or instance data.

Subclass precedence is load-bearing, because the driver's own hierarchy makes the general case also match the specific one. `TestRailLicenseError` extends `TestRailApiError`, so a license restriction must be recognised before a plain 403 permission denial. `TestRailPaginationError` extends `TestRailValidationError`, so an aggregate stop must be recognised before generic validation — and within it, a safety bound (`max_pages`, `max_items`, `max_bytes`, `max_duration`) is `PAGINATION_LIMIT` while a structural fault (`invalid_page`, `invalid_continuation`, `non_progress`) is `INVALID_RESPONSE`.

Status 0 and status 200 both map to `INVALID_RESPONSE`. A status-zero failure is not automatically a transport failure; malformed success JSON reaches the adapter the same way.

## Truthful write outcomes

Every error on an operation that mutates TestRail or initiates report generation carries a `write_outcome`, and it is never inferred from MCP annotations — an attachment download has local file effects but does not mutate TestRail, so it carries none.

- `not_started` — the adapter can prove nothing was dispatched: input validation, capacity rejection, cancellation before invocation.
- `unknown` — invocation began and failed without a usable acknowledgment. This never claims no change occurred and never advises an unconditional retry.
- `acknowledged` — the driver resolved and a later adapter stage failed. It records acknowledgment, not atomic success of every item in a bulk call.

## Verification

`tests/results.test.ts` covers preservation, both budgets under quote and non-ASCII load, strict-versus-advisory validation, per-caller warnings on a shared value, the full status map, subclass precedence and every write outcome. Leakage is asserted directly: a driver error carrying a host, an API key and a local path produces an envelope containing none of them.

The invariants are mutation-checked. Dropping the complete-result budget, measuring in code units instead of UTF-8 bytes, checking `TestRailApiError` before its license subclass, and reporting `not_started` for an ambiguous post-dispatch failure each fail a test.
