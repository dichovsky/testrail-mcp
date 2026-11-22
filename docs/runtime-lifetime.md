# Invocation lifetime

`src/execution/executor.ts` owns ordinary calls and Attachment transfers through `execute(operation, input, options)` and shared, idempotent `shutdown()`. Its async `createOperationExecutor` recovers abandoned staging, constructs the configured driver and assembles one runtime per process. `src/runtime/invocation.ts` implements admission, capacity accounting and settlement behind that owner. `src/transport/server.ts` (F08) reuses the executor across protocol instances and owns protocol closure, signal handling, stdout flushing and process exit.

## Capacity follows settlement, never the result

The runtime releases a slot when the driver's `settled` signal fires and any adapter-owned cleanup has finished. The runtime never releases a slot when the caller's `result` settles. The two are genuinely different moments. An aggregate rejects at its own `maxDurationMs` while its fetch is still in flight. The adapter's response-wait watchdog rejects independently of both. Releasing on `result` would let the next call begin work the previous one has not finished. The slot limit exists precisely to prevent this early start.

Thus, F01 had to deliver `trackOperation`. Without an observable settlement signal there is no correct moment to release a slot, only a guess.

## Admission

Admission decides before anything is dispatched, so a refused call issues no upstream request at all. There is no queue. Admission refuses excess load with `BUSY` rather than buffering it. The default limit is four active tool executions, with one binary download reserved inside that count. The runtime takes the download slot before it issues the request.

Capacity counts **owned invocation scopes, not network requests**. The driver joins identical in-flight GETs even with caching disabled. Thus, four concurrent identical reads can share one upstream request while still holding four slots. This behavior is intended. The limit bounds what the adapter owns and must wait for, not how many sockets are open.

## Cancellation and the watchdog

Before dispatch, an aborted call starts no upstream request and returns `CANCELLED`. After dispatch, cancellation stops adapter-side waiting and discards the delivery. It does not stop upstream work, because the driver exposes no per-request abort. Thus, the slot stays owned until real settlement. A late result is observed rather than surfaced or left unhandled.

The race that answers the caller subscribes to the driver's result in the same synchronous step that starts the operation. Thus, a result that rejects after the watchdog or a cancellation has answered already has an observer. That race is its only observer, so nothing between starting the operation and the race may yield or throw.

`tests/runtime-invocation.test.ts` has the case "observes a result that rejects after the watchdog has answered the caller", and the same case for a cancellation. Each case fails the request only after the caller has its answer. Each case requires no unhandled rejection and the slot held until that failure settles the operation. The "observes a result that rejects before the event loop turns" cases in that file hold the yield half of the rule. These three cases each reject before any request is sent:

- a call that rejects at once;
- the driver refusing an argument;
- an injected DNS lookup that fails at once.

Each case requires the caller to get the error and no unhandled rejection. Thus, a yield to the event loop before the race fails them by name.

The response-wait watchdog is a fixed 60 seconds. It bounds how long the adapter waits, and reports `TIMEOUT`. It does not abort upstream work and must never be described as a hard deadline.

The watchdog and the driver's aggregate deadline differ in one way that matters for capacity. The driver never learns that the adapter stopped waiting. Thus, a DNS lookup answered after the watchdog still goes on to send its request, and the slot covers that request too. The aggregate deadline is the driver's own, so a lookup answered after it starts nothing. Either way the slot is held until the last of that work settles. The aggregate deadline reaches the caller as `PAGINATION_LIMIT` with reason `max_duration`, never as `TIMEOUT`. [Results and errors](results-and-errors.md) explains the driver timeouts that are recognized as the same bound.

Slow or hung requests can therefore hold all four slots until they settle or the process restarts. Every further call is refused with `BUSY` and sends nothing in the meantime. This trade is intended. The alternative is starting work that the process cannot account for.

A slot release must never be able to fail. Adapter cleanup is declared as returning a promise. However, a function written without `async` is still assignable and can throw before any promise exists. Thus, a `.catch` on its return value would not see that throw.

The code wraps the whole release body instead. Thus, a cleanup fault is observed and discarded rather than escaping as an unhandled rejection. Under Node's default, an unhandled rejection would terminate the server. `settled` never rejects by the driver's contract, so the wrapper guards cleanup faults and a breach of that contract, not late descendant failures.

By the driver's `trackOperation` contract, its operation scope observes each piece of work it registers, including one that fails after the result has settled. The caller's race above observes a late rejection of the result itself. The case "survives an adapter cleanup that throws synchronously" in `tests/runtime-invocation.test.ts` requires the slot to be released and no unhandled rejection. Thus, a fault that escapes fails that test by name rather than only failing the run.

## Shutdown

Transport closes protocol intake first and propagates cancellation to active callers. Transport then calls the executor's shutdown. The executor does these steps:

- It stops admission.
- It waits for outstanding work up to the fixed 5-second drain window.
- It destroys the client exactly once.
- It disposes staging using only the remaining time.

Every protocol consumer shares this executor, so shutdown ends admission for all of them. Repeated calls share the same shutdown promise. Closing one connection alone does not shut the executor down. Another connection keeps being served.

A call still stuck when the drain expires is abandoned. The adapter stops waiting for it without claiming the upstream work stopped. That work can still hold driver timers, such as the 15-second request timeout. Such timers would keep the process alive after shutdown.

Staging creation and removal share the drain's five-second window. Removal starts after the runtime has drained or reached its deadline and destroyed the client. Removal may use only the time remaining in that window. A stalled temporary filesystem cannot extend shutdown indefinitely.

Cleanup promises remain observed after the deadline. The server still attempts removal of an area created late if the process is running. A late failure cannot become an unhandled rejection. Shutdown never truncates a copy that an upload may still be reading. A marked staging directory left behind can be recovered on the next start once its owner has exited.

The composition root exits 250 ms after shutdown completes and stdout has flushed. It uses an unreferenced timer, so a process with nothing left running exits by itself first. Waiting for stdout matters. `process.exit` drops whatever stdout still holds. Otherwise, a host that closed stdin and reads its last responses late would get a truncated line.

A host that never reads keeps the process alive until it reads or closes the pipe. With a request hung upstream and stdout draining, the process exits about 5.3 seconds after stdin closes or `SIGINT` or `SIGTERM` arrives.

The signal handlers stay installed for the whole shutdown. Thus, a second signal waits for the same shutdown instead of killing the process before the client is destroyed. Transport absorbs a connection-close failure. The executor absorbs driver-destruction and staging-disposal failures. Thus, an initialized staging area is still disposed when destruction throws. The stop is still logged and the exit is still scheduled.

A failed attempt to create the staging area is forgotten, so the next upload tries again instead of inheriting the failure. Concurrent uploads share an in-flight staging creation.

A download writes its file inside the tracked operation, so the drain waits for the write. A reply arriving after shutdown has closed the connection writes nothing. A write that has already started when the five-second drain expires can be cut short by the exit that follows. The cut can leave a partial file in the download directory. Nothing is reported as downloaded in that case. Completed downloads are retained.

## Verification

`tests/executor-lifetime.test.ts` exercises shutdown directly through the executor interface. It requires these results:

- concurrent and later shutdown callers receive the same promise;
- one drain remains pending until owned work settles;
- immediate admission refusal without a request;
- one driver destruction;
- no retained slot or timer afterward.

`tests/transport/composition-staging.test.ts` holds staging creation and area disposal pending on a fake clock. Shutdown must remain pending before the five-second deadline and finish at that deadline without waiting for either filesystem operation. Creation that resolves later is disposed without sending an upload, and late creation or disposal rejections stay handled. The tests also require the shutdown event and no timer left behind.

The initialized-area regression requires real directory removal even when driver destruction throws, one destruction/disposal and one stop pair across repeated shutdown calls. The remaining-budget cases consume two seconds draining an ordinary call. Then they allow hanging staging disposal only the remaining three seconds, with destruction both succeeding and throwing. A late disposal rejection must remain observed.

These regressions passed locally on 2026-11-21. The [refactoring plan](architecture-refactoring.md#operation-executor) records the full check, coverage, package, catalog-comparison and mutation results. Both fresh independent reviews are complete. The test-review finding was fixed and rechecked.

`tests/runtime-invocation.test.ts` drives the real driver with an injected fetch and DNS. Its central invariants were mutation-checked. Each of these mutations fails at least one test here:

- releasing capacity on `result` instead of `settled`;
- ignoring adapter cleanup;
- permitting a second `destroy`.

Releasing on `result` and ignoring cleanup also fail tests in the pipeline suites below.

A yield to the event loop before the race fails the three "observes a result that rejects before the event loop turns" cases. It fails no other test in this file. The "still held" checks in this file, after the watchdog, a cancellation or an aggregate deadline, pause before they look. Thus, a slot released one timer tick after the caller is answered fails each of them.

The aggregates in this file get a one-second budget. The tests count the requests before they check a slot or a cleanup. Thus, a budget spent before dispatch appears as a missing request.

`tests/runtime-lifetime.test.ts` proves the same rules through the production registrations and the tool pipeline. Thus, a registration or pipeline stage that released capacity early would fail there even with the runtime intact. It fills all four slots with `testrail_get_project` held past the watchdog and with `testrail_get_projects` in all mode held past its own deadline. It shows that the next call is `BUSY` with no new request until real settlement. It covers these cases:

- DNS held past each deadline;
- a response body held mid-read past the watchdog;
- a body cancellation held past the aggregate deadline;
- four identical reads joined into one request;
- a `testrail_add_attachment_to_case` upload whose lookup outlives the watchdog, with its staged copy kept until the request has read it and settled.

Upload staging holds its slot too. `tests/transport/upload-staging.test.ts` pauses a copy, fires the watchdog, and shows the slot held until the copy has stopped, with nothing sent. No test waits for the 60-second watchdog. The tests fire it by hand. The aggregate budget is a few milliseconds, or one second where an aggregate must reach the network first.

`tests/runtime-invocation.test.ts` also holds shutdown's order and what the runtime leaves behind. Admission is closed while the drain is still waiting, and the client is destroyed only after in-flight work settles. Across ten rounds of success, watchdog expiry, mid-flight cancellation and pre-dispatch refusal, these results hold:

- every 60-second watchdog is cleared once its call answers;
- no abort listener stays on a caller's signal;
- nothing is retained for shutdown to drain.

`tests/runtime-lifetime.test.ts` fills all four slots with aggregates whose body cancellation is still pending. `tests/transport/cancellation.test.ts` cancels four dispatched calls in both protocol eras. Both suites require the next call to be `BUSY` without a request until real settlement.

`tests/runtime-timing.test.ts` distinguishes each timing budget on a fake clock. It uses the production driver options through the composition root's seam and the runtime's real 60-second watchdog timer:
- DNS counts against the 15-second request timeout, which starts before the lookup (driver 9.0.0). A resolver that never answers ends the call with `TIMEOUT` at 15 seconds, before any request. The call keeps its slot until the lookup settles, because a lookup cannot be cancelled.
- The body has its own 15 seconds from the arrival of the headers.
- Retry delays are 1, 2 and 4 seconds, and a `Retry-After` is honored up to its 10-second cap.
- The watchdog reports `TIMEOUT` at 60 seconds while the driver is still retrying, and the slot is released only when the driver stops retrying.

Each outcome is shown arriving at its own instant and not a millisecond before.

`tests/transport/composition.test.ts` runs `startServer` itself, with its test-only seams replacing only the driver's network and resolver and the stdio entry. It shows:
- startup and discovery make no request or lookup;
- two protocol consumers share one driver identity and one budget of four calls. This holds whether they negotiate the same era or one is legacy and the other 2026-07-28;
- one consumer disconnecting leaves the other served, and the driver is destroyed only at shutdown;
- concurrent shutdowns share one drain;
- a write pending at shutdown is recorded as `unknown` in the `tool_call` diagnostic, and its request failing during the drain leaves no unhandled rejection;
- a connection close that rejects neither fails the shutdown nor ends it early. The drain still waits for the call in flight, the driver is destroyed and the stop is logged. The test stubs that rejection, so it shows only that the composition root absorbs a rejecting close.

`tests/transport/lifecycle.test.ts` runs the built executable against a loopback TestRail that never answers. With a request in flight, the executable exits with code 0 within the drain window after stdin closure, `SIGINT` and `SIGTERM`. It logs one stop pair. It exits within 1.5 seconds of the `server_stopped` line. A second `SIGINT` or `SIGTERM` during the drain does not cut the shutdown short. After a staging failure, the next upload stages and is sent. Shutdown still exits 0 with nothing but JSON events on stderr.

Node cannot deliver a catchable signal to a child on Windows. `kill` terminates the child outright. The four signal tests therefore run on POSIX only. Stdin closure, the path stdio hosts use, runs on every platform. A host closes stdin with two catalog listings still unread. The host reads them three seconds later through a shell pipe. The host receives every response whole (skipped on Windows, which has no `sh`).

`tests/transport/composition.test.ts` holds the 250 ms grace on a fake clock. It shows that the grace does not start until stdout has flushed. It also shows that its timer never holds the process open by itself.

It was mutation-checked by these changes:

- releasing the slot as soon as the caller is answered (every capacity test fails);
- releasing on `result`;
- disposing a staged copy after dispatch;
- making a late lookup start a request after the aggregate deadline.

The first mutation exposed a flaw in the tests themselves. A "still held" assertion made in the same tick the caller is answered runs before an early release could. Thus, each assertion now pauses first. Review found two more such checks in the cancellation suite. A release deferred by one timer tick passed them. They pause too. That mutation now fails them. F07's closing work added three more mutations. Each fails an upload-staging test:

- staging before admission;
- dispatching an upload after its wait has ended;
- not passing the abandon signal to staging.
