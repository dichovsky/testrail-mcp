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

The F04 registry and input helpers now live in `operations/` and `contracts/inputs.ts`; see the [authoring guide](../docs/registry-authoring.md). F03's `config/environment.ts`, `config/limits.ts` and `driver/configuration.ts` prepare immutable configuration and public driver construction; see [their scope and integration boundary](../docs/startup-configuration.md). They are not yet wired into CLI startup. Family implementations still need to populate the catalog. Create other directories when their implementation begins. The foundation executable provides help and version output; server startup reports that this development build does not yet serve MCP. All endpoint entries remain planned until their implementation and verification are complete.
