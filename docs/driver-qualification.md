# Driver qualification

F01 is qualified. The MCP package pins the published release `@dichovsky/testrail-api-client@9.0.0`. Its acceptance checks run as standing tests in [`tests/driver-qualification.test.ts`](../tests/driver-qualification.test.ts) against the installed artifact rather than a sibling checkout.

## Qualified release — 9.0.0, verified 2026-10-03

- [Release 9.0.0](https://github.com/dichovsky/testrail-api-client/releases/tag/release/9.0.0), tag commit `a5ccffbfa176e9c6675bd81fff61859bd7b6be5d`, published from [upstream PR #308](https://github.com/dichovsky/testrail-api-client/pull/308).
- npm integrity `sha512-CfGOEAkrEfrJTHaVY57YqzUBla3V0FP0cXXFyEfY7FcW+PdMJBp0Ro39MS9qLdz748X7fKOhdy971mZQ/rzkmg==`, matching the committed lockfile and asserted by test. Release 9.0.0 still requires Node 24 or later.
- Every check of the 7.2.0 qualification below was repeated against the installed 9.0.0 artifact. Each check passes unchanged, as it did for 8.0.0. The retry policy is unchanged, so the accepted rate-limited report retry still holds and is still asserted.
- What changed underneath, as the server sees it:
  - **Comment-only and assignee-only results, and one user email rule.** The add-result payloads make `status_id` optional and carry a refinement requiring one of `status_id`, `comment` or `assignedto_id`. The user write payloads check `email` with `TESTRAIL_USER_EMAIL_PATTERN`, the lookup's shape rule. The server had already adopted both rules on 8.0.0 (#49, #55). The server now reuses the driver's refinement, represented in JSON Schema as `anyOf`. It also drops its type assertions and the evidence harness's widened parses.
  - **DNS counts against the request timeout.** The 15-second timer now starts before the host guard's lookup. Thus, a resolver that never answers ends the call with `TIMEOUT` at 15 seconds, before any request. The lookup cannot be cancelled. Thus, the call keeps its slot until the lookup settles. `tests/runtime-timing.test.ts` shows both.
  - **Connections go direct, by default.** Each request connects through a dispatcher pinned to the DNS answers the private-host guard approved. Global proxy and agent settings, `HTTP_PROXY`/`HTTPS_PROXY` with `NODE_USE_ENV_PROXY`, and a global Undici dispatcher are no longer used for TestRail. `NODE_EXTRA_CA_CERTS` still adds trust for a private certificate authority. The server injects no transport. Thus, the server cannot use a TestRail that is reachable only through a proxy. If `TESTRAIL_ALLOW_PRIVATE_HOSTS=true`, the guard does not run and nothing is pinned. Thus, Node's own connection settings apply, a configured proxy included. `tests/driver-configuration.test.ts` holds both cases. The private-host guard also refuses three more IPv4 ranges: `198.18.0.0/15`, `224.0.0.0/4` and `240.0.0.0/4`.
  - The `User-Agent` is now the single token `testrail-api-client/9.0.0`.
- All 133 parameter manifests and the shared domain library were re-reviewed against `a5ccffb`, each with an evidence step from `7680ab6`. Every cited file's shipped build changed, because 9.0.0 drops source maps. Eight sources also changed. Each change has a note. See [driver provenance evidence](parameter-manifest.md#driver-provenance-evidence).
- The live TestRail 10.8.1 run ([live qualification](live-qualification.md)) was repeated with 9.0.0 on 2026-10-04. Nothing failed. The same 98 tools pass, 27 are blocked and 8 are left out, as with 7.2.0. A new comment-only result step passes too.

## Previously qualified release — 8.0.0, verified 2026-10-03

- [Release 8.0.0](https://github.com/dichovsky/testrail-api-client/releases/tag/release/8.0.0), tag commit `7680ab6c0d1973749e3178016a3d133af27bfb0a`, published from [upstream PR #294](https://github.com/dichovsky/testrail-api-client/pull/294).
- npm integrity `sha512-1f7zBc6owy08SCCdLADc5LmwDgtMuhb8drYbgORUhn4LbKjJJE2K28K/3KOEtuIJ8jxZ81jBx5WGGBF4FNM8mw==`, matching the committed lockfile. The pin and integrity are asserted by test, so a drifted lockfile fails CI.
- Release 8.0.0 requires Node 24 or later (`engines.node: ">=24"`). Thus, the engine range of this package narrowed to `>=24` with that release.
- Every check of the 7.2.0 qualification below was repeated against the installed 8.0.0 artifact and passes unchanged:
  - all 133 endpoint bindings and 48 page/all helpers resolve;
  - `trackOperation` keeps `settled` pending while a descendant is in flight after a lost deadline;
  - sequential and concurrent report runs each reach TestRail, with caching off and on;
  - a report run is not retried on a network error, 500 or 503 while an ordinary read is.
- What changed underneath: 8.0.0 derives the retry policy of each request from its shape (`deriveRetryPolicy`) instead of taking it from the call site. The rules are:
  - A multipart body always gets the no-retry policy.
  - A binary download gets the `binaryGet` policy.
  - A method declaring `intent: 'side-effecting-read'` gets no cache key and the rate-limit-only policy. The two report runs now declare this intent in place of `bypassCache: true` and `retry: 'rateLimitOnly'`.
- The multipart builder moved from `client-core.ts` to a new `upload-source.ts`. The behavior the standing tests observe is the same.
- The accepted rate-limited report retry below still holds and is still asserted.
- All 133 parameter manifests and the shared domain library were re-reviewed against `7680ab6`. Each carries an evidence step from `cc7751c`. Ten cited files changed. Each changed file has a note that says what changed and why the claim stands or how it was reworded. See [driver provenance evidence](parameter-manifest.md#driver-provenance-evidence).
- Not repeated: the live TestRail 10.8.1 run ([live qualification](live-qualification.md)), recorded with 7.2.0. 9.0.0 replaced 8.0.0 before the run was repeated.

## Previously qualified release — 7.2.0, verified 2026-09-17

- [Release 7.2.0](https://github.com/dichovsky/testrail-api-client/releases/tag/release/7.2.0), tag commit `cc7751c01c3d3956d061073283bee6b23bf33422`, published from [upstream PR #275](https://github.com/dichovsky/testrail-api-client/pull/275) (merged as `9d402e589d8937dda62b69fe74eac113b075a3f9`).
- npm integrity `sha512-OAVJ1uJtxC0Wzh0jaafBRRcJFhwis/jAPZP3u1441a6wGrtKiZ4JsGtPVERl2wcenKVhqHnxwjkJJExPUB6HHQ==`, matching the committed lockfile. The pin and integrity are asserted by test, so a drifted lockfile fails CI.
- All 133 endpoint bindings and 48 page/all helpers named by the [operation inventory](operation-inventory.json) resolve to functions on the constructed client.
- `trackOperation(callback)` returns `{ result, settled }`. A result deadline that loses a race leaves `settled` pending while the fetch descendant is in flight. `settled` resolves only after the descendant completes. Thus, a lost deadline is not treated as settlement.
- Report generation executes independently. Two sequential `reports.runReport` calls issue two upstream requests, with caching both disabled and enabled. Three concurrent calls issue three requests. Thus, neither the GET cache nor request coalescing suppresses a generation.
- Report generation is not retried on a network error, 500 or 503, with one upstream request each. An ordinary read retries the same failure. The difference confirms that the policy belongs to the report methods rather than a shared cap.

### Accepted behavior: rate-limited report retries

7.2.0 handles 429 in the rate limiter, above the per-method retry policy. Thus, a rate-limited `runReport` is re-sent. 8.0.0 does the same through the rate-limit-only policy that it derives for a side-effecting read. The behavior was reviewed on 2026-09-17 and accepted. The F01 criterion, originally written as "zero retries on network, 429 and 5xx", was amended to exempt 429.

TestRail rejects a rate-limited request before handling it. Thus, the re-send cannot generate the report twice or send a duplicate template-configured email. The retry ban exists to prevent this harm. A 5xx is not exempt, because the server may already have begun generating. The behavior is asserted by test, so an upstream change to it fails CI.

### Fixture provenance

The five parameter fixtures were re-reviewed against 7.2.0 rather than re-stamped. The evidence is:

- `dist/types.d.ts` is byte-identical between release commits `71a80d98` and `cc7751c`;
- all 53 exported payload schemas have identical field sets;
- none of the eight driver source files that the fixtures cited at the time appear among the 54 files changed between those commits.

The `review` blocks and source links of the fixtures now refer to `cc7751c`.

That comparison is now data that the manifest audit checks rather than prose. Each of the five manifests carries a `review.evidence` step from `71a80d98` to `cc7751c` that names every driver file it cites and whether the file changed. The audit compares each claim with [`tests/fixtures/driver-releases.json`](../tests/fixtures/driver-releases.json). That file records both releases' git blob IDs and shipped-file hashes. The 7.2.0 entry is held to the installed package. See [driver provenance evidence](parameter-manifest.md#driver-provenance-evidence).

## Superseded audits

- **8.0.0, 2026-10-03.** Qualified and pinned until later that day, when 9.0.0 replaced it. Its record is kept above.
- **7.2.0, 2026-09-17.** Qualified and pinned until 2026-10-03, when 8.0.0 replaced it. Its record is kept above.
- **7.1.0, 2026-09-10.** Included the network-guard fixes from [upstream PR #266](https://github.com/dichovsky/testrail-api-client/pull/266) and all 181 endpoint/helper bindings, but had no `trackOperation`. Two sequential `reports.runReport` calls made only one upstream request. Not qualified.
- **7.0.0.** The original development baseline, release commit `71a80d984aea14713d8eeaf6ac9a0d41c1fba12b`, without the network-guard fixes.

## Remaining release dependencies

Qualification covers the driver contract only. R03 also requires live TestRail 10.8.1 evidence. A later driver upgrade requires these items:

- an exact dependency review;
- an inventory/parameter diff;
- a repeat of the checks above against the newly installed artifact.

The 8.0.0 and 9.0.0 upgrades did these steps on 2026-10-03, and the live run on 9.0.0 followed on 2026-10-04.
