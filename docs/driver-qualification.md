# Driver qualification

F01 remains open. No published driver has yet been qualified against every required runtime contract, and the MCP development dependency remains exactly `7.0.0` until F03 adopts the qualified release.

## Published 7.1.0 audit — 2026-09-10

- [Release 7.1.0](https://github.com/dichovsky/testrail-api-client/releases/tag/release/7.1.0) was published on 2026-09-09 at 22:01:07 UTC from commit `2b70e26c67e1356ab8de21e79da6d051b6038fc7`.
- It includes the network-guard fixes from [upstream PR #266](https://github.com/dichovsky/testrail-api-client/pull/266), merged at `89f636e276ea701412bb06039e3b963d83126ea1`.
- An isolated installation used the exact npm package with integrity `sha512-BLZWFPx+jtsZD4TddhGbtYaIKNyfGkqreGBje2klL5jF0xD3jnWdMANxZOAXRfuSoFyl0Vumcbw1PG19HvgxDA==`. Its public client exposes all 133 endpoint methods and 48 page/all helpers referenced by the MCP inventory.
- `trackOperation` is absent. Two sequential `reports.runReport` calls with an injected fetch made only one upstream request, confirming the report cache defect remains in this release. These checks used synthetic credentials and no live TestRail instance.

The network prerequisite is now published; report execution and operation settlement still require a new release. This audit does not qualify 7.1.0 for F03 or production.

## Upstream implementation candidate

[Driver PR #275](https://github.com/dichovsky/testrail-api-client/pull/275), commit `234dc8075e425d9f7084feb0b7f0785952d84be7`, adds independent report execution and the public `trackOperation` result/settlement handle. It owns deadline losers, shared requests and multipart cleanup without changing ordinary result semantics. Fresh independent review found a header-timeout regression; the fix and two regression tests were reviewed, with no remaining actionable findings. The branch incorporates upstream's subsequent publication-workflow change; its changelog conflict was resolved by preserving both entries.

Local candidate verification passed 4,343 tests with 23 skipped and the unchanged coverage floors, including 98.02% branch coverage. All 60 new report, settlement and upload tests passed on Node 22.13.0 and 24.20.0. Packed consumer/CLI checks passed on Node 22, 24 and 26, including public handle types, deferred-DNS settlement and independent report execution. Both TypeScript checks, lint, formatting and generated-file checks passed. The PR runs the expanded Node 22/24 checks on Linux, macOS and Windows.

This is an unpublished candidate. These results establish implementation progress and do not complete published-artifact qualification.

## Remaining qualification

Rechecked on 2026-09-15: upstream PR #275 remains open at the same candidate commit; npm's latest published driver remains 7.1.0 with the version, commit and integrity recorded above. No new release is available to qualify. F03 configuration preparation can proceed, but its runtime completion remains blocked on this prerequisite.

After the upstream changes are merged and published, install the exact release into an isolated harness, record its version, commit and npm integrity, and run every F01 acceptance check against that installed artifact. Include endpoint/helper parity, both report methods under cache/coalescing/retry scenarios, and settlement after deferred DNS, fetch, body cancellation, multipart cleanup and shared requests. Source tests or an unpublished packed candidate alone do not satisfy this release gate.

F03 then pins the qualified published package and lockfile. F01 and its dependent release gates stay open until that evidence exists.
