import {
  TestRailApiError, TestRailLicenseError, TestRailPaginationError, TestRailValidationError,
} from '@dichovsky/testrail-api-client';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DEFAULT_LIMITS, FIXED_BUDGETS, type Limits } from '../src/config/limits.js';
import { advisoryWarnings, MAX_WARNING_COUNT, MAX_WARNINGS } from '../src/contracts/drift.js';
import { AdapterError, classifyError, type ErrorContext } from '../src/contracts/errors.js';
import { errorResult, successResult, validateOuter } from '../src/contracts/results.js';
import { RuntimeError } from '../src/runtime/errors.js';

const limits = DEFAULT_LIMITS;
const read: ErrorContext = { mutates: false, dispatched: true, acknowledged: false };
const write = (over: Partial<ErrorContext> = {}): ErrorContext => ({ mutates: true, dispatched: true, acknowledged: false, ...over });

function structured(result: { structuredContent: Readonly<Record<string, unknown>> }) {
  return result.structuredContent as Record<string, unknown>;
}

describe('result wrapper', () => {
  it('preserves driver fields, unknown fields and flat custom values exactly', () => {
    const data = {
      id: 7, name: 'Suite', custom_risk: null, custom_tags: ['a', 'b'],
      unexpected_future_field: { nested: 1 }, is_completed: false,
    };
    const result = successResult({ data }, limits);
    expect(structured(result).data).toEqual(data);
    // The text block must be exactly the serialized wrapper, for older consumers.
    expect(result.content[0]?.text).toBe(JSON.stringify(structured(result)));
    expect(result.isError).toBeUndefined();
  });

  it('represents a resolved void method as null rather than omitting data', () => {
    expect(structured(successResult({ data: undefined }, limits)).data).toBeNull();
    expect(Object.hasOwn(structured(successResult({ data: undefined }, limits)), 'data')).toBe(true);
  });

  it('keeps raw text results intact, including a valid empty string', () => {
    expect(structured(successResult({ data: '' }, limits)).data).toBe('');
    expect(structured(successResult({ data: 'Feature: x\n  Scenario: y' }, limits)).data)
      .toBe('Feature: x\n  Scenario: y');
  });

  it('omits optional wrapper keys entirely when they carry nothing', () => {
    const payload = structured(successResult({ data: [], warnings: [] }, limits));
    expect(Object.keys(payload)).toEqual(['data']);
  });

  it('includes pagination and warnings when present', () => {
    const payload = structured(successResult({
      data: [1], pagination: { mode: 'page', returned: 1 }, warnings: [{ code: 'SCHEMA_DRIFT', count: 3 }],
    }, limits));
    expect(Object.keys(payload)).toEqual(['data', 'pagination', 'warnings']);
  });
});

describe('result budgets', () => {
  it('rejects data over its own budget instead of truncating it', () => {
    const small: Limits = { ...limits, max_data_bytes: 256 };
    expect(() => successResult({ data: 'x'.repeat(1_000) }, small))
      .toThrow(expect.objectContaining({ code: 'RESPONSE_TOO_LARGE' }));
  });

  it('measures the complete result after duplication and escaping, not just data', () => {
    // Quote-heavy content roughly doubles again inside the duplicated text block, so a
    // payload that fits max_data_bytes can still overflow the complete result.
    const data = Array.from({ length: 40 }, (_unused, index) => ({ n: index, s: '"\\é—' .repeat(20) }));
    const dataBytes = Buffer.byteLength(JSON.stringify(data), 'utf8');
    const tuned: Limits = { ...limits, max_data_bytes: dataBytes + 10, max_result_bytes: dataBytes + 200 };
    expect(dataBytes).toBeLessThanOrEqual(tuned.max_data_bytes);
    expect(() => successResult({ data }, tuned))
      .toThrow(expect.objectContaining({ code: 'RESPONSE_TOO_LARGE' }));
  });

  it('counts bytes as UTF-8 rather than code units', () => {
    const data = '\u{1F600}'.repeat(100); // 4 UTF-8 bytes each, 2 UTF-16 units each
    const tuned: Limits = { ...limits, max_data_bytes: 300 };
    expect(JSON.stringify(data).length).toBeLessThan(400);
    expect(() => successResult({ data }, tuned))
      .toThrow(expect.objectContaining({ code: 'RESPONSE_TOO_LARGE' }));
  });

  /** The complete result as the client receives it, in UTF-8 bytes: the reference both budgets are checked against. */
  const resultBytes = (data: unknown) => {
    const payload = { data };
    return Buffer.byteLength(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload }), 'utf8');
  };

  it('counts the escaping of the duplicated text, not just the duplication, against the result budget', () => {
    const data = Array.from({ length: 50 }, () => '"\\'.repeat(40));
    const actual = resultBytes(data);
    const payloadBytes = Buffer.byteLength(JSON.stringify({ data }), 'utf8');
    // The same result if the text block were copied without escaping its quotes and backslashes.
    const unescaped = actual - Buffer.byteLength(JSON.stringify(JSON.stringify({ data })), 'utf8') + payloadBytes + 2;
    expect(unescaped).toBeLessThan(actual - 1_000);
    const roomy = { ...limits, max_data_bytes: payloadBytes };
    expect(() => successResult({ data }, { ...roomy, max_result_bytes: unescaped })).toThrow(expect.objectContaining({ code: 'RESPONSE_TOO_LARGE' }));
    expect(() => successResult({ data }, { ...roomy, max_result_bytes: actual - 1 })).toThrow(expect.objectContaining({ code: 'RESPONSE_TOO_LARGE' }));
    expect(() => successResult({ data }, { ...roomy, max_result_bytes: actual })).not.toThrow();
  });

  it('measures the result budget in UTF-8 bytes, not code units', () => {
    const data = '\u{1F600}\u2014'.repeat(200); // 4 + 3 bytes, 2 + 1 code units
    const actual = resultBytes(data);
    const payload = { data };
    const codeUnits = JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload }).length;
    expect(codeUnits).toBeLessThan(actual - 1_000);
    const roomy = { ...limits, max_data_bytes: actual };
    expect(() => successResult({ data }, { ...roomy, max_result_bytes: actual - 1 })).toThrow(expect.objectContaining({ code: 'RESPONSE_TOO_LARGE' }));
    expect(() => successResult({ data }, { ...roomy, max_result_bytes: actual })).not.toThrow();
  });

  it('accepts data of exactly the default 1 MiB and rejects one byte more', () => {
    expect(DEFAULT_LIMITS.max_data_bytes).toBe(1_048_576);
    // A JSON string serializes with its two quotes.
    expect(() => successResult({ data: 'x'.repeat(1_048_574) }, DEFAULT_LIMITS)).not.toThrow();
    expect(() => successResult({ data: 'x'.repeat(1_048_575) }, DEFAULT_LIMITS)).toThrow(expect.objectContaining({ code: 'RESPONSE_TOO_LARGE' }));
  });

  it('reports an unserializable value as an unusable response', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => successResult({ data: cyclic }, limits))
      .toThrow(expect.objectContaining({ code: 'INVALID_RESPONSE' }));
  });
});

describe('outer structure validation', () => {
  it('rejects an unusable outer structure', () => {
    expect(() => validateOuter(z.array(z.unknown()), { not: 'an array' }))
      .toThrow(expect.objectContaining({ code: 'INVALID_RESPONSE' }));
  });

  it('accepts a usable structure whose entity fields have drifted', () => {
    expect(() => validateOuter(z.record(z.string(), z.unknown()), { id: 'unexpectedly a string' })).not.toThrow();
  });
});

describe('advisory entity validation', () => {
  const entity = z.object({ id: z.number(), name: z.string() });

  it('warns on usable drift with a bounded count and no field names', () => {
    const warnings = advisoryWarnings(entity, 'record', { id: 'x', name: 5 });
    expect(warnings).toEqual([{ code: 'SCHEMA_DRIFT', count: 2 }]);
    // Nothing from the value or its paths may cross the boundary.
    expect(JSON.stringify(warnings)).not.toMatch(/id|name|x/u);
  });

  it('returns no warning when the entity matches, and none without a schema', () => {
    expect(advisoryWarnings(entity, 'record', { id: 1, name: 'a' })).toEqual([]);
    expect(advisoryWarnings(null, 'record', { anything: true })).toEqual([]);
  });

  it('accumulates across collection items and stays bounded', () => {
    const many = Array.from({ length: 2_000 }, () => ({ id: 'x', name: 5 }));
    expect(MAX_WARNING_COUNT).toBe(1_000);
    expect(advisoryWarnings(entity, 'array', many)[0]?.count).toBe(1_000);
  });

  it('gives each caller its own warnings even for one coalesced response', async () => {
    // Two concurrent callers of the same read share one upstream request. A shared
    // driver hook would fire once; this is a function of the value, so both get theirs.
    const shared = { id: 'drifted', name: 5 };
    const [first, second] = await Promise.all([
      Promise.resolve().then(() => advisoryWarnings(entity, 'record', shared)),
      Promise.resolve().then(() => advisoryWarnings(entity, 'record', shared)),
    ]);
    expect(first).toEqual([{ code: 'SCHEMA_DRIFT', count: 2 }]);
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
  });

  it('never alters the value it checks, even with a stripping, defaulting and transforming schema', () => {
    const rewriting = z.object({ id: z.coerce.number(), status: z.string().default('active') })
      .transform((value) => ({ ...value, extra: 1 }));
    const original = { id: '1', custom_extra: 'kept', unknown_field: true, nested: { list: [1] } };
    const before = structuredClone(original);
    const list = [original];
    advisoryWarnings(rewriting, 'record', original);
    advisoryWarnings(rewriting, 'array', list);
    advisoryWarnings(rewriting, 'page', list);
    // Compared with a copy taken first, so a write into the original, or a parsed item
    // put back in the caller's list, is caught.
    expect(original).toEqual(before);
    expect(list).toHaveLength(1);
    expect(list[0]).toBe(original);
    expect(structured(successResult({ data: original }, limits)).data).toEqual(before);
  });

  it('counts a schema that throws as one issue per item instead of throwing', () => {
    const throwing = z.object({ id: z.number() }).refine(() => { throw new Error('advisory hook failed'); });
    expect(advisoryWarnings(throwing, 'record', { id: 1 })).toEqual([{ code: 'SCHEMA_DRIFT', count: 1 }]);
    expect(advisoryWarnings(throwing, 'array', [{ id: 1 }, { id: 2 }, { id: 3 }])).toEqual([{ code: 'SCHEMA_DRIFT', count: 3 }]);
  });

  it('caps a result at ten warning entries, and treats more as an internal fault', () => {
    expect(MAX_WARNINGS).toBe(10);
    const entry = { code: 'SCHEMA_DRIFT' as const, count: 1 };
    expect(() => successResult({ data: 1, warnings: Array.from({ length: 10 }, () => entry) }, limits)).not.toThrow();
    expect(() => successResult({ data: 1, warnings: Array.from({ length: 11 }, () => entry) }, limits))
      .toThrow(expect.objectContaining({ code: 'INTERNAL_ERROR' }));
  });
});

describe('error classification', () => {
  it('keeps license precedence over the API error it subclasses', () => {
    expect(classifyError(new TestRailLicenseError(403, 'Forbidden'), read).code).toBe('LICENSE_REQUIRED');
    expect(classifyError(new TestRailApiError(403, 'Forbidden'), read).code).toBe('PERMISSION_DENIED');
  });

  it('keeps pagination precedence over the validation error it subclasses', () => {
    const bound = new TestRailPaginationError('max_items', 'stopped', 3, 900);
    expect(classifyError(bound, read)).toMatchObject({
      code: 'PAGINATION_LIMIT', reason: 'max_items', pages_fetched: 3, items_fetched: 900,
    });
    expect(classifyError(new TestRailValidationError('bad parameter'), read).code).toBe('INTERNAL_ERROR');
  });

  it('separates a safety bound from a broken page structure', () => {
    for (const reason of ['max_pages', 'max_items', 'max_bytes', 'max_duration'] as const) {
      expect(classifyError(new TestRailPaginationError(reason, 'm', 0, 0), read).code).toBe('PAGINATION_LIMIT');
    }
    for (const reason of ['invalid_page', 'invalid_continuation', 'non_progress'] as const) {
      expect(classifyError(new TestRailPaginationError(reason, 'm', 0, 0), read).code).toBe('INVALID_RESPONSE');
    }
  });

  it('carries progress only when the driver supplied it, and keeps it in the envelope', () => {
    // A timer deadline surfaces as a 408 with no response and no progress counts, so the
    // adapter reports the reason and nothing it did not observe.
    const deadline = classifyError(new TestRailApiError(408, 'Aggregate request deadline exceeded'), { ...read, aggregate: true });
    expect(deadline).toEqual({ code: 'PAGINATION_LIMIT', message: deadline.message, reason: 'max_duration' });
    // The driver's own deadline check supplies its counts, and they are kept.
    expect(classifyError(new TestRailPaginationError('max_duration', 'stopped', 0, 0), { ...read, aggregate: true }))
      .toMatchObject({ code: 'PAGINATION_LIMIT', reason: 'max_duration', pages_fetched: 0, items_fetched: 0 });
    const bound = classifyError(new TestRailPaginationError('max_pages', 'stopped', 2, 40), read);
    expect(structured(errorResult(bound)).error).toMatchObject({ reason: 'max_pages', pages_fetched: 2, items_fetched: 40 });
  });

  it('maps upstream statuses and treats 0 or 200 as an unusable response', () => {
    const cases: [number, string][] = [
      [401, 'AUTHENTICATION_FAILED'], [403, 'PERMISSION_DENIED'], [404, 'NOT_FOUND'],
      [429, 'RATE_LIMITED'], [500, 'UPSTREAM_ERROR'], [400, 'UPSTREAM_ERROR'],
      [0, 'INVALID_RESPONSE'], [200, 'INVALID_RESPONSE'],
    ];
    for (const [status, code] of cases) {
      expect(classifyError(new TestRailApiError(status, 'text'), read).code, `status ${status}`).toBe(code);
    }
    // A status-zero failure is not automatically a transport failure: malformed
    // success JSON reaches the adapter the same way.
    expect(classifyError(new TestRailApiError(0, ''), read).http_status).toBeUndefined();
  });

  /*
   * The driver's own header and body timeouts carry no status TestRail sent, so they are
   * the wait expiring, not a TestRail 408 or an unusable response. They are constructed
   * here exactly as the pinned driver constructs them; a response that did arrive always
   * carries its body text, so a real 408 keeps its status whatever its reason phrase,
   * unless the driver abandons its body at one of its limits and raises its own status-0
   * error instead (tests/families/t11.test.ts holds that through the real driver).
   */
  it.each([
    ['the driver\'s header timeout', new TestRailApiError(408, 'Request timeout after 15000ms')],
    ['a shorter header timeout', new TestRailApiError(408, 'Request timeout after 100ms')],
    ['the driver\'s body timeout', new TestRailApiError(0, 'Body read timeout', 'body read exceeded 15000ms before the response body finished streaming')],
    ['a shorter body timeout', new TestRailApiError(0, 'Body read timeout', 'body read exceeded 100ms before the response body finished streaming')],
  ] as const)('reports %s as TIMEOUT with no status, and unknown on a write', (_label, raised) => {
    expect(classifyError(raised, read)).toEqual({ code: 'TIMEOUT', message: 'The response wait expired; upstream work may still be running.' });
    expect(classifyError(raised, write())).toEqual({
      code: 'TIMEOUT', message: 'The response wait expired; upstream work may still be running.', write_outcome: 'unknown',
    });
  });

  it.each([
    ['a real 408 whose reason phrase is the driver\'s', new TestRailApiError(408, 'Request timeout after 15000ms', '{"error":"slow"}'), 'UPSTREAM_ERROR', 408],
    ['a real 408 with an empty body', new TestRailApiError(408, 'Request Timeout', ''), 'UPSTREAM_ERROR', 408],
    ['a 408 with no response and another phrase', new TestRailApiError(408, 'Request Timeout'), 'UPSTREAM_ERROR', 408],
    ['a status-zero body timeout with other detail', new TestRailApiError(0, 'Body read timeout', 'other'), 'INVALID_RESPONSE', undefined],
    ['a status-zero body timeout with no detail', new TestRailApiError(0, 'Body read timeout'), 'INVALID_RESPONSE', undefined],
    ['a body over the size cap', new TestRailApiError(0, 'Response body too large', 'response body exceeded 1048576 bytes'), 'INVALID_RESPONSE', undefined],
  ] as const)('keeps %s as it was', (_label, raised, code, status) => {
    const safe = classifyError(raised, read);
    expect(safe.code).toBe(code);
    expect(safe.http_status).toBe(status);
  });

  it('carries adapter and runtime codes through unchanged', () => {
    expect(classifyError(new AdapterError('RESPONSE_TOO_LARGE'), read).code).toBe('RESPONSE_TOO_LARGE');
    expect(classifyError(new RuntimeError('BUSY', 'x'), read).code).toBe('BUSY');
    expect(classifyError(new RuntimeError('TIMEOUT', 'x'), read).code).toBe('TIMEOUT');
    expect(classifyError(new Error('anything else'), read).code).toBe('INTERNAL_ERROR');
  });

  it('never forwards a driver message, status text or response body', () => {
    const leaky = new TestRailApiError(500, 'Internal Server Error at https://secret.testrail.io', {
      detail: 'api_key=SECRETVALUE', path: '/Users/someone/private',
    });
    const serialized = JSON.stringify(errorResult(classifyError(leaky, read)));
    for (const secret of ['SECRETVALUE', 'secret.testrail.io', '/Users/someone/private', 'Internal Server Error']) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).toContain('UPSTREAM_ERROR');
  });
});

describe('write outcome', () => {
  it('proves not_started only when nothing was dispatched', () => {
    expect(classifyError(new RuntimeError('BUSY', 'x'), write({ dispatched: false })).write_outcome).toBe('not_started');
    expect(classifyError(new AdapterError('INVALID_ARGUMENT'), write({ dispatched: false })).write_outcome).toBe('not_started');
  });

  it('never lets an error code override what the adapter observed', () => {
    // A pre-dispatch code reaching a post-dispatch failure must not claim nothing was
    // sent. Unknown is the conservative answer; not_started is a claim about reality.
    for (const error of [new RuntimeError('BUSY', 'x'), new AdapterError('INVALID_ARGUMENT')]) {
      expect(classifyError(error, write({ dispatched: true })).write_outcome).toBe('unknown');
      expect(classifyError(error, write({ dispatched: true, acknowledged: true })).write_outcome)
        .toBe('acknowledged');
    }
  });

  it('reports unknown for an ambiguous failure after dispatch', () => {
    for (const error of [new TestRailApiError(500, 'x'), new RuntimeError('TIMEOUT', 'x'), new RuntimeError('CANCELLED', 'x')]) {
      expect(classifyError(error, write()).write_outcome).toBe('unknown');
    }
  });

  it('reports acknowledged when the driver resolved and a later stage failed', () => {
    expect(classifyError(new AdapterError('RESPONSE_TOO_LARGE'), write({ acknowledged: true })).write_outcome)
      .toBe('acknowledged');
  });

  it('gives no TestRail write outcome to a non-mutating call', () => {
    // An attachment download has local effects but does not mutate TestRail.
    expect(classifyError(new AdapterError('FILE_ACCESS_DENIED'), read).write_outcome).toBeUndefined();
    expect(classifyError(new TestRailApiError(500, 'x'), read).write_outcome).toBeUndefined();
  });
});

describe('error envelope', () => {
  it('uses the same structured and text representation with isError', () => {
    const result = errorResult(classifyError(new TestRailApiError(404, 'Not Found'), read));
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe(JSON.stringify(result.structuredContent));
    expect(structured(result).error).toMatchObject({ code: 'NOT_FOUND', http_status: 404 });
  });

  it('fails rather than emit an envelope that is still oversized after degrading', () => {
    expect(() => errorResult({
      code: 'INTERNAL_ERROR', message: 'm'.repeat(FIXED_BUDGETS.max_error_bytes * 2),
    })).toThrow(expect.objectContaining({ code: 'INTERNAL_ERROR' }));
  });

  it('caps the error envelope at 16 KiB of UTF-8, the whole envelope and exactly its limit', () => {
    expect(FIXED_BUDGETS.max_error_bytes).toBe(16_384);
    type Safe = Parameters<typeof errorResult>[0];
    const envelopeBytes = (error: Safe) =>
      Buffer.byteLength(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ error }) }], structuredContent: { error }, isError: true }), 'utf8');
    // An envelope of exactly 16 384 bytes is returned whole; one byte more drops its metadata.
    // Every character appears twice, once escaped, so only an escape of odd length (a
    // newline: 2 bytes in the structured copy, 3 in the text) reaches both parities.
    let exact: Safe | undefined;
    for (let length = 7_000; length < 9_000 && exact === undefined; length += 1) {
      for (const message of ['bounded', 'bounded\n']) {
        const candidate: Safe = { code: 'PAGINATION_LIMIT', message, reason: 'r'.repeat(length), write_outcome: 'unknown' };
        if (envelopeBytes(candidate) === 16_384) { exact = candidate; break; }
      }
    }
    if (exact === undefined) throw new Error('no envelope of exactly 16 384 bytes');
    expect(structured(errorResult(exact)).error).toEqual(exact);
    // Two ordinary characters (4 bytes) traded for a newline (5 bytes): exactly one byte over.
    const over: Safe = { ...exact, reason: `${(exact.reason ?? '').slice(0, -2)}\n` };
    expect(envelopeBytes(over)).toBe(16_385);
    expect(structured(errorResult(over)).error).not.toHaveProperty('reason');
    // Multi-byte metadata under the limit in code units but over it in bytes is dropped too.
    const wide: Safe = { code: 'PAGINATION_LIMIT', message: 'bounded', reason: '\u00e9'.repeat(5_000), write_outcome: 'unknown' };
    const codeUnits = JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ error: wide }) }], structuredContent: { error: wide }, isError: true }).length;
    expect(codeUnits).toBeLessThan(16_384);
    expect(envelopeBytes(wide)).toBeGreaterThan(16_384);
    expect(structured(errorResult(wide)).error).toEqual({ code: 'PAGINATION_LIMIT', message: 'bounded', write_outcome: 'unknown' });
  });

  it('stays within its fixed budget by dropping metadata before the outcome', () => {
    const oversized = {
      code: 'PAGINATION_LIMIT' as const, message: 'bounded',
      reason: 'r'.repeat(FIXED_BUDGETS.max_error_bytes), write_outcome: 'unknown' as const,
    };
    const result = errorResult(oversized);
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(FIXED_BUDGETS.max_error_bytes);
    expect(structured(result).error).toEqual({
      code: 'PAGINATION_LIMIT', message: 'bounded', write_outcome: 'unknown',
    });
  });
});
