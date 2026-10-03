# Coverage reports

Every CI job publishes R01's machine-readable reports as an artifact named `coverage-reports-<os>-node<version>`. They record what the deterministic suite verified for that build and which package and driver it ran against. They are offline evidence only, and each file says so.

These reports describe endpoint and parameter coverage. Source coverage is separate: `npm run test:coverage` measures it with V8 and fails below 99% for lines, statements, functions or branches of `src/`. CI enforces it on Linux, and its output stays in the job log, not in these artifacts.

## What the reports claim

Every file opens with the same header:

| Field | Meaning |
| --- | --- |
| `evidence` | Always `offline_fixtures`: the files come from a passing run of the deterministic suite (`npm test`), which replays hand-authored fixtures through the registered tools and the pinned driver, with an injected fetch. |
| `live.testrail`, `live.clients` | Always `not_run`. Each links the issue that owns that qualification: [R03](https://github.com/dichovsky/testrail-mcp/issues/24) for a live TestRail instance, [R02](https://github.com/dichovsky/testrail-mcp/issues/23) for MCP host clients. |
| `package` | This package's name and version. |
| `driver` | The installed driver's name and version, with the tarball URL and integrity hash from the lockfile. `reviewed_commits` is the driver commit every manifest was reviewed against. |
| `runtime` | Node version, platform and architecture of the job. |
| `source.head_commit` | The commit under review: a pull request's head, or the pushed commit. `null` outside CI. |
| `source.built_commit` | The commit CI checked out and tested. On a pull request this is GitHub's temporary merge of the head into the base branch, so it differs from `head_commit` and may later stop resolving once the base moves. `null` outside CI. |

No TestRail instance, credentials, user directories or MCP host clients are involved. The reports carry no local path, home directory, temporary directory or credential-like environment value. A gate checks this machine's own paths in both slash forms, and also rejects common path shapes: a drive letter with either slash, a `~/` home path, the usual Unix home and system roots, and a CI runner's tool cache.

## The three files

**`coverage.json`**, endpoint coverage. `totals` counts operations, resources, families, controlled and response-driven lists, page/all helpers, registered tools, manifests by status, parameters, requirements covered out of total, and accepted and rejected cases. `endpoints` has one row per inventory operation, with:

- its family, resource, method, route, driver method and pagination helpers;
- its inventory status;
- whether the registry serves it with the inventory's method, route, family, binding and pagination;
- a manifest summary: review status and date, parameter count, requirements covered out of total, and accepted and rejected cases.

**`parameters.json`**, parameter coverage. For every endpoint, each coverage target is listed: the endpoint-wide `$input` rules, then each parameter with its scope, requiredness and wire location. Every requirement lists the IDs of the cases that cover it. The IDs include the rejections derived from the [shared domain library](parameter-manifest.md), such as `project_id:zero`, so the report shows every requirement row, not only every parameter name.

**`fixture-evidence.json`**, fixture evidence. For every endpoint:

- the manifest's review block (driver version, commit, authored commit, review date and any driver provenance evidence) and its cited sources;
- the input policy and outer result shape;
- for each accepted case: the driver binding, the literal wire request (method, TestRail endpoint, and whether the body was JSON, multipart or none), and the kinds of upstream response and driver result;
- for each rejected case: its expected error code.

The fixtures themselves stay in [`tests/fixtures/parameters`](../tests/fixtures/parameters). The report records what each one checks and where its evidence comes from.

## How they are produced and gated

[`tests/coverage-report.test.ts`](../tests/coverage-report.test.ts) builds the reports from the production registry, the [operation inventory](operation-inventory.json) and the loaded manifests, using [`tests/contracts/coverage-report.ts`](../tests/contracts/coverage-report.ts). Every check below is a gate. The test that writes the files runs last and refuses to write unless every gate passed earlier in the same run. A run where a gate fails, or where a filter skipped it, writes nothing:

- **Contract numbers.** The reports account for 133 operations, 28 resources, 12 families, 18 controlled and 6 response-driven lists, and 48 helpers. These numbers are stated in the test rather than read from the inventory.
- **Endpoint coverage.** Every endpoint is registered with its inventory identity and has a complete manifest. Every requirement is covered by at least one case, and every endpoint has at least one accepted case.
- **Faithful to the manifests.** Every manifest's `$input` rules, parameters and requirement rows appear in order. Parameter, requirement, accepted and rejected totals equal counts taken straight from the manifests. The three files agree on every endpoint's cases. Each accepted case keeps its own driver binding, wire method, endpoint and body kind.
- **Hand-checked samples.** `testrail_get_project` matches a transcription of its manifest requirement by requirement, including which cases cover each row. Its fixture evidence, the JSON bodies of `testrail_add_project` and the multipart bodies of `testrail_add_attachment_to_case` are transcribed too.
- **Versions and commits.** The driver is the exact `9.0.0` the package pins and the lockfile resolves, reviewed at commit `a5ccffbfa176e9c6675bd81fff61859bd7b6be5d`. In CI both commits are recorded, and on a pull request the head differs from the built merge.
- **Inventory status.** Each inventory row's `status` is `implemented` exactly when the report shows it registered and fully covered, and `planned` otherwise. The inventory's top-level status is `implemented` only when every row is. Its `status_scope` says the status is offline verification only, and its release record names the pinned driver's version, commit and integrity.
- **Every field from its source.** Each report is rebuilt inside the test from the file it came from, and must equal the builder's output field for field:
  - every endpoint row from the inventory;
  - every parameter's scope, requiredness and wire location, and every requirement's covering cases, from the manifest, found by searching its cases for that exact parameter and requirement;
  - every manifest's review, sources, input policy and outer result, and every case's binding, wire request, response kinds and rejection code.
- **Coverage document.** In [API coverage](api-coverage.md), every endpoint row agrees with the inventory: REST endpoint, tool, driver method, page/all helpers and status. Every resource row has the inventory's counts and status. The total row and the status line agree too, and the resource rows name exactly the inventory's 28 resources.
- **Gaps show.** Each of these shows up in the report: a registry missing an endpoint, a registration bound to the wrong driver method, a registration the inventory does not list, a missing manifest, and one uncovered requirement. For the uncovered requirement, only that row empties while its siblings keep their covering cases.

The test runs in `npm test`. When `TESTRAIL_MCP_REPORT_DIR` is set, it writes `coverage.json`, `parameters.json` and `fixture-evidence.json` there; otherwise it writes them to a temporary directory and removes it. CI sets the variable on its test step and uploads the directory as the final step. A job that fails any check, including the packaged-executable protocol checks, therefore publishes no reports.

To produce them locally, run the whole deterministic suite:

```bash
TESTRAIL_MCP_REPORT_DIR=./coverage-reports npm test
```

The report test's gates cover registration, manifests and coverage. They do not replay fixtures; `tests/registered-parameters.test.ts` and the family suites do that. Reports are evidence only from a run in which every test passed. CI guarantees this by uploading only from a job whose every step passed. A local run that writes reports while another test file fails produces files that describe nothing.

## What they do not claim

An `implemented` row, and every count in these files, describes offline verification against a pinned driver and fixture replies. It does not claim that an operation succeeds on a particular TestRail instance, version, edition or permission set, or that a particular MCP host can discover and call it. Those results belong to R02 and R03 and will be recorded separately. These reports will never report them as passed.
