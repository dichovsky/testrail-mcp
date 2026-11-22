# Pagination

`src/operations/lists.ts` owns list definitions, filter projection, argument mappings, page defaults, aggregate bounds and reply interpretation. `src/contracts/pagination.ts` supplies its continuation validation and metadata implementation. The driver's public `getAll*` helper still owns aggregation. This layer never runs a fetch loop.

## One page by default

A controlled list returns one page of 50 unless the caller says otherwise, up to a supported maximum of 250. Explicit aggregation is opt-in through `_mcp.pagination: "all"`, which maps to the public helper's `pageSize`, `startOffset`, `maxItems`, `maxPages`, `maxBytes` and `maxDurationMs`. Absent controls default to the configured server maxima.

A stated bound may lower a configured maximum but never raise it. The server refuses `max_items`, `max_pages`, `max_bytes` or `max_duration_ms` above `max_all_items`, `max_all_pages`, `max_all_bytes` or `max_all_duration_ms` with `INVALID_ARGUMENT`. The list module checks these limits before transport admission and before driver lookup on standalone aggregate bindings.

The input schema cannot enforce operator limits. The server builds schemas when the catalog loads, before it reads `TESTRAIL_MCP_LIMITS`. Thus, the ceiling that the schemas advertise and enforce is the built-in default. The server refuses a bound rather than clamping it, so the aggregate never quietly does less than the caller asked.

One consequence remains. A configured limit above the built-in default applies when the caller states no bound. But a caller cannot state a value above the default.

"All" means every remaining match from the effective `start_offset`, as far as TestRail's replies show. "All" is not a transactional snapshot. The reported `start_offset` is the one the caller asked for, which is also where the first request starts, rather than always zero. A reply that arrives as a bare array is the exception.

The driver reads a bare array on any list as its last page, because it carries no continuation. Thus, the aggregate stops there and still reports `complete: true`. The driver reads a bare array that follows an envelope the same way. The driver checks the offset only of an envelope. Thus, it joins that bare array as the last page without an offset check. The server cannot see which kind of reply ended an aggregate, because the driver's aggregate helper returns the items alone.

TestRail documents bare-array replies for three of the 24 lists. The description of each of these tools says what a bare-array reply means. For `get_attachments_for_plan` and `get_attachments_for_run`, the descriptions warn that a full reply may not be the whole list. They also point to the next offset in page mode. For `get_case_statuses`, TestRail's reference contradicts itself (a bare-array example beside an envelope field table). Its description says two things:

- A reply in bare-array form is read as the whole list, with `has_more` false in page mode.
- All mode stops after that reply while reporting complete, with no way to tell whether TestRail holds more.

The description gives no next-offset advice, because the list takes no offset. On any other list, a bare array would only come from an older TestRail, which is best effort.

## Links are metadata, never fetch authority

The driver's page type supplies `_links`, not parsed controls. This layer validates a next link into caller-controllable arguments and exposes **only the validated numbers**. It discards host and path. Thus, the caller's original filters are reused rather than whatever the link happens to encode. The driver's aggregate does the same when it follows a link.

The driver's aggregate rebuilds each request from its own endpoint and the caller's filters. It takes the link's offset, and its limit only on a response-driven list. A controlled list keeps its own page size.

The layer reads controls from both places where TestRail puts them. A conventional link carries `?offset=50&limit=25` in the query. The real `_links.next`, however, carries **no question mark at all**. It is the fragment a client appends after its own `index.php?`, as in `/api/v2/get_cases/1&limit=250&offset=250`.

A URL parse puts the fragment entirely in `pathname` and leaves `search` empty. Thus, reading only the query would discard every genuine continuation. The layer reads and validates both locations together. Thus, a control repeated across the two forms is seen twice and rejected rather than silently preferred.

The layer accepts a continuation only with all of these items:

- exactly one canonical non-negative offset (no sign and no leading zero, as the driver's parser also requires);
- at most one positive limit no greater than 250;
- an offset that strictly advances past what this page already returned (`next > current` and `next - current >= returned`).

Replaying or overlapping a continuation would silently duplicate items. Silent duplication is worse than reporting that manual paging is unavailable.

## Saying only what was observed

`returned` comes from the items actually present. The driver's own `size` is preserved separately under `pagination.driver` rather than substituted for `returned`. When the driver reports more data but no controllable continuation could be validated, `next_action` is `"none"`, with `has_more` still true.

Advertising a manual page would mean inventing a cursor. Advising the bounded aggregate would be no better. The aggregate reads the same link through the driver's own continuation parser. The pinned driver refuses every link that this layer refuses. The refused links cover these cases:

- an invalid reference;
- a missing, repeated or malformed offset;
- a repeated or out-of-range limit;
- an offset that does not advance past the page, which the driver reports as `non_progress`.

Following the advice to use the aggregate would turn a usable page into a failure with no data.

A response-driven list runs the same aggregate over the same server-selected first page. Thus, the same rules validate its link. The link never becomes a manual page there. A valid link advises `"all"`, and a refused link advises `"none"`.

`tests/pagination.test.ts` puts each rejection branch to a public aggregate helper, for both kinds of list. It asserts the driver's exact reason rather than comparing with a restatement of its rules. Thus, a driver that starts following one of these links fails a test rather than leaving the advice stale.

Response-driven lists never get manual paging, even when a link parses, because their public page methods accept no caller-supplied offset.

The server reports a terminal legacy array as `source: "legacy_array"` with `has_more: false` and `next_action: "none"`. It invents no `limit` or `offset` for a shape that never had them. This report describes the observed response. It is not independent proof that the upstream dataset held nothing more.

## Verification

`tests/list-definitions.test.ts` covers explicit filter names and serialization, omitted and falsy values, scalar/array preservation, defaults, declared controls, authoring guards and driver type checks. `tests/registered-parameters.test.ts` independently checks arguments and wire requests. It also refuses each of the four configured-bound violations on every list before driver invocation. `tests/pagination.test.ts` covers these items:

- both link forms;
- cross-form duplicates;
- non-canonical numbers;
- out-of-range limits;
- the advance/overlap rule;
- response-driven suppression;
- legacy arrays;
- empty pages (terminal, still linking to a next page, and linking back to where they are).

A `next_offset` is the link's own validated offset, never one computed from the page.

`tests/paging-through-tools.test.ts` runs all 24 paged lists end to end through `executor.execute`, the path a client's call takes. The lists run against a two-page stand-in that serves TestRail's own link form. The inventory names the lists and the driver source names each list's envelope key, so neither comes from the registry under test. The case history is served as TestRail sends it, its envelope inside a one-element array.

In page mode, each list must do these things:

- ask for the first page (a limit of 50 from offset 0 on a controlled list, no controls at all on a response-driven one);
- return that page's items with no drift warning;
- describe the next page: a manual `next_offset` on a controlled list, `next_action: "all"` and no offset on a response-driven one.

In all mode, each list must do these things:

- follow the continuation;
- return both pages' items with `returned: 2` and `complete: true`;
- report `start_offset` only where the caller controls it.

Each list must also stop at `max_items` with `PAGINATION_LIMIT`, reason `max_items`, no data and no request for the second page. `max_pages`, `max_bytes` and `max_duration_ms` are exercised on one list of each kind, and each must report its own reason.

Each list is also served a bare array, the case history's included. The case history's bare array goes through the driver's nested decoder. When the bare array is the first reply, page mode must describe it as a terminal `legacy_array` with `has_more: false`, `next_action: "none"` and no `limit` or `offset`. All mode must return it as complete after one request.

After an envelope, all mode must join the bare array and report complete after two requests. That second case pins what the driver does today, so this page cannot fall out of date. It does not endorse that behavior.

The F06 acceptance audit added boundary and continuation cases on one list of each kind (`get_projects`, `get_groups`). The expected values come from the driver source (`collectAllPages`):
- Each of `max_items`, `max_pages` and `max_bytes` set exactly to what the list needs succeeds. The exact values are two items, two pages, or the two pages' exact serialized item bytes in UTF-8. The items carry multi-byte text, so a count of code units misses the boundary. One byte less stops at `max_bytes`. (`max_duration_ms` has no exact value to hit.)
- A single last page that already passes `max_items` or `max_bytes` is refused, not returned.
- `max_bytes` exactly spent by the first page stops before a second request.
- A continuation with a malformed or non-advancing offset, or a page answering an offset the aggregate did not ask for, fails as `INVALID_RESPONSE`. The error carries the driver's reason (`invalid_continuation`, `non_progress` or `invalid_page`) and no data.
- A link naming another endpoint, another filter or another host is followed only for its offset. The second request goes to the configured host and the same endpoint, with the caller's filter. It uses the caller's stated page size on a controlled list or the link's limit on a response-driven one.
- An empty last page is described as finished, and an empty page that links to a next page is followed.
- A caller's `start_offset` is where the first request starts and what is reported (on `get_projects`, since only a controlled list has one).
- An aggregate over `max_result_bytes` is refused whole, as a single read is (on `get_projects`).
- Progress counts appear exactly as the driver's helper supplies them, and a timer deadline adds none.

`tests/pagination-disclosure.test.ts` holds what each tool says, from the inventory's paging kinds. A controlled list says `Returns one page by default. Use _mcp.pagination="all" for bounded remaining matches.` A response-driven list says `Returns the server-selected first page by default; manual continuation is unavailable. Use _mcp.pagination="all" for bounded complete retrieval.`

The 109 unpaged tools say nothing about pages, offsets, continuations or cursors. The exception is the exact warning sentences on two attachment lists. TestRail documents no paging for these lists. Their input schemas refuse `_mcp` and `query.limit`/`offset`. Neither a description nor the server instructions claim a consistent snapshot.

Exactly three paged lists say what a bare-array reply means. They say `bare array`, `has_more false`, and that all mode stops after the reply while reporting complete. These are the three lists whose hand-authored manifests carry an accepted bare-array reply: `get_attachments_for_plan`, `get_attachments_for_run` and `get_case_statuses`. No other paged list says this.

The test checks the set against the manifests. Thus, a bare-array fixture added to another list demands a disclosure there too. An accepted reply counts as a bare array the way the driver reads it. Any array counts, except on the case history, where an array holding the list's envelope is not a bare array.

The suite also scans `src/` for any import of a private driver file. It also checks that only the page describer, `src/contracts/pagination.ts`, does either of these things, comments aside:

- reads a page's `_links` (by member access, index or destructuring);
- calls `parseContinuation`.

That scan is not a proof that the server runs no fetch loop of its own, since a loop over computed offsets reads no link. The structure limits each driver callback to its one bound public method. It also pins each list's two helpers to the inventory. But a callback could still call that method again at a computed offset. Such a loop is caught by the exact request counts that `tests/paging-through-tools.test.ts` asserts on every paged list.

The mutation check covered these changes. Each fails a test:

- dropping the advance/overlap requirement;
- reporting the driver `size` as `returned`;
- permitting manual continuation on a response-driven list;
- reading controls only from the query;
- hardcoding `limit`/`offset` instead of reading the page.

Through the tools, each of these mutations fails the end-to-end suite:

- asking for a page other than the first;
- advising no next step;
- treating a response-driven list as controlled;
- ignoring any one of the four caller bounds or reading one as another;
- naming the wrong bound in the error;
- decoding the nested case history as a flat page;
- misreporting how many items an aggregate returned.

The F06 audit added nineteen more mutations. Each of them passed every test before. Seven are in the adapter:

- an empty page read as the end;
- an empty page advised as `all`;
- a `next_offset` computed from the page;
- a hardcoded reported `start_offset`;
- stripped progress;
- invented progress;
- an aggregate exempt from the result budget.

Seven are in the driver:

- `>=` for `>` on a terminal page's items;
- `>=` for `>` on a terminal page's bytes;
- `>` for `>=` on the bytes before another page;
- one terminal check removed;
- the other terminal check removed;
- `max_pages` applied to the last page;
- a next page fetched from the link's own path.

The other five are in inputs, descriptions and imports. Two of them are paging sentence mutations: one missing and one invented. The five are:

- page mode accepting `start_offset` and `max_duration_ms`;
- a missing paging sentence;
- an invented one;
- a snapshot claim;
- a private driver import.

Review then found ten more that passed earlier versions of these tests:
- `max_duration` counts stripped;
- other paging wording on unpaged tools, including "paginated" and advice added inside a warned description;
- a controlled list taking the link's limit, or falling back to the driver's default page size;
- an empty page ending the aggregate;
- a malformed offset, or an unexpected page offset, reported with the wrong reason;
- aggregate bytes counted in UTF-16 code units.

F06's closing work checked fifteen more, listed in `docs/issues/F06.md` with the tests each fails. Ten fail only a new or extended test:
- the `get_case_statuses` bare-array sentence removed, or one invented on `get_projects`;
- a bare array written into another list's manifest, plain or as an envelope wrapped in a one-element array, or the case-statuses one turned into an envelope. In each case, the expected driver result is changed to match;
- the test's own bare-array check counting the case history's nested envelope;
- the nested history decoder refusing a bare array (only the two new history rows fail);
- the driver refusing a bare array after an envelope;
- a snapshot claim in the server instructions;
- a page's `_links` read, indexed or destructured, or `parseContinuation` called, in the then-current `src/transport/tool-call.ts` (the pipeline is now in `src/execution/executor.ts`).

An older test also catches the other five:
- the plan list's bare-array sentence dropped (`tests/families/t12.test.ts`);
- the driver following a bare array with a computed offset (`tests/families/t10.test.ts` and `tests/families/t12.test.ts`);
- a legacy array advised as `all`, or given a `limit` and `offset` (`tests/pagination.test.ts`);
- a page callback that fetches the next page itself at a computed offset. It reads no link and passes the scan. It fails the older page-mode request count on its list in `tests/paging-through-tools.test.ts`.

The held first page in the duration test of this suite is stopped sometimes by the driver's own deadline check. Sometimes one of its request timers stops it. Both must be reported as `max_duration`. A fault in recognizing the timer spellings therefore fails that test only in some runs. `tests/runtime-lifetime.test.ts` forces each spelling by freezing the clock and fails every time.

Two of those checks came from earlier mistakes. An early mutation that did *not* fail showed that a hand-rolled splitter was reimplementing `URLSearchParams`. `URLSearchParams` replaced the splitter.

Review then found that the remaining parser read only `url.search`. The shape that TestRail actually emits has no `?`. Thus, the parser was internally consistent and tested against a fixture that TestRail never sends. It would have returned no continuation in production.
