import { types } from 'node:util';
import type { JsonSchemaType, Tool } from '@modelcontextprotocol/server';
import { Ajv, AjvJsonSchemaValidator, addFormats } from '@modelcontextprotocol/server/validators/ajv';
import type { z } from 'zod';
import { AdapterError } from './errors.js';
import { inputJsonSchema } from './inputs.js';

export interface InputContract<T extends object = object> {
  readonly jsonSchema: Tool['inputSchema'];
  /** Validate without changing or replacing the caller's JSON value. */
  readonly validate: (input: unknown) => T;
}

function freezeDocument<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(freezeDocument);
  }
  return value;
}

/**
 * JSON Schema describes JSON, not every value JavaScript can manufacture. Check
 * the original graph without invoking getters or toJSON, dropping keys, or
 * coercing values. A per-call ancestry set rejects cycles but permits shared
 * subobjects. Completed subgraphs are visited once, never cached between calls.
 */
function isJson(input: unknown): boolean {
  const pending: { value: unknown; leaving?: boolean }[] = [{ value: input }];
  const active = new Set<object>();
  const checked = new Set<object>();
  while (pending.length > 0) {
    const { value, leaving } = pending.pop()!;
    if (value === null || typeof value === 'string' || typeof value === 'boolean') continue;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return false;
      continue;
    }
    if (typeof value !== 'object' || types.isProxy(value)) return false;
    if (leaving === true) {
      active.delete(value);
      checked.add(value);
      continue;
    }
    if (active.has(value)) return false;
    if (checked.has(value)) continue;
    const array = Array.isArray(value);
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== null && prototype !== (array ? Array.prototype : Object.prototype)) return false;
    const keys = Reflect.ownKeys(value);
    if (array && keys.length !== value.length + 1) return false;
    active.add(value);
    pending.push({ value, leaving: true });
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string') return false;
      if (array && (!/^(?:0|[1-9]\d*)$/u.test(key) || Number(key) >= value.length)) return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return false;
      pending.push({ value: descriptor.value as unknown });
    }
  }
  return true;
}

/** Finalize after authoring; the captured schema is also the runtime authority. */
export function createInputContract<S extends z.ZodType<object>>(schema: S): InputContract<z.output<S>> {
  const jsonSchema = freezeDocument(structuredClone(inputJsonSchema(schema)));
  // inputJsonSchema emits draft-07. Use the SDK's bundled engine and formats,
  // with JSON's own-member semantics even for names such as __proto__.
  const ajv = new Ajv({
    strict: false, validateFormats: true, validateSchema: false, allErrors: true,
    ownProperties: true, coerceTypes: false, useDefaults: false, removeAdditional: false,
  });
  // The SDK's bundled declaration exposes this function through an untyped default.
  (addFormats as (engine: InstanceType<typeof Ajv>) => unknown)(ajv);
  const validateJson = new AjvJsonSchemaValidator(ajv).getValidator(jsonSchema as unknown as JsonSchemaType);
  return Object.freeze({
    jsonSchema,
    validate(input: unknown): z.output<S> {
      if (!isJson(input) || !validateJson(input).valid) throw new AdapterError('INVALID_ARGUMENT');
      // Authoring rejects transforms and unsupported refinements. JSON validation
      // proves the inferred shape; no parsed clone can lose an own __proto__ key.
      return input as z.output<S>;
    },
  });
}
