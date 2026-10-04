# Source boundaries

`cli.ts` is the executable entry point. Informational arguments are parsed in `config/command-line.ts` before credentials or transport dependencies are loaded.

The remaining components follow [the architecture](../docs/architecture.md#runtime-and-component-boundaries):

| Directory | Responsibility | Implementation item |
| --- | --- | --- |
| `config/` | Immutable environment, directory and budget configuration | F03 |
| `driver/` | Public TestRail client construction and operation settlement | F03 |
| `runtime/` | Admission, invocation lifetime and shutdown | F03 |
| `operations/` | Endpoint registry and domain bindings | F04, T01-T12 |
| `contracts/` | Input validation, preserved results, errors and pagination | F04-F06 |
| `files/` | Bounded upload staging and persistent downloads | F07 |
| `transport/` | MCP registration and stdio compatibility | F08 |

`operations/catalog.ts` composes the 12 endpoint families into 133 tools. The [authoring guide](../docs/registry-authoring.md) describes registry entries and the input helpers in `contracts/inputs.ts`.

`config/environment.ts`, `config/limits.ts` and `driver/configuration.ts` validate immutable startup configuration and construct the public driver; see [startup configuration](../docs/startup-configuration.md). `runtime/invocation.ts` owns admission, invocation lifetime and shutdown through the driver's settlement handle; see [runtime lifetime](../docs/runtime-lifetime.md).

`transport/server.ts` composes the server and registers the tools, `transport/tool-call.ts` runs each call, and `transport/diagnostics.ts` keeps stdout protocol-only; see [transport](../docs/transport.md). The contracts preserve response data, report advisory schema drift, classify errors and describe pagination; see [results and errors](../docs/results-and-errors.md) and [pagination](../docs/pagination.md).

`files/` enforces upload containment, stages bounded copies, recovers abandoned staging files and saves persistent downloads; see [local files](../docs/local-files.md). The executable serves the complete catalog over stdio with legacy and modern MCP protocol support.
