# Source boundaries

`cli.ts` is the executable entry point. The code parses informational arguments in `config/command-line.ts` before it loads credentials or transport dependencies.

The remaining components follow [the architecture](../docs/architecture.md#runtime-and-component-boundaries):

| Directory | Responsibility | Implementation item |
| --- | --- | --- |
| `config/` | Immutable environment, directory and budget configuration | F03 |
| `driver/` | Public TestRail client construction and configuration | F03 |
| `execution/` | Process-owned calls, driver/runtime/staging lifetime and bounded shutdown | [ADR 0004](../docs/adr/0004-operation-executor-lifetime.md) |
| `runtime/` | Internal admission, capacity, cancellation and settlement implementation | F03 |
| `operations/` | Endpoint registry and domain bindings | F04, T01-T12 |
| `contracts/` | Input validation, preserved results, errors and pagination | F04-F06 |
| `files/` | Bounded upload staging and persistent downloads | F07 |
| `transport/` | MCP registration, stdio compatibility and protocol/process lifecycle | F08 |

`operations/catalog.ts` composes the 12 endpoint families into 133 tools. Registration finalizes each authoring schema through `contracts/input-contract.ts`. The published, immutable JSON Schema also governs runtime validation. Typed driver bindings share that contract. The [authoring guide](../docs/registry-authoring.md) describes registry entries and the schema helpers in `contracts/inputs.ts`.

`operations/lists.ts` owns the 24 list definitions. Explicit filters generate projection and argument mappings. The module prepares page/all calls, enforces configured bounds and interprets replies. Continuation parsing and metadata remain internal implementation in `contracts/pagination.ts`. The driver fetches the pages.

`config/environment.ts`, `config/limits.ts` and `driver/configuration.ts` validate immutable startup configuration and construct the public driver. See [startup configuration](../docs/startup-configuration.md).

`execution/executor.ts` owns ordinary calls and Attachment transfers, one shared driver/runtime and a lazy staging area. It validates and prepares calls before admission. It observes dispatch and acknowledgement. It assembles results and provides shared bounded shutdown. `runtime/invocation.ts` implements admission, capacity and settlement behind that owner. See [runtime lifetime](../docs/runtime-lifetime.md).

`transport/server.ts` creates the process executor once and registers each protocol server around it, delegating calls through `execute(operation, input, options)`. Transport closes protocol intake before executor `shutdown()` and retains cancellation delivery, signal handling, stdout flushing and process exit. `transport/diagnostics.ts` keeps stdout protocol-only. See [transport](../docs/transport.md).

The contracts preserve response data, report advisory schema drift, classify errors and describe pagination. See [results and errors](../docs/results-and-errors.md) and [pagination](../docs/pagination.md).

`files/` enforces upload containment, stages bounded copies, recovers abandoned staging files and saves persistent downloads. See [local files](../docs/local-files.md). The executable serves the complete catalog over stdio with legacy and modern MCP protocol support.
