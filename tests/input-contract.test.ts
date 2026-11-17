import { AddCasePayloadSchema, AddDatasetPayloadSchema } from '@dichovsky/testrail-api-client';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { z } from 'zod';
import { AdapterError } from '../src/contracts/errors.js';
import { createInputContract } from '../src/contracts/input-contract.js';
import { jsonValueSchema, payloadInput, positiveIdSchema, strictObject } from '../src/contracts/inputs.js';

describe('finalized input contracts', () => {
  it('keeps original-key validation after descriptions and annotation metadata', () => {
    const described = payloadInput(AddCasePayloadSchema, { extensions: 'custom' }).describe('A Test Case.');
    const contract = createInputContract(strictObject({
      body: described.meta({ ...described.meta(), title: 'Test Case' }),
    }));
    const invalid: unknown = JSON.parse('{"body":{"title":"Case","__proto__":5}}');
    expect(() => contract.validate(invalid)).toThrow(AdapterError);
    const valid = { body: { title: 'Case', custom_value: 5 } };
    expect(contract.validate(valid)).toBe(valid);
    expect(contract.jsonSchema.properties?.body).toMatchObject({ title: 'Test Case', description: 'A Test Case.' });
  });

  it('validates record keys and values after cloning a nested payload', () => {
    const contract = createInputContract(strictObject({ body: payloadInput(AddDatasetPayloadSchema).describe('Dataset') }));
    const valid: unknown = JSON.parse('{"body":{"name":"D","variables":{"__proto__":"value"}}}');
    const invalid: unknown = JSON.parse('{"body":{"name":"D","variables":{"__proto__":42}}}');
    expect(contract.validate(valid)).toBe(valid);
    expect(() => contract.validate(invalid)).toThrow(AdapterError);
  });

  it('requires own JSON members even when their names exist on Object.prototype', () => {
    const contract = createInputContract(strictObject({
      body: z.record(z.enum(['__proto__', 'constructor', 'toString']), z.string()),
    }));
    const valid: unknown = JSON.parse('{"body":{"__proto__":"a","constructor":"b","toString":"c"}}');
    expect(contract.validate(valid)).toBe(valid);
    expect(() => contract.validate({ body: {} })).toThrow(AdapterError);
    expect(() => contract.validate({ body: { constructor: 'b', toString: 'c' } })).toThrow(AdapterError);
    expect(() => contract.validate(JSON.parse('{"body":{"__proto__":42,"constructor":"b","toString":"c"}}')))
      .toThrow(AdapterError);
    const optional = createInputContract(strictObject({ constructor: z.string().optional(), toString: z.string().optional() }));
    expect(optional.validate({})).toEqual({});
    expect(() => optional.validate({ constructor: 42 })).toThrow(AdapterError);
  });

  it('preserves frozen recursive JSON and does not replace the original value', () => {
    const custom: unknown = JSON.parse('{"__proto__":{"nested":[null,false,0,"",{"__proto__":true}]}}');
    const input = Object.freeze({ body: Object.freeze({ title: 'Case', custom_value: Object.freeze(custom as object) }) });
    const contract = createInputContract(strictObject({ body: payloadInput(AddCasePayloadSchema, { extensions: 'custom' }) }));
    const before = JSON.stringify(input);
    expect(contract.validate(input)).toBe(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(Object.hasOwn(input.body.custom_value, '__proto__')).toBe(true);
  });

  it('owns an immutable schema document and ignores later authoring changes', () => {
    const source = strictObject({ id: positiveIdSchema, optional: z.string().optional() });
    const contract = createInputContract(source);
    const published = JSON.stringify(contract.jsonSchema);
    source.describe('A later description');
    source.shape.id = z.number();
    expect(() => contract.validate({ id: -1 })).toThrow(AdapterError);
    expect(contract.validate({ id: 1 })).toEqual({ id: 1 });
    expect(JSON.stringify(contract.jsonSchema)).toBe(published);
    expect(Object.isFrozen(contract)).toBe(true);
    expect(Object.isFrozen(contract.jsonSchema)).toBe(true);
    expect(Object.isFrozen(contract.jsonSchema.properties?.id)).toBe(true);
    expect(Reflect.set(contract.jsonSchema, 'additionalProperties', true)).toBe(false);
    expect(() => contract.validate({ id: '1' })).toThrow(AdapterError);
    expect(() => contract.validate({ id: 1, extra: true })).toThrow(AdapterError);
  });

  it('preserves inference and omitted values, and rechecks mutable input on every call', () => {
    const contract = createInputContract(strictObject({ id: positiveIdSchema, optional: z.string().optional() }));
    expectTypeOf(contract.validate({ id: 1 })).toEqualTypeOf<{ id: number; optional?: string | undefined }>();
    const input: { id: unknown } = { id: 1 };
    expect(contract.validate(input)).toBe(input);
    expect(Object.hasOwn(input, 'optional')).toBe(false);
    input.id = '1';
    expect(() => contract.validate(input)).toThrow(AdapterError);
  });

  it('rejects unsupported authoring constructs before accepting calls', () => {
    expect(() => createInputContract(strictObject({ id: z.coerce.number() }))).toThrow('coercion');
    expect(() => createInputContract(strictObject({ id: z.number().default(1) }))).toThrow('defaults');
    expect(() => createInputContract(strictObject({ name: z.string().transform((s) => s.trim()) }))).toThrow();
  });
});

describe('original JSON input domain', () => {
  const contract = createInputContract(strictObject({ value: jsonValueSchema }));

  it.each([
    ['undefined', undefined], ['NaN', NaN], ['infinity', Infinity], ['negative infinity', -Infinity],
    ['bigint', 1n], ['function', () => 1], ['symbol', Symbol('value')],
    ['date', new Date(0)], ['map', new Map()], ['set', new Set()], ['regexp', /a/u],
    ['typed array', new Uint8Array([1])], ['boxed number', Object(1) as unknown],
    ['class instance', new (class { name = 'value'; })()], ['sparse array', new Array<unknown>(2)],
    ['array with extra property', Object.assign([1], { extra: 1 })],
    ['hole replaced by a non-index property', Object.assign(new Array<unknown>(1), { extra: 1 })],
    ['array with noncanonical index', Object.assign(new Array<unknown>(1), { '00': 1 })],
    ['array with out-of-bounds property', Object.assign(new Array<unknown>(1), { '4294967295': 1 })],
    ['hidden property', Object.defineProperty({}, 'hidden', { value: 1 })],
    ['symbol property', { [Symbol('key')]: 1 }],
  ])('refuses %s without converting or dropping it', (_name, value) => {
    expect(() => contract.validate({ value })).toThrowError(new AdapterError('INVALID_ARGUMENT'));
  });

  it('rejects accessors and proxies without invoking user code', () => {
    const getter = vi.fn(() => { throw new Error('must not run'); });
    const value = Object.defineProperty({}, 'key', { get: getter, enumerable: true });
    expect(() => contract.validate({ value })).toThrow(AdapterError);
    expect(getter).not.toHaveBeenCalled();
    const trap = vi.fn(() => { throw new Error('must not run'); });
    const proxy = new Proxy({}, { getPrototypeOf: trap, ownKeys: trap, get: trap });
    expect(() => contract.validate({ value: proxy })).toThrow(AdapterError);
    expect(trap).not.toHaveBeenCalled();
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expect(() => contract.validate({ value: revoked.proxy })).toThrow(AdapterError);
  });

  it('rejects cycles but accepts shared subobjects and null-prototype objects', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => contract.validate({ value: cyclic })).toThrow(AdapterError);
    const shared = Object.assign(Object.create(null) as Record<string, unknown>, { number: 1, text: 'x' });
    const input = { value: { a: shared, b: shared, list: [shared, null, false, 0, ''] } };
    expect(contract.validate(input)).toBe(input);
    const array: unknown[] = [];
    array.push(array);
    expect(() => contract.validate({ value: array })).toThrow(AdapterError);
  });

  it('rejects non-object roots through the published object schema', () => {
    for (const input of [null, 1, 'value', false, []]) {
      expect(() => contract.validate(input)).toThrowError(new AdapterError('INVALID_ARGUMENT'));
    }
  });
});
