# Stdio transport

`src/transport/` implements F08: the composition root, tool registration, the per-call pipeline and stderr diagnostics. It contains no endpoint logic — a family adds registry entries, never transport code.

## The driver lives outside the factory

`serveStdio(factory)` pins one server instance per connection, and the factory can run more than once during an opening when an era falls back. So the factory only constructs an `McpServer` and registers the catalog; configuration, driver and runtime are created once in `startServer` and closed over. A second server instance therefore cannot mean a second credential, a second rate budget, or a disposal that tears down state another instance is using.

Registration contacts nothing, so discovery makes no TestRail request and repeated discovery is byte-identical within a connection.

## The advertised schema is the reviewed one

Tools advertise each operation's reviewed JSON Schema **verbatim**, through a small passthrough `StandardSchemaWithJSON` whose `validate` accepts everything.

Handing the SDK a Zod schema instead would re-emit it in another dialect, so the bytes a client sees would stop matching the document the parameter gates reviewed. Letting the SDK validate would be worse than cosmetic: it rejects bad arguments itself with a bare error carrying no `structuredContent`, which bypasses the adapter's error taxonomy entirely. Both failures are pinned by tests — swapping in the Zod schema fails two of them.

The adapter validates instead, and a rejected argument is an `INVALID_ARGUMENT` tool error like any other.

`outputSchema` describes only the wrapper, with `data` unconstrained, so entity drift can never fail it. The SDK also skips output validation for error results (`if (result.isError) return;`), so an error envelope is never measured against it either.

## One call, end to end

Input validation → page/all mode selection → upload staging when the operation takes a file → `runtime.invoke`, which for a download also writes the file → result assembly (`validateOuter`, page or aggregate metadata, `advisoryWarnings`) → `successResult`. A failure anywhere becomes `errorResult(classifyError(...))`; the pipeline never throws, because a failed operation is a tool error while the protocol itself is healthy.

A download's file is written inside the driver callback the runtime tracks, not after `runtime.invoke` returns. The runtime holds the download slot until that callback settles, so the next download is refused as `BUSY` until the file is written or its write has failed. A reply that arrives after the call has already returned an error writes nothing, since no caller would learn the file's path. A write already under way when the call ends finishes before the slot is freed, and the committed file is kept, as the implementation contract requires of a download whose delivery fails.

`dispatched` and `acknowledged` are recorded as they happen rather than inferred afterwards, since they decide what a caller is told about a write. `dispatched` is set on entering the driver callback rather than once bytes reach the network, which errs toward `unknown` and never toward a false `not_started`. Whether an operation mutates comes from `effects.testRail`, never from `readOnlyHint` — an attachment download has local effects but does not change TestRail, so it carries no write outcome.

## Diagnostics and lifetime

Standard output carries protocol messages only. Diagnostics are one JSON object per line on stderr, restricted to fixed event codes, tool names, a correlation id, durations and counts. Tool results legitimately contain TestRail data and local file paths; diagnostics must not, so they accept no arguments, bodies or paths at all.

Configuration is loaded before any transport exists, so a misconfigured server never emits a protocol message it cannot honour; it names the offending key on stderr, writes nothing to stdout, and exits non-zero. Shutdown is idempotent and runs once for whichever of stdin closure, `SIGINT` or `SIGTERM` arrives first: it stops admission, closes the connection, drains the runtime and disposes staging.

## Two behaviours recorded rather than claimed

**Cross-era key ordering.** The two eras serialize an advertised schema's keys in a different order — legacy emits `$schema` first, modern emits it after `required` — while carrying identical keys and values. Catalogs are therefore compared structurally across eras, and byte-for-byte only within one era, where determinism does hold.

**Malformed lines get no reply.** The contract says malformed protocol messages stay protocol errors. The SDK's stdio transport drops a line it cannot parse without emitting `-32700` and without an error callback, and there is no id to answer. Emitting one would mean replacing the transport to correct a host-side fault, which is disproportionate. A test pins the observed behaviour — the line is skipped and the connection keeps serving — so a future SDK change surfaces here rather than inside a release claim. R01 should record this as evidence rather than assert the contract sentence unqualified.

## Verification

`tests/transport/protocol.test.ts` drives a real client over a linked in-memory transport: both eras with the negotiated era read from the connection rather than inferred, deterministic discovery with no upstream request, verbatim schema and annotations, the wrapper as structured content plus identical text, an argument rejection and an upstream failure as classified tool errors, and an unknown tool as a protocol error.

`tests/transport/lifecycle.test.ts` drives the **packaged executable**: stdout is parsed line by line and every line must be a protocol message, diagnostics appear on stderr with no configured value, stdin closure exits zero, an unknown method returns `-32601`, and a malformed line is skipped without ending the session.

`tests/transport/tool-call.test.ts` covers the pipeline directly with synthetic download and upload operations: a caller's identifier survives unchanged whether it is a number or a UUID, a staged copy is gone after a call refused at admission, and a cancelled upload keeps its copy until its request settles.

Mutation-checked: routing diagnostics to stdout fails the lifecycle test; advertising the Zod schema instead of the reviewed document fails both the discovery and argument-rejection tests; coercing a non-numeric attachment id, dropping the staged disposal, disposing it while a cancelled upload still reads it, and reading a nested `file` object instead of the reserved flat inputs each fail a tool-call test.

## Two corrections review found here

Both were real and neither would have surfaced until an endpoint family landed.

**Identifiers were coerced.** TestRail accepts a positive integer **or a UUID** for an attachment id — the driver's own signature is `getAttachment(attachmentId: number | string)`. The download branch collapsed anything non-numeric to `0`, which would have labelled every UUID download with a placeholder and broken any caller matching a batch of downloads back to what it requested. The validated value now passes through untouched, and an operation registered without an identifier raises an internal error rather than inventing one.

**Staged uploads leaked on refusal.** The runtime rejects `BUSY` and pre-dispatch cancellation *before* it creates the slot that runs cleanup, so a call refused at admission left its staged copy in the staging directory for the life of the process. The catch now disposes it, but only for a call that never entered the driver. Once dispatched, the runtime's settlement cleanup disposes it instead, because a cancelled or timed-out upload may still be reading the copy into its request; disposing it from the catch would fail that request part-way.

A third fault surfaced while writing the test for the second: the reserved upload inputs are **flat** — `file_path`, `filename`, `content_type` — and the pipeline was reading a nested `file` object it had invented. It would never have matched a real registered upload, so staging would silently never have happened. The registry's own layout check caught it.

## Not in this layer

Endpoint registrations (T01–T12) and their parameter manifests. The catalog is empty, so a running server currently exposes zero tools; the transport is exercised by a synthetic operation that stands in for the families, because what it does with one entry is what it will do with 133.
