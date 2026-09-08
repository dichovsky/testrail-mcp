## Outcome

Implement the full TestRail MCP server in this repository using the public `@dichovsky/testrail-api-client` driver. The first release covers all **133 TestRail 10.7.0 endpoints across 28 resource groups** with supported parameters, custom fields, paging and file transfers. Older versions are best effort.

## Accepted product contract

- Local stdio, one configured TestRail instance and user identity per subprocess.
- One endpoint tool named `testrail_<REST operation token>`; all 133 enabled by default, including writes, administration, closing and deletion. No server-added startup unlock or per-call confirmation.
- One page by default,50 items where controllable; explicit bounded all mode for24 lists. Disclose the six initial-page/all-only lists.
- Uploads within configured roots; unique downloads to a configured directory return absolute path/ID/bytes and persist until user removal. BDD uploads share file handling.
- Preserve driver-returned fields and flat custom_* in a stable wrapper; strict inputs, per-call entity-drift warnings, structural errors and truthful mutation outcomes.
- Required clients: Codex desktop/CLI, Claude Code and GitHub Copilot CLI. Full catalog verification is required in every target.

## Implementation checklist

- [ ] [[F01] Qualify and pin a published TestRail driver with required runtime fixes](F01.md)
- [ ] [[F02] Scaffold the TypeScript ESM package and baseline CI](F02.md)
- [ ] [[F03] Implement configuration, driver ownership and bounded invocation lifetime](F03.md)
- [ ] [[F04] Build the operation registry, strict inputs and parameter manifest](F04.md)
- [ ] [[F05] Implement preserved results, per-call warnings and truthful errors](F05.md)
- [ ] [[F06] Implement page defaults and bounded complete aggregation](F06.md)
- [ ] [[F07] Implement shared upload staging and persistent attachment downloads](F07.md)
- [ ] [[F08] Wire stdio MCP with legacy and current protocol compatibility](F08.md)
- [ ] [[T01] Implement Projects, Suites, Sections endpoint tools (16)](T01.md)
- [ ] [[T02] Implement Cases endpoint tools (12)](T02.md)
- [ ] [[T03] Implement BDD, Shared Steps endpoint tools (10)](T03.md)
- [ ] [[T04] Implement Runs, Tests endpoint tools (10)](T04.md)
- [ ] [[T05] Implement Results endpoint tools (8)](T05.md)
- [ ] [[T06] Implement Plans, Configurations endpoint tools (19)](T06.md)
- [ ] [[T07] Implement Milestones, Labels endpoint tools (11)](T07.md)
- [ ] [[T08] Implement Users, Groups, Roles endpoint tools (12)](T08.md)
- [ ] [[T09] Implement Datasets, Variables endpoint tools (9)](T09.md)
- [ ] [[T10] Implement Case Fields, Case Types, Dynamic Filter Fields, Priorities, Result Fields, Statuses, Templates, Versions endpoint tools (10)](T10.md)
- [ ] [[T11] Implement Reports endpoint tools (4)](T11.md)
- [ ] [[T12] Implement Attachments endpoint tools (12)](T12.md)
- [ ] [[R01] Enforce exhaustive endpoint, parameter and protocol regression gates](R01.md)
- [ ] [[R02] Document and qualify Codex, Claude Code and Copilot CLI](R02.md)
- [ ] [[R03] Qualify TestRail 10.7 and ship the complete npm release](R03.md)

## Release gates

The 23 implementation items have explicit dependencies and acceptance tests. Adapter development can start with exact driver 7.0.0, but production release requires an exact published driver with the newer network-guard fixes and report generators that bypass cache/coalescing/retries. Full endpoint and independent parameter parity, both MCP protocol eras, all certified OS/Node checks, required-client evidence and TestRail 10.7 live qualification must pass. Missing credentials/licensed test features are unverified, never passing results. Phase completion alone does not authorize a reduced API release.

Architecture and engineering decisions: [architecture](https://github.com/dichovsky/testrail-mcp/blob/codex/testrail-mcp-plan/docs/architecture.md), [contracts](https://github.com/dichovsky/testrail-mcp/blob/codex/testrail-mcp-plan/docs/implementation-contracts.md), [implementation plan](https://github.com/dichovsky/testrail-mcp/blob/codex/testrail-mcp-plan/docs/implementation-plan.md), [coverage](https://github.com/dichovsky/testrail-mcp/blob/codex/testrail-mcp-plan/docs/api-coverage.md), [clients](https://github.com/dichovsky/testrail-mcp/blob/codex/testrail-mcp-plan/docs/client-compatibility.md).
