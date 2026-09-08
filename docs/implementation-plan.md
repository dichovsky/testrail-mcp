# Implementation plan

Status: architecture and implementation backlog defined on 2026-09-09. All implementation and release checks below remain to be executed. The first release must deliver the complete baseline; completing a subset is not a reduced-scope release.

The server is a local stdio adapter around `@dichovsky/testrail-api-client`, with one configured TestRail identity per subprocess. It exposes exactly **133 endpoint tools across 28 resources**, enabled by default, including administration and destructive operations. TestRail 10.7.0 is the compatibility baseline; older versions are best effort. Required clients are Codex desktop/CLI, Claude Code and GitHub Copilot CLI.

The [architecture](architecture.md) defines component boundaries and accepted behavior. The [implementation contracts](implementation-contracts.md) define exact inputs, outputs, budgets, configuration, error outcomes, files and lifecycle. The [inventory](operation-inventory.json) and [coverage table](api-coverage.md) define every endpoint and public driver binding. These requirements apply to every issue below.

## Work items and dependencies

Tracking epic: [EPIC](https://github.com/dichovsky/testrail-mcp/issues/1). There are **23 implementation issues**, each with scope, explicit dependencies and acceptance/verification criteria. The [issue manifest](implementation-items.json) records IDs, endpoint ownership and published issue links; [local issue bodies](issues/) retain the reviewable text.

| Item | Deliverable | Depends on | Endpoint tools |
| --- | --- | --- | ---: |
| [F01](https://github.com/dichovsky/testrail-mcp/issues/2) | Qualify and pin a published TestRail driver with required runtime fixes | None | — |
| [F02](https://github.com/dichovsky/testrail-mcp/issues/3) | Scaffold the TypeScript ESM package and baseline CI | None | — |
| [F03](https://github.com/dichovsky/testrail-mcp/issues/4) | Implement configuration, driver ownership and bounded invocation lifetime | [F02](https://github.com/dichovsky/testrail-mcp/issues/3) | — |
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

Publication verification on 2026-09-09 confirmed that the tracking epic and all 23 implementation issues are open and that their titles, bodies, numbers and URLs match the saved issue files and manifest. Documentation links and dependency references were checked after publication.
