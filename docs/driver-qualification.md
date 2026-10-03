# Driver qualification

F01 is qualified. The MCP package pins the published release `@dichovsky/testrail-api-client@9.0.0`, and its acceptance checks run as standing tests in [`tests/driver-qualification.test.ts`](../tests/driver-qualification.test.ts) against the installed artifact rather than a sibling checkout.

## Qualified release — 9.0.0, verified 2026-10-03

- [Release 9.0.0](https://github.com/dichovsky/testrail-api-client/releases/tag/release/9.0.0), tag commit `a5ccffbfa176e9c6675bd81fff61859bd7b6be5d`, published from [upstream PR #308](https://github.com/dichovsky/testrail-api-client/pull/308).
- npm integrity `sha512-CfGOEAkrEfrJTHaVY57YqzUBla3V0FP0cXXFyEfY7FcW+PdMJBp0Ro39MS9qLdz748X7fKOhdy971mZQ/rzkmg==`, matching the committed lockfile and asserted by test. It still requires Node 24 or later.
- Every check of the 7.2.0 qualification below was repeated against the installed 9.0.0 artifact and passes unchanged, as it did for 8.0.0. The retry policy is unchanged, so the accepted rate-limited report retry still holds and is still asserted.
- What changed underneath, as the server sees it:
  - **Comment-only and assignee-only results, and one user email rule.** The add-result payloads make `status_id` optional and carry a refinement requiring one of `status_id`, `comment` or `assignedto_id`. The user write payloads check `email` with `TESTRAIL_USER_EMAIL_PATTERN`, the lookup's shape rule. The server had already adopted both rules on 8.0.0 (#49, #55). It now reuses the driver's refinement, represented in JSON Schema as `anyOf`, and drops its type assertions and the evidence harness's widened parses.
  - **DNS counts against the request timeout.** The 15-second timer now starts before the host guard's lookup, so a resolver that never answers ends the call with `TIMEOUT` at 15 seconds, before any request. The lookup cannot be cancelled, so the call keeps its slot until the lookup settles; `tests/runtime-timing.test.ts` shows both.
  - **Connections go direct, by default.** Each request connects through a dispatcher pinned to the DNS answers the private-host guard approved. Global proxy and agent settings, `HTTP_PROXY`/`HTTPS_PROXY` with `NODE_USE_ENV_PROXY`, and a global Undici dispatcher are no longer used for TestRail. `NODE_EXTRA_CA_CERTS` still adds trust for a private certificate authority. The server injects no transport, so a TestRail reachable only through a proxy cannot be used that way. With `TESTRAIL_ALLOW_PRIVATE_HOSTS=true` the guard does not run and nothing is pinned, so Node's own connection settings apply, a configured proxy included; `tests/driver-configuration.test.ts` holds both cases. The private-host guard also refuses three more IPv4 ranges: `198.18.0.0/15`, `224.0.0.0/4` and `240.0.0.0/4`.
  - The `User-Agent` is now the single token `testrail-api-client/9.0.0`.
- All 133 parameter manifests and the shared domain library were re-reviewed against `a5ccffb`, each with an evidence step from `7680ab6`. Every cited file's shipped build changed, because 9.0.0 drops source maps, and eight sources changed; each change has a note. See [driver provenance evidence](parameter-manifest.md#driver-provenance-evidence).
- The live TestRail 10.8.1 run ([live qualification](live-qualification.md)) was recorded with 7.2.0, so it has to be repeated with 9.0.0 before release.

## Previously qualified release — 8.0.0, verified 2026-10-03

- [Release 8.0.0](https://github.com/dichovsky/testrail-api-client/releases/tag/release/8.0.0), tag commit `7680ab6c0d1973749e3178016a3d133af27bfb0a`, published from [upstream PR #294](https://github.com/dichovsky/testrail-api-client/pull/294).
- npm integrity `sha512-1f7zBc6owy08SCCdLADc5LmwDgtMuhb8drYbgORUhn4LbKjJJE2K28K/3KOEtuIJ8jxZ81jBx5WGGBF4FNM8mw==`, matching the committed lockfile. The pin and integrity are asserted by test, so a drifted lockfile fails CI.
- It requires Node 24 or later (`engines.node: ">=24"`), so this package's engine range narrowed to `>=24` with it.
- Every check of the 7.2.0 qualification below was repeated against the installed 8.0.0 artifact and passes unchanged: all 133 endpoint bindings and 48 page/all helpers resolve; `trackOperation` keeps `settled` pending while a descendant is in flight after a lost deadline; sequential and concurrent report runs each reach TestRail, with caching off and on; and a report run is not retried on a network error, 500 or 503 while an ordinary read is.
- What changed underneath: 8.0.0 derives each request's retry policy from its shape (`deriveRetryPolicy`) instead of taking it from the call site. A multipart body always gets the no-retry policy, a binary download the `binaryGet` policy, and a method declaring `intent: 'side-effecting-read'`, which the two report runs now do in place of `bypassCache: true` and `retry: 'rateLimitOnly'`, gets no cache key and the rate-limit-only policy. The multipart builder moved from `client-core.ts` to a new `upload-source.ts`. The behavior the standing tests observe is the same.
- The accepted rate-limited report retry below still holds and is still asserted.
- All 133 parameter manifests and the shared domain library were re-reviewed against `7680ab6`. Each carries an evidence step from `cc7751c`; ten cited files changed, and each changed file has a note saying what changed and why the claim stands or how it was reworded. See [driver provenance evidence](parameter-manifest.md#driver-provenance-evidence).
- Not repeated: the live TestRail 10.8.1 run ([live qualification](live-qualification.md)), recorded with 7.2.0. 9.0.0 replaced 8.0.0 before it was.

## Previously qualified release — 7.2.0, verified 2026-09-17

- [Release 7.2.0](https://github.com/dichovsky/testrail-api-client/releases/tag/release/7.2.0), tag commit `cc7751c01c3d3956d061073283bee6b23bf33422`, published from [upstream PR #275](https://github.com/dichovsky/testrail-api-client/pull/275) (merged as `9d402e589d8937dda62b69fe74eac113b075a3f9`).
- npm integrity `sha512-OAVJ1uJtxC0Wzh0jaafBRRcJFhwis/jAPZP3u1441a6wGrtKiZ4JsGtPVERl2wcenKVhqHnxwjkJJExPUB6HHQ==`, matching the committed lockfile. The pin and integrity are asserted by test, so a drifted lockfile fails CI.
- All 133 endpoint bindings and 48 page/all helpers named by the [operation inventory](operation-inventory.json) resolve to functions on the constructed client.
- `trackOperation(callback)` returns `{ result, settled }`. A result deadline that loses a race leaves `settled` pending while the fetch descendant is in flight, and `settled` resolves only after the descendant completes. A lost deadline is therefore not treated as settlement.
- Report generation executes independently: two sequential `reports.runReport` calls issue two upstream requests with caching both disabled and enabled, and three concurrent calls issue three requests, so neither the GET cache nor request coalescing suppresses a generation.
- Report generation is not retried on a network error, 500 or 503 — one upstream request each — while an ordinary read retries the same failure, confirming the policy belongs to the report methods rather than a shared cap.

### Accepted behavior: rate-limited report retries

7.2.0 handles 429 in the rate limiter, above the per-method retry policy, so a rate-limited `runReport` is re-sent; 8.0.0 does the same through the rate-limit-only policy it derives for a side-effecting read. This was reviewed on 2026-09-17 and accepted; the F01 criterion, originally written as "zero retries on network, 429 and 5xx", was amended to exempt 429.

TestRail rejects a rate-limited request before handling it, so the re-send cannot generate the report twice or send a duplicate template-configured email — the harm the retry ban exists to prevent. A 5xx is not exempt, because the server may already have begun generating. The behavior is asserted by test, so an upstream change to it fails CI.

### Fixture provenance

The five parameter fixtures were re-reviewed against 7.2.0 rather than re-stamped. Evidence: `dist/types.d.ts` is byte-identical between release commits `71a80d98` and `cc7751c`; all 53 exported payload schemas have identical field sets; and none of the eight driver source files the fixtures cited at the time appear among the 54 files changed between those commits. Their `review` blocks and source links now point at `cc7751c`.

That comparison is now data the manifest audit checks rather than prose. Each of the five manifests carries a `review.evidence` step from `71a80d98` to `cc7751c` that names every driver file it cites and whether the file changed. The audit compares each claim with [`tests/fixtures/driver-releases.json`](../tests/fixtures/driver-releases.json), which records both releases' git blob IDs and shipped-file hashes; the 7.2.0 entry is held to the installed package. See [driver provenance evidence](parameter-manifest.md#driver-provenance-evidence).

## Superseded audits

- **8.0.0, 2026-10-03.** Qualified and pinned until later that day, when 9.0.0 replaced it. Its record is kept above.
- **7.2.0, 2026-09-17.** Qualified and pinned until 2026-10-03, when 8.0.0 replaced it. Its record is kept above.
- **7.1.0, 2026-09-10.** Included the network-guard fixes from [upstream PR #266](https://github.com/dichovsky/testrail-api-client/pull/266) and all 181 endpoint/helper bindings, but had no `trackOperation`, and two sequential `reports.runReport` calls made only one upstream request. Not qualified.
- **7.0.0.** The original development baseline, release commit `71a80d984aea14713d8eeaf6ac9a0d41c1fba12b`, without the network-guard fixes.

## Remaining release dependencies

Qualification covers the driver contract only. R03 also requires live TestRail 10.8.1 evidence, and a later driver upgrade requires an exact dependency review, inventory/parameter diff and a repeat of the checks above against the newly installed artifact. The 8.0.0 and 9.0.0 upgrades did that on 2026-10-03; the live run on 9.0.0 is still owed.
