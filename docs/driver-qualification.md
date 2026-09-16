# Driver qualification

F01 is qualified except for one recorded deviation. The MCP package pins the published release `@dichovsky/testrail-api-client@7.2.0`, and its acceptance checks run as standing tests in [`tests/driver-qualification.test.ts`](../tests/driver-qualification.test.ts) against the installed artifact rather than a sibling checkout.

## Qualified release — 7.2.0, verified 2026-09-17

- [Release 7.2.0](https://github.com/dichovsky/testrail-api-client/releases/tag/release/7.2.0), tag commit `cc7751c01c3d3956d061073283bee6b23bf33422`, published from [upstream PR #275](https://github.com/dichovsky/testrail-api-client/pull/275) (merged as `9d402e589d8937dda62b69fe74eac113b075a3f9`).
- npm integrity `sha512-OAVJ1uJtxC0Wzh0jaafBRRcJFhwis/jAPZP3u1441a6wGrtKiZ4JsGtPVERl2wcenKVhqHnxwjkJJExPUB6HHQ==`, matching the committed lockfile. The pin and integrity are asserted by test, so a drifted lockfile fails CI.
- All 133 endpoint bindings and 48 page/all helpers named by the [operation inventory](operation-inventory.json) resolve to functions on the constructed client.
- `trackOperation(callback)` returns `{ result, settled }`. A result deadline that loses a race leaves `settled` pending while the fetch descendant is in flight, and `settled` resolves only after the descendant completes. A lost deadline is therefore not treated as settlement.
- Report generation executes independently: two sequential `reports.runReport` calls issue two upstream requests with caching both disabled and enabled, and three concurrent calls issue three requests, so neither the GET cache nor request coalescing suppresses a generation.
- Report generation is not retried on a network error, 500 or 503 — one upstream request each — while an ordinary read retries the same failure, confirming the policy belongs to the report methods rather than a shared cap.

### Recorded deviation: rate-limited report retries

F01 requires zero report retries on "network, 429 and 5xx failures". 7.2.0 satisfies this for network errors and 5xx but **not for 429**: a rate-limited `runReport` is re-sent four times, because 7.2.0 handles 429 in the rate limiter, above the per-method retry policy.

TestRail rejects a rate-limited request before handling it, so the re-send cannot duplicate report generation or a template-configured email — the harm the retry ban exists to prevent. The behavior is asserted by test so that any upstream change is visible. Whether to tighten the driver or amend the criterion with this rationale is an open decision recorded on [F01](https://github.com/dichovsky/testrail-mcp/issues/2); until it is settled, F01 stays open.

### Fixture provenance

The five parameter fixtures were re-reviewed against 7.2.0 rather than re-stamped. Evidence: `dist/types.d.ts` is byte-identical between release commits `71a80d98` and `cc7751c`; all 53 exported payload schemas have identical field sets; and none of the eight driver source files the fixtures cite appear among the 54 files changed between those commits. Their `review` blocks and source links now point at `cc7751c`.

## Superseded audits

- **7.1.0, 2026-09-10.** Included the network-guard fixes from [upstream PR #266](https://github.com/dichovsky/testrail-api-client/pull/266) and all 181 endpoint/helper bindings, but had no `trackOperation`, and two sequential `reports.runReport` calls made only one upstream request. Not qualified.
- **7.0.0.** The original development baseline, release commit `71a80d984aea14713d8eeaf6ac9a0d41c1fba12b`, without the network-guard fixes.

## Remaining release dependencies

Qualification covers the driver contract only. R03 still requires live TestRail 10.7.0 evidence, and a later driver upgrade requires an exact dependency review, inventory/parameter diff and a repeat of the checks above against the newly installed artifact.
