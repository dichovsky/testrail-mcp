# Implementation plan

Status: the original delivery backlog is complete. F01 is qualified. The package pins published `9.0.0`. Its [qualification evidence](driver-qualification.md) runs as standing tests against the installed artifact.

The foundations that the endpoint families depend on are merged:

- configuration;
- [runtime lifetime](runtime-lifetime.md);
- the [registry](registry-authoring.md);
- [results](results-and-errors.md);
- [paging](pagination.md);
- [local files](local-files.md);
- the [stdio transport](transport.md).

All twelve endpoint families, T01–T12, are merged too. Thus, the server registers every one of the 133 endpoint tools, each with a complete parameter manifest. The regression gates of [R01](https://github.com/dichovsky/testrail-mcp/issues/22) hold that coverage offline. CI publishes the [coverage reports](coverage-reports.md) as artifacts.

The owner closed client qualification ([R02](https://github.com/dichovsky/testrail-mcp/issues/23)) on 2026-10-04 with the results that the [client guide](client-compatibility.md#required-surfaces-and-evidence) lists. Version 1.0.0 was published on 2026-10-04. [R03](https://github.com/dichovsky/testrail-mcp/issues/24) is closed. The [release record](issues/R03.md#released--2026-10-04) documents publication and post-publication verification. The release includes the complete 133-tool baseline, with live and client qualification limitations recorded in the [release notes](../CHANGELOG.md#100---2026-10-04).

The server is a local stdio adapter around `@dichovsky/testrail-api-client`, with one configured TestRail identity per subprocess. It exposes exactly **133 endpoint tools across 28 resources**, enabled by default, including administration and destructive operations. The tools cover the TestRail 10.7.0 API reference. TestRail 10.8.1 is the compatibility baseline, because the live qualification runs against that version. Older versions are best effort. Required clients are Codex desktop/CLI, Claude Code and GitHub Copilot CLI.

The [architecture](architecture.md) defines component boundaries and accepted behavior. The [implementation contracts](implementation-contracts.md) define exact inputs, outputs, budgets, configuration, error outcomes, files and lifecycle. The [inventory](operation-inventory.json) and [coverage table](api-coverage.md) define every endpoint and public driver binding. These requirements apply to every issue below.

The subsequent [architecture refactoring plan](architecture-refactoring.md) records the completed input-contract, list-definition and operation-executor changes, merged in [#130](https://github.com/dichovsky/testrail-mcp/pull/130), [#132](https://github.com/dichovsky/testrail-mcp/pull/132) and [#133](https://github.com/dichovsky/testrail-mcp/pull/133). All 133 tools retain their published contracts. Executor local gates and mutation checks passed on 2026-11-21. Both fresh independent reviews are complete. The test-review finding was fixed and rechecked. The original delivery plan below is retained as historical scope, dependencies and acceptance criteria.

## Work items and dependencies

Tracking epic: [EPIC](https://github.com/dichovsky/testrail-mcp/issues/1). There are **23 implementation issues**, each with scope, explicit dependencies and acceptance/verification criteria. The [issue manifest](implementation-items.json) records IDs, endpoint ownership and published issue links. [Local issue bodies](issues/) retain the reviewable text.

| Item | Deliverable | Depends on | Endpoint tools |
| --- | --- | --- | ---: |
| [F01](https://github.com/dichovsky/testrail-mcp/issues/2) | Qualify and pin a published TestRail driver with required runtime fixes | None | — |
| [F02](https://github.com/dichovsky/testrail-mcp/issues/3) | Scaffold the TypeScript ESM package and baseline CI | None | — |
| [F03](https://github.com/dichovsky/testrail-mcp/issues/4) | Implement configuration, driver ownership and bounded invocation lifetime | [F01](https://github.com/dichovsky/testrail-mcp/issues/2), [F02](https://github.com/dichovsky/testrail-mcp/issues/3) | — |
| [F04](https://github.com/dichovsky/testrail-mcp/issues/5) | Build the operation registry, strict inputs and parameter manifest | [F02](https://github.com/dichovsky/testrail-mcp/issues/3) | — |
| [F05](https://github.com/dichovsky/testrail-mcp/issues/6) | Implement preserved results, per-call warnings and truthful errors | [F03](https://github.com/dichovsky/testrail-mcp/issues/4), [F04](https://github.com/dichovsky/testrail-mcp/issues/5) | — |
| [F06](https://github.com/dichovsky/testrail-mcp/issues/7) | Implement page defaults and bounded complete aggregation | [F05](https://github.com/dichovsky/testrail-mcp/issues/6) | — |
| [F07](https://github.com/dichovsky/testrail-mcp/issues/8) | Implement shared upload staging and persistent attachment downloads | [F03](https://github.com/dichovsky/testrail-mcp/issues/4), [F05](https://github.com/dichovsky/testrail-mcp/issues/6) | — |
| [F08](https://github.com/dichovsky/testrail-mcp/issues/9) | Wire stdio MCP with legacy and current protocol compatibility | [F03](https://github.com/dichovsky/testrail-mcp/issues/4), [F04](https://github.com/dichovsky/testrail-mcp/issues/5), [F05](https://github.com/dichovsky/testrail-mcp/issues/6) | — |
| [T01](https://github.com/dichovsky/testrail-mcp/issues/10) | Implement Projects, Suites, Sections endpoint tools (16) | [F03](https://github.com/dichovsky/testrail-mcp/issues/4), [F04](https://github.com/dichovsky/testrail-mcp/issues/5), [F05](https://github.com/dichovsky/testrail-mcp/issues/6), [F06](https://github.com/dichovsky/testrail-mcp/issues/7) | 16 |
| [T02](https://github.com/dichovsky/testrail-mcp/issues/11) | Implement Cases endpoint tools (12) | [F03](https://github.com/dichovsky/testrail-mcp/issues/4), [F04](https://github.com/dichovsky/testrail-mcp/issues/5), [F05](https://github.com/dichovsky/testrail-mcp/issues/6), [F06](https://github.com/dichovsky/testrail-mcp/issues/7) | 12 |
| [T03](https://github.com/dichovsky/testrail-mcp/issues/12) | Implement BDD, Shared Steps endpoint tools (10) | [F03](https://github.com/dichovsky/testrail-mcp/issues/4), [F04](https://github.com/dichovsky/testrail-mcp/issues/5), [F05](https://github.com/dichovsky/testrail-mcp/issues/6), [F06](https://github.com/dichovsky/testrail-mcp/issues/7), [F07](https://github.com/dichovsky/testrail-mcp/issues/8) | 10 |
| [T04](https://github.com/dichovsky/testrail-mcp/issues/13) | Implement Runs, Tests endpoint tools (10) | [F03](https://github.com/dichovsky/testrail-mcp/issues/4), [F04](https://github.com/dichovsky/testrail-mcp/issues/5), [F05](https://github.com/dichovsky/testrail-mcp/issues/6), [F06](https://github.com/dichovsky/testrail-mcp/issues/7) | 10 |
| [T05](https://github.com/dichovsky/testrail-mcp/issues/14) | Implement Results endpoint tools (8) | [F03](https://github.com/dichovsky/testrail-mcp/issues/4), [F04](https://github.com/dichovsky/testrail-mcp/issues/5), [F05](https://github.com/dichovsky/testrail-mcp/issues/6), [F06](https://github.com/dichovsky/testrail-mcp/issues/7) | 8 |
| [T06](https://github.com/dichovsky/testrail-mcp/issues/15) | Implement Plans, Configurations endpoint tools (19) | [F03](https://github.com/dichovsky/testrail-mcp/issues/4), [F04](https://github.com/dichovsky/testrail-mcp/issues/5), [F05](https://github.com/dichovsky/testrail-mcp/issues/6), [F06](https://github.com/dichovsky/testrail-mcp/issues/7) | 19 |
| [T07](https://github.com/dichovsky/testrail-mcp/issues/16) | Implement Milestones, Labels endpoint tools (11) | [F03](https://github.com/dichovsky/testrail-mcp/issues/4), [F04](https://github.com/dichovsky/testrail-mcp/issues/5), [F05](https://github.com/dichovsky/testrail-mcp/issues/6), [F06](https://github.com/dichovsky/testrail-mcp/issues/7) | 11 |
| [T08](https://github.com/dichovsky/testrail-mcp/issues/17) | Implement Users, Groups, Roles endpoint tools (12) | [F03](https://github.com/dichovsky/testrail-mcp/issues/4), [F04](https://github.com/dichovsky/testrail-mcp/issues/5), [F05](https://github.com/dichovsky/testrail-mcp/issues/6), [F06](https://github.com/dichovsky/testrail-mcp/issues/7) | 12 |
| [T09](https://github.com/dichovsky/testrail-mcp/issues/18) | Implement Datasets, Variables endpoint tools (9) | [F03](https://github.com/dichovsky/testrail-mcp/issues/4), [F04](https://github.com/dichovsky/testrail-mcp/issues/5), [F05](https://github.com/dichovsky/testrail-mcp/issues/6), [F06](https://github.com/dichovsky/testrail-mcp/issues/7) | 9 |
| [T10](https://github.com/dichovsky/testrail-mcp/issues/19) | Implement Case Fields, Case Types, Dynamic Filter Fields, Priorities, Result Fields, Statuses, Templates, Versions endpoint tools (10) | [F03](https://github.com/dichovsky/testrail-mcp/issues/4), [F04](https://github.com/dichovsky/testrail-mcp/issues/5), [F05](https://github.com/dichovsky/testrail-mcp/issues/6), [F06](https://github.com/dichovsky/testrail-mcp/issues/7) | 10 |
| [T11](https://github.com/dichovsky/testrail-mcp/issues/20) | Implement Reports endpoint tools (4) | [F03](https://github.com/dichovsky/testrail-mcp/issues/4), [F04](https://github.com/dichovsky/testrail-mcp/issues/5), [F05](https://github.com/dichovsky/testrail-mcp/issues/6), [F01](https://github.com/dichovsky/testrail-mcp/issues/2) | 4 |
| [T12](https://github.com/dichovsky/testrail-mcp/issues/21) | Implement Attachments endpoint tools (12) | [F03](https://github.com/dichovsky/testrail-mcp/issues/4), [F04](https://github.com/dichovsky/testrail-mcp/issues/5), [F05](https://github.com/dichovsky/testrail-mcp/issues/6), [F06](https://github.com/dichovsky/testrail-mcp/issues/7), [F07](https://github.com/dichovsky/testrail-mcp/issues/8) | 12 |
| [R01](https://github.com/dichovsky/testrail-mcp/issues/22) | Enforce exhaustive endpoint, parameter and protocol regression gates | [F08](https://github.com/dichovsky/testrail-mcp/issues/9), [T01](https://github.com/dichovsky/testrail-mcp/issues/10), [T02](https://github.com/dichovsky/testrail-mcp/issues/11), [T03](https://github.com/dichovsky/testrail-mcp/issues/12), [T04](https://github.com/dichovsky/testrail-mcp/issues/13), [T05](https://github.com/dichovsky/testrail-mcp/issues/14), [T06](https://github.com/dichovsky/testrail-mcp/issues/15), [T07](https://github.com/dichovsky/testrail-mcp/issues/16), [T08](https://github.com/dichovsky/testrail-mcp/issues/17), [T09](https://github.com/dichovsky/testrail-mcp/issues/18), [T10](https://github.com/dichovsky/testrail-mcp/issues/19), [T11](https://github.com/dichovsky/testrail-mcp/issues/20), [T12](https://github.com/dichovsky/testrail-mcp/issues/21) | — |
| [R02](https://github.com/dichovsky/testrail-mcp/issues/23) | Document and qualify Codex, Claude Code and Copilot CLI | [R01](https://github.com/dichovsky/testrail-mcp/issues/22), [F07](https://github.com/dichovsky/testrail-mcp/issues/8), [F08](https://github.com/dichovsky/testrail-mcp/issues/9) | — |
| [R03](https://github.com/dichovsky/testrail-mcp/issues/24) | Qualify TestRail 10.7 and ship the complete npm release | [F01](https://github.com/dichovsky/testrail-mcp/issues/2), [R01](https://github.com/dichovsky/testrail-mcp/issues/22), [R02](https://github.com/dichovsky/testrail-mcp/issues/23) | — |

Dependencies describe completion prerequisites. An implementer may prepare fixtures or parallel code ahead of a dependency, but cannot close an item until its prerequisites and acceptance checks are satisfied. F01's published driver is now qualified and pinned at exact `9.0.0` (first qualified at `7.2.0`, then `8.0.0`). Thus, F03 runtime completion, T11 and R03 are no longer waiting on an upstream release.

A public method result deadline is not proof that DNS/fetch/body cleanup has settled. The added F03 → F01 dependency makes that runtime prerequisite explicit.

## Execution sequence

1. **Foundation:** pursue F01 upstream qualification and F02 package/CI in parallel. F01 includes network-guard fixes, report-generation cache/coalescing/retry behavior and a public per-operation result/settlement handle. F01 must name an actual published version, not a guessed future version.
2. **Shared adapter:** after F02, F04 registry/input work can proceed while F01 qualifies the enhanced driver. F03 runtime/configuration may be prepared in parallel, but completes only after both F01 and F02. F03 adopts the qualified package and uses its settlement handle. F05 results/errors follows both. F06 pagination, F07 files and F08 stdio can then proceed alongside one another.
3. **Endpoint families:** implement T01–T12 in parallel as their shared dependencies are ready. Keep the public registry stable and partition edits by family. T03/T12 share F07. T11 depends on F01. Each family owns its complete independent parameter manifest and fixtures, not only a handler list.
4. **Integrated qualification:** R01 assembles exhaustive endpoint/parameter/protocol gates. R02 verifies the required client surfaces and setup documentation against the packed candidate.
5. **Release:** R03 verifies the TestRail 10.8.1 baseline and final candidate, then publishes through the repository release process when authorized. All 133 operations and all required evidence must be complete before the full release is ready.

## Common definition of done

- The exact tool name, REST method/route, public driver method and supported parameters match the reviewed baseline. Generated schemas agree with runtime validation. No endpoint or parameter is silently omitted.
- Inputs validate before invocation, preserve supported custom fields and sentinel/null distinctions, and remain operation-specific. All tools stay enabled. No startup write unlock or server confirmation parameter is added.
- Results preserve driver data, correctly describe paging, warn per call on usable entity drift and reject unusable outer structures. Errors distinguish calls never started, unknown effects and acknowledged writes whose output failed.
- Applicable fixture tests invoke the real driver through injected fetch/DNS and independently assert serialized requests. Include valid variants and important negative cases. Expected requests must not be generated from the same registry under test.
- Targeted tests, build, typecheck and lint pass. Shared changes run affected regression gates. Documentation and inventory status are updated only to reflect work actually verified.

## Release gates and evidence

| Gate | Required evidence | Owner |
| --- | --- | --- |
| Published driver | Exact version/integrity with required runtime fixes. Public export and endpoint parity. Report requests execute independently without retries. Per-operation settlement remains pending for deadline losers | F01 |
| Endpoint and parameter coverage | All 133 bindings, 28 resources, 24 page/all pairs and every supported parameter; independent positive/negative fixtures and omission-detection regressions | T01–T12, R01 |
| Runtime and local files | Bounded calls/downloads, per-caller warnings, complete-result byte caps, honest cancellation/write outcomes, staging cleanup after actual descendant settlement, persistent completed downloads and accurate local-effect annotations | F03, F05–F07, R01 |
| Protocol and packaging | Legacy initialization plus MCP 2026-07-28 discovery; protocol-only stdout; tarball install and executable checks on Node 24 across Linux/macOS/Windows | F02, F08, R01 |
| Required clients | Exact versions/builds, models/providers, settings and C01–C12 results for Codex desktop, Codex CLI, Claude Code and Copilot CLI. For 1.0.0 the owner accepted Claude Code's record, Codex CLI's reported result and no test of the other two. The release notes list all of them (owner's decision, 2026-10-04, in [R02](issues/R02.md)) | R02 |
| TestRail 10.8.1 | Dedicated disposable project, operation-level live evidence and truthful availability reporting. A tool that the license of the instance or its permissions block is a documented limitation in the release notes, never a pass (owner's decision, 2026-10-03, in [R03](issues/R03.md)) | R03 |
| Published artifact | Tested version/tag/lockfile/provenance, authorized npm release and post-publication install verification | R03 |

The deterministic suite needs no live credentials. Live qualification and model-facing client tests require available accounts, clients and a dedicated TestRail environment during implementation. Their absence is a recorded outstanding prerequisite, not a reason to claim a pass or reduce API coverage. Destructive fixtures and live cleanup target disposable test data. Report templates used in live tests must have deliberate notification settings.

The 133-operation baseline is versioned, not a claim to cover future TestRail releases automatically. Driver upgrades require exact dependency review, inventory/parameter diff and regression qualification. Newly discovered gaps are explicit upstream/release dependencies. The MCP layer does not introduce an independent TestRail HTTP implementation.

## Planning verification

The planning inventory was checked against the selected driver source and the published 7.0.0 artifact. The counts were:

- 133 endpoint methods;
- 48 additional page/all helpers;
- 28 resource groups;
- 12 implementation families.

All 133 endpoint tools are assigned exactly once. The 23-item dependency graph is acyclic. This check validates the plan's accounting, not the future server's implementation or live compatibility.

Publication verification on 2026-09-09 confirmed these facts:

- The tracking epic and all 23 implementation issues are open.
- Their titles, bodies, numbers and URLs match the saved issue files and manifest.

Documentation links and dependency references were checked after publication.

A fresh review on 2026-09-10 identified and resolved two planning gaps:

- observable driver settlement after internal deadlines;
- MCP annotations for persistent attachment downloads.

The revised plan does these things:

- It adds F03's completion dependency on F01.
- It specifies the required upstream settlement API and regression cases.
- It separates local file effects from TestRail mutation/retry policy.

The reviewer rechecked the revisions with no remaining concrete findings. All 23 work items remain acyclic. All 133 endpoints remain assigned exactly once. These are planning fixes. The upstream API and server tests remain implementation work.
