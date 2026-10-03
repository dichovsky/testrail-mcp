# Changelog

All notable changes to `@dichovsky/testrail-mcp` are recorded here. Versions follow [semantic versioning](https://semver.org/) as [docs/release.md](docs/release.md#versioning-and-compatibility) defines it for this server. A section stays `Unreleased` until its release is cut; the release workflow refuses to publish a version whose section is not dated.

## [1.0.0] - Unreleased

The first release: a local stdio MCP server for the complete TestRail 10.7.0 API.

### Added

- 133 tools, one per TestRail REST endpoint, across all 28 API resources, all enabled by default, with per-tool MCP annotations for their effects.
- MCP over stdio for both the legacy `initialize` handshake and protocol 2026-07-28, with protocol messages only on stdout and JSON diagnostic events on stderr.
- Results as `{data, pagination, warnings}` that keep TestRail's field names and custom fields, advisory drift warnings, and a byte budget that refuses a result whole rather than truncating it.
- Errors with a fixed code, and a `write_outcome` of `not_started`, `acknowledged` or `unknown` for every write.
- One page of 50 by default, up to 250, and a bounded complete fetch with `_mcp.pagination: "all"` that stops with `PAGINATION_LIMIT` and no partial data.
- Uploads confined to configured directories and read through a staged copy, and downloads that always create a new, retained file.
- At most four calls at a time, a 60-second response wait, and a call's slot held until its TestRail request has really finished.
- Configuration from the launch environment only, with a startup error that names the variable and never its value.
- The pinned, qualified driver `@dichovsky/testrail-api-client` 7.2.0.

### Verification

- Every endpoint's hand-authored parameter manifest runs through the registered tool and the real driver. Registry, protocol, result-contract, paging and runtime-lifetime gates run in CI on Node 24 across Linux, macOS and Windows, and CI publishes coverage reports as artifacts.
- Client qualification (R02) and live TestRail 10.8.1 qualification (R03) are recorded before this section is dated.
