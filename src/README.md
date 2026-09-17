# Source boundaries

`cli.ts` is the executable entry point. Informational arguments are parsed in `config/command-line.ts` before credentials or transport dependencies are loaded.

The remaining components follow [the architecture](../docs/architecture.md#runtime-and-component-boundaries):

| Directory | Responsibility | Implementation item |
| --- | --- | --- |
| `config/` | Immutable environment, directory and budget configuration | F03 |
| `driver/` | Public TestRail client construction and operation settlement | F03 |
| `runtime/` | Admission, invocation lifetime and shutdown | F03 |
| `operations/` | Endpoint registry and domain bindings | F04, T01–T12 |
| `contracts/` | Input validation, preserved results, errors and pagination | F04–F06 |
| `files/` | Bounded upload staging and persistent downloads | F07 |
| `transport/` | MCP registration and stdio compatibility | F08 |

The F04 registry and input helpers now live in `operations/` and `contracts/inputs.ts`; see the [authoring guide](../docs/registry-authoring.md). F03's `config/environment.ts`, `config/limits.ts` and `driver/configuration.ts` prepare immutable configuration and public driver construction; see [their scope and integration boundary](../docs/startup-configuration.md). `runtime/invocation.ts` adds admission, invocation lifetime and shutdown over the qualified driver's settlement handle; see [the runtime notes](../docs/runtime-lifetime.md). F08's `transport/` wires them together: `server.ts` is the composition root and tool registration, `tool-call.ts` runs one call end to end, and `diagnostics.ts` keeps stdout protocol-only; see [the transport notes](../docs/transport.md). F05's `contracts/results.ts`, `contracts/drift.ts` and `contracts/errors.ts` add the preserved result wrapper, advisory drift warnings and the error taxonomy; see [results and errors](../docs/results-and-errors.md). F06's `contracts/pagination.ts` adds page defaults, validated continuations and aggregate control mapping; see [pagination](../docs/pagination.md). F07's `files/` adds upload containment, bounded staging copies, abandoned-staging recovery and persistent downloads; see [local files](../docs/local-files.md). Family implementations still need to populate the catalog. Create other directories when their implementation begins. The executable provides help and version output and now serves MCP over stdio; with the catalog still empty it exposes zero tools until the families land. All endpoint entries remain planned until their implementation and verification are complete.
