# Independent parameter manifests

F04 provides a test-only fixture format and reviewed examples. Endpoint families T01–T12 must finish the manifests and adapter contract tests before R01. A manifest's `complete` review status means that its parameter requirements have been reviewed and represented in fixtures; it does not certify an implemented tool, file policy, client compatibility or a live TestRail instance.

The examples use the installed development driver `7.0.0`, source commit [`71a80d984aea14713d8eeaf6ac9a0d41c1fba12b`](https://github.com/dichovsky/testrail-api-client/tree/71a80d984aea14713d8eeaf6ac9a0d41c1fba12b). F01 must qualify the later production driver independently. Updating a package pin does not automatically update reviewed fixture provenance.

| Endpoint | Reviewed parameters | Fixture cases | Review status |
| --- | ---: | ---: | --- |
| `get_attachment` | 1 | 12 | Complete input manifest |
| `get_attachments_for_plan_entry` | 2 | 11 | Complete input manifest |
| `get_cases` | 2 | 9 | Partial: project ID and refs variants |
| `update_case` | 3 | 8 | Partial: case ID, body container and custom-field extension point |
| `update_project` | 2 | 9 | Partial: project ID and group role sentinel values |

There are **128 endpoints without a manifest**, **3 partial manifests**, and **2 complete input manifests**. The partial files name their remaining fields under `review.pending`. `parameterCoverageReport()` returns the exact sorted tool names in each group; its test compares their union with all 133 inventory names. Completing a manifest requires reviewing the endpoint's entire parameter surface against sources, not merely deleting its pending text.

## Format and integration

The strict schema and audit helpers are in [tests/contracts/parameter-manifest.ts](../tests/contracts/parameter-manifest.ts). Files under [tests/fixtures/parameters](../tests/fixtures/parameters/) contain authored JSON values and expected requests. They import nothing from the production registry.

Each manifest records:

- Exact method, route, tool, family and public driver binding; an independently reviewed source revision and evidence links.
- Each reviewed parameter's input path, requiredness, independent JSON Schema domain fragment, omission/null semantics, driver argument index/path, and wire field names and encoding. `*` denotes a reviewed array member or custom-field extension point. Adapter-only selectors such as `_mcp.pagination` use `driver: null`, allowed only with `scope: "mcp"` and `wire.location: "adapter_only"`. Their fixtures still verify the selected public helper. Controls such as `_mcp.page_size` declare the real driver argument path (`pageSize`) while remaining absent from wire serialization.
- The driver result's required outer shape and the tool's data projection, including void-to-null, page-to-items and binary-to-download-metadata behavior. Entity details remain advisory as required by F05.
- Named mapping and valid/invalid requirements for every reviewed parameter. Required parameters need a missing-input rejection requirement; optional or conditional parameters need an omission requirement. Conditional nested requirements, such as `role_id` being required inside a supplied group assignment, also have an explicit rejection requirement.
- Literal accepted/rejected tool inputs and references to the requirements they exercise. Endpoint-wide requirements use the reserved `$input` target. Valid fixtures contain independently authored public driver arguments, wire method/endpoint/body, a synthetic upstream response and the expected driver result.

`loadParameterManifests()` parses all fixture files. `auditParameterManifests(manifests, inventory)` detects duplicate endpoint, route, parameter, source, requirement and case IDs; identity mismatches; unresolved source/parameter/requirement references; omitted fixture coverage; missing per-parameter mapping/validation requirements; and outcome/requirement conflicts. It does not infer undocumented parameters from a registry or treat an arbitrary `domain` object as proof of a valid JSON Schema.

Endpoints without inputs use `parameters: []`, an accepted empty-object fixture with `driver.arguments: []`, and endpoint-wide rejection requirements for unknown fields. Every endpoint must include at least one accepted fixture with driver and wire evidence, even if it has no parameters. The format tests exercise this with a synthetic `get_priorities` example; it does not add another completed family manifest to the coverage totals above.

`parameterCoverageReport(manifests, inventory)` lists reviewed, complete, partial and absent endpoints. A family contract suite should load its files, validate each literal input with both the production runtime schema and emitted JSON Schema, assert rejected inputs cause no driver invocation, and compare accepted calls and injected-fetch requests with the fixture's literal expectations. Runtime schemas, generated schema acceptance, driver arguments and wire serialization are separate assertions. Do not generate expected requests or domains from the registry being tested.

The format also represents text responses, JSON/void outer variants and multipart fields. Multipart expectations describe decoded part name, filename, media type and synthetic UTF-8 contents, independently of a generated boundary string. Optional `files` entries reserve explicit fixture tokens, filenames and contents for the T12/F07 disposable-file harness. That harness must define token substitution and staged-file assertions when those examples are added; no current fixture creates or uploads a local file. A case cannot declare both JSON and multipart request bodies.

## Reviewed source decisions

`entry_id` is a UUID string, although the attachment documentation historically labels it an integer. The pinned public method documents that discrepancy and applies the UUID validator. `attachment_id` accepts a positive numeric ID or UUID, while numeric strings, arbitrary paths, malformed UUIDs and whitespace padding are invalid. Sources: [attachment methods](https://github.com/dichovsky/testrail-api-client/blob/71a80d984aea14713d8eeaf6ac9a0d41c1fba12b/src/modules/attachments.ts), [identifier validators](https://github.com/dichovsky/testrail-api-client/blob/71a80d984aea14713d8eeaf6ac9a0d41c1fba12b/src/validation.ts).

The MCP UUID domain additionally requires the match to reach the absolute end of input. Its `(?![\s\S])` terminal assertion rejects a final newline, unlike JavaScript's `$` anchor used in the pinned driver. Explicit LF/CRLF rejection fixtures and domain-pattern regressions prevent terminal line breaks from passing the MCP boundary.

For `get_cases`, a string uses `refs=value`; an array emits repeated `refs%5B%5D=value` parameters. Each value is independently percent encoded, and an empty array emits no refs parameter. The fixture uses characters such as `&` and `#` so a broken encoder cannot pass with simple alphanumeric inputs. Sources: [case filter mapping](https://github.com/dichovsky/testrail-api-client/blob/71a80d984aea14713d8eeaf6ac9a0d41c1fba12b/src/modules/cases.ts), [URL encoder](https://github.com/dichovsky/testrail-api-client/blob/71a80d984aea14713d8eeaf6ac9a0d41c1fba12b/src/url.ts).

Case payload custom fields remain flat and preserve JSON values, including `null`, `false`, `0`, arrays and objects. The exported schema uses passthrough, so the MCP boundary must separately reject unknown ordinary names. The exported legacy `custom_fields` property remains an explicitly pending T02 field review; these examples neither relocate flat values into it nor silently remove it from the driver's supported surface. Sources: [case schemas](https://github.com/dichovsky/testrail-api-client/blob/71a80d984aea14713d8eeaf6ac9a0d41c1fba12b/src/schemas/cases.ts), [shared object schema](https://github.com/dichovsky/testrail-api-client/blob/71a80d984aea14713d8eeaf6ac9a0d41c1fba12b/src/schemas/common.ts).

Project assignment `role_id: 0` selects the global role; `role_id: null` clears the project-specific role. Omitting the assignment collection is a different input. A supplied assignment still requires a role field. The fixture verifies each of these states; it does not generalize null to all numeric IDs. For example, the published update-run payload has optional numeric IDs without null, while move-section parent/position fields explicitly support null. Sources: [project payload schemas](https://github.com/dichovsky/testrail-api-client/blob/71a80d984aea14713d8eeaf6ac9a0d41c1fba12b/src/schemas/projects.ts), [TestRail project role semantics](https://support.testrail.com/hc/en-us/articles/7077792415124-Projects), [run schemas](https://github.com/dichovsky/testrail-api-client/blob/71a80d984aea14713d8eeaf6ac9a0d41c1fba12b/src/schemas/runs.ts), [section schemas](https://github.com/dichovsky/testrail-api-client/blob/71a80d984aea14713d8eeaf6ac9a0d41c1fba12b/src/schemas/sections.ts).

## Review procedure

1. Read the pinned public driver declaration, implementation and exported payload schema alongside the official endpoint documentation. Record disagreements and the chosen source-backed behavior. Escalate driver gaps through F01; do not use private HTTP helpers.
2. Enumerate every supported path, query, body, nested, multipart and adapter control field. Inspect alias/list/nullable/sentinel branches explicitly, and distinguish a driver's helper parameters from public tool inputs. Mark any unreviewed fields in `review.pending`.
3. Author literal input, driver argument, request and response fixtures by hand from the evidence. Include all union branches, omission versus null, bounds, required fields, unknown fields and cross-field constraints. Review nested ordinary fields as well as the outer object. Give every parameter a mapping and validation requirement.
4. Run the manifest audit and the family adapter suite, including generated JSON Schema acceptance and real public driver requests with injected fetch/DNS. Prove invalid calls are rejected before invocation. Add harness support explicitly for new binary/text/multipart or outer-result variants.
5. Have the independent reviewer compare the complete field list with sources. Set `review.status: complete` and clear `review.pending` only when the source review and fixture requirements are complete. Keep implementation/host/live qualification status in their corresponding work items.

The current 13 accepted examples run against the installed public driver with injected fetch and DNS, comparing exact URLs, request JSON and driver results. No request reaches TestRail. Rejected fixture cases are format and coverage requirements until a family adapter consumes them; the direct-driver evidence harness does not pretend to validate the MCP input boundary. Run the fixture checks with `npm exec -- vitest run tests/parameter-manifest.test.ts`.
