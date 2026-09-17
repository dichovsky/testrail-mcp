import { TestRailClient } from '@dichovsky/testrail-api-client';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_LIMITS } from '../src/config/limits.js';
import { RuntimeError } from '../src/runtime/errors.js';
import { createRuntime, type Delay } from '../src/runtime/invocation.js';

/** A fetch whose every call is held open until the test releases it, and counted. */
function gatedFetch() {
  const releases: (() => void)[] = [];
  let calls = 0;
  const fetch = (async () => {
    calls += 1;
    await new Promise<void>((resolve) => releases.push(resolve));
    return new Response(JSON.stringify({ id: 1, name: 'Project' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof globalThis.fetch;
  return {
    fetch,
    get calls() { return calls; },
    releaseAll() { for (const release of releases.splice(0)) release(); },
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

    // The aggregate deadline rejects while its fetch is still in flight.
    const outcomes = await Promise.allSettled(Array.from({ length: 4 }, () =>
      runtime.invoke((instance) => instance.projects.getAllProjects({ maxDurationMs: 50 }))));
    for (const outcome of outcomes) {
      expect(outcome.status).toBe('rejected');
      // Either deadline mechanism is correct here; see driver-qualification.test.ts.
      expect(String((outcome as PromiseRejectedResult).reason)).toMatch(/maxDurationMs|deadline exceeded/iu);
    }

    // Rejected results, but the descendants are still running: the slots stay taken.
    expect(runtime.stats().active).toBe(4);
    await expect(runtime.invoke((instance) => instance.projects.getProject(1)))
      .rejects.toMatchObject({ code: 'BUSY' });
    const beforeRelease = upstream.calls;

    upstream.releaseAll();
    await waitFor(() => runtime.stats().active === 0, 'slots released');
    // Only now does a new call get in, and only now is new upstream work started.
    const next = runtime.invoke((instance) => instance.projects.getProject(1));
    await settle();
    expect(upstream.calls).toBe(beforeRelease + 1);
    upstream.releaseAll();
    await next;
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

    // Cancellation does not stop upstream work, so the slot is still owned.
    expect(runtime.stats().active).toBe(1);
    upstream.releaseAll();
    await waitFor(() => runtime.stats().active === 0, 'slots released');
    await runtime.shutdown();
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

    const call = runtime.invoke((instance) => instance.projects.getProject(1), { cleanup });
    await waitFor(() => upstream.calls === 1, 'the dispatched request');
    upstream.releaseAll();
    await expect(call).resolves.toMatchObject({ id: 1 });
    await waitFor(() => runtime.stats().active === 0, 'the slot released despite the fault');
    await runtime.shutdown();
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
});
