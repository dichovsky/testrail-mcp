## Outcome

Implement the full TestRail MCP server in this repository using the public `@dichovsky/testrail-api-client` driver. The first release covers all **133 TestRail 10.7.0 endpoints across 28 resource groups** with supported parameters, custom fields, paging and file transfers. Older versions are best effort.

## Accepted product contract

- Local stdio, one configured TestRail instance and user identity per subprocess.
- One endpoint tool named `testrail_<REST operation token>`; all 133 enabled by default, including writes, administration, closing and deletion. No server-added startup unlock or per-call confirmation.
- One page by default, 50 items where controllable; explicit bounded all mode for 24 lists. Disclose the six initial-page/all-only lists.
- Uploads within configured roots; unique downloads to a configured directory return absolute path/ID/bytes and persist until user removal. BDD uploads share file handling.
- Preserve driver-returned fields and flat custom_* in a stable wrapper; strict inputs, per-call entity-drift warnings, structural errors and truthful mutation outcomes.
- Required clients: Codex desktop/CLI, Claude Code and GitHub Copilot CLI. Full catalog verification is required in every target.

## Implementation checklist

- [x] [[F01] Qualify and pin a published TestRail driver with required runtime fixes](https://github.com/dichovsky/testrail-mcp/issues/2)
- [x] [[F02] Scaffold the TypeScript ESM package and baseline CI](https://github.com/dichovsky/testrail-mcp/issues/3)
- [x] [[F03] Implement configuration, driver ownership and bounded invocation lifetime](https://github.com/dichovsky/testrail-mcp/issues/4)
- [x] [[F04] Build the operation registry, strict inputs and parameter manifest](https://github.com/dichovsky/testrail-mcp/issues/5)
- [x] [[F05] Implement preserved results, per-call warnings and truthful errors](https://github.com/dichovsky/testrail-mcp/issues/6)
- [x] [[F06] Implement page defaults and bounded complete aggregation](https://github.com/dichovsky/testrail-mcp/issues/7)
- [x] [[F07] Implement shared upload staging and persistent attachment downloads](https://github.com/dichovsky/testrail-mcp/issues/8)
- [x] [[F08] Wire stdio MCP with legacy and current protocol compatibility](https://github.com/dichovsky/testrail-mcp/issues/9)
- [x] [[T01] Implement Projects, Suites, Sections endpoint tools (16)](https://github.com/dichovsky/testrail-mcp/issues/10)
- [x] [[T02] Implement Cases endpoint tools (12)](https://github.com/dichovsky/testrail-mcp/issues/11)
- [x] [[T03] Implement BDD, Shared Steps endpoint tools (10)](https://github.com/dichovsky/testrail-mcp/issues/12)
- [x] [[T04] Implement Runs, Tests endpoint tools (10)](https://github.com/dichovsky/testrail-mcp/issues/13)
- [x] [[T05] Implement Results endpoint tools (8)](https://github.com/dichovsky/testrail-mcp/issues/14)
- [x] [[T06] Implement Plans, Configurations endpoint tools (19)](https://github.com/dichovsky/testrail-mcp/issues/15)
- [x] [[T07] Implement Milestones, Labels endpoint tools (11)](https://github.com/dichovsky/testrail-mcp/issues/16)
- [x] [[T08] Implement Users, Groups, Roles endpoint tools (12)](https://github.com/dichovsky/testrail-mcp/issues/17)
- [x] [[T09] Implement Datasets, Variables endpoint tools (9)](https://github.com/dichovsky/testrail-mcp/issues/18)
- [x] [[T10] Implement Case Fields, Case Types, Dynamic Filter Fields, Priorities, Result Fields, Statuses, Templates, Versions endpoint tools (10)](https://github.com/dichovsky/testrail-mcp/issues/19)
- [x] [[T11] Implement Reports endpoint tools (4)](https://github.com/dichovsky/testrail-mcp/issues/20)
- [x] [[T12] Implement Attachments endpoint tools (12)](https://github.com/dichovsky/testrail-mcp/issues/21)
- [x] [[R01] Enforce exhaustive endpoint, parameter and protocol regression gates](https://github.com/dichovsky/testrail-mcp/issues/22)
- [ ] [[R02] Document and qualify Codex, Claude Code and Copilot CLI](https://github.com/dichovsky/testrail-mcp/issues/23)
- [ ] [[R03] Qualify TestRail 10.7 and ship the complete npm release](https://github.com/dichovsky/testrail-mcp/issues/24)

## Release gates

The 23 implementation items have explicit dependencies and acceptance tests. Adapter development can start with exact driver 7.0.0, but F03 runtime completion and production release require an exact published driver with the newer network-guard fixes, report generators that bypass cache/coalescing/retries, and a public per-operation settlement API that covers background work after result deadlines. Full endpoint and independent parameter parity, both MCP protocol eras, all certified OS/Node checks, required-client evidence and TestRail 10.7 live qualification must pass. Missing credentials/licensed test features are unverified, never passing results. Phase completion alone does not authorize a reduced API release.

Architecture and engineering decisions: [architecture](https://github.com/dichovsky/testrail-mcp/blob/codex/testrail-mcp-plan/docs/architecture.md), [contracts](https://github.com/dichovsky/testrail-mcp/blob/codex/testrail-mcp-plan/docs/implementation-contracts.md), [implementation plan](https://github.com/dichovsky/testrail-mcp/blob/codex/testrail-mcp-plan/docs/implementation-plan.md), [coverage](https://github.com/dichovsky/testrail-mcp/blob/codex/testrail-mcp-plan/docs/api-coverage.md), [clients](https://github.com/dichovsky/testrail-mcp/blob/codex/testrail-mcp-plan/docs/client-compatibility.md).

## Progress — 2026-10-04

Every implementation item except R02 and R03 is closed, and its box above is ticked to match: F01 to F08, T01 to T12 and R01. F02 and F04 were already ticked. Two items added after this checklist was written are closed too: F09 (#30) and F10 (#31).

Two statements above have been overtaken:
- "Release gates" says adapter development could start with driver 7.0.0, and that release needed a later published driver: one with the newer network-guard fixes, report generators that bypass cache, coalescing and retries, and a public per-operation settlement API. F01 closed once that driver was published: the server pinned driver 7.2.0, the release that added `trackOperation`, then 8.0.0 from #95, and now 9.0.0. [F01](F01.md) records the rest.
- The outcome names TestRail 10.7.0. The tools still cover the 10.7.0 API reference, but on 2026-10-02 the owner made TestRail 10.8.1 the version the live qualification runs against. See [R03](R03.md).

Still open:
- [R02](R02.md) (#23): evidence from Codex, Claude Code and Copilot CLI. Claude Code has a fixture-run record of all twelve scenarios. Codex desktop, Codex CLI and Copilot CLI, and every live smoke check, remain.
- [R03](R03.md) (#24): the live gate and the release. Three live runs against 10.8.1 are recorded. In the third, on 2026-10-04 with the release's driver 9.0.0, nothing failed, and 35 tools have no live pass, 27 blocked by a missing licence or permission and 8 left out by the owner's choice. On 2026-10-03 the owner made those documented limitations rather than blockers. Publishing needs the npm trusted publisher and the `npm-release` environment.

Resolved since: #49 and #55, two rules driver 8.0.0 declared on payload types its methods never parse. The four add-result tools take a result with a status, a comment or an assignee, as TestRail documents. The user write tools take the lookup's address rule, so a single-label domain or domain literal can be written as well as looked up. Both were fixed on 8.0.0 in the adapter, and driver 9.0.0, now pinned, declares the same two rules itself (dichovsky/testrail-api-client#305). Neither was an item on this checklist.
