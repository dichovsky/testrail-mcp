# Changelog

All notable changes to `@dichovsky/testrail-mcp` are recorded here. Versions follow [semantic versioning](https://semver.org/) as [docs/release.md](docs/release.md#versioning-and-compatibility) defines it for this server. Move `Unreleased` entries into a dated version section when preparing a release; the release workflow refuses to publish a version whose section is not dated.

## [Unreleased]

### Fixed

- Shutdown bounds its wait for upload staging creation and cleanup, so a stalled temporary filesystem cannot prevent the exit grace from starting after the drain.
- Attachment uploads accept documented numeric and UUID identifiers without reporting false schema drift. Missing and malformed identifiers still produce advisory warnings.
- The complete tool-result byte budget includes metadata added by the MCP SDK.
- The source overview describes the implemented 133-tool catalog and its component boundaries.

### Maintenance

- npm publishing requires approval from the repository owner through the `npm-publish` environment, with self-approval permitted by the release policy.
- GitHub vulnerability alerts and security-update pull requests are enabled. Dependabot configuration checks npm and GitHub Actions versions weekly while retaining dependency review and driver qualification.

## [1.0.0] - 2026-10-04

The first release: a local stdio MCP server for the complete TestRail 10.7.0 API.

### Added

- 133 tools, one per TestRail REST endpoint, across all 28 API resources, all enabled by default, with per-tool MCP annotations for their effects.
- MCP over stdio for both the legacy `initialize` handshake and protocol 2026-07-28, with protocol messages only on stdout and JSON diagnostic events on stderr.
- Results as `{data, pagination, warnings}` that keep TestRail's field names and custom fields, advisory drift warnings, and a byte budget that refuses a result whole rather than truncating it.
- Errors with a fixed code, and a `write_outcome` of `not_started`, `acknowledged` or `unknown` for every write.
- One page of 50 by default, up to 250, and a bounded complete fetch with `_mcp.pagination: "all"`, as far as TestRail's replies link on, that stops with `PAGINATION_LIMIT` and no partial data.
- Uploads confined to configured directories and read through a staged copy, and downloads that always create a new, retained file.
- At most four calls at a time, a 60-second response wait, and a call's slot held until its TestRail request has really finished.
- Configuration from the launch environment only, with a startup error that names the variable and never its value.
- Results with only a comment or only an assignee: the four add-result tools need at least one of `status_id`, `comment` or `assignedto_id`, as TestRail documents, rather than always `status_id` ([#49](https://github.com/dichovsky/testrail-mcp/issues/49)).
- One address rule for every user tool: `add_user` and `update_user` accept the single-label domains and domain literals `get_user_by_email` accepts, so a user a self-hosted or directory instance stores can be created and updated as well as looked up ([#55](https://github.com/dichovsky/testrail-mcp/issues/55)).
- The pinned, qualified driver `@dichovsky/testrail-api-client` 9.0.0, and with it a Node 24 or later requirement. By default TestRail connections go direct, pinned to the DNS answers the driver's private-host guard approved: proxy settings are not used, and `NODE_EXTRA_CA_CERTS` adds trust for a private certificate authority. With `TESTRAIL_ALLOW_PRIVATE_HOSTS=true` nothing is pinned, and Node's own connection settings, a configured proxy included, apply. DNS resolution counts against the 15-second request timeout.

### Verification

- Every endpoint's hand-authored parameter manifest runs through the registered tool and the real driver. Registry, protocol, result-contract, paging and runtime-lifetime gates run in CI on Node 24 across Linux, macOS and Windows, and CI publishes coverage reports as artifacts. CI on Linux also requires at least 99% line, statement, function and branch coverage of the source.
- Claude Code passed all twelve client scenarios against the fixture stand-in, and the live qualification on TestRail 10.8.1 with driver 9.0.0 has no failures. What neither covers is listed below.

### Known limitations

The live qualification on TestRail 10.8.1 with driver 9.0.0 ([record](docs/evidence/live/testrail-10.8.1.json)) has no failures, but 35 of the 133 tools have no live pass. Their offline contract tests pass, which is not a live pass.

- **Blocked by the instance's licence (10).** `get_case_statuses`, `get_datasets` and `get_variables`, and `add_dataset` and `add_variable`, answered `LICENSE_REQUIRED`. `get_dataset`, `update_dataset`, `delete_dataset`, `update_variable` and `delete_variable` then had no dataset or variable to work on.
- **Blocked by the API user's permissions (17).** `get_cross_project_reports`, `add_config_group`, `delete_milestone`, `delete_plan` and `delete_run` answered `PERMISSION_DENIED`. Twelve tools then had nothing to work on:
  - the configuration tools `add_config`, `update_config`, `delete_config`, `update_config_group` and `delete_config_group`;
  - the plan-entry tools `add_plan_entry`, `update_plan_entry`, `add_run_to_plan_entry`, `update_run_in_plan_entry`, `delete_run_from_plan_entry`, `get_attachments_for_plan_entry` and `add_attachment_to_plan_entry`.
- **Not run, by the owner's choice (8).**
  - The writes outside a project: `add_user`, `update_user`, `add_group`, `update_group`, `delete_group` and `add_case_field`. TestRail cannot delete users or case fields.
  - `run_report` and `run_cross_project_report`, which generate reports and can send email.

The client checks ([client configuration](docs/client-compatibility.md#required-surfaces-and-evidence)) cover two of the four targeted clients, and only against the fixture stand-in, never a live TestRail instance.

- **Claude Code** 2.1.288 passed all twelve scenarios, headless on Linux, with an earlier development build of this server and driver 7.2.0 ([record](docs/evidence/clients/claude-code.json)).
- **Codex CLI** 0.160.0 passed 10 of 12, as the owner reported; its record is not in the repository.
  - It chose the wrong tool for 2 of 28 natural-language tasks: closing a run, and listing case types.
  - It never tells the server that a call was cancelled, neither on Esc nor at its own tool timeout. The server finishes such a call within its budgets, so a write cancelled in Codex may still be applied.
- **Codex desktop** and **GitHub Copilot CLI** were not tested.
