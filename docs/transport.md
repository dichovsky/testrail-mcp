# Stdio transport

`src/transport/` implements F08: the composition root, tool registration, protocol lifecycle and stderr diagnostics. `src/execution/executor.ts` owns the per-call pipeline and shared driver, runtime and staging lifetime. A family adds registry entries without changing transport code.

## The executor lives outside the factory

`serveStdio(factory)` pins one server instance for each connection. The factory can run more than once during an opening when an era falls back. `startServer` loads configuration and awaits `createOperationExecutor` one time.

The executor recovers abandoned staging, and it constructs its configured driver and runtime. The factory only calls `buildServer({ executor, registry })`. That call constructs an `McpServer` and registers the catalog around the same executor. Thus, a second server instance cannot mean a second credential, a second rate budget, or a disposal that tears down state that another instance uses.

`tests/transport/serving-process.test.ts` holds part of this. It replays the SDK client's own modern `server/discover` probe to the built executable, and then it sends a legacy `initialize`. Thus, `serveStdio` discards the probe's server and calls the factory again on one connection. A real call afterwards still reaches TestRail, so discarding a server does not dispose the shared executor. The composition tests in `tests/transport/composition.test.ts` hold that the factory builds no second driver or budget, for consumers in one era or in two.

Registration contacts nothing. Thus, discovery makes no TestRail request, and repeated discovery is byte-identical within a connection. The server lists tools in name order (`localeCompare` in English). The order is the same in every process.

## Server instructions

The instructions' first paragraph fits in 512 characters and ends at a sentence, because hosts may truncate there. It holds every rule that prevents harm:
- the user's permissions apply;
- a list that takes `_mcp` (a paged list) returns one page by default (50 where a limit applies), never the whole dataset;
- the other lists take no paging control and return what TestRail returns;
- `all` fetches the rest within bounds, only as far as TestRail's replies link on;
- field names are kept;
- a write's or report run's error carries `write_outcome`:
  - `unknown` may already be applied, so check before retrying;
  - `acknowledged` was applied, so do not repeat it;
- a report is never polled.

The rest adds these items:
- the result wrapper and `custom_*` fields;
- `not_started`;
- what `acknowledged` means;
- the license;
- report emails;
- the behavior of downloads, uploads and warnings.

Tests assert every rule as a whole sentence. Thus, a change that reverses or drops one rule fails a test. The whole text stays under 2 KiB.

## The advertised schema is the reviewed one

Tools advertise each operation's reviewed JSON Schema **verbatim**, through a small passthrough `StandardSchemaWithJSON` whose `validate` accepts everything.

If the server handed the SDK a Zod schema instead, the SDK would re-emit it in another dialect. The bytes that a client sees would then stop matching the document that the parameter gates reviewed. Letting the SDK validate would be worse than cosmetic. The SDK rejects bad arguments itself with a bare error that carries no `structuredContent`. That rejection bypasses the adapter's error taxonomy entirely. Tests pin both failures, and swapping in the Zod schema fails two of them.

The adapter validates through the operation's finalized input contract, whose compiled validator uses that same document. It checks the original JSON before admission or staging and preserves it for the driver binding, which also guards standalone invocation. A rejected argument is an `INVALID_ARGUMENT` tool error like any other.

`outputSchema` describes only the wrapper, with `data` unconstrained, so entity drift can never fail it. The SDK also skips output validation for error results (`if (result.isError) return;`), so an error envelope is never measured against the output schema either.

## One call, end to end

The registered handler delegates to `executor.execute(operation, input, options)`. Options carry the caller's cancellation signal and the negotiated protocol fields used to measure complete results and the separate error budget. The executor owns admission, binary capacity, staging and cleanup. The handler supplies none of these for each call.

The pipeline has these stages, in this order:

1. Input validation.
2. List-module preparation. This stage selects page/all. Before admission, it refuses any aggregate bound above its configured limit.
3. `runtime.invoke`. Its tracked callback stages the upload when the operation takes a file, and then it calls the driver. For a download, the callback also writes the file.
4. Result assembly. The list module validates and interprets list replies. `validateOuter` checks other replies. Then `advisoryWarnings` describes entity drift.
5. `successResult`.

Reply interpretation still follows successful-driver acknowledgement. A failure anywhere becomes `errorResult(classifyError(...))`. The pipeline never throws, because a failed operation is a tool error while the protocol itself is healthy. Should the pipeline ever reject, the server answers `INTERNAL_ERROR` itself rather than let the SDK send the raw error message, as [results and errors](results-and-errors.md) describes.

The tracked callback stages an upload too, not ahead of admission. Thus, staging holds a slot, and the watchdog and cancellation bound it like the request. [Local files](local-files.md) gives the details.

A download's file is written inside the driver callback that the runtime tracks, not after `runtime.invoke` returns. The runtime holds the download slot until that callback settles. Thus, the runtime refuses the next download as `BUSY` until the file is written or its write has failed. A reply that arrives after the call has already returned an error writes nothing, since no caller would learn the file's path. A write that is already under way when the call ends finishes before the runtime frees the slot. The server keeps the committed file, as the implementation contract requires of a download whose delivery fails.

The executor records `dispatched` and `acknowledged` as they happen. It does not infer them afterwards, because they decide what a caller is told about a write. The executor sets `dispatched` immediately before it calls the driver method, after any upload staging. It does not wait until bytes reach the network. This errs toward `unknown` and never toward a false `not_started`.

An upload whose wait ended during staging is never sent, so its `not_started` stays true. Whether an operation mutates comes from `effects.testRail`, never from `readOnlyHint`. An attachment download has local effects but does not change TestRail, so it carries no write outcome.

## Diagnostics and lifetime

Standard output carries protocol messages only. Diagnostics are one JSON object on each line of stderr. A diagnostic holds only these items:
- fixed event codes;
- tool names;
- a correlation id;
- durations;
- counts;
- for the error of a write or report run, its `write_outcome`;
- for a `transport_error`, the class name of the error, limited to a plain identifier.

That class name is the one addition to the list in the [implementation contracts](implementation-contracts.md). Tool results legitimately contain TestRail data and local file paths. Diagnostics must not contain them, so the server never passes arguments, bodies or paths to the diagnostics. The `DiagnosticFields` type fixes which fields an event may have, not what they carry, so tests hold each caller.

`tests/result-contract.test.ts` holds this for `tool_call` events. Each of these calls logs one event:
- a failed write with a secret-laden error body;
- a successful read;
- a refused upload.

The two errors carry `write_outcome` `unknown` and `not_started`. All keys of each event are on that list, and the event carries no argument, body, path, host or key. `tests/transport/diagnostic-events.test.ts` holds the five lifecycle events field by field.

The server loads configuration before any transport exists. Thus, a misconfigured server never emits a protocol message that it cannot honor. It names the offending key on stderr, writes nothing to stdout, and exits non-zero.

Shutdown is idempotent. It runs once, for whichever of stdin closure, `SIGINT` or `SIGTERM` arrives first. It has these steps:

1. The transport closes the connection and delivers cancellation.
2. The transport calls `executor.shutdown()` to stop admission, drain and dispose staging within the shared deadline.

These rules also apply:
- A later signal waits for that shutdown. It does not kill the process during the drain.
- No shutdown step can make the shutdown fail.
- The process exits 250 ms after shutdown completes and stdout has flushed, even if a request that the drain abandoned still holds driver timers.

Signals are tested on POSIX only. Node cannot deliver a catchable signal to a child on Windows, because `kill` terminates the child outright. Stdin closure is tested on every platform. [Runtime lifetime](runtime-lifetime.md) gives the timings.

The server cannot answer a write that is already dispatched when the connection closes. Its `tool_call` diagnostic carries `write_outcome: "unknown"`. That value is then the only record that the write may have been applied. The server never sends an upload that is still being staged at that moment. Closing the connection cancels the call and stops staging, and the diagnostic records `CANCELLED` with `write_outcome: "not_started"`.

`tests/transport/composition.test.ts` holds the first case through a shutdown ("the composition root > records a write pending at shutdown as unknown, and stops cleanly when it fails during the drain"). The second case is held only through the same cancellation signal, not through a shutdown: "upload staging inside the call slot > sends nothing when the caller cancels as staging completes" in `tests/transport/upload-staging.test.ts`.

## Three behaviours recorded rather than claimed

**Cross-era key ordering.** The two eras serialize the keys of an advertised schema in a different order. Legacy emits `$schema` first, and modern emits it after `required`. The keys and values are identical. Thus, catalogs are compared structurally across eras, and byte-for-byte only within one era, where determinism does hold.

**Malformed lines, and invalid messages, get no reply.** The contract says malformed protocol messages stay protocol errors. The SDK's stdio transport drops a line it cannot parse without emitting `-32700` and without an error callback, and there is no id to answer. Emitting a `-32700` would mean replacing the transport to correct a host-side fault. That is disproportionate. A test pins the observed behavior: the line is skipped and the connection keeps serving. Thus, a future SDK change surfaces here rather than inside a release claim.

The same holds for valid JSON that is not a valid JSON-RPC message, even with an id (`{"jsonrpc":"2.0","id":9}`). JSON-RPC 2.0 asks for `-32600`, but the SDK's transport drops the message and reports it through `onerror`. The server logs only the class name of the error, as a `transport_error` event, and keeps serving (`tests/transport/serving-process.test.ts`). The name is whatever the thrower set, so the server logs a name that is not a plain identifier as `Error`. R01 should record this behavior as evidence rather than assert the contract sentence unqualified.

**A cancelled request id 0 is cancelled like any other.** Through SDK 2.0.0 the server dropped a `notifications/cancelled` whose `requestId` was falsy (`if (!notification.params.requestId) return;`). It treated id 0 as naming no request. A legacy connection spends id 0 on `initialize`, which is never cancelled. A 2026-07-28 client opens with a string-id discover probe, so its first ordinary request gets id 0. Thus, cancelling that tool call never reached the handler.

SDK 2.3.0 tests `requestId === undefined` instead. Thus, the handler resolves `CANCELLED` and the SDK suppresses the response, as for any other id. A test pins this behavior, so a change of it in the SDK surfaces here.

## Verification

`tests/transport/protocol.test.ts` drives a real client over a linked in-memory transport. It covers these cases:
- both eras, with the negotiated era read from the connection rather than inferred;
- deterministic discovery with no upstream request;
- verbatim schema and annotations;
- the wrapper as structured content plus identical text;
- an argument rejection and an upstream failure as classified tool errors;
- an unknown tool as a protocol error.

`tests/transport/lifecycle.test.ts` drives the **built executable**, `dist/cli.js`, as a child process. These rules apply:
- The test parses stdout line by line, and every line must be a protocol message.
- Diagnostics appear on stderr with no configured value.
- Stdin closure exits zero.
- An unknown method returns `-32601`.
- A malformed line is skipped without ending the session.

Against a loopback TestRail that never answers, the executable makes no request at startup or discovery. With a call in flight, the executable exits with code 0 within the drain window after stdin closure, `SIGINT` or `SIGTERM`. The test reads stdout once the child's streams have closed. Stdout ends with a newline, and every line before it is a JSON-RPC message that the SDK's parser accepts, so a blank line fails too. The test also shows these results:
- A second `SIGINT` or `SIGTERM` during the drain does not cut the shutdown short, again with nothing but protocol messages on stdout.
- A staging failure is reported as `INTERNAL_ERROR` with `not_started`, is retried, and still shuts down with exit code 0.
- No API key, email, Basic credential or TestRail address appears on either stream.

`npm run test:package` drives the **packaged executable**: the tarball that npm packs, installed into a clean directory. `scripts/package-protocol.mjs` runs three sessions against it. Each session has its own TestRail stand-in on the loopback interface. The sessions are:
- a legacy `initialize` session;
- a session pinned to 2026-07-28;
- a session that the SDK's own stdio transport negotiates automatically.

The script reads the era that each session negotiated from the connection. Every session must meet these conditions:
- It lists exactly the 133 inventory tools, twice identically and without contacting TestRail. The client's response cache is bypassed, so each listing reaches the server.
- It serves `testrail_get_project` with one request that carries the configured Basic credential.
- It refuses a string ID as `INVALID_ARGUMENT` without a request.
- It answers an unknown tool with the protocol's invalid-params error and keeps serving.

The server runs with Node's process warnings silenced. Thus, every stderr line must be one of its JSON diagnostic events, the startup event among them. Neither the API key, the Basic credential, the email nor the TestRail address may appear there. The first two sessions run over a transport that records every byte that the server writes to stdout. Thus, they also require these results:
- Every stdout line, a final unterminated one included, is a complete JSON-RPC message (a request, a notification, or a response with a result or an error). Every such line is free of those values.
- The shutdown event appears on stderr.
- The server exits with code 0 within 10 seconds of stdin closing. A server that has to be killed fails.

The pipes and process of the automatic session belong to the SDK, so that session leaves its raw stdout and exit to the other two. A failure names the session and the step under way, and it ends with the server's stderr. The recorded sessions also report the exit status.

`tests/transport/serving.test.ts` connects a real client to the production catalog in both eras. Each of the 133 tools must be advertised in name order, without contacting TestRail. Each advertisement must have its registered schema (the 24 top-level `anyOf` inputs included), description (under 2 KiB) and annotations. The server must offer tools only, with `listChanged: false` and no resources or prompts. The arguments of a successful or failed call must stay out of every stderr line. Two source scans hold that nothing in `src/` imports an HTTP or socket server, and that transport code names no tool and imports no endpoint family.

`tests/transport/serving-process.test.ts` drives the built executable, `dist/cli.js`, over raw stdio:
- A legacy session negotiates `2025-11-25`, lists 133 tools, and returns an `INVALID_ARGUMENT` tool error for a bad argument.
- The executable answers `resources/list` and `prompts/list` with `-32601`, and a malformed `tools/call` or an unknown tool with `-32602`.
- An id-bearing invalid message gets no reply.
- A call that succeeds and one that TestRail fails each log one `tool_call` event, and neither call's argument appears anywhere on stderr.
- The executable exits 0 on stdin closure, and every stdout line, read after the streams close, is a JSON-RPC message.
- The discover-then-initialize session is described above.

`tests/transport/cancellation.test.ts` sends `notifications/cancelled` from a real client, in both eras, for registered tools that have already reached TestRail. The handler's signal aborts and the call ends `CANCELLED`, a write with `write_outcome: "unknown"`. The SDK then suppresses the response, so the client gets nothing for that id: neither the result nor the upstream reply that arrives later. The slot stays owned until that reply settles. The late reply raises no unhandled rejection, and the connection keeps serving.

Because nothing is written back, the test wraps the pipeline to read the result that the handler produced. Two mutations each fail the test: not passing the handler's signal, and never recording dispatch.

`tests/transport/tool-call.test.ts` covers the pipeline directly with synthetic download and upload operations. These rules apply:
- A caller's identifier survives unchanged, whether it is a number or a UUID.
- A call refused at admission never asks for the staging area.
- A cancelled upload keeps its copy until its request settles.

`tests/transport/upload-staging.test.ts` shows staging inside the slot through a registered upload:
- The watchdog ends the wait during a paused copy. The copy then stops before its next chunk and sends nothing.
- When a caller cancels as the copy finishes, the pipeline returns `CANCELLED` with `not_started`, and nothing is sent.

`tests/transport/diagnostic-events.test.ts` runs the composition root in-process through one lifetime. The run has these steps:
- It recovers an abandoned staging directory.
- It reports two transport errors, one named `SyntaxError` and one whose name is a URL.
- It shuts down.

The events must be exactly these, in this order and with no other field:
- `staging_recovered` with `removed: 1`;
- `server_started` with the tool count;
- `transport_error` with `SyntaxError` and then `Error`;
- `server_stopping`;
- `server_stopped`.

A table keyed by every event code lists each event's fields. Thus, a new event code does not typecheck until it is added, and the test then requires it to be seen. No stderr write may contain any of these items:
- the temporary or download directory, in either spelling;
- the name of the staging directory;
- the configured host, email or key;
- the key, host or path that the messages of the reported errors carry.

`tests/transport/handler-failure.test.ts` makes the pipeline reject, through a real client, and requires the `INTERNAL_ERROR` envelope and one `tool_call` line instead of the raw message.

The suites are mutation-checked. Each mutation below fails the tests that the item names:
- Routing diagnostics to stdout fails the lifecycle test and the package check.
- Each of these mutations fails the package check:
  - a stray stdout line, with or without a final newline;
  - a final line that is JSON but not a complete JSON-RPC message;
  - a dropped tool;
  - a diagnostic that carries the API key, the Basic credential or the TestRail address;
  - diagnostics written as Node warnings;
  - a non-event JSON value on stderr;
  - a server that stops serving after an unknown tool while listings could be cached;
  - an unknown tool that is never answered;
  - a server that exits during a call;
  - a server that ignores stdin closure.
- Advertising the Zod schema instead of the reviewed document fails both the discovery and argument-rejection tests.
- Each of these mutations fails a tool-call test:
  - coercing a non-numeric attachment id;
  - dropping the settlement cleanup that disposes a staged copy;
  - disposing it while a cancelled upload still reads it;
  - staging before admission;
  - reading a nested `file` object instead of the reserved flat inputs.
- Each of these mutations fails the diagnostic-events test:
  - the download directory's path in `server_stopping` or `staging_recovered`;
  - an extra field in `server_started`;
  - a transport error's name logged unchecked;
  - a transport error's message logged in place of an unusable name.

  The first three of these mutations pass every other transport, CLI and result-contract test.
- Removing the server's guard for a rejected pipeline, or its diagnostic, fails the handler-failure test.
- A line of text, a blank line, or a response with no id, written to stdout only when `SIGINT` or `SIGTERM` arrives, passes every other test. It fails the four signal cases of the lifecycle test on their protocol-only check.
- Building a driver and runtime in each factory call fails the composition test's shared budget and shutdown cases, and the lifecycle drain cases.
- Building one per era, through the era that `serveStdio` passes the factory, fails only the composition test's case with a legacy and a 2026-07-28 consumer.

## Two corrections review found here

Both were real and neither would have surfaced until an endpoint family was added.

**Identifiers were coerced.** TestRail accepts a positive integer **or a UUID** for an attachment id. The driver's own signature is `getAttachment(attachmentId: number | string)`. The download branch collapsed anything non-numeric to `0`. That collapse would have labelled every UUID download with a placeholder. It would also have broken any caller that matches a batch of downloads back to what it requested.

The validated value now passes through untouched. An operation registered without an identifier raises an internal error rather than inventing one.

**Staged uploads leaked on refusal.** The runtime rejects `BUSY` and pre-dispatch cancellation *before* it creates the slot that runs cleanup. Thus, a call refused at admission left its staged copy in the staging directory for the life of the process.

The catch now disposes it, but only for a call that never entered the driver. Once the call is dispatched, the runtime's settlement cleanup disposes the copy instead, because a cancelled or timed-out upload may still be reading the copy into its request. Disposing the copy from the catch would fail that request part-way. F07's closing work later removed that catch disposal. Staging now runs inside the slot, so a call refused at admission has staged nothing, and settlement cleanup is the copy's only disposer.

A third fault surfaced while writing the test for the second. The reserved upload inputs are **flat**: `file_path`, `filename` and `content_type`. The pipeline was reading a nested `file` object that it had invented. That object would never have matched a real registered upload, so staging would silently never have happened. The registry's own layout check caught the fault.

## Not in this layer

Endpoint registrations (T01–T12) and their parameter manifests are not in this layer. The protocol and tool-call suites above use a synthetic operation. The serving and cancellation suites use the production catalog.
