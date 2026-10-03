import { getEventListeners } from 'node:events';
import { TestRailClient } from '@dichovsky/testrail-api-client';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_LIMITS } from '../src/config/limits.js';
import { RuntimeError } from '../src/runtime/errors.js';
import { createRuntime, type Delay } from '../src/runtime/invocation.js';

/** A fetch whose every call is held open until the test releases or fails it, and counted. */
function gatedFetch() {
  const held: { resolve: () => void; reject: (error: Error) => void }[] = [];
  let calls = 0;
  const fetch = (async () => {
    calls += 1;
    await new Promise<void>((resolve, reject) => held.push({ resolve, reject }));
    return new Response(JSON.stringify({ id: 1, name: 'Project' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof globalThis.fetch;
  return {
    fetch,
    get calls() { return calls; },
    releaseAll() { for (const request of held.splice(0)) request.resolve(); },
    failAll(error: Error) { for (const request of held.splice(0)) request.reject(error); },
  };
}

function client(fetch: typeof globalThis.fetch): TestRailClient {
  return new TestRailClient({
    baseUrl: 'https://runtime.testrail.io', email: 'user@example.com', apiKey: 'synthetic',
    fetch, registerProcessHandlers: false, maxRetries: 0,
    // Inject DNS: a fake hostname must not make these tests wait on a real resolver.
    dnsLookup: () => Promise.resolve([{ address: '203.0.113.10', family: 4 }]),
  });
}

/** A watchdog the test fires by hand, so no suite waits 60 seconds. */
function manualDelay() {
  const pending: { ms: number; fire: () => void; cancelled: boolean }[] = [];
  const delay = (ms: number): Delay => {
    const entry = { ms, fire: () => undefined as void, cancelled: false };
    const promise = new Promise<void>((resolve) => { entry.fire = resolve; });
    pending.push(entry);
    return { promise, cancel: () => { entry.cancelled = true; } };
  };
  return { delay, fireAll: () => { for (const entry of pending) if (!entry.cancelled) entry.fire(); }, pending };
}

async function settle(ms = 20): Promise<void> {
  await new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * Wait for a state to be reached rather than for a fixed duration. A timed sleep that
 * is long enough on Linux is not necessarily long enough on a loaded Windows runner.
 * Only assertions that something has *not* happened still use a fixed wait.
 */
async function waitFor(condition: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => { setTimeout(resolve, 5); });
  }
}

describe('runtime admission and invocation', () => {
  it('fills every slot, refuses the next call as BUSY and issues no request for it', async () => {
    const upstream = gatedFetch();
    const runtime = createRuntime({ client: client(upstream.fetch), limits: DEFAULT_LIMITS });

    const inflight = Array.from({ length: DEFAULT_LIMITS.max_active_calls }, (_unused, index) =>
      runtime.invoke((instance) => instance.projects.getProject(index + 1)));
    await waitFor(() => upstream.calls === 4, 'four dispatched requests');
    expect(runtime.stats().active).toBe(4);

    await expect(runtime.invoke((instance) => instance.projects.getProject(1)))
      .rejects.toMatchObject({ code: 'BUSY' });
    // The refused call must not have reached the driver at all.
    expect(upstream.calls).toBe(4);

    upstream.releaseAll();
    await Promise.all(inflight);
    await waitFor(() => runtime.stats().active === 0, 'slots released');
    await runtime.shutdown();
  });

  it('owns one slot per caller even when the driver coalesces them into one request', async () => {
    const upstream = gatedFetch();
    const runtime = createRuntime({ client: client(upstream.fetch), limits: DEFAULT_LIMITS });

    // Caching is disabled, but the driver still joins identical in-flight GETs.
    const coalesced = Array.from({ length: 4 }, () => runtime.invoke((instance) => instance.projects.getProject(7)));
    await waitFor(() => upstream.calls > 0, 'the coalesced request');
    await settle();
    expect(upstream.calls).toBe(1);
    // Capacity counts owned invocation scopes, not network primitives, so all four are held.
    expect(runtime.stats().active).toBe(4);
    await expect(runtime.invoke((instance) => instance.projects.getProject(8)))
      .rejects.toMatchObject({ code: 'BUSY' });

    upstream.releaseAll();
    await Promise.all(coalesced);
    await waitFor(() => runtime.stats().active === 0, 'slots released');
    await runtime.shutdown();
  });

  it('holds capacity after an aggregate rejects at its own deadline, until descendants settle', async () => {
    const upstream = gatedFetch();
    const runtime = createRuntime({ client: client(upstream.fetch), limits: DEFAULT_LIMITS });

    // The aggregate deadline rejects while its fetch is still in flight. The budget is
    // real time and long enough for all four requests to reach fetch on a slow runner;
    // with a budget spent before dispatch, an aggregate holds no descendant at all.
    const outcomes = await Promise.allSettled(Array.from({ length: 4 }, () =>
      runtime.invoke((instance) => instance.projects.getAllProjects({ maxDurationMs: 1_000 }))));
    for (const outcome of outcomes) {
      expect(outcome.status).toBe('rejected');
      // Either deadline mechanism is correct here; see driver-qualification.test.ts.
      expect(String((outcome as PromiseRejectedResult).reason)).toMatch(/maxDurationMs|deadline exceeded/iu);
    }
    // Checked first, so a budget spent before dispatch shows up as a missing request
    // rather than as a slot that looks released early.
    expect(upstream.calls).toBe(4);

    // Rejected results, but the descendants are still running: the slots stay taken.
    // Paused first, so a slot released just after its caller was answered would show.
    await settle();
    expect(runtime.stats().active).toBe(4);
    await expect(runtime.invoke((instance) => instance.projects.getProject(1)))
      .rejects.toMatchObject({ code: 'BUSY' });
    expect(upstream.calls).toBe(4);

    upstream.releaseAll();
    await waitFor(() => runtime.stats().active === 0, 'slots released');
    // Only now does a new call get in, and only now is new upstream work started.
    const next = runtime.invoke((instance) => instance.projects.getProject(1));
    await waitFor(() => upstream.calls === 5, 'the next request');
    upstream.releaseAll();
    await next;
    await runtime.shutdown();
  });

  it('runs adapter cleanup only after settlement, not when an aggregate rejects at its own deadline', async () => {
    const upstream = gatedFetch();
    const runtime = createRuntime({ client: client(upstream.fetch), limits: DEFAULT_LIMITS });
    // Stands in for disposing a staged upload: it must not run while the request that
    // may still be reading the file is in flight.
    const cleanup = vi.fn(() => Promise.resolve());
    // A budget long enough for the request to reach fetch on a slow runner, as above.
    await expect(runtime.invoke((instance) => instance.projects.getAllProjects({ maxDurationMs: 1_000 }), { cleanup }))
      .rejects.toThrow(/maxDurationMs|deadline exceeded/iu);
    // Checked first, so a budget spent before dispatch shows up as a missing request
    // rather than as cleanup that ran early.
    expect(upstream.calls).toBe(1);
    await settle(30);
    expect(cleanup).not.toHaveBeenCalled();
    expect(runtime.stats().active).toBe(1);
    upstream.releaseAll();
    await waitFor(() => runtime.stats().active === 0, 'slot released');
    expect(cleanup).toHaveBeenCalledTimes(1);
    await runtime.shutdown();
  });

  it('reports TIMEOUT when the response wait expires but keeps the slot until settlement', async () => {
    const upstream = gatedFetch();
    const watchdog = manualDelay();
    const runtime = createRuntime({
      client: client(upstream.fetch), limits: DEFAULT_LIMITS, delay: watchdog.delay,
    });

    const call = runtime.invoke((instance) => instance.projects.getProject(1));
    await waitFor(() => upstream.calls === 1, 'the dispatched request');
    // Pin the budget itself, not just that some timer fires.
    expect(watchdog.pending[0]?.ms).toBe(60_000);
    watchdog.fireAll();
    await expect(call).rejects.toMatchObject({ code: 'TIMEOUT' });

    // A watchdog rejection is an adapter-side giving-up, not evidence upstream stopped.
    // Paused first, so a slot released just after the caller was answered would show.
    await settle();
    expect(runtime.stats().active).toBe(1);

    upstream.releaseAll();
    await waitFor(() => runtime.stats().active === 0, 'slots released');
    await runtime.shutdown();
  });

  it('rejects a pre-aborted call as CANCELLED without dispatching it', async () => {
    const upstream = gatedFetch();
    const runtime = createRuntime({ client: client(upstream.fetch), limits: DEFAULT_LIMITS });

    await expect(runtime.invoke((instance) => instance.projects.getProject(1), { signal: AbortSignal.abort() }))
      .rejects.toMatchObject({ code: 'CANCELLED' });
    expect(upstream.calls).toBe(0);
    expect(runtime.stats().active).toBe(0);
    await runtime.shutdown();
  });

  it('keeps the slot after a mid-flight cancellation and observes the late result', async () => {
    const upstream = gatedFetch();
    const runtime = createRuntime({ client: client(upstream.fetch), limits: DEFAULT_LIMITS });
    const controller = new AbortController();

    const call = runtime.invoke((instance) => instance.projects.getProject(1), { signal: controller.signal });
    await waitFor(() => upstream.calls === 1, 'the dispatched request');
    controller.abort();
    await expect(call).rejects.toMatchObject({ code: 'CANCELLED' });

    // Cancellation does not stop upstream work, so the slot is still owned. Paused
    // first, so a slot released just after the caller was answered would show.
    await settle();
    expect(runtime.stats().active).toBe(1);
    upstream.releaseAll();
    await waitFor(() => runtime.stats().active === 0, 'slots released');
    await runtime.shutdown();
  });

  it.each(['watchdog', 'cancellation'] as const)(
    'observes a result that rejects after the %s has answered the caller',
    async (answeredBy) => {
      const upstream = gatedFetch();
      const watchdog = manualDelay();
      const runtime = createRuntime({ client: client(upstream.fetch), limits: DEFAULT_LIMITS, delay: watchdog.delay });
      const controller = new AbortController();
      const unhandled = vi.fn();
      process.on('unhandledRejection', unhandled);
      try {
        const call = runtime.invoke((instance) => instance.projects.getProject(1), { signal: controller.signal });
        await waitFor(() => upstream.calls === 1, 'the dispatched request');
        if (answeredBy === 'watchdog') watchdog.fireAll();
        else controller.abort();
        await expect(call).rejects.toMatchObject({ code: answeredBy === 'watchdog' ? 'TIMEOUT' : 'CANCELLED' });
        // Paused first, so a slot released just after the caller was answered would show.
        await settle();
        expect(runtime.stats().active).toBe(1);

        // The request fails only now, so the driver's result rejects with no caller left
        // waiting for it. Under Node's default that rejection, left unobserved, would end
        // the server.
        upstream.failAll(new TypeError('socket hang up'));
        await waitFor(() => runtime.stats().active === 0, 'the slot released by the late failure');
        await settle();
        expect(unhandled).not.toHaveBeenCalled();
      } finally {
        process.off('unhandledRejection', unhandled);
        upstream.releaseAll();
        await runtime.shutdown();
      }
    },
  );

  it.each<[string, (fetch: typeof globalThis.fetch) => TestRailClient, (target: TestRailClient) => Promise<unknown>, RegExp]>([
    [
      'a call that rejects at once',
      client,
      () => Promise.reject(new Error('rejected before any I/O')),
      /rejected before any I\/O/u,
    ],
    [
      // The driver checks its arguments before it starts a request.
      'the driver refusing an argument',
      client,
      (target) => target.projects.getProject(0),
      /projectId must be a positive integer/u,
    ],
    [
      // A failure further into the driver's request pipeline, before any fetch.
      'a DNS lookup that fails at once',
      (fetch) => new TestRailClient({
        baseUrl: 'https://runtime.testrail.io', email: 'user@example.com', apiKey: 'synthetic',
        fetch, registerProcessHandlers: false, maxRetries: 0,
        dnsLookup: () => Promise.reject(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' })),
      }),
      (target) => target.projects.getProject(1),
      /DNS validation failed/u,
    ],
  ])('observes a result that rejects before the event loop turns: %s', async (_source, instance, call, error) => {
    // The race is the result's only observer, and it subscribes in the turn that
    // started the operation. Had invoke yielded to the event loop first, this
    // rejection would be reported as unhandled before the race subscribed, which
    // under Node's default ends the server.
    const upstream = gatedFetch();
    const runtime = createRuntime({ client: instance(upstream.fetch), limits: DEFAULT_LIMITS });
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      await expect(runtime.invoke(call)).rejects.toThrow(error);
      expect(upstream.calls).toBe(0);
      await waitFor(() => runtime.stats().active === 0, 'the slot released by the failure');
      await settle();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
      await runtime.shutdown();
    }
  });

  it('reserves the single download slot independently of general capacity', async () => {
    const upstream = gatedFetch();
    const runtime = createRuntime({ client: client(upstream.fetch), limits: DEFAULT_LIMITS });

    const download = runtime.invoke((instance) => instance.projects.getProject(1), { binary: true });
    await waitFor(() => upstream.calls === 1, 'the download request');
    expect(runtime.stats().binary).toBe(1);

    // Three general slots remain, but the one download slot is taken.
    await expect(runtime.invoke((instance) => instance.projects.getProject(1), { binary: true }))
      .rejects.toMatchObject({ code: 'BUSY' });
    const ordinary = runtime.invoke((instance) => instance.projects.getProject(2));
    await waitFor(() => upstream.calls === 2, 'the ordinary request');
    expect(runtime.stats().active).toBe(2);
    // The ordinary call must not have consumed the download slot.
    expect(runtime.stats().binary).toBe(1);

    upstream.releaseAll();
    await Promise.all([download, ordinary]);
    await waitFor(() => runtime.stats().binary === 0, 'download slot released');
    await runtime.shutdown();
  });

  it('holds the slot until adapter-owned cleanup finishes, not merely until settlement', async () => {
    const upstream = gatedFetch();
    const runtime = createRuntime({ client: client(upstream.fetch), limits: DEFAULT_LIMITS });
    let finishCleanup: () => void = () => undefined;
    const cleanup = () => new Promise<void>((resolve) => { finishCleanup = resolve; });

    const call = runtime.invoke((instance) => instance.projects.getProject(1), { cleanup });
    await waitFor(() => upstream.calls === 1, 'the dispatched request');
    upstream.releaseAll();
    await call;
    await settle(30);

    // The driver has settled, but local file work still owns the slot.
    expect(runtime.stats().active).toBe(1);
    finishCleanup();
    await waitFor(() => runtime.stats().active === 0, 'slots released');
    await runtime.shutdown();
  });

  it('survives an adapter cleanup that throws synchronously', async () => {
    const upstream = gatedFetch();
    const runtime = createRuntime({ client: client(upstream.fetch), limits: DEFAULT_LIMITS });
    // Declared as returning a promise but written without async, which is assignable.
    // The throw happens before any returned promise exists, so a .catch on the return
    // value would never see it and the rejection would take the process down.
    const cleanup = (): Promise<void> => { throw new Error('staged file is locked'); };
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const call = runtime.invoke((instance) => instance.projects.getProject(1), { cleanup });
      await waitFor(() => upstream.calls === 1, 'the dispatched request');
      upstream.releaseAll();
      await expect(call).resolves.toMatchObject({ id: 1 });
      await waitFor(() => runtime.stats().active === 0, 'the slot released despite the fault');
      // The slot observed the fault: it did not reach the process as an unhandled
      // rejection, which would otherwise fail only the run and name no test.
      await settle();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
      await runtime.shutdown();
    }
  });

  it('stops admission on shutdown and destroys the shared client exactly once', async () => {
    const upstream = gatedFetch();
    const instance = client(upstream.fetch);
    const destroy = vi.spyOn(instance, 'destroy');
    const runtime = createRuntime({ client: instance, limits: DEFAULT_LIMITS });

    await runtime.shutdown();
    expect(runtime.stats().accepting).toBe(false);
    await expect(runtime.invoke((target) => target.projects.getProject(1)))
      .rejects.toMatchObject({ code: 'BUSY' });
    expect(upstream.calls).toBe(0);

    // A second protocol consumer shutting down must not tear the client down twice.
    await runtime.shutdown();
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('gives up draining after the fixed window rather than hanging on a stuck call', async () => {
    const upstream = gatedFetch();
    const drain = manualDelay();
    const instance = client(upstream.fetch);
    const destroy = vi.spyOn(instance, 'destroy');
    const runtime = createRuntime({ client: instance, limits: DEFAULT_LIMITS, delay: drain.delay });

    const stuck = runtime.invoke((target) => target.projects.getProject(1))
      .then(() => undefined, (error: unknown) => error);
    await waitFor(() => upstream.calls === 1, 'the stuck request');
    const shutdown = runtime.shutdown();
    // The call's watchdog is pending; wait for shutdown to register the drain as well.
    await waitFor(() => drain.pending.length >= 2, 'the drain window');
    expect(drain.pending[1]?.ms).toBe(5_000);
    drain.fireAll(); // shutdown proceeds on the drain window rather than the stuck call
    await shutdown;
    expect(destroy).toHaveBeenCalledTimes(1);

    upstream.releaseAll();
    expect(await stuck).toBeInstanceOf(RuntimeError);
    await settle(30);
  });

  it('stops admission before draining, and destroys only after in-flight work settles', async () => {
    const upstream = gatedFetch();
    const drain = manualDelay();
    const instance = client(upstream.fetch);
    const destroy = vi.spyOn(instance, 'destroy');
    const runtime = createRuntime({ client: instance, limits: DEFAULT_LIMITS, delay: drain.delay });

    const inflight = runtime.invoke((target) => target.projects.getProject(1));
    await waitFor(() => upstream.calls === 1, 'the in-flight request');
    const shutdown = runtime.shutdown();

    // Admission is already closed while the drain is still waiting.
    expect(runtime.stats().accepting).toBe(false);
    await expect(runtime.invoke((target) => target.projects.getProject(2))).rejects.toMatchObject({ code: 'BUSY' });
    expect(upstream.calls).toBe(1);
    await settle();
    // The drain waits for the call; it does not destroy the client under it.
    expect(destroy).not.toHaveBeenCalled();

    upstream.releaseAll();
    await expect(inflight).resolves.toMatchObject({ id: 1 });
    await shutdown;
    expect(destroy).toHaveBeenCalledTimes(1);
    // It finished on the call settling, not on the drain window expiring.
    expect(drain.pending.find(({ ms }) => ms === 5_000)?.cancelled).toBe(true);
  });

  it('leaves no timer, listener or retained slot behind across many calls of every outcome', async () => {
    const upstream = gatedFetch();
    const timers = manualDelay();
    const runtime = createRuntime({ client: client(upstream.fetch), limits: DEFAULT_LIMITS, delay: timers.delay });
    const signals: AbortSignal[] = [];
    const signal = () => { const controller = new AbortController(); signals.push(controller.signal); return controller; };

    for (let round = 0; round < 10; round += 1) {
      // Success.
      const ok = runtime.invoke((target) => target.projects.getProject(1), { signal: signal().signal });
      await waitFor(() => upstream.calls === round * 3 + 1, 'the successful request');
      upstream.releaseAll();
      await ok;
      // Watchdog expiry, then late settlement.
      const late = runtime.invoke((target) => target.projects.getProject(2), { signal: signal().signal });
      await waitFor(() => upstream.calls === round * 3 + 2, 'the timed-out request');
      timers.fireAll();
      await expect(late).rejects.toMatchObject({ code: 'TIMEOUT' });
      upstream.releaseAll();
      // Mid-flight cancellation, then late settlement.
      const controller = signal();
      const cancelled = runtime.invoke((target) => target.projects.getProject(3), { signal: controller.signal });
      await waitFor(() => upstream.calls === round * 3 + 3, 'the cancelled request');
      controller.abort();
      await expect(cancelled).rejects.toMatchObject({ code: 'CANCELLED' });
      upstream.releaseAll();
      // Refused before dispatch.
      await expect(runtime.invoke((target) => target.projects.getProject(4), { signal: AbortSignal.abort() }))
        .rejects.toMatchObject({ code: 'CANCELLED' });
      await waitFor(() => runtime.stats().active === 0, 'every slot released');
    }

    // One 60-second watchdog per dispatched call, and every one cleared once its call
    // answered, fired or not: none is left armed to hold a timer for a minute.
    expect(timers.pending.map(({ ms, cancelled }) => ({ ms, cancelled })))
      .toEqual(Array.from({ length: 30 }, () => ({ ms: 60_000, cancelled: true })));
    // No call left its abort listener on the caller's signal.
    expect(signals.map((entry) => getEventListeners(entry, 'abort').length)).toEqual(signals.map(() => 0));
    // With nothing retained, shutdown has nothing to drain and arms no drain window.
    const before = timers.pending.length;
    await runtime.shutdown();
    expect(timers.pending.slice(before)).toEqual([]);
  });
});
