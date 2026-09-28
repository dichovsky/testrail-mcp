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

Input validation → page/all mode selection, refusing in all mode any stated aggregate bound above its configured limit → upload staging when the operation takes a file → `runtime.invoke`, which for a download also writes the file → result assembly (`validateOuter`, page or aggregate metadata, `advisoryWarnings`) → `successResult`. A failure anywhere becomes `errorResult(classifyError(...))`; the pipeline never throws, because a failed operation is a tool error while the protocol itself is healthy.

A download's file is written inside the driver callback the runtime tracks, not after `runtime.invoke` returns. The runtime holds the download slot until that callback settles, so the next download is refused as `BUSY` until the file is written or its write has failed. A reply that arrives after the call has already returned an error writes nothing, since no caller would learn the file's path. A write already under way when the call ends finishes before the slot is freed, and the committed file is kept, as the implementation contract requires of a download whose delivery fails.

`dispatched` and `acknowledged` are recorded as they happen rather than inferred afterwards, since they decide what a caller is told about a write. `dispatched` is set on entering the driver callback rather than once bytes reach the network, which errs toward `unknown` and never toward a false `not_started`. Whether an operation mutates comes from `effects.testRail`, never from `readOnlyHint` — an attachment download has local effects but does not change TestRail, so it carries no write outcome.

## Diagnostics and lifetime

Standard output carries protocol messages only. Diagnostics are one JSON object per line on stderr, restricted to fixed event codes, tool names, a correlation id, durations and counts. Tool results legitimately contain TestRail data and local file paths; diagnostics must not, so they accept no arguments, bodies or paths at all. `tests/result-contract.test.ts` holds this for `tool_call` events: a failed write with a secret-laden error body, a successful read and a refused upload each log one event whose keys are all on that list and which carries no argument, body, path, host or key.

Configuration is loaded before any transport exists, so a misconfigured server never emits a protocol message it cannot honour; it names the offending key on stderr, writes nothing to stdout, and exits non-zero. Shutdown is idempotent and runs once for whichever of stdin closure, `SIGINT` or `SIGTERM` arrives first: it stops admission, closes the connection, drains the runtime and disposes staging. A later signal waits for that shutdown rather than killing the process mid-drain, no shutdown step can make it fail, and the process exits 250 ms after shutdown completes, even if a request abandoned by the drain still holds driver timers. [Runtime lifetime](runtime-lifetime.md) gives the timings. A write still pending when the connection closes cannot be answered; its `tool_call` diagnostic carries `write_outcome: "unknown"`, which is then the only record that it may have been applied.

## Three behaviours recorded rather than claimed

**Cross-era key ordering.** The two eras serialize an advertised schema's keys in a different order — legacy emits `$schema` first, modern emits it after `required` — while carrying identical keys and values. Catalogs are therefore compared structurally across eras, and byte-for-byte only within one era, where determinism does hold.

**Malformed lines get no reply.** The contract says malformed protocol messages stay protocol errors. The SDK's stdio transport drops a line it cannot parse without emitting `-32700` and without an error callback, and there is no id to answer. Emitting one would mean replacing the transport to correct a host-side fault, which is disproportionate. A test pins the observed behaviour — the line is skipped and the connection keeps serving — so a future SDK change surfaces here rather than inside a release claim. R01 should record this as evidence rather than assert the contract sentence unqualified.

**A cancelled request id 0 is not cancelled.** The SDK's server drops a `notifications/cancelled` whose `requestId` is falsy (`if (!notification.params.requestId) return;`), so it treats id 0 as naming no request. A legacy connection spends id 0 on `initialize`, which is never cancelled. A 2026-07-28 client opens with a string-id discover probe, so its first ordinary request gets id 0. If that request is a tool call, cancelling it never reaches the handler: the call runs to completion and its reply is written anyway. Hosts list tools before calling one, so this needs an unusual client. It is an SDK fault, not worth replacing the protocol layer for, and a test pins it so an SDK upgrade surfaces here.

## Verification

`tests/transport/protocol.test.ts` drives a real client over a linked in-memory transport: both eras with the negotiated era read from the connection rather than inferred, deterministic discovery with no upstream request, verbatim schema and annotations, the wrapper as structured content plus identical text, an argument rejection and an upstream failure as classified tool errors, and an unknown tool as a protocol error.

`tests/transport/lifecycle.test.ts` drives the **built executable**, `dist/cli.js`, as a child process: stdout is parsed line by line and every line must be a protocol message, diagnostics appear on stderr with no configured value, stdin closure exits zero, an unknown method returns `-32601`, and a malformed line is skipped without ending the session. Against a loopback TestRail that never answers, it makes no request at startup or discovery. With a call in flight, it exits with code 0 within the drain window after stdin closure, `SIGINT` or `SIGTERM`. It also shows a second `SIGINT` or `SIGTERM` during the drain does not cut the shutdown short, a staging failure is retried and still shuts down with exit code 0, and that no API key, email, Basic credential or TestRail address appears on either stream.

`npm run test:package` drives the **packaged executable**: the tarball npm packs, installed into a clean directory. `scripts/package-protocol.mjs` runs three sessions against it, each with its own TestRail stand-in on the loopback interface: a legacy `initialize` session, one pinned to 2026-07-28, and one the SDK's own stdio transport negotiates automatically. The era each session negotiated is read from the connection. Every session must list exactly the 133 inventory tools, twice identically and without contacting TestRail, with the client's response cache bypassed so each listing reaches the server; serve `testrail_get_project` with one request carrying the configured Basic credential; refuse a string ID as `INVALID_ARGUMENT` without a request; and answer an unknown tool with the protocol's invalid-params error and keep serving. The server runs with Node's process warnings silenced, so every stderr line must be one of its JSON diagnostic events, the startup event among them, and neither the API key, the Basic credential, the email nor the TestRail address may appear there. The first two sessions run over a transport that records every byte the server writes to stdout, so they also require every stdout line, a final unterminated one included, to be a complete JSON-RPC message (a request, a notification, or a response with a result or an error) and free of those values, the shutdown event on stderr, and the server to exit with code 0 within 10 seconds of stdin closing; a server that has to be killed fails. The automatic session's pipes and process belong to the SDK, so its raw stdout and exit are left to the other two. A failure names the session and the step under way and ends with the server's stderr; the recorded sessions also report the exit status.

`tests/transport/cancellation.test.ts` sends `notifications/cancelled` from a real client, in both eras, for registered tools that have already reached TestRail. The handler's signal aborts and the call ends `CANCELLED`, a write with `write_outcome: "unknown"`. The SDK then suppresses the response, so the client gets nothing for that id: neither the result nor the upstream reply that arrives later. The slot stays owned until that reply settles, the late reply raises no unhandled rejection, and the connection keeps serving. Because nothing is written back, the test wraps the pipeline to read the result the handler produced. Mutation-checked: not passing the handler's signal, and never recording dispatch, each fail it.

`tests/transport/tool-call.test.ts` covers the pipeline directly with synthetic download and upload operations: a caller's identifier survives unchanged whether it is a number or a UUID, a staged copy is gone after a call refused at admission, and a cancelled upload keeps its copy until its request settles.

Mutation-checked: routing diagnostics to stdout fails the lifecycle test and the package check; a stray stdout line with or without a final newline, a final line that is JSON but not a complete JSON-RPC message, a dropped tool, a diagnostic carrying the API key, the Basic credential or the TestRail address, diagnostics written as Node warnings, a non-event JSON value on stderr, a server that stops serving after an unknown tool while listings could be cached, an unknown tool that is never answered, a server that exits during a call, and a server that ignores stdin closure each fail the package check; advertising the Zod schema instead of the reviewed document fails both the discovery and argument-rejection tests; coercing a non-numeric attachment id, dropping the staged disposal, disposing it while a cancelled upload still reads it, and reading a nested `file` object instead of the reserved flat inputs each fail a tool-call test.

## Two corrections review found here

Both were real and neither would have surfaced until an endpoint family landed.

**Identifiers were coerced.** TestRail accepts a positive integer **or a UUID** for an attachment id — the driver's own signature is `getAttachment(attachmentId: number | string)`. The download branch collapsed anything non-numeric to `0`, which would have labelled every UUID download with a placeholder and broken any caller matching a batch of downloads back to what it requested. The validated value now passes through untouched, and an operation registered without an identifier raises an internal error rather than inventing one.

**Staged uploads leaked on refusal.** The runtime rejects `BUSY` and pre-dispatch cancellation *before* it creates the slot that runs cleanup, so a call refused at admission left its staged copy in the staging directory for the life of the process. The catch now disposes it, but only for a call that never entered the driver. Once dispatched, the runtime's settlement cleanup disposes it instead, because a cancelled or timed-out upload may still be reading the copy into its request; disposing it from the catch would fail that request part-way.

A third fault surfaced while writing the test for the second: the reserved upload inputs are **flat** — `file_path`, `filename`, `content_type` — and the pipeline was reading a nested `file` object it had invented. It would never have matched a real registered upload, so staging would silently never have happened. The registry's own layout check caught it.

## Not in this layer

Endpoint registrations (T01–T12) and their parameter manifests. The protocol and tool-call suites above use a synthetic operation where one entry shows what the transport does with all 133; the cancellation suite uses the production catalog.
