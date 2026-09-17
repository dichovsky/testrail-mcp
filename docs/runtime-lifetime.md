# Invocation lifetime

`src/runtime/invocation.ts` implements F03's admission, capacity accounting and shutdown over the driver qualified by F01. It is not yet wired into CLI startup: F08 owns the composition root, signal handling and stderr diagnostics.

## Capacity follows settlement, never the result

A slot is released when the driver's `settled` signal fires and any adapter-owned cleanup has finished — never when the caller's `result` settles. The two are genuinely different moments. An aggregate rejects at its own `maxDurationMs` while its fetch is still in flight, and the adapter's response-wait watchdog rejects independently of both. Releasing on `result` would let the next call begin work the previous one has not finished, which is precisely what the slot limit exists to prevent.

This is why F01 had to deliver `trackOperation`. Without an observable settlement signal there is no correct moment to release a slot, only a guess.

## Admission

Admission decides before anything is dispatched, so a refused call issues no upstream request at all. There is no queue: excess load is refused with `BUSY` rather than buffered. The default limit is four active tool executions with one binary download reserved inside that count; the download slot is taken before the request is issued.

Capacity counts **owned invocation scopes, not network requests**. The driver joins identical in-flight GETs even with caching disabled, so four concurrent identical reads can share one upstream request while still holding four slots. That is intended: the limit bounds what the adapter owns and must wait for, not how many sockets are open.

## Cancellation and the watchdog

Before dispatch, an aborted call starts no upstream request and returns `CANCELLED`. After dispatch, cancellation stops adapter-side waiting and discards the delivery, but it does not stop upstream work — the driver exposes no per-request abort — so the slot stays owned until real settlement, and a late result is observed rather than surfaced or left unhandled.

The response-wait watchdog is a fixed 60 seconds. It bounds how long the adapter waits, and reports `TIMEOUT`. It does not abort upstream work and must never be described as a hard deadline.

A slot release must never be able to fail. Adapter cleanup is declared as returning a promise, but a function written without `async` is still assignable and can throw before any promise exists, so a `.catch` on its return value would not see it. The whole release body is wrapped instead: a late descendant failure or a cleanup fault is observed and discarded rather than escaping as an unhandled rejection, which under Node's default would terminate the server.

## Shutdown

Shutdown stops admission first, then waits for outstanding work up to the fixed 5-second drain window, then destroys the client exactly once. Destroy zeroes the shared credential, so a second protocol consumer calling shutdown must not tear down a client another one is still using. A call still stuck when the drain expires does not block exit; the adapter stops waiting for it without claiming the upstream work stopped.

## Verification

`tests/runtime-invocation.test.ts` drives the real driver with an injected fetch and DNS. Its central invariants were mutation-checked: releasing capacity on `result` instead of `settled`, ignoring adapter cleanup, and permitting a second `destroy` each fail exactly one test and no other.
