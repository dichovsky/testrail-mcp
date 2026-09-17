# Pagination

`src/contracts/pagination.ts` implements F06's page defaults, page metadata and aggregate control mapping. The driver's public `getAll*` helper still owns aggregation; this layer never runs a fetch loop.

## One page by default

A list returns one page of 50 unless the caller says otherwise, up to a supported maximum of 250. Explicit aggregation is opt-in through `_mcp.pagination: "all"`, which maps to the public helper's `pageSize`, `startOffset`, `maxItems`, `maxPages`, `maxBytes` and `maxDurationMs`. Absent controls default to the configured server maxima.

"All" means every remaining match from the effective `start_offset`. It is not a transactional snapshot, and the reported `start_offset` is the one actually used rather than always zero.

## Links are metadata, never fetch authority

The driver's page type supplies `_links`, not parsed controls. This layer validates a next link into caller-controllable arguments and exposes **only the validated numbers** — host and path are discarded, so the caller's original filters are reused rather than whatever the link happens to encode.

Controls are read from both places TestRail puts them. A conventional link carries `?offset=50&limit=25` in the query. The real `_links.next`, however, carries **no question mark at all** — it is the fragment a client appends after its own `index.php?`, as in `/api/v2/get_cases/1&limit=250&offset=250`. A URL parse puts that entirely in `pathname` and leaves `search` empty, so reading only the query would discard every genuine continuation. Both locations are read and validated together, which also means a control repeated across the two forms is seen twice and rejected rather than silently preferred.

A continuation is accepted only with exactly one canonical non-negative offset, at most one positive limit no greater than 250, and an offset that strictly advances past what this page already returned (`next > current` and `next - current >= returned`). Replaying or overlapping a continuation would silently duplicate items, which is worse than reporting that manual paging is unavailable.

## Saying only what was observed

`returned` comes from the items actually present; the driver's own `size` is preserved separately under `pagination.driver` rather than substituted for it. When the driver reports more data but no controllable continuation could be validated, `next_action` is `"all"` — the bounded aggregate is the only honest way forward, and advertising a manual page would mean inventing a cursor.

Response-driven lists never get manual paging, even when a link parses, because their public page methods accept no caller-supplied offset.

A terminal legacy array is reported as `source: "legacy_array"` with `has_more: false` and `next_action: "none"`, and invents no `limit` or `offset` for a shape that never had them. This describes the observed response; it is not independent proof that the upstream dataset held nothing more.

## Verification

`tests/pagination.test.ts` covers both link forms, cross-form duplicates, non-canonical numbers, out-of-range limits, the advance/overlap rule, response-driven suppression, legacy arrays and the control mapping.

Mutation-checked: dropping the advance/overlap requirement, reporting the driver `size` as `returned`, permitting manual continuation on a response-driven list, reading controls only from the query, and hardcoding `limit`/`offset` instead of reading the page each fail a test.

Two of those checks were earned the hard way. An early mutation that did *not* fail showed a hand-rolled splitter was reimplementing `URLSearchParams`, which replaced it. Review then found the remaining parser read only `url.search`, while the shape TestRail actually emits has no `?` — so it was internally consistent, tested against a fixture that TestRail never sends, and would have returned no continuation in production.
