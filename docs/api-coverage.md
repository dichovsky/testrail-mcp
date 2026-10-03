# TestRail API coverage baseline

Status: implemented and verified offline. All 133 REST endpoints in this inventory are served through **one MCP tool per endpoint**. Each tool's name is `testrail_` plus the REST operation token before any slash. All operations are enabled by default, including writes and destructive operations, with no startup unlock or server-added per-call confirmation. List tools default to one page, with 50 items where caller controls are supported, and offer explicit bounded fetch-all where the driver supports it. JSON results preserve returned fields in a stable wrapper; attachments use the accepted local-file workflow. Every row is **implemented**: the tool is registered with the inventory's route and driver binding, and it has a complete parameter manifest whose every requirement a fixture covers. `tests/registered-parameters.test.ts` passes every one of those fixtures through the registered tool and the pinned driver. Row statuses track that completion and nothing more. `tests/coverage-report.test.ts` fails when a row here disagrees with the [operation inventory](operation-inventory.json) in its endpoint, tool, driver method, page/all helpers, counts or status. It also fails when the inventory's statuses disagree with the registry and manifests. CI publishes the [coverage reports](coverage-reports.md) it checks as artifacts. Accepted decisions are recorded in the [architecture](architecture.md).

This document maps the full-API scope to the driver. An `implemented` row is offline evidence: it does not claim the operation was tested against a live TestRail instance or through an MCP host client. Those qualifications are tracked by [R03](https://github.com/dichovsky/testrail-mcp/issues/24) and [R02](https://github.com/dichovsky/testrail-mcp/issues/23).

## Provenance and compatibility boundary

Inspected on 2026-09-07 at driver commit `89f636e276ea701412bb06039e3b963d83126ea1`. The local checkout matched upstream `main` at inspection. All driver source links below are pinned to this commit.

- [Endpoint inventory](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/docs/testrail-endpoints.json): canonical resource groups, HTTP verbs, paths, and pagination declarations.
- [Generated endpoint-to-method mapping](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/docs/API-MAPPING.md): public method bindings and source locations, derived from the driver's `@testrail` annotations.
- [TestRail 10.7.0 compatibility audit](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/docs/TESTRAIL-10.7.0-COMPATIBILITY.md): source corpus, cumulative additions, contract corrections, and unresolved documentation ambiguities.
- [Driver composition root](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/client.ts): the public `TestRailClient` module properties used to qualify each method.
- [Pagination contract](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/docs/ARCHITECTURE.md#33-pagination-projections): supported projections and safety bounds.

The coverage baseline is the driver's cumulative TestRail 10.7.0 audit: 125 operations from the official reference plus eight cumulative operations identified in release notes or auxiliary official references. The tools cover this 10.7.0 audit. The supported TestRail baseline, the version the live qualification runs against, is **10.8.1**, with **best-effort compatibility for older versions**. It is not a claim about every historical or future TestRail release. The audit links its underlying [official TestRail API reference](https://support.testrail.com/hc/en-us/sections/7077185274644-API-reference), release notes, BDD reference, and official TRCLI source.

Full coverage means every listed HTTP verb/path operation has an MCP-accessible implementation using the mapped public driver method and its supported parameters. A TestRail server may reject a covered operation because of its version, edition/license, configuration, or the authenticated user's permissions. Those upstream limitations must be distinguishable from an operation absent from the MCP server; this inventory does not assert availability on a particular instance or assign unverified per-endpoint minimum versions.

### Development dependency and production prerequisite

**Resolved in 7.2.0.** The package pinned published `@dichovsky/testrail-api-client@7.2.0` (tag commit `cc7751c01c3d3956d061073283bee6b23bf33422`), and now pins `8.0.0` (tag commit `7680ab6c0d1973749e3178016a3d133af27bfb0a`); each meets all three requirements listed below, with one accepted deviation: it re-sends a rate-limited (429) report run. TestRail rejects a rate-limited request before handling it, so the re-send cannot generate a report twice. The [driver qualification](driver-qualification.md) records the evidence and runs it as standing tests. The rest of this section is the original baseline, kept for provenance.

Exact npm dependency **`@dichovsky/testrail-api-client@7.0.0` is the development baseline only**, with a committed lockfile. As checked on 2026-09-09, [npm metadata](https://registry.npmjs.org/@dichovsky%2Ftestrail-api-client/7.0.0) and [GitHub release/7.0.0](https://github.com/dichovsky/testrail-api-client/releases/tag/release/7.0.0) identify commit `71a80d984aea14713d8eeaf6ac9a0d41c1fba12b` as the latest published stable release. Its endpoint inventory, domain modules, and 181 endpoint/helper methods match this baseline; the published tarball was integrity-checked and its declarations and JavaScript bindings were verified. The machine-readable [operation inventory](operation-inventory.json) records that verification and the development-only dependency scope.

Follow-up on 2026-09-10: published 7.1.0 includes the network-guard fixes and retains all 181 endpoint/helper bindings, but still lacks independent report execution and the settlement API. See the [current driver qualification evidence](driver-qualification.md). The original 7.0.0 audit above remains the development baseline.

**Production release is blocked on a new fixed published driver version**, which must include all three requirements:

- The network-guard fixes already present at inspected main commit `89f636e276ea701412bb06039e3b963d83126ea1` in `client-core.ts` and `config-validation.ts`. Published 7.0.0 lacks these fixes; see the [pinned changelog](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/CHANGELOG.md).
- A driver patch for `reports.runReport` and `reports.runCrossProjectReport`: use `bypassCache: true` and `retry: 'none'`, bypassing GET cache reads/writes **and pending-request coalescing**. These endpoints generate reports despite using GET. Each explicit invocation must execute independently without automatic retries. Both published 7.0.0 and the inspected main revision still need this patch; merely upgrading to that main commit is insufficient.

- A public per-operation handle that exposes result completion separately from actual settlement of DNS/fetch/body/upload/retry/coalesced descendants, as defined in the [implementation contracts](implementation-contracts.md). The inspected public method promise can reject at a deadline while background work remains pending; F03 cannot enforce its capacity/cleanup contract without this addition.

Once the fixed package is published, F03 must pin its exact version in the production dependency and committed lockfile, then reverify this matrix and runtime regression checks against that package. An unpinned Git dependency does not satisfy the prerequisite. The runtime changes and settlement API do not change this 133-endpoint inventory or add an MCP tool.

## Counting and pagination rules

- Count a REST endpoint once per unique `(HTTP verb, path)` pair. There are **133 endpoints: 58 GET and 75 POST**, grouped into **28 API resources**. The accepted one-tool-per-endpoint organization therefore defines **133 MCP tools**.
- Each endpoint maps to one public `client.module.method`. Overloads do not create additional endpoints.
- **24 endpoint lists** also expose `get*Page()` and `getAll*()` projections: **48 convenience methods**, giving **181 public domain methods** when combined with the 133 endpoint methods. Helpers reuse existing REST endpoints and do not increase endpoint coverage.
- The driver CLI exposes 134 actions because `run watch` repeatedly invokes the same run-read endpoint. That workflow is not a 134th REST endpoint and is not an automatic MCP commitment.
- **Controlled** pagination (18 lists) supports caller-provided limit/offset on page reads and pageSize/startOffset plus safety bounds on all-page reads. **Response-driven** pagination (6 lists) follows server continuation under safety bounds but does not expose caller page size/start offset.
- The pagination column names exact verified driver helpers on the same module as the primary method. **No page/all helpers** means the driver does not promise those projections for that endpoint; it does not imply the result is scalar or that TestRail has no other response behavior.
- Existing list methods return one response's items. Page helpers preserve the distinction between a complete pagination envelope and a terminal legacy array. All-page helpers are bounded and return no partial aggregate on failure. The accepted MCP behavior is one page by default and explicit bounded fetch-all. The six response-driven page methods do not accept manual continuation; their tools must disclose that obtaining later pages requires fetch-all. See the [architecture](architecture.md#list-pagination) for the accepted pagination behavior.

## Per-resource counts

| API resource | REST endpoints | GET | POST | Lists with page/all helpers | MCP status |
| --- | ---: | ---: | ---: | ---: | --- |
| [Attachments](#attachments) | 12 | 6 | 6 | 3 | implemented |
| [BDD](#bdd) | 4 | 2 | 2 | 1 | implemented |
| [Case Fields](#case-fields) | 2 | 1 | 1 | 0 | implemented |
| [Case Types](#case-types) | 1 | 1 | 0 | 0 | implemented |
| [Cases](#cases) | 12 | 4 | 8 | 2 | implemented |
| [Configurations](#configurations) | 7 | 1 | 6 | 0 | implemented |
| [Datasets](#datasets) | 5 | 2 | 3 | 1 | implemented |
| [Dynamic Filter Fields](#dynamic-filter-fields) | 1 | 1 | 0 | 0 | implemented |
| [Groups](#groups) | 5 | 2 | 3 | 1 | implemented |
| [Labels](#labels) | 6 | 2 | 4 | 1 | implemented |
| [Milestones](#milestones) | 5 | 2 | 3 | 1 | implemented |
| [Plans](#plans) | 12 | 2 | 10 | 1 | implemented |
| [Priorities](#priorities) | 1 | 1 | 0 | 0 | implemented |
| [Projects](#projects) | 5 | 2 | 3 | 1 | implemented |
| [Reports](#reports) | 4 | 4 | 0 | 0 | implemented |
| [Result Fields](#result-fields) | 1 | 1 | 0 | 0 | implemented |
| [Results](#results) | 8 | 3 | 5 | 3 | implemented |
| [Roles](#roles) | 1 | 1 | 0 | 1 | implemented |
| [Runs](#runs) | 6 | 2 | 4 | 1 | implemented |
| [Sections](#sections) | 6 | 2 | 4 | 1 | implemented |
| [Shared Steps](#shared-steps) | 6 | 3 | 3 | 2 | implemented |
| [Statuses](#statuses) | 2 | 2 | 0 | 1 | implemented |
| [Suites](#suites) | 5 | 2 | 3 | 1 | implemented |
| [Templates](#templates) | 1 | 1 | 0 | 0 | implemented |
| [Tests](#tests) | 4 | 2 | 2 | 1 | implemented |
| [Users](#users) | 6 | 4 | 2 | 0 | implemented |
| [Variables](#variables) | 4 | 1 | 3 | 1 | implemented |
| [Versions](#versions) | 1 | 1 | 0 | 0 | implemented |
| **Total** | **133** | **58** | **75** | **24** | **implemented** |

## Endpoint matrix

Method labels are relative to a configured `TestRailClient` instance: `cases.getCase` means `client.cases.getCase(...)`. Endpoint cells preserve the inventory's path templates; source links on method cells locate the implementation. The MCP tool name is `testrail_` followed by the endpoint's operation token (for example, `GET get_case/{case_id}` becomes `testrail_get_case`).

### Attachments

| REST endpoint | MCP tool | Public driver method | Driver page/all capabilities | MCP status |
| --- | --- | --- | --- | --- |
| `GET get_attachment/{attachment_id}` | `testrail_get_attachment` | [`attachments.getAttachment`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/attachments.ts#L140) | No page/all helpers | implemented |
| `GET get_attachments_for_case/{case_id}` | `testrail_get_attachments_for_case` | [`attachments.getAttachmentsForCase`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/attachments.ts#L67) | Controlled: `getAttachmentsForCasePage()`, `getAllAttachmentsForCase()` | implemented |
| `GET get_attachments_for_plan/{plan_id}` | `testrail_get_attachments_for_plan` | [`attachments.getAttachmentsForPlan`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/attachments.ts#L102) | Controlled: `getAttachmentsForPlanPage()`, `getAllAttachmentsForPlan()` | implemented |
| `GET get_attachments_for_plan_entry/{plan_id}/{entry_id}` | `testrail_get_attachments_for_plan_entry` | [`attachments.getAttachmentsForPlanEntry`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/attachments.ts#L126) | No page/all helpers | implemented |
| `GET get_attachments_for_run/{run_id}` | `testrail_get_attachments_for_run` | [`attachments.getAttachmentsForRun`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/attachments.ts#L82) | Controlled: `getAttachmentsForRunPage()`, `getAllAttachmentsForRun()` | implemented |
| `GET get_attachments_for_test/{test_id}` | `testrail_get_attachments_for_test` | [`attachments.getAttachmentsForTest`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/attachments.ts#L97) | No page/all helpers | implemented |
| `POST add_attachment_to_case/{case_id}` | `testrail_add_attachment_to_case` | [`attachments.addAttachmentToCase`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/attachments.ts#L151) | No page/all helpers | implemented |
| `POST add_attachment_to_plan/{plan_id}` | `testrail_add_attachment_to_plan` | [`attachments.addAttachmentToPlan`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/attachments.ts#L184) | No page/all helpers | implemented |
| `POST add_attachment_to_plan_entry/{plan_id}/{entry_id}` | `testrail_add_attachment_to_plan_entry` | [`attachments.addAttachmentToPlanEntry`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/attachments.ts#L200) | No page/all helpers | implemented |
| `POST add_attachment_to_result/{result_id}` | `testrail_add_attachment_to_result` | [`attachments.addAttachmentToResult`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/attachments.ts#L162) | No page/all helpers | implemented |
| `POST add_attachment_to_run/{run_id}` | `testrail_add_attachment_to_run` | [`attachments.addAttachmentToRun`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/attachments.ts#L173) | No page/all helpers | implemented |
| `POST delete_attachment/{attachment_id}` | `testrail_delete_attachment` | [`attachments.deleteAttachment`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/attachments.ts#L217) | No page/all helpers | implemented |

### BDD

| REST endpoint | MCP tool | Public driver method | Driver page/all capabilities | MCP status |
| --- | --- | --- | --- | --- |
| `GET get_bdd/{case_id}` | `testrail_get_bdd` | [`bdd.getBdd`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/bdd.ts#L83) | No page/all helpers | implemented |
| `GET get_bdds/{project_id}` | `testrail_get_bdds` | [`bdd.getBdds`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/bdd.ts#L96) | Controlled: `getBddsPage()`, `getAllBdds()` | implemented |
| `POST add_bdd/{section_id}` | `testrail_add_bdd` | [`bdd.addBdd`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/bdd.ts#L114) | No page/all helpers | implemented |
| `POST update_bdd/{case_id}` | `testrail_update_bdd` | [`bdd.updateBdd`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/bdd.ts#L123) | No page/all helpers | implemented |

### Case Fields

| REST endpoint | MCP tool | Public driver method | Driver page/all capabilities | MCP status |
| --- | --- | --- | --- | --- |
| `GET get_case_fields` | `testrail_get_case_fields` | [`metadata.getCaseFields`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/metadata.ts#L123) | No page/all helpers | implemented |
| `POST add_case_field` | `testrail_add_case_field` | [`metadata.addCaseField`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/metadata.ts#L154) | No page/all helpers | implemented |

### Case Types

| REST endpoint | MCP tool | Public driver method | Driver page/all capabilities | MCP status |
| --- | --- | --- | --- | --- |
| `GET get_case_types` | `testrail_get_case_types` | [`metadata.getCaseTypes`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/metadata.ts#L164) | No page/all helpers | implemented |

### Cases

| REST endpoint | MCP tool | Public driver method | Driver page/all capabilities | MCP status |
| --- | --- | --- | --- | --- |
| `GET get_case/{case_id}` | `testrail_get_case` | [`cases.getCase`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/cases.ts#L113) | No page/all helpers | implemented |
| `GET get_case_titles` | `testrail_get_case_titles` | [`cases.getCaseTitles`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/cases.ts#L123) | No page/all helpers | implemented |
| `GET get_cases/{project_id}` | `testrail_get_cases` | [`cases.getCases`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/cases.ts#L137) | Controlled: `getCasesPage()`, `getAllCases()` | implemented |
| `GET get_history_for_case/{case_id}` | `testrail_get_history_for_case` | [`cases.getHistoryForCase`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/cases.ts#L370) | Controlled: `getHistoryForCasePage()`, `getAllHistoryForCase()` | implemented |
| `POST add_case/{section_id}` | `testrail_add_case` | [`cases.addCase`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/cases.ts#L152) | No page/all helpers | implemented |
| `POST add_cases/{section_id}` | `testrail_add_cases` | [`cases.addCases`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/cases.ts#L172) | No page/all helpers | implemented |
| `POST copy_cases_to_section/{section_id}` | `testrail_copy_cases_to_section` | [`cases.copyCasesToSection`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/cases.ts#L344) | No page/all helpers | implemented |
| `POST delete_case/{case_id}` | `testrail_delete_case` | [`cases.deleteCase`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/cases.ts#L222) | No page/all helpers | implemented |
| `POST delete_cases/{suite_id}` | `testrail_delete_cases` | [`cases.deleteCases`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/cases.ts#L293) | No page/all helpers | implemented |
| `POST move_cases_to_section/{section_id}` | `testrail_move_cases_to_section` | [`cases.moveCasesToSection`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/cases.ts#L360) | No page/all helpers | implemented |
| `POST update_case/{case_id}` | `testrail_update_case` | [`cases.updateCase`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/cases.ts#L203) | No page/all helpers | implemented |
| `POST update_cases/{suite_id}` | `testrail_update_cases` | [`cases.updateCases`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/cases.ts#L260) | No page/all helpers | implemented |

### Configurations

| REST endpoint | MCP tool | Public driver method | Driver page/all capabilities | MCP status |
| --- | --- | --- | --- | --- |
| `GET get_configs/{project_id}` | `testrail_get_configs` | [`configurations.getConfigurations`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/configurations.ts#L18) | No page/all helpers | implemented |
| `POST add_config/{config_group_id}` | `testrail_add_config` | [`configurations.addConfiguration`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/configurations.ts#L62) | No page/all helpers | implemented |
| `POST add_config_group/{project_id}` | `testrail_add_config_group` | [`configurations.addConfigurationGroup`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/configurations.ts#L28) | No page/all helpers | implemented |
| `POST delete_config/{config_id}` | `testrail_delete_config` | [`configurations.deleteConfiguration`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/configurations.ts#L84) | No page/all helpers | implemented |
| `POST delete_config_group/{config_group_id}` | `testrail_delete_config_group` | [`configurations.deleteConfigurationGroup`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/configurations.ts#L53) | No page/all helpers | implemented |
| `POST update_config/{config_id}` | `testrail_update_config` | [`configurations.updateConfiguration`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/configurations.ts#L73) | No page/all helpers | implemented |
| `POST update_config_group/{config_group_id}` | `testrail_update_config_group` | [`configurations.updateConfigurationGroup`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/configurations.ts#L39) | No page/all helpers | implemented |

### Datasets

| REST endpoint | MCP tool | Public driver method | Driver page/all capabilities | MCP status |
| --- | --- | --- | --- | --- |
| `GET get_dataset/{dataset_id}` | `testrail_get_dataset` | [`datasets.getDataset`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/datasets.ts#L39) | No page/all helpers | implemented |
| `GET get_datasets/{project_id}` | `testrail_get_datasets` | [`datasets.getDatasets`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/datasets.ts#L49) | Response-driven: `getDatasetsPage()`, `getAllDatasets()` | implemented |
| `POST add_dataset/{project_id}` | `testrail_add_dataset` | [`datasets.addDataset`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/datasets.ts#L64) | No page/all helpers | implemented |
| `POST delete_dataset/{dataset_id}` | `testrail_delete_dataset` | [`datasets.deleteDataset`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/datasets.ts#L86) | No page/all helpers | implemented |
| `POST update_dataset/{dataset_id}` | `testrail_update_dataset` | [`datasets.updateDataset`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/datasets.ts#L75) | No page/all helpers | implemented |

### Dynamic Filter Fields

| REST endpoint | MCP tool | Public driver method | Driver page/all capabilities | MCP status |
| --- | --- | --- | --- | --- |
| `GET get_dynamic_filter_fields/{project_id}` | `testrail_get_dynamic_filter_fields` | [`metadata.getDynamicFilterFields`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/metadata.ts#L104) | No page/all helpers | implemented |

### Groups

| REST endpoint | MCP tool | Public driver method | Driver page/all capabilities | MCP status |
| --- | --- | --- | --- | --- |
| `GET get_group/{group_id}` | `testrail_get_group` | [`users.getGroup`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/users.ts#L118) | No page/all helpers | implemented |
| `GET get_groups` | `testrail_get_groups` | [`users.getGroups`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/users.ts#L128) | Response-driven: `getGroupsPage()`, `getAllGroups()` | implemented |
| `POST add_group` | `testrail_add_group` | [`users.addGroup`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/users.ts#L143) | No page/all helpers | implemented |
| `POST delete_group/{group_id}` | `testrail_delete_group` | [`users.deleteGroup`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/users.ts#L167) | No page/all helpers | implemented |
| `POST update_group/{group_id}` | `testrail_update_group` | [`users.updateGroup`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/users.ts#L153) | No page/all helpers | implemented |

### Labels

| REST endpoint | MCP tool | Public driver method | Driver page/all capabilities | MCP status |
| --- | --- | --- | --- | --- |
| `GET get_label/{label_id}` | `testrail_get_label` | [`labels.getLabel`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/labels.ts#L44) | No page/all helpers | implemented |
| `GET get_labels/{project_id}` | `testrail_get_labels` | [`labels.getLabels`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/labels.ts#L54) | Controlled: `getLabelsPage()`, `getAllLabels()` | implemented |
| `POST add_label/{project_id}` | `testrail_add_label` | [`labels.addLabel`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/labels.ts#L69) | No page/all helpers | implemented |
| `POST delete_label/{label_id}` | `testrail_delete_label` | [`labels.deleteLabel`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/labels.ts#L92) | No page/all helpers | implemented |
| `POST delete_labels` | `testrail_delete_labels` | [`labels.deleteLabels`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/labels.ts#L101) | No page/all helpers | implemented |
| `POST update_label/{label_id}` | `testrail_update_label` | [`labels.updateLabel`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/labels.ts#L80) | No page/all helpers | implemented |

### Milestones

| REST endpoint | MCP tool | Public driver method | Driver page/all capabilities | MCP status |
| --- | --- | --- | --- | --- |
| `GET get_milestone/{milestone_id}` | `testrail_get_milestone` | [`milestones.getMilestone`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/milestones.ts#L43) | No page/all helpers | implemented |
| `GET get_milestones/{project_id}` | `testrail_get_milestones` | [`milestones.getMilestones`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/milestones.ts#L53) | Controlled: `getMilestonesPage()`, `getAllMilestones()` | implemented |
| `POST add_milestone/{project_id}` | `testrail_add_milestone` | [`milestones.addMilestone`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/milestones.ts#L68) | No page/all helpers | implemented |
| `POST delete_milestone/{milestone_id}` | `testrail_delete_milestone` | [`milestones.deleteMilestone`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/milestones.ts#L90) | No page/all helpers | implemented |
| `POST update_milestone/{milestone_id}` | `testrail_update_milestone` | [`milestones.updateMilestone`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/milestones.ts#L79) | No page/all helpers | implemented |

### Plans

| REST endpoint | MCP tool | Public driver method | Driver page/all capabilities | MCP status |
| --- | --- | --- | --- | --- |
| `GET get_plan/{plan_id}` | `testrail_get_plan` | [`plans.getPlan`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/plans.ts#L61) | No page/all helpers | implemented |
| `GET get_plans/{project_id}` | `testrail_get_plans` | [`plans.getPlans`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/plans.ts#L67) | Controlled: `getPlansPage()`, `getAllPlans()` | implemented |
| `POST add_plan/{project_id}` | `testrail_add_plan` | [`plans.addPlan`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/plans.ts#L82) | No page/all helpers | implemented |
| `POST add_plan_entry/{plan_id}` | `testrail_add_plan_entry` | [`plans.addPlanEntry`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/plans.ts#L120) | No page/all helpers | implemented |
| `POST add_run_to_plan_entry/{plan_id}/{entry_id}` | `testrail_add_run_to_plan_entry` | [`plans.addRunToPlanEntry`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/plans.ts#L153) | No page/all helpers | implemented |
| `POST close_plan/{plan_id}` | `testrail_close_plan` | [`plans.closePlan`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/plans.ts#L104) | No page/all helpers | implemented |
| `POST delete_plan/{plan_id}` | `testrail_delete_plan` | [`plans.deletePlan`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/plans.ts#L114) | No page/all helpers | implemented |
| `POST delete_plan_entry/{plan_id}/{entry_id}` | `testrail_delete_plan_entry` | [`plans.deletePlanEntry`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/plans.ts#L143) | No page/all helpers | implemented |
| `POST delete_run_from_plan_entry/{run_id}` | `testrail_delete_run_from_plan_entry` | [`plans.deleteRunFromPlanEntry`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/plans.ts#L176) | No page/all helpers | implemented |
| `POST update_plan/{plan_id}` | `testrail_update_plan` | [`plans.updatePlan`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/plans.ts#L93) | No page/all helpers | implemented |
| `POST update_plan_entry/{plan_id}/{entry_id}` | `testrail_update_plan_entry` | [`plans.updatePlanEntry`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/plans.ts#L131) | No page/all helpers | implemented |
| `POST update_run_in_plan_entry/{run_id}` | `testrail_update_run_in_plan_entry` | [`plans.updateRunInPlanEntry`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/plans.ts#L165) | No page/all helpers | implemented |

### Priorities

| REST endpoint | MCP tool | Public driver method | Driver page/all capabilities | MCP status |
| --- | --- | --- | --- | --- |
| `GET get_priorities` | `testrail_get_priorities` | [`metadata.getPriorities`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/metadata.ts#L95) | No page/all helpers | implemented |

### Projects

| REST endpoint | MCP tool | Public driver method | Driver page/all capabilities | MCP status |
| --- | --- | --- | --- | --- |
| `GET get_project/{project_id}` | `testrail_get_project` | [`projects.getProject`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/projects.ts#L49) | No page/all helpers | implemented |
| `GET get_projects` | `testrail_get_projects` | [`projects.getProjects`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/projects.ts#L64) | Controlled: `getProjectsPage()`, `getAllProjects()` | implemented |
| `POST add_project` | `testrail_add_project` | [`projects.addProject`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/projects.ts#L88) | No page/all helpers | implemented |
| `POST delete_project/{project_id}` | `testrail_delete_project` | [`projects.deleteProject`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/projects.ts#L109) | No page/all helpers | implemented |
| `POST update_project/{project_id}` | `testrail_update_project` | [`projects.updateProject`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/projects.ts#L98) | No page/all helpers | implemented |

### Reports

| REST endpoint | MCP tool | Public driver method | Driver page/all capabilities | MCP status |
| --- | --- | --- | --- | --- |
| `GET get_cross_project_reports` | `testrail_get_cross_project_reports` | [`reports.getCrossProjectReports`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/reports.ts#L34) | No page/all helpers | implemented |
| `GET get_reports/{project_id}` | `testrail_get_reports` | [`reports.getReports`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/reports.ts#L10) | No page/all helpers | implemented |
| `GET run_cross_project_report/{report_template_id}` | `testrail_run_cross_project_report` | [`reports.runCrossProjectReport`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/reports.ts#L46) | No page/all helpers | implemented |
| `GET run_report/{report_template_id}` | `testrail_run_report` | [`reports.runReport`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/reports.ts#L20) | No page/all helpers | implemented |

### Result Fields

| REST endpoint | MCP tool | Public driver method | Driver page/all capabilities | MCP status |
| --- | --- | --- | --- | --- |
| `GET get_result_fields` | `testrail_get_result_fields` | [`metadata.getResultFields`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/metadata.ts#L114) | No page/all helpers | implemented |

### Results

| REST endpoint | MCP tool | Public driver method | Driver page/all capabilities | MCP status |
| --- | --- | --- | --- | --- |
| `GET get_results/{test_id}` | `testrail_get_results` | [`results.getResults`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/results.ts#L90) | Controlled: `getResultsPage()`, `getAllResults()` | implemented |
| `GET get_results_for_case/{run_id}/{case_id}` | `testrail_get_results_for_case` | [`results.getResultsForCase`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/results.ts#L105) | Controlled: `getResultsForCasePage()`, `getAllResultsForCase()` | implemented |
| `GET get_results_for_run/{run_id}` | `testrail_get_results_for_run` | [`results.getResultsForRun`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/results.ts#L120) | Controlled: `getResultsForRunPage()`, `getAllResultsForRun()` | implemented |
| `POST add_result/{test_id}` | `testrail_add_result` | [`results.addResult`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/results.ts#L135) | No page/all helpers | implemented |
| `POST add_result_for_case/{run_id}/{case_id}` | `testrail_add_result_for_case` | [`results.addResultForCase`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/results.ts#L146) | No page/all helpers | implemented |
| `POST add_results/{run_id}` | `testrail_add_results` | [`results.addResults`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/results.ts#L169) | No page/all helpers | implemented |
| `POST add_results_for_cases/{run_id}` | `testrail_add_results_for_cases` | [`results.addResultsForCases`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/results.ts#L158) | No page/all helpers | implemented |
| `POST edit_result/{result_id}` | `testrail_edit_result` | [`results.editResult`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/results.ts#L183) | No page/all helpers | implemented |

### Roles

| REST endpoint | MCP tool | Public driver method | Driver page/all capabilities | MCP status |
| --- | --- | --- | --- | --- |
| `GET get_roles` | `testrail_get_roles` | [`metadata.getRoles`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/metadata.ts#L183) | Response-driven: `getRolesPage()`, `getAllRoles()` | implemented |

### Runs

| REST endpoint | MCP tool | Public driver method | Driver page/all capabilities | MCP status |
| --- | --- | --- | --- | --- |
| `GET get_run/{run_id}` | `testrail_get_run` | [`runs.getRun`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/runs.ts#L59) | No page/all helpers | implemented |
| `GET get_runs/{project_id}` | `testrail_get_runs` | [`runs.getRuns`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/runs.ts#L65) | Controlled: `getRunsPage()`, `getAllRuns()` | implemented |
| `POST add_run/{project_id}` | `testrail_add_run` | [`runs.addRun`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/runs.ts#L80) | No page/all helpers | implemented |
| `POST close_run/{run_id}` | `testrail_close_run` | [`runs.closeRun`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/runs.ts#L102) | No page/all helpers | implemented |
| `POST delete_run/{run_id}` | `testrail_delete_run` | [`runs.deleteRun`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/runs.ts#L119) | No page/all helpers | implemented |
| `POST update_run/{run_id}` | `testrail_update_run` | [`runs.updateRun`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/runs.ts#L91) | No page/all helpers | implemented |

### Sections

| REST endpoint | MCP tool | Public driver method | Driver page/all capabilities | MCP status |
| --- | --- | --- | --- | --- |
| `GET get_section/{section_id}` | `testrail_get_section` | [`sections.getSection`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/sections.ts#L45) | No page/all helpers | implemented |
| `GET get_sections/{project_id}` | `testrail_get_sections` | [`sections.getSections`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/sections.ts#L55) | Controlled: `getSectionsPage()`, `getAllSections()` | implemented |
| `POST add_section/{project_id}` | `testrail_add_section` | [`sections.addSection`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/sections.ts#L70) | No page/all helpers | implemented |
| `POST delete_section/{section_id}` | `testrail_delete_section` | [`sections.deleteSection`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/sections.ts#L99) | No page/all helpers | implemented |
| `POST move_section/{section_id}` | `testrail_move_section` | [`sections.moveSection`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/sections.ts#L131) | No page/all helpers | implemented |
| `POST update_section/{section_id}` | `testrail_update_section` | [`sections.updateSection`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/sections.ts#L81) | No page/all helpers | implemented |

### Shared Steps

| REST endpoint | MCP tool | Public driver method | Driver page/all capabilities | MCP status |
| --- | --- | --- | --- | --- |
| `GET get_shared_step/{shared_step_id}` | `testrail_get_shared_step` | [`sharedSteps.getSharedStep`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/sharedSteps.ts#L88) | No page/all helpers | implemented |
| `GET get_shared_step_history/{shared_step_id}` | `testrail_get_shared_step_history` | [`sharedSteps.getSharedStepHistory`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/sharedSteps.ts#L147) | Response-driven: `getSharedStepHistoryPage()`, `getAllSharedStepHistory()` | implemented |
| `GET get_shared_steps/{project_id}` | `testrail_get_shared_steps` | [`sharedSteps.getSharedSteps`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/sharedSteps.ts#L98) | Controlled: `getSharedStepsPage()`, `getAllSharedSteps()` | implemented |
| `POST add_shared_step/{project_id}` | `testrail_add_shared_step` | [`sharedSteps.addSharedStep`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/sharedSteps.ts#L113) | No page/all helpers | implemented |
| `POST delete_shared_step/{shared_step_id}` | `testrail_delete_shared_step` | [`sharedSteps.deleteSharedStep`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/sharedSteps.ts#L135) | No page/all helpers | implemented |
| `POST update_shared_step/{shared_step_id}` | `testrail_update_shared_step` | [`sharedSteps.updateSharedStep`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/sharedSteps.ts#L124) | No page/all helpers | implemented |

### Statuses

| REST endpoint | MCP tool | Public driver method | Driver page/all capabilities | MCP status |
| --- | --- | --- | --- | --- |
| `GET get_case_statuses` | `testrail_get_case_statuses` | [`metadata.getCaseStatuses`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/metadata.ts#L80) | Response-driven: `getCaseStatusesPage()`, `getAllCaseStatuses()` | implemented |
| `GET get_statuses` | `testrail_get_statuses` | [`metadata.getStatuses`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/metadata.ts#L71) | No page/all helpers | implemented |

### Suites

| REST endpoint | MCP tool | Public driver method | Driver page/all capabilities | MCP status |
| --- | --- | --- | --- | --- |
| `GET get_suite/{suite_id}` | `testrail_get_suite` | [`suites.getSuite`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/suites.ts#L43) | No page/all helpers | implemented |
| `GET get_suites/{project_id}` | `testrail_get_suites` | [`suites.getSuites`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/suites.ts#L58) | Controlled: `getSuitesPage()`, `getAllSuites()` | implemented |
| `POST add_suite/{project_id}` | `testrail_add_suite` | [`suites.addSuite`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/suites.ts#L78) | No page/all helpers | implemented |
| `POST delete_suite/{suite_id}` | `testrail_delete_suite` | [`suites.deleteSuite`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/suites.ts#L114) | No page/all helpers | implemented |
| `POST update_suite/{suite_id}` | `testrail_update_suite` | [`suites.updateSuite`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/suites.ts#L94) | No page/all helpers | implemented |

### Templates

| REST endpoint | MCP tool | Public driver method | Driver page/all capabilities | MCP status |
| --- | --- | --- | --- | --- |
| `GET get_templates/{project_id}` | `testrail_get_templates` | [`metadata.getTemplates`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/metadata.ts#L173) | No page/all helpers | implemented |

### Tests

| REST endpoint | MCP tool | Public driver method | Driver page/all capabilities | MCP status |
| --- | --- | --- | --- | --- |
| `GET get_test/{test_id}` | `testrail_get_test` | [`tests.getTest`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/tests.ts#L53) | No page/all helpers | implemented |
| `GET get_tests/{run_id}` | `testrail_get_tests` | [`tests.getTests`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/tests.ts#L78) | Controlled: `getTestsPage()`, `getAllTests()` | implemented |
| `POST update_test/{test_id}` | `testrail_update_test` | [`tests.updateTest`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/tests.ts#L96) | No page/all helpers | implemented |
| `POST update_tests` | `testrail_update_tests` | [`tests.updateTests`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/tests.ts#L110) | No page/all helpers | implemented |

### Users

| REST endpoint | MCP tool | Public driver method | Driver page/all capabilities | MCP status |
| --- | --- | --- | --- | --- |
| `GET get_current_user` | `testrail_get_current_user` | [`users.getCurrentUser`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/users.ts#L88) | No page/all helpers | implemented |
| `GET get_user/{user_id}` | `testrail_get_user` | [`users.getUser`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/users.ts#L46) | No page/all helpers | implemented |
| `GET get_user_by_email` | `testrail_get_user_by_email` | [`users.getUserByEmail`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/users.ts#L56) | No page/all helpers | implemented |
| `GET get_users` | `testrail_get_users` | [`users.getUsers`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/users.ts#L66) | No page/all helpers | implemented |
| `POST add_user` | `testrail_add_user` | [`users.addUser`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/users.ts#L97) | No page/all helpers | implemented |
| `POST update_user/{user_id}` | `testrail_update_user` | [`users.updateUser`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/users.ts#L107) | No page/all helpers | implemented |

### Variables

| REST endpoint | MCP tool | Public driver method | Driver page/all capabilities | MCP status |
| --- | --- | --- | --- | --- |
| `GET get_variables/{project_id}` | `testrail_get_variables` | [`variables.getVariables`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/variables.ts#L39) | Response-driven: `getVariablesPage()`, `getAllVariables()` | implemented |
| `POST add_variable/{project_id}` | `testrail_add_variable` | [`variables.addVariable`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/variables.ts#L54) | No page/all helpers | implemented |
| `POST delete_variable/{variable_id}` | `testrail_delete_variable` | [`variables.deleteVariable`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/variables.ts#L76) | No page/all helpers | implemented |
| `POST update_variable/{variable_id}` | `testrail_update_variable` | [`variables.updateVariable`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/variables.ts#L65) | No page/all helpers | implemented |

### Versions

| REST endpoint | MCP tool | Public driver method | Driver page/all capabilities | MCP status |
| --- | --- | --- | --- | --- |
| `GET get_version` | `testrail_get_version` | [`metadata.getVersion`](https://github.com/dichovsky/testrail-api-client/blob/89f636e276ea701412bb06039e3b963d83126ea1/src/modules/metadata.ts#L62) | No page/all helpers | implemented |

## Baseline verification

The original planning snapshot was checked mechanically against the pinned local driver source:

- 133 endpoint inventory entries; 133 unique HTTP verb/path pairs.
- Exact equality between inventory routes and generated mapping routes: zero missing mappings and zero extra mappings.
- 133 distinct public module/method bindings; every module is a public `TestRailClient` property and every method exists in its linked source module.
- All 24 declared paginated endpoints have both named helpers in source: 48 verified helpers, split across 18 controlled and 6 response-driven lists.
- Resource totals sum to 133; the rendered endpoint matrix contains exactly 133 endpoint rows, all then marked planned.
- The matrix assigns 133 distinct MCP tool names, each exactly `testrail_` plus its REST operation token. All names use lowercase ASCII letters, digits, and underscores and are at most 64 characters long.
- The [machine-readable operation inventory](operation-inventory.json) matches all 133 rows, including resource, route, tool name, public method, source link, and pagination helpers; its 12 implementation families cover every operation once.

These checks establish inventory and binding completeness only. Protocol schemas, operation behavior, full parameter coverage, licensing/version error handling, packaging, and MCP integration acceptance tests remain implementation work. No live TestRail API calls were made for this baseline. That implementation work has since been completed and verified offline; the [coverage reports](coverage-reports.md) describe what now holds it.
