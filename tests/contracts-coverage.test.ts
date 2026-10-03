import {
  TestRailApiError,
  TestRailPaginationError,
} from '@dichovsky/testrail-api-client';
import { specTypeSchemas } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { z as zm } from 'zod/mini';
import { DEFAULT_LIMITS } from '../src/config/limits.js';
import { AdapterError, classifyError, type ErrorContext } from '../src/contracts/errors.js';
import {
  inputJsonSchema,
  jsonValueSchema,
  payloadArray,
  payloadInput,
  strictObject,
} from '../src/contracts/inputs.js';
import { successResult } from '../src/contracts/results.js';

const read: ErrorContext = { mutates: false, dispatched: true, acknowledged: false };
const aggregateRead: ErrorContext = { ...read, aggregate: true };

/** An object whose own enumerable `__proto__` key survives, as a JSON body delivers it. */
function ownProto(value: unknown): object {
  return JSON.parse(`{"__proto__":${JSON.stringify(value)}}`) as object;
}

afterEach(() => { vi.restoreAllMocks(); });

describe('classifyError edges', () => {
  it.each([
    ['no response text', undefined],
    ['a non-text response', { body: 'body read exceeded 10ms after 5 bytes' }],
  ])('a body-read timeout inside an aggregate with %s is not taken for the deadline', (_label, response) => {
    // Only the driver's own string spelling can prove a clipped body deadline. Without
    // it the error is neither the duration bound nor a driver timeout, so it falls
    // through to the ordinary status-zero classification and reports no status.
    const error = new TestRailApiError(0, 'Body read timeout', response);
    const safe = classifyError(error, aggregateRead);
    expect(safe.code).toBe('INVALID_RESPONSE');
    expect(safe.reason).toBeUndefined();
    expect(Object.hasOwn(safe, 'http_status')).toBe(false);
  });

  it.each([
    ['NaN', Number.NaN, Number.NaN],
    ['unsafe integers', 2 ** 53, Number.MAX_VALUE],
    ['fractions', 1.5, 0.25],
  ])('drops pagination progress counters that are %s', (_label, pages, items) => {
    const error = new TestRailPaginationError('max_items', 'stopped', pages, items);
    const safe = classifyError(error, read);
    expect(safe).toEqual({
      code: 'PAGINATION_LIMIT',
      message: expect.any(String) as string,
      reason: 'max_items',
    });
    expect(Object.hasOwn(safe, 'pages_fetched')).toBe(false);
    expect(Object.hasOwn(safe, 'items_fetched')).toBe(false);
  });

  it('keeps one valid counter while dropping the other', () => {
    const safe = classifyError(new TestRailPaginationError('max_pages', 'stopped', 3, Number.NaN), read);
    expect(safe.pages_fetched).toBe(3);
    expect(Object.hasOwn(safe, 'items_fetched')).toBe(false);
  });
});

describe('successResult with data JSON cannot represent', () => {
  it.each([
    ['a function', () => 1],
    ['a symbol', Symbol('opaque')],
  ])('reports %s as an invalid response rather than an empty result', (_label, data) => {
    // JSON.stringify returns undefined for these instead of throwing.
    expect(JSON.stringify(data)).toBeUndefined();
    let thrown: unknown;
    try { successResult({ data }, DEFAULT_LIMITS); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(AdapterError);
    expect((thrown as AdapterError).code).toBe('INVALID_RESPONSE');
  });
});

describe('payloadInput construction guards', () => {
  it('refuses field overrides on a non-object source', () => {
    expect(() => payloadInput(z.string(), { fields: { name: z.string() } }))
      .toThrow('Payload field overrides require an object schema');
  });

  it('refuses a field that is not a Zod classic schema', () => {
    expect(() => payloadInput(z.object({ name: zm.string() })))
      .toThrow('Payload fields require Zod classic types');
  });

  it('refuses a nested element that is not a Zod classic schema', () => {
    expect(() => payloadInput(z.object({ names: z.array(zm.string()) })))
      .toThrow('Input schemas require Zod classic types');
  });

  it('refuses a custom extension policy whose property check was not registered', () => {
    // Defensive: Zod's refine always records a custom check. A refine that returned
    // the schema unchanged would leave the custom_* policy unenforced while its JSON
    // Schema still advertised it, so construction must stop rather than continue.
    const source = z.object({ name: z.string() });
    const prototype = Object.getPrototypeOf(source) as { refine: (...args: unknown[]) => unknown };
    vi.spyOn(prototype, 'refine').mockImplementation(function (this: unknown) { return this; });
    expect(() => payloadInput(source, { extensions: 'custom' }))
      .toThrow('Custom property check was not created');
  });

  it('refuses required alternatives on a non-object source', () => {
    expect(() => payloadInput(z.string(), { requireOneOf: ['name'] }))
      .toThrow('Required alternatives require an object schema');
  });

  it('refuses a required alternative the payload does not declare', () => {
    expect(() => payloadInput(z.object({ name: z.string().optional() }), { requireOneOf: ['name', 'title'] }))
      .toThrow('Required alternatives must be declared payload fields');
  });

  it('refuses required alternatives whose check was not registered', () => {
    // Defensive, as for the custom_* policy: the JSON Schema would advertise an anyOf
    // that nothing at runtime enforced.
    const source = z.object({ name: z.string().optional() });
    const prototype = Object.getPrototypeOf(source) as { refine: (...args: unknown[]) => unknown };
    vi.spyOn(prototype, 'refine').mockImplementation(function (this: unknown) { return this; });
    expect(() => payloadInput(source, { requireOneOf: ['name'] }))
      .toThrow('Required alternatives check was not created');
  });
});

describe('payloadInput __proto__ checks run synchronously only', () => {
  it('refuses an asynchronous record result', async () => {
    const record = payloadInput(z.record(z.string(), z.string().transform((value) => Promise.resolve(value))));
    await expect(record.safeParseAsync({ name: 'value' }))
      .rejects.toThrow('Payloads are validated synchronously');
  });

  it('refuses an asynchronous record key check on an own __proto__ key', async () => {
    const record = payloadInput(z.record(z.string().refine(() => Promise.resolve(true)), z.string()));
    await expect(record.safeParseAsync(ownProto('value')))
      .rejects.toThrow('Payload records are validated synchronously');
  });

  it('refuses an asynchronous record value check on an own __proto__ key', async () => {
    const record = payloadInput(z.record(z.string(), z.string().transform((value) => Promise.resolve(value))));
    await expect(record.safeParseAsync(ownProto('value')))
      .rejects.toThrow('Payload records are validated synchronously');
  });

  it('refuses an asynchronous JSON check on an own __proto__ extension', () => {
    // Defensive: the JSON value schema has no asynchronous parts. If it ever gained
    // one, the extension check must fail loudly instead of dropping the key's issues.
    const object = payloadInput(z.object({ name: z.string().optional() }), { extensions: 'json' });
    vi.spyOn(jsonValueSchema._zod, 'run').mockReturnValue(Promise.resolve({ value: 1, issues: [] }));
    expect(() => object.safeParse(ownProto(1))).toThrow('Payload objects are validated synchronously');
  });

  it('still accepts a JSON own __proto__ extension synchronously', () => {
    const object = payloadInput(z.object({ name: z.string().optional() }), { extensions: 'json' });
    expect(object.safeParse(ownProto({ nested: [1, 'two', null] })).success).toBe(true);
  });
});

describe('payloadArray', () => {
  it('refuses a source array carrying a refinement', () => {
    expect(() => payloadArray(z.array(z.string()).refine((items) => items.length > 0), z.string()))
      .toThrow('Array refinement needs a JSON Schema equivalent');
  });

  it('keeps the source bounds while replacing the item schema', () => {
    const adapted = payloadArray(z.array(z.string()).min(1).max(2), z.number());
    expect(adapted.safeParse([1]).success).toBe(true);
    expect(adapted.safeParse([]).success).toBe(false);
    expect(adapted.safeParse([1, 2, 3]).success).toBe(false);
    expect(adapted.safeParse(['one']).success).toBe(false);
  });
});

describe('inputJsonSchema SDK check', () => {
  it('refuses a schema the SDK would not accept as a tool input schema', () => {
    // Defensive: Zod's draft-07 output for an accepted input always satisfies the SDK
    // today. Should the SDK tighten its Tool schema, generation must fail here rather
    // than publish a tool the client side rejects.
    const standard = specTypeSchemas.Tool['~standard'];
    vi.spyOn(standard, 'validate').mockReturnValue({ issues: [{ message: 'rejected' }] });
    expect(() => inputJsonSchema(strictObject({ name: z.string() })))
      .toThrow('Input JSON Schema is not an SDK tool schema');
  });
});
