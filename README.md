# TestRail MCP server

A local stdio MCP server for the complete TestRail 10.7.0 API, powered by [`@dichovsky/testrail-api-client`](https://github.com/dichovsky/testrail-api-client).

The accepted design exposes **133 endpoint tools**, enabled by default, for Codex desktop/CLI, Claude Code and GitHub Copilot CLI. It preserves TestRail fields and custom fields, supports bounded pagination, and manages attachment and BDD files within configured local directories. Older TestRail versions are best effort.

**Status:** the package foundation and registry/input infrastructure are implemented, with help/version commands and build, schema, test and packaging checks. The MCP runtime, endpoint tools and release qualification remain in the implementation backlog. Client configuration examples describe the intended release.

## Development

Use Node 22.13 or later in the 22 series, or Node 24. CI runs on Node 22 and 24 across Linux, macOS and Windows. Other Node majors admitted by the package engine range are best effort until certified.

```sh
npm ci
npm run check
node dist/cli.js --help
node dist/cli.js --version
```

`npm run check` builds from a clean output directory, checks registry parity and generated references, typechecks, lints, runs tests, then packs and installs the tarball into a temporary directory to verify the executable and published files. These checks need no TestRail credentials. The development executable exits with a clear error when invoked to serve MCP; it does not advertise a partial tool catalog.

Source ownership follows the [component boundaries](src/README.md). The initial package version is an unpublished development version; npm publication is tracked separately in R03.

## Implementation documents

- [Implementation plan and GitHub work items](docs/implementation-plan.md)
- [Architecture](docs/architecture.md) and [precise implementation contracts](docs/implementation-contracts.md)
- [Full endpoint coverage](docs/api-coverage.md) and [machine-readable inventory](docs/operation-inventory.json)
- [Registry authoring](docs/registry-authoring.md), [generated operation reference](docs/operation-reference.md) and [independent parameter fixtures](docs/parameter-manifest.md)
- [Client configuration and verification](docs/client-compatibility.md)
- [Domain glossary](CONTEXT.md), [design decision](docs/adr/0001-endpoint-tools.md) and [research sources](docs/research-notes.md)

Production release requires a published driver containing the identified network-guard and report-execution fixes plus a public operation-settlement API, complete endpoint/parameter verification, and the required client and TestRail compatibility evidence. See the implementation plan for dependencies and acceptance criteria.
