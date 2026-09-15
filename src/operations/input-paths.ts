import type { JsonSchemaType, Tool } from '@modelcontextprotocol/server';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/server/validators/ajv';
import type { CallMode } from './registry.js';

type Schema = Record<string, unknown>;

export function isRecord(value: unknown): value is Schema {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Walk the emitted schema so mappings describe the input advertised to clients. */
export class InputPaths {
  private readonly validator = new AjvJsonSchemaValidator();

  constructor(private readonly root: Tool['inputSchema']) {}

  variants(schema: unknown, seen: ReadonlySet<unknown> = new Set()): Schema[] {
    if (!isRecord(schema) || seen.has(schema)) return [];
    const visited = new Set([...seen, schema]);
    if (typeof schema.$ref === 'string') {
      if (!schema.$ref.startsWith('#/')) throw new Error('Input paths require local schema references');
      let target: unknown = this.root;
      for (const part of schema.$ref.slice(2).split('/')) {
        const key = decodeURIComponent(part).replaceAll('~1', '/').replaceAll('~0', '~');
        target = isRecord(target) && Object.hasOwn(target, key) ? target[key] : undefined;
      }
      if (target === undefined) throw new Error(`Unresolved input schema reference: ${schema.$ref}`);
      return this.variants(target, visited);
    }
    const alternatives = schema.anyOf ?? schema.oneOf;
    return Array.isArray(alternatives)
      ? alternatives.flatMap((alternative) => this.variants(alternative, visited))
      : [schema];
  }

  private accepts(schema: unknown, value: unknown): boolean {
    if (!isRecord(schema)) return schema === true;
    const fragment = { $schema: this.root.$schema, definitions: this.root.definitions, ...schema };
    return this.validator.getValidator(fragment as JsonSchemaType)(value).valid;
  }

  /** The dispatcher selects all only for an explicit _mcp.pagination="all". */
  forMode(variants: readonly Schema[], mode: CallMode): Schema[] {
    if (mode === 'single') return [...variants];
    return variants.flatMap((variant) => {
      const properties = isRecord(variant.properties) ? variant.properties : {};
      const required = Array.isArray(variant.required) ? variant.required : [];
      const candidates: Schema[] = [];
      // Omission selects page even when the optional control object only allows all.
      if (mode === 'page' && !required.includes('_mcp')) {
        candidates.push({ ...variant, properties: Object.fromEntries(Object.entries(properties).filter(([key]) => key !== '_mcp')) });
      }
      for (const control of this.variants(properties._mcp)) {
        const fields = isRecord(control.properties) ? control.properties : {};
        const requiredFields = Array.isArray(control.required) ? control.required : [];
        if (this.accepts(fields.pagination, mode) || (mode === 'page' && !requiredFields.includes('pagination'))) {
          candidates.push({ ...variant, properties: { ...properties, _mcp: control } });
        }
      }
      return candidates;
    });
  }

  has(schema: unknown, path: string): boolean {
    return this.walk(schema, path.replaceAll('[]', '.*').split('.'));
  }

  private walk(schema: unknown, parts: readonly string[]): boolean {
    return this.variants(schema).some((variant) => {
      if (parts.length === 0) return true;
      const [name, ...rest] = parts;
      if (name === '*') return variant.type === 'array' && this.walk(variant.items, rest);
      if (name === undefined || variant.type !== 'object') return false;
      if (variant.propertyNames !== undefined && !this.accepts(variant.propertyNames, name)) return false;
      const properties = isRecord(variant.properties) ? variant.properties : {};
      // Catchalls are only present for explicitly declared custom/open JSON objects.
      const child = Object.hasOwn(properties, name) ? properties[name] : variant.additionalProperties;
      return this.walk(child, rest);
    });
  }
}
