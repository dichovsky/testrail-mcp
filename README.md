# TestRail MCP server

A local stdio MCP server for the complete TestRail 10.7.0 API, powered by [`@dichovsky/testrail-api-client`](https://github.com/dichovsky/testrail-api-client).

The accepted design exposes **133 endpoint tools**, enabled by default, for Codex desktop/CLI, Claude Code and GitHub Copilot CLI. It preserves TestRail fields and custom fields, supports bounded pagination, and manages attachment and BDD files within configured local directories. Older TestRail versions are best effort.

**Status:** architecture and implementation backlog defined; server implementation and release qualification are planned. Package names and client configuration examples describe the intended release.

- [Implementation plan and GitHub work items](docs/implementation-plan.md)
- [Architecture](docs/architecture.md) and [precise implementation contracts](docs/implementation-contracts.md)
- [Full endpoint coverage](docs/api-coverage.md) and [machine-readable inventory](docs/operation-inventory.json)
- [Client configuration and verification](docs/client-compatibility.md)
- [Domain glossary](CONTEXT.md), [design decision](docs/adr/0001-endpoint-tools.md) and [research sources](docs/research-notes.md)

Production release requires a published driver containing the identified network-guard and report-execution fixes, complete endpoint/parameter verification, and the required client and TestRail compatibility evidence. See the implementation plan for dependencies and acceptance criteria.
