# Implementation plan

Status: architecture and implementation backlog defined on 2026-09-09. All implementation and release checks below remain to be executed. The first release must deliver the complete baseline; completing a subset is not a reduced-scope release.

The server is a local stdio adapter around `@dichovsky/testrail-api-client`, with one configured TestRail identity per subprocess. It exposes exactly **133 endpoint tools across 28 resources**, enabled by default, including administration and destructive operations. TestRail 10.7.0 is the compatibility baseline; older versions are best effort. Required clients are Codex desktop/CLI, Claude Code and GitHub Copilot CLI.

The [architecture](architecture.md) defines component boundaries and accepted behavior. The [implementation contracts](implementation-contracts.md) define exact inputs, outputs, budgets, configuration, error outcomes, files and lifecycle. The [inventory](operation-inventory.json) and [coverage table](api-coverage.md) define every endpoint and public driver binding. These requirements apply to every issue below.

## Work items and dependencies

Tracking epic: [EPIC](issues/EPIC.md). There are **23 implementation issues**, each with scope, explicit dependencies and acceptance/verification criteria. The [issue manifest](implementation-items.json) records IDs, endpoint ownership and published issue links; [local issue bodies](issues/) retain the reviewable text.

| Item | Deliverable | Depends on | Endpoint tools |
| --- | --- | --- | ---: |
| [F01](issues/F01.md) | Qualify and pin a published TestRail driver with required runtime fixes | None | — |
| [F02](issues/F02.md) | Scaffold the TypeScript ESM package and baseline CI | None | — |
| [F03](issues/F03.md) | Implement configuration, driver ownership and bounded invocation lifetime | [F02](issues/F02.md) | — |
| [F04](issues/F04.md) | Build the operation registry, strict inputs and parameter manifest | [F02](issues/F02.md) | — |
| [F05](issues/F05.md) | Implement preserved results, per-call warnings and truthful errors | [F03](issues/F03.md), [F04](issues/F04.md) | — |
| [F06](issues/F06.md) | Implement page defaults and bounded complete aggregation | [F05](issues/F05.md) | — |
| [F07](issues/F07.md) | Implement shared upload staging and persistent attachment downloads | [F03](issues/F03.md), [F05](issues/F05.md) | — |
| [F08](issues/F08.md) | Wire stdio MCP with legacy and current protocol compatibility | [F03](issues/F03.md), [F04](issues/F04.md), [F05](issues/F05.md) | — |
| [T01](issues/T01.md) | Implement Projects, Suites, Sections endpoint tools (16) | [F03](issues/F03.md), [F04](issues/F04.md), [F05](issues/F05.md), [F06](issues/F06.md) | 16 |
| [T02](issues/T02.md) | Implement Cases endpoint tools (12) | [F03](issues/F03.md), [F04](issues/F04.md), [F05](issues/F05.md), [F06](issues/F06.md) | 12 |
| [T03](issues/T03.md) | Implement BDD, Shared Steps endpoint tools (10) | [F03](issues/F03.md), [F04](issues/F04.md), [F05](issues/F05.md), [F06](issues/F06.md), [F07](issues/F07.md) | 10 |
| [T04](issues/T04.md) | Implement Runs, Tests endpoint tools (10) | [F03](issues/F03.md), [F04](issues/F04.md), [F05](issues/F05.md), [F06](issues/F06.md) | 10 |
| [T05](issues/T05.md) | Implement Results endpoint tools (8) | [F03](issues/F03.md), [F04](issues/F04.md), [F05](issues/F05.md), [F06](issues/F06.md) | 8 |
| [T06](issues/T06.md) | Implement Plans, Configurations endpoint tools (19) | [F03](issues/F03.md), [F04](issues/F04.md), [F05](issues/F05.md), [F06](issues/F06.md) | 19 |
| [T07](issues/T07.md) | Implement Milestones, Labels endpoint tools (11) | [F03](issues/F03.md), [F04](issues/F04.md), [F05](issues/F05.md), [F06](issues/F06.md) | 11 |
| [T08](issues/T08.md) | Implement Users, Groups, Roles endpoint tools (12) | [F03](issues/F03.md), [F04](issues/F04.md), [F05](issues/F05.md), [F06](issues/F06.md) | 12 |
| [T09](issues/T09.md) | Implement Datasets, Variables endpoint tools (9) | [F03](issues/F03.md), [F04](issues/F04.md), [F05](issues/F05.md), [F06](issues/F06.md) | 9 |
| [T10](issues/T10.md) | Implement Case Fields, Case Types, Dynamic Filter Fields, Priorities, Result Fields, Statuses, Templates, Versions endpoint tools (10) | [F03](issues/F03.md), [F04](issues/F04.md), [F05](issues/F05.md), [F06](issues/F06.md) | 10 |
| [T11](issues/T11.md) | Implement Reports endpoint tools (4) | [F03](issues/F03.md), [F04](issues/F04.md), [F05](issues/F05.md), [F01](issues/F01.md) | 4 |
| [T12](issues/T12.md) | Implement Attachments endpoint tools (12) | [F03](issues/F03.md), [F04](issues/F04.md), [F05](issues/F05.md), [F06](issues/F06.md), [F07](issues/F07.md) | 12 |
| [R01](issues/R01.md) | Enforce exhaustive endpoint, parameter and protocol regression gates | [F08](issues/F08.md), [T01](issues/T01.md), [T02](issues/T02.md), [T03](issues/T03.md), [T04](issues/T04.md), [T05](issues/T05.md), [T06](issues/T06.md), [T07](issues/T07.md), [T08](issues/T08.md), [T09](issues/T09.md), [T10](issues/T10.md), [T11](issues/T11.md), [T12](issues/T12.md) | — |
| [R02](issues/R02.md) | Document and qualify Codex, Claude Code and Copilot CLI | [R01](issues/R01.md), [F07](issues/F07.md), [F08](issues/F08.md) | — |
| [R03](issues/R03.md) | Qualify TestRail 10.7 and ship the complete npm release | [F01](issues/F01.md), [R01](issues/R01.md), [R02](issues/R02.md) | — |

Dependencies describe completion prerequisites. An implementer may prepare fixtures or parallel code ahead of a dependency, but cannot close an item until its prerequisites and acceptance checks are satisfied. In particular, F02 and initial adapter development can use exact driver 7.0.0 while F01 obtains the fixed published release. T11 qualification and R03 release require that fixed driver.

## Execution sequence

1. **Foundation:** pursue F01 upstream qualification and F02 package/CI in parallel. F01 includes already identified network-guard fixes and report-generation cache/coalescing/retry behavior; it must name an actual published version, not a guessed future version.
2. **Shared adapter:** after F02, develop F03 runtime/configuration and F04 registry/input infrastructure in parallel. F05 results/errors follows both; F06 pagination, F07 files and F08 stdio can then proceed alongside one another.
3. **Endpoint families:** implement T01–T12 in parallel as their shared dependencies are ready. Keep the public registry stable and partition edits by family. T03/T12 share F07, and T11 depends on F01. Each family owns its complete independent parameter manifest and fixtures, not only a handler list.
4. **Integrated qualification:** R01 assembles exhaustive endpoint/parameter/protocol gates. R02 verifies the required client surfaces and setup documentation against the packed candidate.
5. **Release:** R03 verifies the dedicated TestRail 10.7.0 baseline and final candidate, then publishes through the repository release process when authorized. All 133 operations and all required evidence must be complete before the full release is ready.

## Common definition of done

- The exact tool name, REST method/route, public driver method and supported parameters match the reviewed baseline. Generated schemas agree with runtime validation. No endpoint or parameter is silently omitted.
- Inputs validate before invocation, preserve supported custom fields and sentinel/null distinctions, and remain operation-specific. All tools stay enabled; no startup write unlock or server confirmation parameter is added.
- Results preserve driver data, correctly describe paging, warn per call on usable entity drift and reject unusable outer structures. Errors distinguish calls never started, unknown effects and acknowledged writes whose output failed.
- Applicable fixture tests invoke the real driver through injected fetch/DNS and independently assert serialized requests. Include valid variants and important negative cases; expected requests must not be generated from the same registry under test.
- Targeted tests, build, typecheck and lint pass. Shared changes run affected regression gates. Documentation and inventory status are updated only to reflect work actually verified.

## Release gates and evidence

| Gate | Required evidence | Owner |
| --- | --- | --- |
| Published driver | Exact version/integrity with required runtime fixes; public export and endpoint parity; report requests execute independently without retries | F01 |
| Endpoint and parameter coverage | All 133 bindings, 28 resources, 24 page/all pairs and every supported parameter; independent positive/negative fixtures and omission-detection regressions | T01–T12, R01 |
| Runtime and local files | Bounded calls/downloads, per-caller warnings, complete-result byte caps, honest cancellation/write outcomes, staging cleanup and persistent completed downloads | F03, F05–F07, R01 |
| Protocol and packaging | Legacy initialization plus MCP 2026-07-28 discovery; protocol-only stdout; tarball install and executable checks on Node 22/24 across Linux/macOS/Windows | F02, F08, R01 |
| Required clients | Exact versions/builds, models/providers, settings and C01–C12 results for Codex desktop, Codex CLI, Claude Code and Copilot CLI | R02 |
| TestRail 10.7.0 | Dedicated disposable environment, required features/licenses/permissions, operation-level live evidence and truthful availability reporting | R03 |
| Published artifact | Tested version/tag/lockfile/provenance, authorized npm release and post-publication install verification | R03 |

The deterministic suite needs no live credentials. Live qualification and model-facing client tests require available accounts, clients and a dedicated TestRail environment during implementation. Their absence is a recorded outstanding prerequisite, not a reason to claim a pass or reduce API coverage. Destructive fixtures and live cleanup target disposable test data. Report templates used in live tests must have deliberate notification settings.

The 133-operation baseline is versioned, not a claim to cover future TestRail releases automatically. Driver upgrades require exact dependency review, inventory/parameter diff and regression qualification. Newly discovered gaps are explicit upstream/release dependencies; the MCP layer does not introduce an independent TestRail HTTP implementation.

## Planning verification

The planning inventory was checked against the selected driver source and the published 7.0.0 artifact: 133 endpoint methods, 48 additional page/all helpers, 28 resource groups and 12 implementation families. All 133 endpoint tools are assigned exactly once; the 23-item dependency graph is acyclic. This validates the plan's accounting, not the future server's implementation or live compatibility.
