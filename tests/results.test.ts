import {
  TestRailApiError, TestRailLicenseError, TestRailPaginationError, TestRailValidationError,
} from '@dichovsky/testrail-api-client';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DEFAULT_LIMITS, FIXED_BUDGETS, type Limits } from '../src/config/limits.js';
import { advisoryWarnings, MAX_WARNING_COUNT } from '../src/contracts/drift.js';
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
    expect(advisoryWarnings(entity, 'array', many)[0]?.count).toBe(MAX_WARNING_COUNT);
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

  it('never substitutes parsed output for the returned value', () => {
    // A schema that would strip unknown keys and apply a default must not alter data.
    const stripping = z.object({ id: z.number(), status: z.string().default('active') });
    const original = { id: 1, custom_extra: 'kept', unknown_field: true };
    advisoryWarnings(stripping, 'record', original);
    expect(structured(successResult({ data: original }, limits)).data).toEqual(original);
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
