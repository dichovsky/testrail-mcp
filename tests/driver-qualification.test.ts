import { readFile } from 'node:fs/promises';
import { TestRailClient } from '@dichovsky/testrail-api-client';
import { describe, expect, it } from 'vitest';
import { parseInventory } from '../src/operations/parity.js';

/**
 * F01 gates, asserted against the installed published artifact rather than a sibling
 * checkout. A driver bump that loses any of these must fail here before it reaches the
 * runtime: the adapter's capacity accounting depends on observable settlement, and a
 * report tool must never be served a cached result or re-trigger generation on retry.
 */

const inventory = parseInventory(
  JSON.parse(await readFile(new URL('../docs/operation-inventory.json', import.meta.url), 'utf8')),
);

const qualified = {
  version: '7.2.0',
  integrity: 'sha512-OAVJ1uJtxC0Wzh0jaafBRRcJFhwis/jAPZP3u1441a6wGrtKiZ4JsGtPVERl2wcenKVhqHnxwjkJJExPUB6HHQ==',
};

function client(fetch: typeof globalThis.fetch, overrides: Record<string, unknown> = {}): TestRailClient {
  return new TestRailClient({
    baseUrl: 'https://qualification.testrail.io', email: 'user@example.com', apiKey: 'synthetic',
    fetch, registerProcessHandlers: false, ...overrides,
  });
}

async function readJson<T>(relative: string): Promise<T> {
  return JSON.parse(await readFile(new URL(relative, import.meta.url), 'utf8')) as T;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function bind(instance: TestRailClient, path: string): unknown {
  return path.split('.').reduce<unknown>(
    (target, part) => (target as Record<string, unknown> | undefined)?.[part], instance,
  );
}

/** Count upstream requests made by one call, ignoring how it settles. */
async function requests(
  call: (instance: TestRailClient) => Promise<unknown>,
  respond: () => Promise<Response>,
  overrides: Record<string, unknown> = {},
): Promise<number> {
  let count = 0;
  const instance = client(() => { count += 1; return respond(); }, overrides);
  await call(instance).catch(() => undefined);
  return count;
}

describe('F01 published driver qualification', () => {
  it('pins the exact qualified release with its recorded npm integrity', async () => {
    const manifest = await readJson<{ dependencies: Record<string, string> }>('../package.json');
    const lock = await readJson<{ packages: Record<string, { version: string; integrity: string }> }>('../package-lock.json');
    expect(manifest.dependencies['@dichovsky/testrail-api-client']).toBe(qualified.version);
    expect(lock.packages['node_modules/@dichovsky/testrail-api-client']).toEqual(
      expect.objectContaining({ version: qualified.version, integrity: qualified.integrity }),
    );
  });

  it('exposes every endpoint binding and page/all helper in the versioned inventory', () => {
    const instance = client(() => Promise.resolve(json({})));
    const bindings = inventory.flatMap(({ driver_method, pagination }) =>
      [driver_method, pagination.page_method, pagination.all_method]
        .filter((name): name is string => name !== null));
    expect(bindings.filter((name) => typeof bind(instance, name) !== 'function')).toEqual([]);
    expect(inventory).toHaveLength(133);
    expect(new Set(bindings).size).toBe(133 + 48);
  });

  it('executes each report generation independently instead of serving a cached result', async () => {
    for (const enableCache of [false, true]) {
      let calls = 0;
      const instance = client(
        () => { calls += 1; return Promise.resolve(json({ report_url: 'https://reports.example/1' })); },
        { enableCache },
      );
      await instance.reports.runReport(1);
      await instance.reports.runReport(1);
      expect(calls, `enableCache: ${enableCache}`).toBe(2);
    }
  });

  it('coalesces no concurrent report generation: each caller reaches TestRail', async () => {
    let calls = 0;
    const instance = client(() => { calls += 1; return Promise.resolve(json({ report_url: 'https://reports.example/1' })); });
    await Promise.all([instance.reports.runReport(1), instance.reports.runReport(1), instance.reports.runReport(1)]);
    expect(calls).toBe(3);
  });

  it('never retries a report generation on a network or server failure', async () => {
    const report = (instance: TestRailClient) => instance.reports.runReport(1);
    for (const [label, respond] of [
      ['network error', () => Promise.reject(new TypeError('fetch failed'))],
      ['500', () => Promise.resolve(json({ error: 'upstream' }, 500))],
      ['503', () => Promise.resolve(json({ error: 'upstream' }, 503))],
    ] as const) {
      expect(await requests(report, respond), `report on ${label}`).toBe(1);
    }
    // Contrast once, with a single retry so backoff stays short: an ordinary read does
    // retry the same failure, so the report result above is its own policy, not a shared cap.
    expect(await requests(
      (instance) => instance.projects.getProject(1), () => Promise.resolve(json({ error: 'upstream' }, 500)), { maxRetries: 1 },
    )).toBe(2);
  });

  it('retries a rate-limited report generation, which F01 accepts as safe', async () => {
    // 7.2.0 handles 429 in the rate limiter, above the per-method retry policy, so a
    // report generation is re-sent. Accepted 2026-09-17: TestRail rejects a rate-limited
    // request before handling it, so a re-send cannot generate the report twice or send a
    // duplicate template email. A 5xx stays non-retryable because generation may have
    // begun. Asserted so that an upstream change to this returns for a fresh decision.
    expect(await requests((instance) => instance.reports.runReport(1), () => Promise.resolve(json({ error: 'rate' }, 429)))).toBe(4);
  }, 20_000);

  it('rejects an aggregate at its own deadline while settlement stays pending', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let fetches = 0;
    const instance = client(async () => {
      fetches += 1;
      await gate;
      return json([{ id: 1, name: 'Project' }]);
    }, { maxRetries: 0 });

    // The aggregate deadline is the mechanism F01 names. A request timeout cannot stand
    // in for it: the driver delivers that one through the fetch AbortSignal, so it can
    // never reject ahead of the fetch it is waiting on.
    const handle = instance.trackOperation(() => instance.projects.getAllProjects({ maxDurationMs: 50 }));
    expect(Object.keys(handle).sort()).toEqual(['result', 'settled']);

    let settled = false;
    void handle.settled.then(() => { settled = true; }, () => { settled = true; });

    await expect(handle.result).rejects.toThrow(/maxDurationMs/u);
    await new Promise((resolve) => { setTimeout(resolve, 40); });
    // The descendant fetch is still in flight, so a rejected result is not settlement.
    expect(settled).toBe(false);
    // The rejected aggregate must not start further upstream work.
    expect(fetches).toBe(1);

    release();
    await expect(handle.settled).resolves.toBeUndefined();
    expect(fetches).toBe(1);
  });

  it('settles an ordinary call only after its descendant completes', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const instance = client(async () => { await gate; return json({ id: 1, name: 'Project' }); });

    const handle = instance.trackOperation(() => instance.projects.getProject(1));
    let settled = false;
    void handle.settled.then(() => { settled = true; }, () => { settled = true; });

    await new Promise((resolve) => { setTimeout(resolve, 50); });
    expect(settled).toBe(false);

    release();
    await expect(handle.result).resolves.toMatchObject({ id: 1 });
    await expect(handle.settled).resolves.toBeUndefined();
  });

});
