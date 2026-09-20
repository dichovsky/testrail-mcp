# Independent parameter manifests

F04 provides a test-only fixture format and reviewed examples. Endpoint families T01–T12 must finish the manifests and adapter contract tests before R01. A manifest's `complete` review status means that its parameter requirements have been reviewed and represented in fixtures; it does not certify an implemented tool, file policy, client compatibility or a live TestRail instance.

The examples use the qualified driver `7.2.0`, source commit [`cc7751c01c3d3956d061073283bee6b23bf33422`](https://github.com/dichovsky/testrail-api-client/tree/cc7751c01c3d3956d061073283bee6b23bf33422). Updating a package pin does not automatically update reviewed fixture provenance: a version gate fails until each manifest is re-reviewed against the installed driver, and the re-review must cite evidence, not restate the new version.

| Endpoint | Reviewed parameters | Fixture cases | Review status |
| --- | ---: | ---: | --- |
| `add_bdd` | 4 | 10 | Complete input manifest |
| `add_case` | 12 | 16 | Complete input manifest |
| `add_cases` | 12 | 18 | Complete input manifest |
| `add_config` | 3 | 8 | Complete input manifest |
| `add_config_group` | 3 | 8 | Complete input manifest |
| `add_plan` | 27 | 38 | Complete input manifest |
| `add_plan_entry` | 20 | 29 | Complete input manifest |
| `add_project` | 4 | 10 | Complete input manifest |
| `add_result` | 9 | 15 | Complete input manifest |
| `add_result_for_case` | 10 | 15 | Complete input manifest |
| `add_results` | 11 | 20 | Complete input manifest |
| `add_results_for_cases` | 11 | 20 | Complete input manifest |
| `add_run` | 13 | 18 | Complete input manifest |
| `add_run_to_plan_entry` | 12 | 20 | Complete input manifest |
| `add_section` | 5 | 10 | Complete input manifest |
| `add_shared_step` | 5 | 11 | Complete input manifest |
| `add_suite` | 3 | 9 | Complete input manifest |
| `close_plan` | 1 | 3 | Complete input manifest |
| `close_run` | 1 | 3 | Complete input manifest |
| `copy_cases_to_section` | 3 | 6 | Complete input manifest |
| `delete_case` | 2 | 7 | Complete input manifest |
| `delete_cases` | 5 | 11 | Complete input manifest |
| `delete_config` | 1 | 3 | Complete input manifest |
| `delete_config_group` | 1 | 3 | Complete input manifest |
| `delete_plan` | 1 | 3 | Complete input manifest |
| `delete_plan_entry` | 2 | 4 | Complete input manifest |
| `delete_project` | 1 | 3 | Complete input manifest |
| `delete_run` | 2 | 7 | Complete input manifest |
| `delete_run_from_plan_entry` | 1 | 3 | Complete input manifest |
| `delete_section` | 2 | 7 | Complete input manifest |
| `delete_shared_step` | 2 | 7 | Complete input manifest |
| `delete_suite` | 2 | 7 | Complete input manifest |
| `edit_result` | 10 | 17 | Complete input manifest |
| `get_attachment` | 1 | 12 | Complete input manifest |
| `get_attachments_for_plan_entry` | 2 | 11 | Complete input manifest |
| `get_bdd` | 1 | 4 | Complete input manifest |
| `get_bdds` | 14 | 19 | Complete input manifest |
| `get_case` | 1 | 3 | Complete input manifest |
| `get_case_titles` | 1 | 5 | Complete input manifest |
| `get_cases` | 25 | 24 | Complete input manifest |
| `get_configs` | 1 | 3 | Complete input manifest |
| `get_history_for_case` | 10 | 16 | Complete input manifest |
| `get_plan` | 1 | 3 | Complete input manifest |
| `get_plans` | 16 | 24 | Complete input manifest |
| `get_project` | 1 | 3 | Complete input manifest |
| `get_projects` | 10 | 18 | Complete input manifest |
| `get_results` | 12 | 19 | Complete input manifest |
| `get_results_for_case` | 13 | 19 | Complete input manifest |
| `get_results_for_run` | 15 | 24 | Complete input manifest |
| `get_run` | 1 | 3 | Complete input manifest |
| `get_runs` | 18 | 23 | Complete input manifest |
| `get_section` | 1 | 3 | Complete input manifest |
| `get_sections` | 11 | 18 | Complete input manifest |
| `get_shared_step` | 1 | 3 | Complete input manifest |
| `get_shared_step_history` | 6 | 10 | Complete input manifest |
| `get_shared_steps` | 16 | 19 | Complete input manifest |
| `get_suite` | 1 | 3 | Complete input manifest |
| `get_suites` | 10 | 16 | Complete input manifest |
| `get_test` | 2 | 7 | Complete input manifest |
| `get_tests` | 12 | 20 | Complete input manifest |
| `move_cases_to_section` | 4 | 6 | Complete input manifest |
| `move_section` | 3 | 15 | Complete input manifest |
| `update_bdd` | 4 | 10 | Complete input manifest |
| `update_case` | 13 | 15 | Complete input manifest |
| `update_cases` | 14 | 15 | Complete input manifest |
| `update_config` | 3 | 8 | Complete input manifest |
| `update_config_group` | 3 | 8 | Complete input manifest |
| `update_plan` | 8 | 11 | Complete input manifest |
| `update_plan_entry` | 12 | 20 | Complete input manifest |
| `update_project` | 11 | 29 | Complete input manifest |
| `update_run` | 12 | 17 | Complete input manifest |
| `update_run_in_plan_entry` | 10 | 17 | Complete input manifest |
| `update_section` | 3 | 8 | Complete input manifest |
| `update_shared_step` | 5 | 10 | Complete input manifest |
| `update_suite` | 3 | 8 | Complete input manifest |
| `update_test` | 3 | 10 | Complete input manifest |
| `update_tests` | 3 | 13 | Complete input manifest |

Case counts are authored cases; a parameter that references the shared domain library ([tests/fixtures/domains.json](../tests/fixtures/domains.json)) derives further rejections at load, one per proven invalid value. There are **75 endpoints without a manifest**, **no partial manifests**, and **58 complete input manifests**. A partial file names its remaining fields under `review.pending`. `parameterCoverageReport()` returns the exact sorted tool names in each group; its test compares their union with all 133 inventory names. Completing a manifest requires reviewing the endpoint's entire parameter surface against sources, not merely deleting its pending text.

## Format and integration

The strict schema and audit helpers are in [tests/contracts/parameter-manifest.ts](../tests/contracts/parameter-manifest.ts). Files under [tests/fixtures/parameters](../tests/fixtures/parameters/) contain authored JSON values and expected requests. They import nothing from the production registry.

Each manifest records:

- Exact method, route, tool, family and public driver binding; an independently reviewed source revision and evidence links.
- Each reviewed parameter's input path, requiredness, independent JSON Schema domain fragment, omission/null semantics, driver argument index/path, and wire field names and encoding. `*` denotes a reviewed array member or custom-field extension point. Adapter-only selectors such as `_mcp.pagination` use `driver: null`, allowed only with `scope: "mcp"` and `wire.location: "adapter_only"`. Their fixtures still verify the selected public helper. Controls such as `_mcp.page_size` declare the real driver argument path (`pageSize`) while remaining absent from wire serialization.
- The driver result's required outer shape and the tool's data projection, including void-to-null, page-to-items and binary-to-download-metadata behavior. Entity details remain advisory as required by F05.
- Named mapping and valid/invalid requirements for every reviewed parameter. Required parameters need a missing-input rejection requirement; optional or conditional parameters need an omission requirement. Conditional nested requirements, such as `role_id` being required inside a supplied group assignment, also have an explicit rejection requirement.
- Literal accepted/rejected tool inputs and references to the requirements they exercise. Endpoint-wide requirements use the reserved `$input` target. Valid fixtures contain independently authored public driver arguments, wire method/endpoint/body, a synthetic upstream response and the expected driver result.

`loadParameterManifests()` parses all fixture files. `auditRegisteredParameters(registry, manifests)` additionally holds a registration to its manifest: every reviewed parameter needs an argument mapping in each mode it applies to **and** an accepted fixture of that mode that actually supplies it, since a declared mapping that no example carries would still match a branch which silently drops the parameter. It also compares the registration's response shape with the reviewed outer result, because a wrong contract fails every real call inside `validateOuter` while all the arguments still agree. `auditParameterManifests(manifests, inventory)` detects duplicate endpoint, route, parameter, source, requirement and case IDs; identity mismatches; unresolved source/parameter/requirement references; omitted fixture coverage; missing per-parameter mapping/validation requirements; and outcome/requirement conflicts. It does not infer undocumented parameters from a registry or treat an arbitrary `domain` object as proof of a valid JSON Schema.

Endpoints without inputs use `parameters: []`, an accepted empty-object fixture with `driver.arguments: []`, and endpoint-wide rejection requirements for unknown fields. Every endpoint must include at least one accepted fixture with driver and wire evidence, even if it has no parameters. The format tests exercise this with a synthetic `get_priorities` example; it does not add another completed family manifest to the coverage totals above.

`parameterCoverageReport(manifests, inventory)` lists reviewed, complete, partial and absent endpoints. A family contract suite should load its files, validate each literal input with both the production runtime schema and emitted JSON Schema, assert rejected inputs cause no driver invocation, and compare accepted calls and injected-fetch requests with the fixture's literal expectations. Runtime schemas, generated schema acceptance, driver arguments and wire serialization are separate assertions. Do not generate expected requests or domains from the registry being tested.

The format also represents text responses, JSON/void outer variants and multipart fields. A reply that is not the shape an endpoint documents is the reply's fault, not the adapter's: asking `get_test` for a test's data makes the driver assemble one record out of three parts, and a reply missing them is reported as an invalid response rather than as an internal failure. Two bulk writes that look alike can differ in what they can honestly report. An unusable success from the bulk case writes is an unknown outcome, because the driver method fails closed and never resolves; the same reply from the bulk result writes is an acknowledged one, because response validation there is advisory, so the driver resolves and the boundary refuses the body after TestRail has already accepted the submission. A result is not always the entity its name suggests: `update_tests` acknowledges a bulk label assignment by echoing the IDs and labels rather than returning the tests, and `get_test` merges a test's results and attachments into one record when they are asked for. `get_bdd` is the one endpoint of this API that answers with text rather than JSON, and `get_shared_step_history` the one whose paging is response-driven: it documents no request controls, so its fixtures send none and its page result says a continuation cannot be requested by offset. Multipart expectations describe decoded part name, filename, media type and synthetic UTF-8 contents, independently of a generated boundary string. `files` entries declare the synthetic files an upload fixture needs: a token, a filename and the contents. A manifest cannot name an absolute path, because it is authored by hand and read on every machine that runs the suite, so [tests/contracts/uploads.ts](../tests/contracts/uploads.ts) materializes each declared file into a temporary directory for the length of one case and substitutes `{{token}}` with that path wherever it appears, in the fixture's input and in its expected driver arguments alike. The BDD upload examples are the first to use this. A multipart request body is compared part by part rather than as an opaque object, since the boundary string is generated per request and says nothing about what was sent. The parts are read out of the encoded request rather than the form data handed to the encoder, because the encoding is where a name or a media type can still change: a part whose type the caller left undeclared is written as `application/octet-stream`. They are read inside the request as well, since the driver owns an upload's streams and cancels them once it settles. A case cannot declare both JSON and multipart request bodies.

## Reviewed source decisions

`entry_id` is a UUID string, although the attachment documentation historically labels it an integer. The pinned public method documents that discrepancy and applies the UUID validator. `attachment_id` accepts a positive numeric ID or UUID, while numeric strings, arbitrary paths, malformed UUIDs and whitespace padding are invalid. Sources: [attachment methods](https://github.com/dichovsky/testrail-api-client/blob/cc7751c01c3d3956d061073283bee6b23bf33422/src/modules/attachments.ts), [identifier validators](https://github.com/dichovsky/testrail-api-client/blob/cc7751c01c3d3956d061073283bee6b23bf33422/src/validation.ts).

The MCP UUID domain requires the match to reach the absolute end of input, which its `(?![\s\S])` terminal assertion states outright. The pinned driver's `$` anchor behaves the same way here, because it carries no multiline flag, so neither layer admits a trailing line terminator; an earlier note in this document claimed the two differed, and a probe against the driver showed they do not. The assertion is kept because it says what is meant without depending on a flag elsewhere in the pattern, and because a shared domain is only worth reusing if what it claims is proven: the `entry_id` domain drives its LF, CR and CRLF values through a public driver method and asserts the refusal at both layers, so a driver that started admitting them would fail the suite rather than quietly widen the boundary.

For `get_cases`, a string uses `refs=value`; a non-empty array emits repeated `refs%5B%5D=value` parameters, each value independently percent encoded. The driver would send nothing for an empty array, silently widening the result to every case, so the boundary refuses an empty array instead; the same rule holds for the seven comma-joined ID filters through the shared `id_filter` domain. The fixture uses characters such as `&` and `#` so a broken encoder cannot pass with simple alphanumeric inputs. Sources: [case filter mapping](https://github.com/dichovsky/testrail-api-client/blob/cc7751c01c3d3956d061073283bee6b23bf33422/src/modules/cases.ts), [URL encoder](https://github.com/dichovsky/testrail-api-client/blob/cc7751c01c3d3956d061073283bee6b23bf33422/src/url.ts).

Case payload custom fields remain flat and preserve JSON values, including `null`, `false`, `0`, arrays and objects. The exported schema uses passthrough, so the MCP boundary must separately reject unknown ordinary names. The exported payloads also declare a nested `custom_fields` record that TestRail does not document as a request field: it reads custom values only as flat `custom_*` properties, so forwarding the container would drop them silently. The T02 manifests therefore refuse it explicitly (`legacy-custom-container`) rather than forwarding or relocating it. Body identifiers (`section_id`, `template_id`, `type_id`, `priority_id`, `milestone_id`) and numeric label members are held to the identifier domain where the driver accepts any number; `milestone_id` admits no null in the driver, so unlinking a milestone is not available through the pinned driver. Sources: [case schemas](https://github.com/dichovsky/testrail-api-client/blob/cc7751c01c3d3956d061073283bee6b23bf33422/src/schemas/cases.ts), [shared object schema](https://github.com/dichovsky/testrail-api-client/blob/cc7751c01c3d3956d061073283bee6b23bf33422/src/schemas/common.ts).

Project assignment `role_id: 0` selects the global role; `role_id: null` clears the project-specific role. Omitting the assignment collection is a different input. A supplied assignment still requires a role field. The fixture verifies each of these states; it does not generalize null to all numeric IDs. For example, the published update-run payload has optional numeric IDs without null, while move-section parent/position fields explicitly support null. Sources: [project payload schemas](https://github.com/dichovsky/testrail-api-client/blob/cc7751c01c3d3956d061073283bee6b23bf33422/src/schemas/projects.ts), [TestRail project role semantics](https://support.testrail.com/hc/en-us/articles/7077792415124-Projects), [run schemas](https://github.com/dichovsky/testrail-api-client/blob/cc7751c01c3d3956d061073283bee6b23bf33422/src/schemas/runs.ts), [section schemas](https://github.com/dichovsky/testrail-api-client/blob/cc7751c01c3d3956d061073283bee6b23bf33422/src/schemas/sections.ts).

A plan's entries carry fields that the endpoints changing them do not accept, and forwarding one would be a write the caller is told succeeded while nothing changed. TestRail's reference states that `config_ids` and `runs` are not supported on `update_plan_entry`, and that endpoint's request body carries no `suite_id`; a run inside an entry takes its name from its configuration combination, so `add_run_to_plan_entry` and `update_run_in_plan_entry` refuse a `name`, and the latter refuses `config_ids` as well. Each refusal is an endpoint-wide requirement with its own fixture rather than an unnamed consequence of strictness, so removing the rule fails a case that says what was lost. The driver parses none of these payloads, so every rule at every depth of a plan, an entry and a nested run is the boundary's alone. Sources: [plan payload schemas](https://github.com/dichovsky/testrail-api-client/blob/cc7751c01c3d3956d061073283bee6b23bf33422/src/schemas/plans.ts), [TestRail plan semantics](https://support.testrail.com/hc/en-us/articles/7077711537684-Plans).

A nested run is held to the same rule. TestRail's reference names `assignedto_id`, `include_all` and `case_ids` as the fields a run inside an entry may override, and the runs example in that reference carries no `name`; the driver's payload schemas say why, recording that TestRail derives a nested run's name from its configuration combination, which is also why the standalone `add_run_to_plan_entry` payload omits the field entirely. `add_plan` and `add_plan_entry` therefore refuse a nested `name` as well, so the same field is not accepted in one place and refused in another on the same stated ground.

An effect annotation is now a gate rather than a per-endpoint assertion. `effects.destructive` is published as the MCP `destructiveHint`, which is what a host uses to decide whether to ask before calling, and until T06 nothing compared it against anything: the manifests describe arguments and replies, and the registration audits compare response shapes. `update_plan_entry` shipped as non-destructive although narrowing its case selection deletes tests and results in every run the entry generated, while the two siblings that destroy strictly less were both flagged correctly. [tests/effects.test.ts](../tests/effects.test.ts) states the rules over the whole registry instead: every removal is destructive, no read is, and a write that is not a creation and can narrow an existing run's case selection is. A rule has to be argued with, where a per-endpoint restatement could simply be edited to agree with a mistake.

Three plan filters are rewritten between the caller and the wire, and the boolean is the one that can fail silently. `created_by` and `milestone_id` are comma-joined from a list, which is visible in the rendered query string, while `is_completed` is sent as `1` or `0`, so a `false` treated as absent would quietly ask for every plan instead of the open ones. The family suite asserts all three in the rendered query string on the first request, and the boolean again on an aggregate continuation, because a filter that survives only the first request returns a correct first page and a wrong remainder.

## Review procedure

1. Read the pinned public driver declaration, implementation and exported payload schema alongside the official endpoint documentation. Record disagreements and the chosen source-backed behavior. Escalate driver gaps through F01; do not use private HTTP helpers.
2. Enumerate every supported path, query, body, nested, multipart and adapter control field. Inspect alias/list/nullable/sentinel branches explicitly, and distinguish a driver's helper parameters from public tool inputs. Mark any unreviewed fields in `review.pending`.
3. Author literal input, driver argument, request and response fixtures by hand from the evidence. Include all union branches, omission versus null, bounds, required fields, unknown fields and cross-field constraints. Review nested ordinary fields as well as the outer object. Give every parameter a mapping and validation requirement.
4. Run the manifest audit and the family adapter suite, including generated JSON Schema acceptance and real public driver requests with injected fetch/DNS. Prove invalid calls are rejected before invocation. Add harness support explicitly for new binary/text/multipart or outer-result variants.
5. Have the independent reviewer compare the complete field list with sources. Set `review.status: complete` and clear `review.pending` only when the source review and fixture requirements are complete. Keep implementation/host/live qualification status in their corresponding work items.

## Shared parameter domains

`validateId(id, name)` is a single implementation applied at **129 call sites**, and its `name` argument only shapes the error message. Every TestRail identifier therefore shares one domain, as do `limit` and `offset` through `validatePaginationParams`. Writing that domain out per parameter would mean a hundred copies of "reject `-1`" — duplication that carries no signal, makes a genuinely wrong entry harder to spot among near-identical neighbours, and turns a driver validation change into a hundred-file edit.

[`tests/fixtures/domains.json`](../tests/fixtures/domains.json) describes each shared domain once: its JSON Schema, its semantics, its requirements, and its valid and invalid values. A parameter then writes `domain_ref` in place of an inline `domain` and `requirements`. Measured on `testrail_get_project`, whose identifier is its only parameter, this cut the manifest from 223 lines to 144; the library pays for itself after three endpoints.

Two properties keep a reference as strong as writing it out.

**The library is evidence, not a claim.** A shared domain reused by many parameters would otherwise concentrate risk: one wrong entry silently weakens every parameter referencing it. Each domain names a public driver method as its `probe`, and [`tests/domains.test.ts`](../tests/domains.test.ts) drives every value through it — asserting that an invalid value is refused *before dispatch*, with zero upstream requests, and that a valid one reaches the wire. The package does not export its validators and the contracts forbid importing internals, so this proves the domain against the driver's real behaviour rather than against a copy of its rules. Each invalid value also records `rejected_by`, and the probe asserts all three cases apart: `driver` where the pinned client refuses it with its own validation error, `driver_crash` where the client stops before dispatch but by throwing from an unguarded operation rather than a stated check, and `adapter` where only the MCP boundary refuses. The middle label matters because a crash is not a contract: `serializeIdFilter` and `getCaseTitles` both stop a wrongly typed argument today, but neither documents doing so. `validateId` uses `Number.isInteger`, not `Number.isSafeInteger`, so a value above 2^53 passes the driver and is refused only here — the library says so rather than implying the driver guarantees it.

A parameter inside a reviewed array names its member with `*`, as in `body.results[].status_id`. Its derived rejections mutate the first member alone, so every other member stays valid and the refusal can still only have come from the member under test.

**Derived rejections stay attributable.** A manifest using `domain_ref` names a `baseline` accepted case. Each rejection is derived by mutating that baseline at exactly one input path, so everything else in the input stayed valid and the refusal can only have come from the parameter under test. Removing the derivation leaves the covered requirements uncovered and the audit names each one, so these cases are load-bearing rather than decorative.

A parameter of any scope may reference a shared domain when the adapter holds it to that domain — path, query and body identifiers all reference `positive_id`, and a body reference records in its `semantics` where the driver itself is looser. Endpoint-specific domains, such as the `attachment_id` union or a payload's own value types, stay written out in full.

The Cases family added three domains. `id_filter` is one identifier or a non-empty list, proven through the `typeId` option of `cases.getCasesPage`, which is one of the seven filters the driver comma-joins. `unix_timestamp` is proven through `createdAfter`; the driver forwards any value there, so every rejection is recorded as the adapter's. `case_ids` is a non-empty identifier list proven through `cases.getCaseTitles`. That is a query-side proof: the four bulk bodies referencing the same domain are forwarded unchecked by the driver, so their guarantee is the adapter's alone, which each body reference records in its semantics. The Plans family added `entry_id`, the only non-numeric identifier in the library, proven through `attachments.getAttachmentsForPlanEntry`: the driver validates the UUID layout there before dispatch, so its eight rejections are recorded as the driver's rather than the adapter's. The earlier `get_attachments_for_plan_entry` manifest still writes the same rule out inline instead of referencing the domain, which is left as follow-up work.

The accepted examples run against the installed public driver with injected fetch and DNS, comparing exact URLs, request JSON and driver results. No request reaches TestRail. Rejected fixture cases are format and coverage requirements until a family adapter consumes them; the direct-driver evidence harness does not pretend to validate the MCP input boundary. Run the fixture checks with `npm exec -- vitest run tests/parameter-manifest.test.ts`.
