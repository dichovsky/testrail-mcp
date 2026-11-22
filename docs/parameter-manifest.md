# Independent parameter manifests

F04 provides a test-only fixture format and reviewed examples. Endpoint families T01–T12 must finish the manifests and adapter contract tests before R01. A manifest's `complete` review status means that its parameter requirements have been reviewed and represented in fixtures. The status does not certify an implemented tool, file policy, client compatibility or a live TestRail instance.

The examples use the qualified driver `9.0.0`, source commit [`a5ccffbfa176e9c6675bd81fff61859bd7b6be5d`](https://github.com/dichovsky/testrail-api-client/tree/a5ccffbfa176e9c6675bd81fff61859bd7b6be5d). Updating a package pin does not automatically update reviewed fixture provenance. A version gate fails until each manifest is re-reviewed against the installed driver. The re-review must record [evidence the audit checks](#driver-provenance-evidence). It must not restate the new version.

| Endpoint | Reviewed parameters | Fixture cases | Review status |
| --- | ---: | ---: | --- |
| `add_attachment_to_case` | 4 | 17 | Complete input manifest |
| `add_attachment_to_plan` | 4 | 17 | Complete input manifest |
| `add_attachment_to_plan_entry` | 5 | 18 | Complete input manifest |
| `add_attachment_to_result` | 4 | 17 | Complete input manifest |
| `add_attachment_to_run` | 4 | 17 | Complete input manifest |
| `add_bdd` | 4 | 10 | Complete input manifest |
| `add_case` | 12 | 17 | Complete input manifest |
| `add_case_field` | 18 | 53 | Complete input manifest |
| `add_cases` | 12 | 19 | Complete input manifest |
| `add_config` | 3 | 8 | Complete input manifest |
| `add_config_group` | 3 | 8 | Complete input manifest |
| `add_dataset` | 4 | 12 | Complete input manifest |
| `add_group` | 3 | 10 | Complete input manifest |
| `add_label` | 3 | 10 | Complete input manifest |
| `add_milestone` | 8 | 12 | Complete input manifest |
| `add_plan` | 27 | 41 | Complete input manifest |
| `add_plan_entry` | 20 | 32 | Complete input manifest |
| `add_project` | 4 | 10 | Complete input manifest |
| `add_result` | 9 | 18 | Complete input manifest |
| `add_result_for_case` | 10 | 18 | Complete input manifest |
| `add_results` | 11 | 22 | Complete input manifest |
| `add_results_for_cases` | 11 | 22 | Complete input manifest |
| `add_run` | 13 | 20 | Complete input manifest |
| `add_run_to_plan_entry` | 12 | 22 | Complete input manifest |
| `add_section` | 5 | 10 | Complete input manifest |
| `add_shared_step` | 5 | 12 | Complete input manifest |
| `add_suite` | 3 | 9 | Complete input manifest |
| `add_user` | 11 | 26 | Complete input manifest |
| `add_variable` | 3 | 8 | Complete input manifest |
| `close_plan` | 1 | 3 | Complete input manifest |
| `close_run` | 1 | 3 | Complete input manifest |
| `copy_cases_to_section` | 3 | 6 | Complete input manifest |
| `delete_attachment` | 1 | 15 | Complete input manifest |
| `delete_case` | 2 | 7 | Complete input manifest |
| `delete_cases` | 5 | 11 | Complete input manifest |
| `delete_config` | 1 | 3 | Complete input manifest |
| `delete_config_group` | 1 | 3 | Complete input manifest |
| `delete_dataset` | 1 | 3 | Complete input manifest |
| `delete_group` | 1 | 3 | Complete input manifest |
| `delete_label` | 1 | 3 | Complete input manifest |
| `delete_labels` | 2 | 10 | Complete input manifest |
| `delete_milestone` | 1 | 3 | Complete input manifest |
| `delete_plan` | 1 | 3 | Complete input manifest |
| `delete_plan_entry` | 2 | 4 | Complete input manifest |
| `delete_project` | 1 | 3 | Complete input manifest |
| `delete_run` | 2 | 7 | Complete input manifest |
| `delete_run_from_plan_entry` | 1 | 3 | Complete input manifest |
| `delete_section` | 2 | 7 | Complete input manifest |
| `delete_shared_step` | 2 | 7 | Complete input manifest |
| `delete_suite` | 2 | 7 | Complete input manifest |
| `delete_variable` | 1 | 3 | Complete input manifest |
| `edit_result` | 10 | 18 | Complete input manifest |
| `get_attachment` | 1 | 15 | Complete input manifest |
| `get_attachments_for_case` | 10 | 16 | Complete input manifest |
| `get_attachments_for_plan` | 10 | 16 | Complete input manifest |
| `get_attachments_for_plan_entry` | 2 | 6 | Complete input manifest |
| `get_attachments_for_run` | 10 | 16 | Complete input manifest |
| `get_attachments_for_test` | 1 | 6 | Complete input manifest |
| `get_bdd` | 1 | 4 | Complete input manifest |
| `get_bdds` | 14 | 19 | Complete input manifest |
| `get_case` | 1 | 3 | Complete input manifest |
| `get_case_fields` | 0 | 2 | Complete input manifest |
| `get_case_statuses` | 5 | 14 | Complete input manifest |
| `get_case_titles` | 1 | 5 | Complete input manifest |
| `get_case_types` | 0 | 2 | Complete input manifest |
| `get_cases` | 25 | 24 | Complete input manifest |
| `get_configs` | 1 | 3 | Complete input manifest |
| `get_cross_project_reports` | 0 | 2 | Complete input manifest |
| `get_current_user` | 0 | 2 | Complete input manifest |
| `get_dataset` | 1 | 5 | Complete input manifest |
| `get_datasets` | 6 | 10 | Complete input manifest |
| `get_dynamic_filter_fields` | 1 | 3 | Complete input manifest |
| `get_group` | 1 | 3 | Complete input manifest |
| `get_groups` | 5 | 10 | Complete input manifest |
| `get_history_for_case` | 10 | 16 | Complete input manifest |
| `get_label` | 1 | 3 | Complete input manifest |
| `get_labels` | 10 | 16 | Complete input manifest |
| `get_milestone` | 1 | 3 | Complete input manifest |
| `get_milestones` | 12 | 21 | Complete input manifest |
| `get_plan` | 1 | 3 | Complete input manifest |
| `get_plans` | 16 | 24 | Complete input manifest |
| `get_priorities` | 0 | 2 | Complete input manifest |
| `get_project` | 1 | 3 | Complete input manifest |
| `get_projects` | 10 | 18 | Complete input manifest |
| `get_reports` | 1 | 3 | Complete input manifest |
| `get_result_fields` | 0 | 2 | Complete input manifest |
| `get_results` | 12 | 19 | Complete input manifest |
| `get_results_for_case` | 13 | 19 | Complete input manifest |
| `get_results_for_run` | 15 | 24 | Complete input manifest |
| `get_roles` | 5 | 10 | Complete input manifest |
| `get_run` | 1 | 3 | Complete input manifest |
| `get_runs` | 18 | 23 | Complete input manifest |
| `get_section` | 1 | 3 | Complete input manifest |
| `get_sections` | 11 | 18 | Complete input manifest |
| `get_shared_step` | 1 | 3 | Complete input manifest |
| `get_shared_step_history` | 6 | 10 | Complete input manifest |
| `get_shared_steps` | 16 | 19 | Complete input manifest |
| `get_statuses` | 0 | 2 | Complete input manifest |
| `get_suite` | 1 | 3 | Complete input manifest |
| `get_suites` | 10 | 16 | Complete input manifest |
| `get_templates` | 1 | 3 | Complete input manifest |
| `get_test` | 2 | 7 | Complete input manifest |
| `get_tests` | 12 | 20 | Complete input manifest |
| `get_user` | 1 | 3 | Complete input manifest |
| `get_user_by_email` | 1 | 11 | Complete input manifest |
| `get_users` | 1 | 7 | Complete input manifest |
| `get_variables` | 6 | 10 | Complete input manifest |
| `get_version` | 0 | 2 | Complete input manifest |
| `move_cases_to_section` | 4 | 6 | Complete input manifest |
| `move_section` | 3 | 15 | Complete input manifest |
| `run_cross_project_report` | 1 | 3 | Complete input manifest |
| `run_report` | 1 | 3 | Complete input manifest |
| `update_bdd` | 4 | 10 | Complete input manifest |
| `update_case` | 13 | 16 | Complete input manifest |
| `update_cases` | 14 | 16 | Complete input manifest |
| `update_config` | 3 | 8 | Complete input manifest |
| `update_config_group` | 3 | 8 | Complete input manifest |
| `update_dataset` | 4 | 11 | Complete input manifest |
| `update_group` | 4 | 11 | Complete input manifest |
| `update_label` | 4 | 9 | Complete input manifest |
| `update_milestone` | 10 | 15 | Complete input manifest |
| `update_plan` | 8 | 11 | Complete input manifest |
| `update_plan_entry` | 12 | 22 | Complete input manifest |
| `update_project` | 11 | 29 | Complete input manifest |
| `update_run` | 12 | 19 | Complete input manifest |
| `update_run_in_plan_entry` | 10 | 19 | Complete input manifest |
| `update_section` | 3 | 8 | Complete input manifest |
| `update_shared_step` | 5 | 11 | Complete input manifest |
| `update_suite` | 3 | 8 | Complete input manifest |
| `update_test` | 3 | 10 | Complete input manifest |
| `update_tests` | 3 | 13 | Complete input manifest |
| `update_user` | 12 | 24 | Complete input manifest |
| `update_variable` | 3 | 8 | Complete input manifest |

The case counts are authored cases. A parameter that references the shared domain library ([tests/fixtures/domains.json](../tests/fixtures/domains.json)) derives further rejections at load, one per proven invalid value.

There are **no endpoints without a manifest**, **no partial manifests**, and **133 complete input manifests**: one for every endpoint in the inventory. A partial file names its remaining fields under `review.pending`. `parameterCoverageReport()` returns the exact sorted tool names in each group. The test for `parameterCoverageReport()` compares the union of the groups with all 133 inventory names. Completing a manifest requires a review of the entire parameter surface of the endpoint against sources. Deleting the manifest's pending text is not enough.

## Format and integration

The strict schema and audit helpers are in [tests/contracts/parameter-manifest.ts](../tests/contracts/parameter-manifest.ts). Files under [tests/fixtures/parameters](../tests/fixtures/parameters/) contain authored JSON values and expected requests. They import nothing from the production registry.

Each manifest records:

- The exact method, route, tool, family and public driver binding.
- An independently reviewed source revision and evidence links.
- Each reviewed parameter's input path, requiredness, independent JSON Schema domain fragment, omission/null semantics, driver argument index/path, and wire field names and encoding. `*` denotes a reviewed array member or custom-field extension point. Adapter-only selectors such as `_mcp.pagination` use `driver: null`. This value is allowed only with `scope: "mcp"` and `wire.location: "adapter_only"`. Their fixtures still verify the selected public helper. Controls such as `_mcp.page_size` declare the real driver argument path (`pageSize`) and remain absent from wire serialization.
- The driver result's required outer shape and the tool's data projection, including void-to-null, page-to-items and binary-to-download-metadata behavior. Entity details remain advisory, as F05 requires.
- Named mapping and valid/invalid requirements for every reviewed parameter. Required parameters need a missing-input rejection requirement. Optional or conditional parameters need an omission requirement. Conditional nested requirements also have an explicit rejection requirement. For example, `role_id` is required inside a supplied group assignment.
- Literal accepted/rejected tool inputs and references to the requirements they exercise. Endpoint-wide requirements use the reserved `$input` target. Valid fixtures contain independently authored public driver arguments, wire method/endpoint/body, a synthetic upstream response and the expected driver result.

`loadParameterManifests()` parses all fixture files. `auditRegisteredParameters(registry, manifests)` additionally holds a registration to its manifest. Every reviewed parameter needs an argument mapping in each mode that it applies to **and** an accepted fixture of that mode that actually supplies it. The reason is that a declared mapping that no example carries would still match a branch that silently drops the parameter. `auditRegisteredParameters` also compares the response shape of the registration with the reviewed outer result. The reason is that a wrong contract fails every real call inside `validateOuter`, although all the arguments still agree.

`auditParameterManifests(manifests, inventory)` detects:

- duplicate endpoint, route, parameter, source, requirement and case IDs;
- identity mismatches;
- unresolved source/parameter/requirement references;
- omitted fixture coverage;
- missing per-parameter mapping/validation requirements;
- outcome/requirement conflicts;
- rejections that are not attributable.

A refusal names no field, so the audit holds a rejected case to one cause, the one it names. A rejected case may claim at most one parameter. That parameter must be what is wrong, judged by its own authored `domain`:

- for a presence requirement, its leaf is missing, and every parent on the way is present and well-typed;
- for any other rejection, its value is outside the domain. For a `domain_ref` parameter, the value is also a value that the shared library proved refused for that very requirement.

The audit also holds the case to these conditions:

- every other parameter that the case supplies stays inside its own domain;
- every other required parameter is present;
- no top-level key is unknown;
- an endpoint-wide `$input` claim is not combined with a parameter claim.

A case that claims only `$input` must likewise carry no parameter outside its domain.

Without these rules, an input could stand in for the isolating fixtures of a parameter while its registered constraint was weakened. The input would be malformed in a second field, or it would carry an unknown key. An example is the plan entry identifier. Registering it as any string and replacing its eight derived rejections with one such case passes `auditRegisteredParameters`. This audit only asks whether each case is accepted or refused. Removing the derived rejections without a replacement was already reported as uncovered.

Three limits remain:

- An extension point such as `custom_*` is refused for a key outside its prefix. No value domain describes this refusal. Thus, the extension point can share its case with the matching `$input` rule. The audit holds the extension point only to the one-parameter and other-parameter rules.
- An inline domain has no per-requirement values. Thus, for a parameter written out in full, a single out-of-domain value can still claim several of its rejection requirements.
- The audit judges unknown keys at the top level only. The audit catches a key nested inside the object of the named parameter only where the domain of that object forbids extra keys. An example is an extra key beside a rejected `body.name`.

Because a domain is now read as evidence, it has to describe the refusal. Three things changed to meet this requirement.

The `name` and `email` fragments of the user write manifests were bare strings. They now carry the `minLength` of the driver and the address pattern that the boundary applies. The `.feature` filename rule of `add_bdd`/`update_bdd` and the empty-body rule of `edit_result` were filed under `$input`. They now belong to the `filename` and `body` parameters. The domains of these parameters already expressed these rules.

The audit also holds two claims to the case inputs rather than only to each other.

Each parameter's `driver` location must agree with the literal `expect.driver.arguments` of every accepted case. The value that the input carries at `input_path` must be the value found at that argument and `path`. This holds for every parameter that the case supplies, whether or not the case claims to cover it. Otherwise, a location that the manifest and the argument map of the registration both misdescribe would stand. The reason is that the adapter check compares only the literal arguments. The comparison can see a swapped location only where some case gives the two parameters different values or supplies only one of them.

Thus, the suite also swaps the locations of every pair of parameters in every manifest, and it requires the audit to object. Fourteen pairs once carried equal values in every case, such as the `template_id` and `created_by` lists of `get_cases` and the user write flags. These pairs now have a case in which they differ.

An accepted case that covers a requirement of a `domain_ref` parameter must use a value that the shared domain proved for that requirement. For example, a case cannot claim `upper-bound` with `7`. The representative `mapping`/`valid` pair, which holds the requirements of the `representative` value of the domain, is the one exception. Any value that the schema of the domain admits represents the pair as well. The accepted driver evidence of the case itself proves the value that it uses. In both cases, the audit judges every member of a fan-out, and a case that covers a requirement must supply the value.

The audit does not infer undocumented parameters from a registry. The audit does not treat an arbitrary `domain` object as proof of a valid JSON Schema.

Endpoints without inputs use these items:

- `parameters: []`;
- an accepted empty-object fixture with `driver.arguments: []`;
- endpoint-wide rejection requirements for unknown fields.

Every endpoint must include at least one accepted fixture with driver and wire evidence, even if it has no parameters. The format tests exercise this rule with a synthetic `get_priorities` example that is built from the attachment manifest. This example is separate from the reviewed `get_priorities` manifest that T10 added. Only the reviewed manifest counts toward the totals above.

`parameterCoverageReport(manifests, inventory)` lists reviewed, complete, partial and absent endpoints. A family contract suite should:

- load its files;
- validate each literal input with both the production runtime schema and the emitted JSON Schema;
- assert that rejected inputs cause no driver invocation;
- compare accepted calls and injected-fetch requests with the literal expectations of the fixture.

Runtime schemas, generated schema acceptance, driver arguments and wire serialization are separate assertions. Do not generate expected requests or domains from the registry being tested.

The format also represents text responses, JSON/void outer variants and multipart fields.

A reply that does not have the shape that an endpoint documents is the fault of the reply, not of the adapter. For example, if a caller asks `get_test` for the data of a test, the driver assembles one record out of three parts. From 9.0.0 the driver defaults missing results and attachments to empty lists. It refuses a reply without the test, or with parts of the wrong shape, as an unexpected response. This refusal is reported as an invalid response rather than as an internal failure.

Two bulk writes that look alike can differ in what they can honestly report. An unusable success from the bulk case writes is an unknown outcome, because the driver method fails closed and never resolves. The same reply from the bulk result writes is an acknowledged outcome, because response validation there is advisory. Thus, the driver resolves, and the boundary refuses the body after TestRail has already accepted the submission.

A result is not always the entity that its name suggests. For example, `update_tests` acknowledges a bulk label assignment by echoing the IDs and labels rather than returning the tests. `get_test` merges the results and attachments of a test into one record when the caller requests them. `get_bdd` is the one endpoint of this API that answers with text rather than JSON.

Response-driven paging is no longer the single case that this sentence once described. Six of the twenty-four paged lists in the registry use response-driven paging. `get_shared_step_history` was the first, and `get_groups`, `get_roles`, `get_datasets`, `get_variables` and `get_case_statuses` page the same way. Each of the six lists documents no request controls. Thus, their fixtures send none of their own, and their page results say that a continuation cannot be requested by offset.

An aggregate still walks the next link of the envelope and carries whatever offset and limit TestRail put there. No one on this side chooses the page size.

Multipart expectations describe the decoded part name, filename, media type and synthetic UTF-8 contents, independently of a generated boundary string.

`files` entries declare the synthetic files that an upload fixture needs: a token, a filename and the contents. A manifest cannot name an absolute path. The reason is that the manifest is authored by hand and is read on every machine that runs the suite. Thus, [tests/contracts/uploads.ts](../tests/contracts/uploads.ts) materializes each declared file into a temporary directory for the duration of one case. The module substitutes `{{token}}` with that path wherever the token appears, in the input of the fixture and in its expected driver arguments alike. The BDD upload examples are the first to use this mechanism.

A multipart request body is compared part by part rather than as an opaque object. The reason is that the boundary string is generated per request and says nothing about what was sent. The parts are read out of the encoded request rather than out of the form data that is handed to the encoder. The reason is that the encoding is where a name or a media type can still change. For example, a part whose type the caller left undeclared is written as `application/octet-stream`. The parts are read inside the request as well, since the driver owns an upload's streams and cancels them once the request settles.

A case cannot declare both JSON and multipart request bodies.

## Reviewed source decisions

`entry_id` is a UUID string, although the attachment documentation historically labels it an integer. The pinned public method documents that discrepancy and applies the UUID validator. `attachment_id` accepts a positive numeric ID or UUID. Numeric strings, arbitrary paths, malformed UUIDs and whitespace padding are invalid. Sources: [attachment methods](https://github.com/dichovsky/testrail-api-client/blob/a5ccffbfa176e9c6675bd81fff61859bd7b6be5d/src/modules/attachments.ts), [identifier validators](https://github.com/dichovsky/testrail-api-client/blob/a5ccffbfa176e9c6675bd81fff61859bd7b6be5d/src/validation.ts).

The MCP UUID domain requires the match to reach the absolute end of input. Its `(?![\s\S])` terminal assertion states this requirement outright. The `$` anchor of the pinned driver behaves the same way here, because it carries no multiline flag. Thus, neither layer admits a trailing line terminator. An earlier note in this document claimed that the two differed, and a probe against the driver showed that they do not.

The assertion is kept for these reasons:

- it says what is meant without depending on a flag elsewhere in the pattern;
- a shared domain is only worth reusing if what the domain claims is proven.

The `entry_id` domain drives its LF, CR and CRLF values through a public driver method and asserts the refusal at both layers. Thus, a driver that started admitting them would fail the suite rather than quietly widen the boundary.

For `get_cases`, a string uses `refs=value`. A non-empty array emits repeated `refs%5B%5D=value` parameters. Each value is percent encoded independently. The driver would send nothing for an empty array, and this would silently widen the result to every case. Thus, the boundary refuses an empty array instead.

The same rule holds for the seven comma-joined ID filters through the shared `id_filter` domain. The fixture uses characters such as `&` and `#`, so a broken encoder cannot pass with simple alphanumeric inputs. Sources: [case filter mapping](https://github.com/dichovsky/testrail-api-client/blob/a5ccffbfa176e9c6675bd81fff61859bd7b6be5d/src/modules/cases.ts), [URL encoder](https://github.com/dichovsky/testrail-api-client/blob/a5ccffbfa176e9c6675bd81fff61859bd7b6be5d/src/url.ts).

Case payload custom fields remain flat and preserve JSON values, including `null`, `false`, `0`, arrays and objects. The exported schema uses passthrough, so the MCP boundary must separately reject unknown ordinary names. The exported payloads also declare a nested `custom_fields` record. TestRail does not document this record as a request field: TestRail reads custom values only as flat `custom_*` properties. Thus, forwarding the container would drop the values silently. The T02 manifests therefore refuse the record explicitly (`legacy-custom-container`) rather than forwarding or relocating it.

Body identifiers (`section_id`, `template_id`, `type_id`, `priority_id`, `milestone_id`) and numeric label members are held to the identifier domain where the driver accepts any number. `milestone_id` admits no null in the driver, so unlinking a milestone is not available through the pinned driver. Sources: [case schemas](https://github.com/dichovsky/testrail-api-client/blob/a5ccffbfa176e9c6675bd81fff61859bd7b6be5d/src/schemas/cases.ts), [shared object schema](https://github.com/dichovsky/testrail-api-client/blob/a5ccffbfa176e9c6675bd81fff61859bd7b6be5d/src/schemas/common.ts).

Project assignment `role_id: 0` selects the global role. `role_id: null` clears the project-specific role. Omitting the assignment collection is a different input. A supplied assignment still requires a role field. The fixture verifies each of these states.

The fixture does not generalize null to all numeric IDs. For example, the published update-run payload has optional numeric IDs without null, while the move-section parent/position fields explicitly support null. Sources: [project payload schemas](https://github.com/dichovsky/testrail-api-client/blob/a5ccffbfa176e9c6675bd81fff61859bd7b6be5d/src/schemas/projects.ts), [TestRail project role semantics](https://support.testrail.com/hc/en-us/articles/7077792415124-Projects), [run schemas](https://github.com/dichovsky/testrail-api-client/blob/a5ccffbfa176e9c6675bd81fff61859bd7b6be5d/src/schemas/runs.ts), [section schemas](https://github.com/dichovsky/testrail-api-client/blob/a5ccffbfa176e9c6675bd81fff61859bd7b6be5d/src/schemas/sections.ts).

The entries of a plan carry fields that the endpoints that change them do not accept. Forwarding such a field would be a write that the caller is told succeeded while nothing changed. TestRail's reference states that `config_ids` and `runs` are not supported on `update_plan_entry`. The request body of that endpoint carries no `suite_id`.

A run inside an entry takes its name from its configuration combination. Thus, `add_run_to_plan_entry` and `update_run_in_plan_entry` refuse a `name`, and `update_run_in_plan_entry` refuses `config_ids` as well. Each refusal is an endpoint-wide requirement with its own fixture rather than an unnamed consequence of strictness. Thus, removing the rule fails a case that says what was lost.

The driver parses none of these payloads. Thus, every rule at every depth of a plan, an entry and a nested run is the boundary's alone. Sources: [plan payload schemas](https://github.com/dichovsky/testrail-api-client/blob/a5ccffbfa176e9c6675bd81fff61859bd7b6be5d/src/schemas/plans.ts), [TestRail plan semantics](https://support.testrail.com/hc/en-us/articles/7077711537684-Plans).

A nested run is held to the same rule. TestRail's reference names `assignedto_id`, `include_all` and `case_ids` as the fields that a run inside an entry can override. The runs example in that reference carries no `name`. The payload schemas of the driver say why: they record that TestRail derives the name of a nested run from its configuration combination. That derivation is also why the standalone `add_run_to_plan_entry` payload omits the field entirely.

`add_plan` and `add_plan_entry` therefore refuse a nested `name` as well. Thus, the same field is not accepted in one place and refused in another on the same stated ground.

An effect annotation is now a gate rather than a per-endpoint assertion. `effects.destructive` is published as the MCP `destructiveHint`. A host uses this hint to decide whether to ask before calling.

Until T06, nothing compared the hint against anything: the manifests describe arguments and replies, and the registration audits compare response shapes. `update_plan_entry` shipped as non-destructive, although narrowing its case selection deletes tests and results in every run that the entry generated. The two siblings that destroy strictly less were both flagged correctly. [tests/effects.test.ts](../tests/effects.test.ts) states the rules over the whole registry instead:

- every removal is destructive;
- no read is destructive;
- a write that is not a creation and can narrow the case selection of an existing run is destructive.

A rule has to be argued with, but a per-endpoint restatement could simply be edited to agree with a mistake.

Three plan filters are rewritten between the caller and the wire. The boolean is the one that can fail silently. `created_by` and `milestone_id` are comma-joined from a list. This rewrite is visible in the rendered query string. `is_completed` is sent as `1` or `0`. Thus, a `false` that is treated as absent would quietly ask for every plan instead of the open ones.

The family suite asserts all three filters in the rendered query string on the first request. The suite asserts the boolean again on an aggregate continuation. The reason is that a filter that survives only the first request returns a correct first page and a wrong remainder.


Three of the six label endpoints are undocumented. TestRail's Labels reference covers `get_label`, `get_labels` and `update_label` only. `add_label`, `delete_label` and `delete_labels` appear in neither table. Thus, their evidence is the module of the driver and the [official TestRail CLI](https://github.com/gurock/trcli/blob/e723052d0898da6a501972c6855eddf487cd51bb/trcli/commands/cmd_labels.py), which sends the same requests.

The reply of a label mutation has shipped both flat and wrapped under a `label` key. The CLI reads the reply as `label_data.get('label', label_data)`. The response schema of the driver is a union that unwraps the wrapper. Thus, a caller sees one flat record whichever form arrives. The family suite proves this by running both replies through the same tool and comparing the results.

`delete_labels` is the only endpoint in this family with no path segment. It is also one of the four payloads that the pinned driver checks before dispatch anywhere in this server, alongside `labels.updateLabel`, `results.editResult` and `tests.updateTests`. This check refuses these values, each with a stated validation error:

- a value that is not an array;
- an empty array;
- any non-positive member.

The manifest of `delete_labels` writes that list out instead of referencing the shared identifier-list domain, because the enforcement genuinely differs by binding. The same scalar that `labels.deleteLabels` refuses with a `TestRailValidationError` makes `cases.getCaseTitles`, the probe of the domain, throw a `TypeError` instead. Thus, referencing the shared domain here would have recorded a crash where the truth is a stated check. The mismatch is the concern that the follow-up on proving a shared domain at every binding that references it tracks, now with a measured example.

TestRail caps a label title at 20 characters, and the boundary does not. The schema of the driver records that the limit is deliberately left to the server. In this way, the client does not duplicate a rule that TestRail may change independently. This server follows this approach: an over-long title is sent and TestRail's refusal is reported as it arrived.

The official CLI takes the opposite position and checks the length in its own command layer. Thus, the two disagree. The manifest names the rule `server-limit` and covers it with a fixture rather than leaving the decision implicit.

`update_label` is the other driver-checked body in this family. It asks for the owning project even though the label is identified by its own ID in the path. The driver validates that `project_id` before dispatch.

Both milestone list filters are booleans at the boundary, and they reach TestRail as 1 or 0. The driver also accepts deprecated numeric spellings of the same two filters. These numeric spellings are not exposed. One name per filter is one thing to keep true. Thus, the numeric form is refused here rather than quietly accepted as a second way to say the same thing.

`parent_id` admits no null in either milestone payload, and TestRail documents no way to clear it. Thus, detaching a sub-milestone is not reachable through the pinned driver.

TestRail's own `update_milestone` table lists four fields, while its heading promises partial updates. The payload type of the driver carries the create fields as well. The wider set is accepted, and the disagreement is recorded in the manifest rather than resolved silently. Sources: [label schemas](https://github.com/dichovsky/testrail-api-client/blob/a5ccffbfa176e9c6675bd81fff61859bd7b6be5d/src/schemas/labels.ts), [milestone schemas](https://github.com/dichovsky/testrail-api-client/blob/a5ccffbfa176e9c6675bd81fff61859bd7b6be5d/src/schemas/milestones.ts), [TestRail labels](https://support.testrail.com/hc/en-us/articles/38961149782036-Labels), [TestRail milestones](https://support.testrail.com/hc/en-us/articles/7077723976084-Milestones).


A result needs a status, a comment or an assignee, any one of them, as TestRail documents. The four add-result tools enforce this rule by presence. Each body, or each bulk entry, must carry at least one of `status_id`, `comment` or `assignedto_id`. TestRail returns a result recorded without a status with `status_id` null.

An empty comment counts as present. The documentation does not say whether TestRail accepts an empty comment. If TestRail refuses it, the tool reports the TestRail error.

From 9.0.0, the rule belongs to the driver. Its three add payloads make `status_id` optional. They also carry a refinement that requires one of the three ([dichovsky/testrail-api-client#305](https://github.com/dichovsky/testrail-api-client/pull/305)). The adapter represents that refinement in JSON Schema as `anyOf` over single-name `required` lists, beside the edit payload's and the case deletion's. The manifests carry comment-only, assignee-only and empty-content cases.

Driver 8.0.0 declared `status_id` required instead. This boundary first honored that declaration. Thus, a comment-only or assignment-only result could be read here and not written ([#49](https://github.com/dichovsky/testrail-mcp/issues/49)). This problem was fixed on 8.0.0 by stating the rule in the adapter, before the driver carried the rule.

The Users family held the first endpoints in this server that take nothing at all. T10 has since widened this set. The Users family also holds its only input that sits under `query` while it reaches the wire as a path segment.

`get_current_user` and the two response-driven lists carry no parameter.

`get_users` carries an optional project. The presence of the project selects a different endpoint, `get_users/{project_id}`, rather than filtering the same one. TestRail requires that form of non-administrators from 6.6. TestRail returns a narrower set through that form, omitting inactive users and users who hold only global access. The registered route is the bare one, because the endpoint has two forms. Thus, the project is a query-scoped input, and the manifest states its wire encoding outright.

`get_users` is also the one list in the Users family that TestRail documents as a bare array, while its siblings document an envelope. Outside the family, a bare array is no longer unusual. Seven of the reads of T10, `get_statuses` and `get_priorities` among them, are documented only as bare arrays. `get_case_statuses` documents a bare-array example beside an envelope field table. For `get_users`, the driver accepts the array, the wrapper and a null collection, and it resolves all three to an array. The family suite proves this by sending each shape through the same tool.

`update_group` carries its own identifier twice. TestRail rejects a body without `group_id`. Thus, the driver injects the path identifier after spreading the caller's payload. A caller's own value would be overwritten rather than sent.

The boundary refuses the field instead, on the same ground as the plan-entry fields refused in T06. Accepting a value that cannot take effect is the same lie as forwarding a value that TestRail ignores. The fixtures record the injected identifier in the expected request body. Thus, a driver that stopped injecting the identifier would fail rather than quietly start sending bodies that TestRail refuses.

Every user tool takes one address rule, the driver's `TESTRAIL_USER_EMAIL_PATTERN`: one `@` with non-empty whitespace-free parts. The comment of the pattern argues that single-label domains and domain literals are legitimate on self-hosted, LDAP, AD and SSO instances. It also argues that authoritative validation is TestRail's. From 9.0.0 the driver applies the pattern to `get_user_by_email` and declares the pattern on both user write payloads.

Driver 8.0.0's write payloads declared a dotted-domain format that refused those same addresses. This boundary first honored that format. Thus, on such an instance, a user was readable and not writable ([#55](https://github.com/dichovsky/testrail-mcp/issues/55)). This problem was fixed on 8.0.0 by giving the writes the lookup's rule, since the driver never parses a write payload.

The write manifests accept a single-label domain and a domain literal. The published-driver evidence sends each of them through the real method to the wire. The rule is restated in [src/contracts/inputs.ts](../src/contracts/inputs.ts) only for the Unicode flag that JSON Schema parity requires. A test in `tests/inputs.test.ts` holds the restatement to the driver's write payloads on a corpus of addresses. Sources: [user module](https://github.com/dichovsky/testrail-api-client/blob/a5ccffbfa176e9c6675bd81fff61859bd7b6be5d/src/modules/users.ts), [user schemas](https://github.com/dichovsky/testrail-api-client/blob/a5ccffbfa176e9c6675bd81fff61859bd7b6be5d/src/schemas/users.ts), [TestRail users](https://support.testrail.com/hc/en-us/articles/7077978310292-Users), [TestRail groups](https://support.testrail.com/hc/en-us/articles/7077338821012-Groups).


Datasets and variables were the first endpoints in this server that an instance's edition gates. Other endpoints that an instance's edition gates are:

- `get_case_statuses` of T10, which TestRail documents as requiring TestRail Enterprise 7.3 or later;
- the two cross-project report endpoints of T11, which TestRail documents as Enterprise only.

The write payload of datasets and variables also takes bare caller-chosen keys. This is unusual but not unique. A flat case, result or shared-step extension must match `custom_*`, a namespace that this server owns. A step entry inside `custom_steps_separated` or `custom_step_results`, however, is an open record whose keys are as unconstrained as these. A key spelled like one of this server's controls is therefore expressible in more than one payload. This family is where such a key is tested.

TestRail documents a 403 "Not an Enterprise license/subscription" on all nine dataset and variable endpoints. This boundary cannot anticipate this refusal: an instance's edition is not an argument, so the call is made and the refusal is reported. The driver separates that refusal from an ordinary permission denial by matching the phrasing that TestRail uses. This server keeps the separation. It publishes `LICENSE_REQUIRED` rather than `PERMISSION_DENIED`, because one is answered by a license and the other by an administrator. The family suite asserts both codes against the same endpoint, so a widened match would fail rather than collapse the two.

An open record's declared value domain applies under every key, `__proto__` included. The record parser of Zod skips that one key before either of the schemas of the record sees the key. The driver, however, is handed the original object of the caller with the key intact. Thus, until the shared payload adapter checked the key itself, the `variables` map of a dataset accepted any value there. The same held for the `filters` map of a filter. Both maps forwarded the value to TestRail.

The adapter now applies the key and value schemas of the record to that key too. This covers every record-valued payload field at once. The dataset and dynamic-filter manifests each carry a rejected case under `__proto__` beside the ordinary one. The fixture loader keeps the input of each case as written rather than the parsed clone of the schema. The reason is that the clone drops the same key and would run such a case without it.

The step entries of shared steps and results are records of arbitrary JSON. Thus, no value under any key is refused there, and there is nothing for such a case to prove.

The same skip applies to the extension point of an object. The object parser of Zod passes over an own `__proto__` key in its catch-all, and the `custom_*` name check sees only the parsed clone. Thus, a case, result or shared-step body accepted a `__proto__` field that its advertised JSON Schema refuses. The adapter applies the extension policy to that key too, so such a body is refused like any other unknown field. Each of the eleven manifests with a `custom_*` extension carries a rejected case under `__proto__` beside its ordinary unknown-field case.

A dataset's values are written as a map from variable name to value. They are read back as an array of entries that carry server-assigned identifiers. The two shapes are not interchangeable, and neither is converted into the other here.

The keys of the map stay open, because they name instance data. The own fields of the payload do not stay open. Thus, an unknown field beside `name` and `variables` is refused. This includes the `id` that TestRail's `add_dataset` and `add_variable` examples show in a request body. The parameter tables of these endpoints never list this `id`.

TestRail states three rules about the map and refuses on each:

- the variable name must already exist in the project;
- values must be submitted as strings;
- values have a length limit.

Only the second rule is expressible at this boundary, so only that rule is enforced here. The other two arrive as TestRail's refusals. An empty map and an absent map are different requests, and both are forwarded as written. The family suite writes variable names that collide with the vocabulary of this server, `limit`, `offset`, `_mcp` and `variables` among them. The reason is that nothing between a tool call and the wire reads the keys of a body to look for a control. This property is worth pinning where the keys are bare.

Two claims about these endpoints are deliberately not made. TestRail does not state whether a supplied `variables` map replaces the values of a dataset or merges into them, so neither manifest claims one. The tool advises sending the full map of values to set. This advice is the safe instruction under either reading. `update_dataset` is published non-destructive on the same convention as the other seventeen updates.

It does say what the boundary itself does with a value. `null` is refused, and an empty string is accepted and sent. There is no claim about which of the two TestRail treats as clearing.

TestRail does state two cascades: deleting a dataset removes its values, and deleting a variable removes the corresponding values from every dataset. Both cascades are TestRail's own. This server neither enumerates datasets before a variable deletion nor repairs anything after one. The fixtures record this behavior as a single request. Sources: [dataset module](https://github.com/dichovsky/testrail-api-client/blob/a5ccffbfa176e9c6675bd81fff61859bd7b6be5d/src/modules/datasets.ts), [variable module](https://github.com/dichovsky/testrail-api-client/blob/a5ccffbfa176e9c6675bd81fff61859bd7b6be5d/src/modules/variables.ts), [dataset schemas](https://github.com/dichovsky/testrail-api-client/blob/a5ccffbfa176e9c6675bd81fff61859bd7b6be5d/src/schemas/datasets.ts), [variable schemas](https://github.com/dichovsky/testrail-api-client/blob/a5ccffbfa176e9c6675bd81fff61859bd7b6be5d/src/schemas/variables.ts), [TestRail datasets](https://support.testrail.com/hc/en-us/articles/7077300491540-Datasets), [TestRail variables](https://support.testrail.com/hc/en-us/articles/7077979742868-Variables).

The metadata family describes how an instance is configured rather than what the instance holds. Most of the family takes nothing at all. Six of its ten tools take no parameter at all. Thus, their manifests follow the `get_current_user` pattern of an empty accepted input and a refused unknown field. `get_case_statuses` takes nothing upstream either, but its tool carries the paging controls. Two of the ten tools, `get_dynamic_filter_fields` and `get_templates`, take a project in the path.

Only `get_case_statuses` is paged. Its reference contradicts itself: the example is a bare array, and the field table is an envelope. The executor of the driver reads the bare array and the envelope under `_links`. The field table's `links` is its label for that object rather than a second spelling. The table is the Shared Steps history table copied down to its step-history wording, and there the same label sits beside an example keyed `_links`. An envelope keyed `links` literally would be refused as an invalid page, and the family suite pins this behavior.

The manifest carries an accepted fixture of the bare array and of the `_links` envelope. Thus, a decoder that stopped accepting TestRail's own example would fail rather than turn the example into an invalid response. The summary of the tool says that a reply in that form is read as the whole list. The summary also says that all mode reports the list complete. `tests/pagination-disclosure.test.ts` checks that exactly the paged lists whose manifests carry an accepted bare-array reply say so.

`get_case_statuses` is the sixth response-driven list. It joins the configured-limits gate without a change to that gate. That gate selects every list that aggregates.

`get_statuses` and `get_case_statuses` share a word but describe different things. `get_statuses` lists the execution statuses that a test result records, keyed by `id`. `get_case_statuses` lists the statuses of test cases themselves, such as Draft and Approved, keyed by `case_status_id`. The summary of each tool names the other tool, so a caller is pointed away from the wrong list. The family suite asserts both the cross-reference and that each tool reads only its own endpoint. Case fields and result fields are treated the same way.

`add_case_field` is the only write, and the driver parses none of its payload: `addCaseField` posts what it is given. The boundary adopts the driver's declared fields at every depth and closes each object. Closing each object refuses a reply-only field such as `system_name`. Closing each object also refuses the step toggles (`has_expected` and its siblings). The driver models these toggles on read replies, and TestRail's result-field example shows them. Neither TestRail's add_case_field reference nor the driver's payload declares them for writing.

`template_ids` is tightened to the identifier domain. `type` must be a string. This is the stated rule of TestRail as well as of the driver. TestRail answers 400 to a type number that is sent as a JSON number, so the boundary refuses the number before dispatch.

`is_indexed` is absent from the Case Fields reference. TestRail's indexing article, however, documents `is_indexed` for `add_case_field` as a TestRail Cloud feature for six field types and at most five fields per instance. `is_indexed` is accepted, and those limits are left to TestRail.

The rules that depend on the type of a field or on instance state stay TestRail's, for the reason that the driver's own comment gives. These rules are:

- which types exist;
- which types take a `default_value`;
- the slug format of `name`;
- the values of `format` and `rows`.

Two fixtures forward requests that break each of these rules, index eligibility included. Thus, a boundary that started enforcing any of them would fail. The replies of these fixtures are stand-ins. The manifest says so. The reason is that a fixture can carry only a success body.

In the reply to `add_case_field`, a nested structure arrives as a string. `configs` is JSON-encoded, and the flags are 0 or 1 rather than the booleans that the driver models for `get_case_fields`. TestRail's own example reply shows both. The tool returns the reply unparsed, since parsing it would substitute the reading of this server for what TestRail sent. The family suite asserts that the documented reply of TestRail comes back unchanged with no drift warning.

The reads keep their variants the same way. `project_ids` lists the projects of a project-scoped configuration. A global configuration can carry `null`, an empty string or an empty array. The driver no longer normalizes any of these values. The suite sends these encodings through both field lists and asserts that they return unchanged.

TestRail's own `get_case_fields` example lacks `is_active`, `include_all` and `template_ids`. The schema of the driver requires these fields. Thus, a reply shaped like the documentation comes back whole with a drift warning rather than being refused.

`get_version` has no page in TestRail's API reference. Its evidence is the 10.6.1 release notes, which announce `get_version` as new. Nothing in this server calls `get_version` except its own tool, and nothing is decided by its answer. A version gate would turn an older or unreadable reply into a missing tool. The one-tool-per-endpoint rule exists to prevent this outcome. The family suite connects a client to a server over the full registry and asserts the following:

- listing tools and calling another tool make no version request;
- the catalog is identical before and after each of three reported versions, one of them not a version at all.

Sources: [metadata module](https://github.com/dichovsky/testrail-api-client/blob/a5ccffbfa176e9c6675bd81fff61859bd7b6be5d/src/modules/metadata.ts), [metadata schemas](https://github.com/dichovsky/testrail-api-client/blob/a5ccffbfa176e9c6675bd81fff61859bd7b6be5d/src/schemas/metadata.ts), [TestRail case fields](https://support.testrail.com/hc/en-us/articles/7077281158164-Case-Fields), [TestRail result fields](https://support.testrail.com/hc/en-us/articles/7077871398036-Result-Fields), [TestRail statuses](https://support.testrail.com/hc/en-us/articles/7077935129364-Statuses), [TestRail dynamic filter fields](https://support.testrail.com/hc/en-us/articles/49616364363924-Dynamic-Filter-Fields), [TestRail templates](https://support.testrail.com/hc/en-us/articles/7077938165780-Templates), [indexing custom case fields](https://support.testrail.com/hc/en-us/articles/51275506274836-Indexing-Custom-Case-Fields), [TestRail 10.6.1 release notes](https://support.testrail.com/hc/en-us/articles/51202137678228-TestRail-10-6-1-Default-1001).

Two of the four report endpoints are GETs that change something. Running a template generates a new report and may send the email that its template is configured to send. Thus, `run_report` and `run_cross_project_report` carry report effects: not read-only, not idempotent, and never retried by this server.

The manifests of these endpoints record the request intent of the driver, `side-effecting-read`. They also record the cache bypass and the 429-only retry that the core of the driver derives from this intent. A manifest fixture, however, is one call that is made with the cache off and no retries. Thus, the fixture proves the arguments and the request rather than the effect. The family suite proves the effect. The suite builds the driver from this server's own production options with fetch and DNS replaced, and counts the requests that reach TestRail.

Two sequential runs make two requests with the driver's cache off and on. Three concurrent runs make three requests. This holds both when the transport is called directly and through a connected client.

A network error, the driver's own timeout, a 408, and each of 500 to 505 and 599 make one request under the production retry budget. The suite counts the request at the wire and at the driver method. Each of these failures leaves the outcome unknown rather than claiming nothing happened. A 400 or 403 refusal also carries unknown. Its code and status say what TestRail answered.

The driver's own rate limiter refuses a run before sending it, with the same 429 that a rate-limited TestRail returns. Thus, a `RATE_LIMITED` run may never have reached TestRail. This run reports unknown too. Both summaries say so, and the suite pins this behavior.

The ordinary-read contrast and the 429 re-send lower the retry budget to one to keep the backoff short. The same 500 on an ordinary template read is retried. Thus, the single request is the report methods' own policy. A 429 is re-sent. F01 accepted that re-send for `runReport` on 2026-09-17, because TestRail rejects a rate-limited request before handling it. The suite asserts the re-send for both run tools, so an upstream change returns for a fresh decision.

The registry used to require report tools to declare the driver retry policy `never`. The generated reference published this policy, although the driver re-sends a 429. Report effects now require `rate-limit-only`. The suite holds that declaration to the driver in this way: it exhausts the production retry budget on a run that TestRail keeps rate-limiting. The result is one request and three re-sends, never more.

A run returns URLs that may not be ready yet. TestRail warns of this in the introduction that precedes all four report endpoints. The introduction opens by speaking of single-project reports and says that the API Templates are executable through the endpoints described below. The cross-project sections do not repeat the warning. Nothing here fetches the URLs or runs the template again to check whether they are ready. The suite also counts this behavior.

A reply without `report_url` is still TestRail's answer to the run. Thus, the reply is returned as sent with a drift warning.

A 200 that the driver resolves is reported as acknowledged when this server cannot return it. This server cannot return it when the JSON of the reply is not an object or its data exceeds the configured budget. A 200 whose body the driver cannot read or parse is reported as unknown. The reason is that the body is not JSON, exceeds the driver's own JSON limit or stalls. This server cannot tell this case from a failed exchange, so it reports unknown. Neither outcome claims that the request never reached TestRail.

An empty body comes back as the `{}` that the driver substitutes, with a drift warning. TestRail documents no parameter for the run endpoints beyond the template. TestRail is silent, rather than explicit, about there being none.

TestRail documents both cross-project endpoints as Enterprise only. The driver calls a 403 a license restriction only when its message says "not an" or "requires" followed by "Enterprise licen" (license or licence) or "Enterprise subscription". The driver ignores letter case in this match.

TestRail's reference describes the refusal of `get_cross_project_reports` as "TestRail Enterprise only. Access denied.". For `run_cross_project_report`, the reference lists only "No access to the project". If TestRail sends the first wording, the refusal arrives as `PERMISSION_DENIED` rather than `LICENSE_REQUIRED`.

Both cross-project summaries say that either code can mean that the instance lacks Enterprise. The suite pins both phrasings on both tools. Thus, a driver that learned the second phrasing would fail the test rather than silently change what callers see.

A refusal does not remove a tool from the catalog. The suite checks this through a connected client. Sources: [report module](https://github.com/dichovsky/testrail-api-client/blob/a5ccffbfa176e9c6675bd81fff61859bd7b6be5d/src/modules/reports.ts), [report schemas](https://github.com/dichovsky/testrail-api-client/blob/a5ccffbfa176e9c6675bd81fff61859bd7b6be5d/src/schemas/reports.ts), [request pipeline](https://github.com/dichovsky/testrail-api-client/blob/a5ccffbfa176e9c6675bd81fff61859bd7b6be5d/src/client-core.ts), [retry policies](https://github.com/dichovsky/testrail-api-client/blob/a5ccffbfa176e9c6675bd81fff61859bd7b6be5d/src/retry-policy.ts), [TestRail reports](https://support.testrail.com/hc/en-us/articles/7077825062036-Reports-and-Cross-Project-Reports), [driver qualification](driver-qualification.md).

Attachments are the one family that moves files both ways. `get_attachment` only reads TestRail, but every call writes a new file under the configured download directory. Thus, `get_attachment` is registered as a persistent download and published with `readOnlyHint`, `destructiveHint` and `idempotentHint` all false. The effects gate had equated a TestRail read with read-only. The gate now holds a download to the same rule that the registry applies.

The family suite downloads the same attachment twice, by number and by UUID. The suite finds two complete files with identical bytes. It also finds a result that carries only the ID as given, the file's path and its byte count. The driver returns the bytes alone, so no filename or media type is invented.

A download that fails carries no `write_outcome`, because nothing was written to TestRail. A failed download leaves no file if it failed before its file was committed. The driver retries a download as it retries any GET. A download that succeeded on its second attempt still writes one file.

The binary limit of the driver is the `max_file_bytes` of this server. Thus, a larger reply is refused while it is read, as `INVALID_RESPONSE`, before anything reaches the directory. The summary says so.

One download runs at a time, from its request until its file is written. A call that is made while the request, reply or write of another download is in progress is refused as `BUSY` before any request. The suite shows this at all three stages.

The transport writes the file inside the operation that the runtime tracks rather than after the operation returns. Thus, the slot covers the write, as [the implementation contract](implementation-contracts.md) asks. The runtime holds the slot until the operation settles. A write that fails still frees the slot.

A reply that arrives after the call has already returned an error, such as `CANCELLED`, keeps the slot until the reply settles. Such a reply writes nothing, since no caller would learn the file's path. A file that is already committed is kept, as the implementation contract requires even when delivery fails. A file whose write was under way when the caller cancelled is completed before the slot is freed. A file whose result then exceeds `max_data_bytes` stays although the call reports `RESPONSE_TOO_LARGE`. The suite pins both.

`get_attachment` is also the first registered endpoint whose driver result is bytes. The production-registration gate compared every non-JSON result with `undefined`. A registered download would have failed this comparison on every accepted fixture. Thus, the gate now compares bytes as bytes. The two manifests that F04 wrote for this family, `get_attachment` and `get_attachments_for_plan_entry`, are rewritten to the family standard with TestRail's reference among their sources. The parameter, requirement and case IDs that the harness's own tests read from them are kept.

TestRail labels every attachment ID an integer. On the same page, TestRail says that the 7.1 (cloud) release introduced a new format. The list example of TestRail shows this format as a UUID. The driver accepts a positive integer or a UUID and nothing else. Thus, `get_attachment` and `delete_attachment` take either, unchanged, and refuse a numeric string.

TestRail labels a plan entry an integer too, but the driver accepts only a UUID and records that TestRail refuses a numeric one with 400. Both plan-entry tools reference the shared `entry_id` domain.

The case, plan and run lists document `limit` and `offset` from TestRail 6.7 and have page and all modes. Their fixtures send the shapes that the reference documents:

- an envelope for cases, from its second example, because the first example names `_link` and is not valid JSON;
- a bare array for plans and runs, which the driver reads as a terminal legacy-array page.

The test and plan-entry lists document neither control and are not given one.

Four lists can hold more attachments than one reply shows, and each summary says how. TestRail gives the test list the format of the case list, which is paged. The driver method returns the list alone. Thus, if TestRail pages the test list, only the attachments of the first reply come back, with nothing that says more exist.

The plan-entry list is documented as a bare array. If TestRail sends the plan-entry list a paged envelope, the same result occurs. The plan and run lists are documented as bare arrays, and a bare array carries no continuation. Thus, a reply that fills the requested page cannot be distinguished from the end of the list in either mode.

The reference documents `limit` as the number of attachments that the response returns. It does not say how a caller reaches attachments past this limit. The pagination metadata of this server reads a bare array as the end of the list. It reports `has_more` false in page mode and `complete` in all mode. Thus, both summaries say what this reading means here and point to the next offset in page mode.

The suite pins each case:

- an envelope whose next link is set, for the test and plan-entry lists;
- a full bare array, for the plan and run lists.

The five uploads share the transport's staging and the driver's multipart pipeline, and differ only in their route. None of them is retried by this server or by its driver, not even after a 429. Unlike for the JSON writes, the driver derives a policy that re-sends nothing for every multipart body. The driver's reason is that an upload is not idempotent and TestRail documents no retry semantics for creating an attachment.

The suite sends each of these to each upload: a network error, the driver's own timeout, and a 400, 403, 404, 408, 429, 500, 502, 503 and 504. It counts one request and one driver call every time, with the outcome unknown. A success reply that is JSON that this server cannot use is acknowledged instead, since the driver resolved. A success reply that is not JSON, or exceeds the driver's JSON limit, is refused by the driver and stays unknown. Two overlapping calls for the same file send two requests and return two attachments.

TestRail accepts files up to 256 MB, but this server's file limit is at most 100 MiB and is enforced while staging. Thus, a larger file is refused as `FILE_TOO_LARGE` before any request. The suite shows this for each tool.

TestRail documents `{"attachment_id": 443}` as the reply and the ID as always included. The driver's attachment schema makes every field optional, since the schema covers every attachment shape. Thus, the uploads require `attachment_id` to be a positive safe integer or UUID, matching attachment reads and deletes. Both forms pass without a warning. A missing or malformed ID produces a drift warning while the reply is returned unchanged. The family suite verifies both valid forms and missing or malformed IDs through all five upload tools.

The fixtures request a filename that differs from the file's own name, so a registration that sent the wrong filename would fail them. TestRail's reference does not say how TestRail uses the name. The driver's documentation describes the name as the name that TestRail stores and shows, and the summaries attribute this description to the driver. A media type is sent lowercased. The driver opens the staged copy as a Blob with the type as given. FormData lowercases the type when FormData wraps the blob as a File.

Transfers are also bounded in time. The driver's 15-second request timeout covers sending an upload's file. The body of a download must arrive within the 15-second body timeout. Both summaries say so.

`add_attachment_to_result` works only when result editing is enabled under Site Settings. Its summary repeats this.

The description of `add_attachment_to_case` in the reference says that it adds an attachment to a test plan. This sentence was copied from the plan section. The manifest records the sentence rather than the summary.

`delete_attachment` is a destructive JSON write. The driver re-sends it after a 429 and after nothing else. The suite shows this with a 429, a network error, a 500, 502, 503 and 504, and a success reply that is not JSON. Sources: [attachment module](https://github.com/dichovsky/testrail-api-client/blob/a5ccffbfa176e9c6675bd81fff61859bd7b6be5d/src/modules/attachments.ts), [attachment schema](https://github.com/dichovsky/testrail-api-client/blob/a5ccffbfa176e9c6675bd81fff61859bd7b6be5d/src/schemas/attachments.ts), [retry policies](https://github.com/dichovsky/testrail-api-client/blob/a5ccffbfa176e9c6675bd81fff61859bd7b6be5d/src/retry-policy.ts), [TestRail attachments](https://support.testrail.com/hc/en-us/articles/7077196481428-Attachments), [TestRail API introduction](https://support.testrail.com/hc/en-us/articles/7077083596436-Introduction-to-the-TestRail-API).

## Review procedure

1. Read the pinned public driver declaration, implementation and exported payload schema alongside the official endpoint documentation. Record the disagreements and the chosen source-backed behavior. Escalate driver gaps through F01. Do not use private HTTP helpers.
2. Enumerate every supported path, query, body, nested, multipart and adapter control field. Inspect alias/list/nullable/sentinel branches explicitly. Distinguish a driver's helper parameters from public tool inputs. Mark any unreviewed fields in `review.pending`.
3. Author literal input, driver argument, request and response fixtures by hand from the evidence. Include all union branches, omission versus null, bounds, required fields, unknown fields and cross-field constraints. Review nested ordinary fields as well as the outer object. Give every parameter a mapping and validation requirement.
4. Run the manifest audit and the family adapter suite. The suite includes generated JSON Schema acceptance and real public driver requests with injected fetch/DNS. Prove invalid calls are rejected before invocation. Add harness support explicitly for new binary/text/multipart or outer-result variants.
5. Have the independent reviewer compare the complete field list with sources. Set `review.status: complete` and clear `review.pending` only when the source review and fixture requirements are complete. Keep implementation/host/live qualification status in their corresponding work items.

## Driver provenance evidence

A manifest's `review` names two driver commits. `authored_commit` is the commit that the manifest was first reviewed against, and it stays there. `driver_commit` is the commit that the manifest is reviewed against now. When the two commits differ, `review.evidence` must record each advance as a step from one commit to the next. The steps must chain from `authored_commit` to `driver_commit`. Each step does these things:

- it lists every driver file that the manifest cites at `driver_commit`;
- it says whether each file changed between the two commits of the step;
- it carries a note for each file that did.

A pointer bump that edits `driver_commit` and the source links alone therefore fails the audit. A manifest backdated to an earlier `authored_commit` without evidence also fails the audit.

`authored_commit` is a declared field. The offline gate has no history to compare it with. Thus, the audit cannot tell a moved `authored_commit` from an honest one. A bump that moves `authored_commit` along with `driver_commit` would pass the audit by itself.

The test "carries evidence on exactly the five manifests…" closes that gap by pinning the `authored_commit` of every manifest. Thus, re-authoring a manifest at a later commit also has to edit that test, in the same diff that a reviewer reads. A manifest for a new endpoint, authored at a later release, edits the test in the same way.

The audit does not take a changed-or-unchanged claim on trust. [`tests/fixtures/driver-releases.json`](../tests/fixtures/driver-releases.json) records these items for each reviewed driver release:

- its tag commit;
- its npm integrity;
- for every driver file that any manifest or the shared domain library cites, the git blob ID of the file at that commit, and the SHA-256 of the file that the published package ships for it (`src/x.ts` ships as `dist/x.js`; `skill/SKILL.md` ships as itself).

A file has changed between two releases when either hash differs. A claim that disagrees with the ledger is rejected. Evidence that names a file or commit that the ledger does not record is rejected too. Every file that a manifest cites must be recorded at its `driver_commit`, so a future step always has both ends to compare.

A citation counts only in the form `https://github.com/dichovsky/testrail-api-client/blob/<driver_commit>/<path>`. A driver link in any other form is refused, because it would escape both the revision check and the evidence rule. This refusal covers these forms:

- `raw`, `blame` and `tree` paths;
- raw.githubusercontent.com and other GitHub hosts;
- another letter case or scheme;
- an explicit port;
- a trailing-dot host;
- user information;
- percent-encoded path segments.

Links are recognized by parsing the URL, not by matching its text.

The gate runs without a network. The installed package ships no sources, so the gate cannot recompute git blob IDs. Instead, the gate holds the ledger entry for the installed version to the installed package:

- its integrity must equal the lockfile's;
- each shipped file that it names must match its recorded SHA-256.

Every entry's `package_file` must also be the file that the package ships for its path, so a hash cannot be borrowed from another file. A release that is not installed cannot be checked against real bytes offline. Thus, the test "pins every recorded release, installed or not" pins a digest of each release entry. Rewriting a historical entry could otherwise let a false unchanged claim pass. Such a rewrite therefore also has to edit that test.

The ledger lists releases oldest first. An evidence step may not move back to an earlier release. The same step may not carry a review date earlier than the step before it or later than the manifest's own.

To re-check every entry against its sources, run `node scripts/audit-driver-ledger.mjs <path to a clone of the driver>`. A clone made with `git clone --filter=blob:none --no-checkout` is enough. The script needs git, npm and a network. The script does these things:

- it checks that the commit of each release is the commit that its `release/<version>` tag names;
- it compares each git blob ID with the clone;
- it compares each integrity and shipped-file SHA-256 with the tarball that npm serves;
- it exits non-zero on any mismatch.

Run the online [driver ledger workflow](../.github/workflows/driver-ledger.yml) during release preparation. Publish also repeats the audit for the tagged source.

This script is the only check that compares the recorded blob IDs with the git history of the driver. This comparison matters most at a driver bump. The blob IDs of the new installed entry cannot be checked offline, and the ledger records `dist/x.js` but not the declaration files. Thus, a source change that leaves the compiled JavaScript identical would otherwise rest on the author's word. Neither the main CI workflow, with its three-platform matrix, nor `npm test` runs the script or clones the driver.

The five manifests that F04 wrote at 7.0.0 (`71a80d98`) carry one step each, to 7.2.0 (`cc7751c`), reviewed on 2026-09-17. `get_attachment` also cites `src/retry-policy.ts`. That file did change between the releases: 7.2.0 added the `rateLimitOnly` policy. The file was first cited on 2026-09-26, when the manifest was rewritten directly against `cc7751c`. Its evidence entry records the file as changed, with the note. The other 128 manifests were authored at `cc7751c`.

All 133 then carry one step from `cc7751c` to 8.0.0 (`7680ab6`), reviewed on 2026-10-03, so the five carry two. Ten cited files changed in that step, each with a note:

- The multipart builder moved from `src/client-core.ts` to the new `src/upload-source.ts`. The seven upload manifests now cite the new file as well. The new file is recorded as absent at 7.2.0, so the step has both ends.
- The retry policy is derived from the shape of a request rather than named by the upload, download and report methods. Thus, those claims were reworded.
- The report manifests now also cite `src/client-core.ts` and `src/retry-policy.ts` for the cache bypass and rate-limit-only retry that their module comments used to state.

The other changes, to the pagination transport, `src/constants.ts` comments and `skill/SKILL.md`, leave every cited claim standing.

All 133 then carry a further step, from 8.0.0 to 9.0.0 (`a5ccffb`), also reviewed on 2026-10-03, so the five carry three. In that step, every cited file changed in the ledger's terms. The reason is that 9.0.0 stopped emitting source maps, and every shipped `dist/*.js` lost its trailing `sourceMappingURL` comment. For the 41 files whose source is unchanged, that comment is the only difference, as a comparison of the two tarballs shows. Their notes say so. Eight sources did change, each with a note:
- The result payloads gained the result-content refinement. The user write payloads gained the email rule of the lookup, `TESTRAIL_USER_EMAIL_PATTERN`. That pattern moved into `src/constants.ts`. The three email manifests now cite `src/constants.ts` for the pattern.
- `getTest`'s `with_data` path now normalizes its own reply.
- `request()` bounds DNS with the request timeout and connects through a dispatcher pinned to the validated DNS answers.
- The multipart cleanup in `src/upload-source.ts` closes a part cleanly once the transport has stopped, and `src/cli/file-input.ts` opens with `O_NONBLOCK`.
- 9.0.0 split `skill/SKILL.md`. The `--filename` guidance that the five upload manifests cite moved to `skill/reference/recipes.md`. The five manifests now cite `skill/reference/recipes.md`. The ledger records `skill/reference/recipes.md` as absent at 7.2.0 and 8.0.0, so that their earlier steps have both ends. For the same reason, the three email manifests' earlier step covers `src/constants.ts`.

The shared domain library ([`tests/fixtures/domains.json`](../tests/fixtures/domains.json)) carries the same provenance fields as a manifest's review (`driver_version`, `driver_commit`, `authored_commit`, `reviewed_on` and an optional `evidence`). `auditDomainProvenance` holds the library to the ledger by the same rules. A manifest's evidence covers only the driver files that the manifest cites itself. What a domain claims about the driver is stated only in the library. Thus, the domains behind a reference are re-reviewed against a new driver release through the library's evidence or not at all.

Today 103 of the 117 manifests that use `domain_ref` reference a domain whose driver file they do not cite. The uncited file is `src/validation.ts` in all 103 manifests. In 14 of them, `src/modules/cases.ts` is also uncited. The manifests that do cite those files (12 each) would name them in their own evidence at a bump. That re-reviews their own claims, not the library's.

The library's rule is stricter than a manifest's in one respect: each domain has one source and is authored from the driver's code. Thus, every domain's source must be a blob URL pinned at the library's `driver_commit`, recorded in the ledger at that commit. A domain whose only source is other documentation is refused.

The library was authored at `cc7751c` and carries one step to `7680ab6`, in which only `src/pagination.ts` changed. The page request carries an intent instead of a cache bypass, and a budget expiry reads as `max_duration`. Neither of these changes touches the option validation, defaults or first-offset check that its domains cite. A second step, to `a5ccffb`, records changes from dropped source-map comments. A third step, to `b7cde374`, records the safe-integer, scalar-or-list and timestamp checks introduced by 10.0.0.

The `authored_commit` of the library is declared like a manifest's. The test "records the installed driver release, and pins the commit it was authored at" in [`tests/domains.test.ts`](../tests/domains.test.ts) pins it. The "domain library provenance" tests in that file hold the rest.

The 10.0.0 review adds a step from `a5ccffb` to `b7cde374` for all 133 manifests. Its ledger measures 35 changed source blobs and 23 changed shipped files across the 50 cited paths. Runtime changes include shared multipart ownership, safe identifier and timestamp validation, and advisory result validation. Source-only changes include removed duplicate response type declarations and an equivalent project-list options type.

To advance the driver, do these steps:

1. Add the new release to the end of the ledger from its tag commit and published tarball.
2. Run `scripts/audit-driver-ledger.mjs` over the ledger.
3. Update the release pin test.
4. Re-review each manifest and the domain library against the new release.
5. In each manifest and in the library, set `driver_commit`, `driver_version` and the source links.
6. Append an evidence step whose claims the audit will check.

The audit's negative tests are in [`tests/parameter-manifest.test.ts`](../tests/parameter-manifest.test.ts) under "driver provenance evidence".

## Shared parameter domains

`validateId(id, name)` requires a positive safe integer and uses `name` in validation messages. Numeric identifiers can share one domain. Pagination bounds have their own domains. Writing that domain out per parameter would mean a hundred copies of "reject `-1`". This duplication has these effects:

- it carries no signal;
- it makes a genuinely wrong entry harder to spot among near-identical neighbors;
- it turns a driver validation change into a hundred-file edit.

[`tests/fixtures/domains.json`](../tests/fixtures/domains.json) describes each shared domain once: its JSON Schema, its semantics, its requirements, and its valid and invalid values. A parameter then writes `domain_ref` in place of an inline `domain` and `requirements`. Measured on `testrail_get_project`, whose identifier is its only parameter, the use of `domain_ref` cut the manifest from 223 lines to 144. The library pays for itself after three endpoints.

Two properties keep a reference as strong as writing it out.

**The library is evidence, not a claim.** A shared domain reused by many parameters would otherwise concentrate risk: one wrong entry silently weakens every parameter referencing it. The probes described here prove the values of each domain against the installed driver. The driver citations of the domains are held separately, by the [provenance rule](#driver-provenance-evidence) above.

Each domain names a public driver method as its `probe`. [`tests/domains.test.ts`](../tests/domains.test.ts) drives every value through the method and asserts two things:

- an invalid value is refused *before dispatch*, with zero upstream requests;
- a valid value reaches the wire.

The package does not export its validators, and the contracts forbid importing internals. Thus, this proves the domain against the real behavior of the driver rather than against a copy of its rules. Each invalid value also records `rejected_by`, and the probe asserts all three cases apart:

- `driver` where the pinned client refuses the value with its own validation error;
- `driver_crash` where the client stops before dispatch but by throwing from an unguarded operation rather than a stated check;
- `adapter` where only the MCP boundary refuses the value.

`getCaseTitles` still throws from an unguarded operation when given a bare number. Driver 10.0.0 makes `serializeIdFilter` reject a wrongly typed scalar explicitly, and it uses `Number.isSafeInteger` in `validateId`.

**A reference is proven where it is used, not only at the probe.** A domain labels each invalid value by what happened at its probe, but another binding can treat the same value differently. The driver validates a path identifier with `validateId` yet forwards most body fields unchecked. The bulk case bodies take a list that the title lookup would validate. Thus, [`tests/domains.test.ts`](../tests/domains.test.ts) also drives every value of every reference through the binding that the reference is used at. There are 394 values, across more than 100 bindings. For each value, the test does these things:

- it takes the baseline case of the parameter, with its literal driver arguments and upstream reply;
- it puts the value where the `driver` location of the manifest says that the parameter lands;
- it records what the pinned driver does with the value: the driver refuses the value with its own validation error, crashes before dispatch, or lets the value reach the wire.

A reference whose binding differs from the probe says so with `rejected_by` next to its `domain_ref`. `rejected_by` takes one of these values:

- `"adapter"`, when the driver refuses none of the domain's invalid values there;
- a record that relabels only the values that it names.

An override must change at least one inherited label, so a restated or empty override is refused. The value is placed where the manifest's `driver` location says, and "adapter" means a request went out.

Two separate checks hold that the value landed where TestRail reads it. The registration audit pairs each location with the argument map. The published-driver evidence compares the wire request of each accepted case. The test asserts the effective label for each value in both directions. Thus, a reference that inherits a label that its binding does not earn fails. A reference that claims adapter-only enforcement where the driver checks fails too.

In 10.0.0, 71 references carry `"adapter"` for unvalidated body fields: 49 numeric IDs and 22 timestamps. The four bulk case writes explicitly reject a bare number passed as `case_ids`. Thus, each of them uses the override `{ "scalar": "driver" }`. The `case_ids` probe still crashes on that input. Every valid value is also accepted at every reference.

A parameter inside a reviewed array names its member with `*`, as in `body.results[].status_id`. The derived rejections of the parameter mutate the first member alone. Thus, every other member stays valid, and the refusal can still only have come from the member under test.

**Derived rejections stay attributable.** A manifest that uses `domain_ref` names a `baseline` accepted case. Each rejection is derived by mutating that baseline at exactly one input path. Thus, everything else in the input stayed valid, and the refusal can only have come from the parameter under test. Removing the derivation leaves the covered requirements uncovered, and the audit names each one. These cases are therefore essential rather than decorative.

A parameter of any scope can reference a shared domain when the adapter holds the parameter to that domain. Path, query and body identifiers all reference `positive_id`. A body reference records in its `semantics` where the driver itself is looser. Endpoint-specific domains, such as the `attachment_id` union or a payload's own value types, stay written out in full.

The Cases family added three domains:

- `id_filter` is one identifier or a non-empty list, proven through the `typeId` option of `cases.getCasesPage`, which is one of the seven filters that the driver comma-joins. Its `list` requirement carries seven proven lists rather than one, because a case that sets several list filters must give each a different list. Equal lists could not expose two filters that are mapped onto each other's options.
- `unix_timestamp` is proven through `createdAfter`, which validates the value before dispatch. Write-body timestamp fields use individual overrides where the driver forwards them unchecked.
- `case_ids` is a non-empty identifier list proven through `cases.getCaseTitles`. The four bulk write methods validate their lists and send them in the JSON body.

The Plans family added `entry_id`, the only non-numeric identifier in the library, proven through `attachments.getAttachmentsForPlanEntry`. The driver validates the UUID layout there before dispatch, so its eight rejections are recorded as the driver's rather than the adapter's. The `get_attachments_for_plan_entry` manifest, first written in F04 with the rule inline, references the domain since T12, as does `add_attachment_to_plan_entry`.

The accepted examples run against the installed public driver with injected fetch and DNS. They compare exact URLs, request JSON and driver results. No request reaches TestRail. Rejected fixture cases are format and coverage requirements until a family adapter consumes them. The direct-driver evidence harness does not pretend to validate the MCP input boundary. Run the fixture checks with `npm exec -- vitest run tests/parameter-manifest.test.ts`.
