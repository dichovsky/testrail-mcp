import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TestRailClient } from '@dichovsky/testrail-api-client';
import { expect, vi } from 'vitest';
import { DEFAULT_LIMITS } from '../../src/config/limits.js';
import type { Operation } from '../../src/operations/registry.js';
import type { ParameterManifest } from './parameter-manifest.js';
import { describeBody, materializeFiles, substituteTokens } from './uploads.js';

/**
 * Drive one registration with one fixture of its manifest, through the real public
 * driver, and compare what reaches the driver method and the wire with what the fixture
 * promised. It throws on the first difference, so a caller can assert either that a
 * production registration honours every fixture or that a deliberately broken one does not.
 */
export async function runRegisteredFixture(
  operation: Operation,
  manifest: ParameterManifest,
  fixture: ParameterManifest['cases'][number],
): Promise<void> {
  // An upload fixture declares its file's contents; the token stands for the path
  // the file lands on here, in the input and in the expected driver arguments alike.
  const directory = (manifest.files ?? []).length === 0
    ? undefined
    : await mkdtemp(join(tmpdir(), 'testrail-mcp-registered-'));
  const paths = directory === undefined
    ? {}
    : await materializeFiles(manifest, directory);
  const input = substituteTokens(fixture.input, paths);
  const expected = substituteTokens(fixture.expect, paths);
  const calls: { url: string; method: string | undefined; body: unknown }[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (target, init) => {
    const url = typeof target === 'string' ? target : target instanceof URL ? target.href : target.url;
    // Described inside the request: the driver owns an upload's streams and
    // cancels them once it settles, so a later read would never complete.
    calls.push({ url, method: init?.method, body: await describeBody(init?.body) });
    // Answer in the shape the fixture declares: one endpoint of this API returns
    // text rather than JSON, and a JSON reply would be read as the feature file.
    const response = expected.kind === 'accepted' ? expected.upstream_response : { kind: 'json' as const, body: {} };
    return Promise.resolve(response.kind === 'json'
      ? new Response(JSON.stringify(response.body), { headers: { 'content-type': 'application/json' } })
      : response.kind === 'text'
        ? new Response(response.text, { headers: { 'content-type': 'text/plain' } })
        : new Response(response.utf8, { headers: { 'content-type': 'application/octet-stream' } }));
  });
  const client = new TestRailClient({
    baseUrl: 'https://fixture.testrail.test', email: 'fixture@example.test', apiKey: 'synthetic',
    registerProcessHandlers: false, enableCache: false, maxRetries: 0, fetch,
    dnsLookup: () => Promise.resolve([{ address: '203.0.113.10', family: 4 }]),
  });
  const control = input._mcp;
  const all = typeof control === 'object' && control !== null && !Array.isArray(control) && control.pagination === 'all';
  const call = operation.pagination.kind === 'none' ? operation.pagination.single
    : all ? operation.pagination.all : operation.pagination.page;
  const [moduleName = '', methodName = ''] = call.binding.split('.');
  const owner: unknown = Reflect.get(client, moduleName);
  const publicMethod = vi.spyOn(owner as Record<string, (...args: never[]) => unknown>, methodName);
  /*
   * An upload operation is dispatched with the staged copy the transport would have
   * made. The staging itself, its root containment and its disposal belong to the
   * family suite; what this gate owns is that the registration hands the driver the
   * file it was given, under the filename and media type the caller asked for.
   */
  const staged = operation.files.kind !== 'upload' || typeof input.file_path !== 'string'
    ? undefined
    : { path: input.file_path, ...(typeof input.content_type === 'string' ? { type: input.content_type } : {}) };
  const context = staged === undefined
    ? { limits: DEFAULT_LIMITS }
    : { limits: DEFAULT_LIMITS, upload: staged };
  try {
    if (expected.kind === 'rejected') {
      await expect(call.invoke(client, input, context)).rejects.toThrow();
      expect(publicMethod).not.toHaveBeenCalled();
      expect(calls).toEqual([]);
      return;
    }
    const result = await call.invoke(client, input, context);
    expect(publicMethod.mock.calls).toEqual([expected.driver.arguments]);
    const sent = calls;
    expect(sent).toEqual([{
      url: `https://fixture.testrail.test/index.php?/api/v2/${expected.wire.endpoint}`,
      method: expected.wire.method,
      body: expected.wire.multipart ?? expected.wire.json,
    }]);
    // A download resolves with bytes, which are compared as bytes; void resolves with nothing.
    if (expected.driver_result.kind === 'binary') {
      expect(result).toBeInstanceOf(ArrayBuffer);
      expect(Buffer.from(result as ArrayBuffer)).toEqual(Buffer.from(expected.driver_result.utf8));
    } else {
      expect(result).toEqual(expected.driver_result.kind === 'json' ? expected.driver_result.value : undefined);
    }
    // What the driver returned must also satisfy the contract the registration
    // declares, or every real call fails in validateOuter while the arguments,
    // the wire and the result all still match the fixture.
    if (all) expect(Array.isArray(result), `${operation.tool}: aggregate result`).toBe(true);
    else expect(operation.response.outerSchema.safeParse(result).success, `${operation.tool}: outer schema`).toBe(true);
  } finally {
    client.destroy();
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  }
}
