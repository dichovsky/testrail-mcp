# Pagination

`src/contracts/pagination.ts` implements F06's page defaults, page metadata and aggregate control mapping. The driver's public `getAll*` helper still owns aggregation; this layer never runs a fetch loop.

## One page by default

A list returns one page of 50 unless the caller says otherwise, up to a supported maximum of 250. Explicit aggregation is opt-in through `_mcp.pagination: "all"`, which maps to the public helper's `pageSize`, `startOffset`, `maxItems`, `maxPages`, `maxBytes` and `maxDurationMs`. Absent controls default to the configured server maxima.

"All" means every remaining match from the effective `start_offset`. It is not a transactional snapshot, and the reported `start_offset` is the one actually used rather than always zero.

## Links are metadata, never fetch authority

The driver's page type supplies `_links`, not parsed controls. This layer validates a next link into caller-controllable arguments and exposes **only the validated numbers** — host and path are discarded, so the caller's original filters are reused rather than whatever the link happens to encode.

`URLSearchParams` reads both link forms TestRail emits. A conventional `?offset=50&limit=25` parses directly, and so does the path-style `?/api/v2/get_cases/1&limit=50&offset=50`, because splitting on `&` leaves the resource path as a key that is neither `limit` nor `offset`. A control repeated across both forms appears twice and is rejected rather than silently preferred.

A continuation is accepted only with exactly one canonical non-negative offset, at most one positive limit no greater than 250, and an offset that strictly advances past what this page already returned (`next > current` and `next - current >= returned`). Replaying or overlapping a continuation would silently duplicate items, which is worse than reporting that manual paging is unavailable.

## Saying only what was observed

`returned` comes from the items actually present; the driver's own `size` is preserved separately under `pagination.driver` rather than substituted for it. When the driver reports more data but no controllable continuation could be validated, `next_action` is `"all"` — the bounded aggregate is the only honest way forward, and advertising a manual page would mean inventing a cursor.

Response-driven lists never get manual paging, even when a link parses, because their public page methods accept no caller-supplied offset.

A terminal legacy array is reported as `source: "legacy_array"` with `has_more: false` and `next_action: "none"`, and invents no `limit` or `offset` for a shape that never had them. This describes the observed response; it is not independent proof that the upstream dataset held nothing more.

## Verification

`tests/pagination.test.ts` covers both link forms, cross-form duplicates, non-canonical numbers, out-of-range limits, the advance/overlap rule, response-driven suppression, legacy arrays and the control mapping.

Mutation-checked: dropping the advance/overlap requirement, reporting the driver `size` as `returned`, and permitting manual continuation on a response-driven list each fail a test. A fourth mutation — parsing only real query parameters — did **not** fail, which showed the original hand-rolled splitter was reimplementing `URLSearchParams`; it was replaced by the standard call.
