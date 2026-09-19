import type { JsonSchemaType } from '@modelcontextprotocol/server';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/server/validators/ajv';
import type { CallMode, OperationRegistry, ResponseContract } from '../../src/operations/registry.js';
import { supplies, type ParameterManifest } from './parameter-manifest.js';

function parts(path: string): string[] {
  return path.replaceAll('[]', '.*').split('.');
}

/**
 * The outer driver result each reviewed shape describes. Both of the driver's
 * two-branch results are a union to the registry, so the mapping is not one to one.
 */
const reviewedShapes: Readonly<Record<ParameterManifest['outer_result']['driver'], ResponseContract['shape']>> = {
  record: 'record', array: 'array', page: 'page', text: 'text', binary: 'binary', void: 'void',
  record_or_void: 'union', record_or_array: 'union',
};

/** The call mode a fixture selects, which is how the dispatcher reads its input. */
function fixtureMode(input: ParameterManifest['cases'][number]['input'], controlled: boolean): CallMode {
  if (!controlled) return 'single';
  const control = input._mcp;
  const all = typeof control === 'object' && control !== null && !Array.isArray(control) && control.pagination === 'all';
  return all ? 'all' : 'page';
}

/** Whole-body mappings carry nested fields; filter renames must remain explicit. */
export function auditRegisteredParameters(registry: OperationRegistry, manifests: readonly ParameterManifest[]): string[] {
  const errors: string[] = [];
  for (const operation of registry.entries) {
    const manifest = manifests.find((candidate) => candidate.endpoint.tool === operation.tool);
    if (manifest === undefined) {
      errors.push(`${operation.tool}: missing independent parameter manifest`);
      continue;
    }
    if (manifest.review.status !== 'complete') errors.push(`${operation.tool}: parameter review is incomplete`);
    // A registration whose response contract disagrees with the reviewed outer result
    // fails every real call in validateOuter while every argument still matches, so the
    // fixtures alone would never see it.
    if (reviewedShapes[manifest.outer_result.driver] !== operation.response.shape) {
      errors.push(`${operation.tool}: response shape ${operation.response.shape} disagrees with reviewed ${manifest.outer_result.driver}`);
    }
    const modes: CallMode[] = operation.pagination.kind === 'none' ? ['single'] : ['page', 'all'];
    const controlled = operation.pagination.kind !== 'none';
    for (const parameter of manifest.parameters) {
      const destination = parameter.driver;
      if (destination === null) continue; // Call selection is verified by fixtures, not an upstream argument.
      const applicableModes = operation.pagination.kind === 'none' ? ['single']
        : parameter.scope === 'mcp' ? ['all']
        : parameter.scope === 'query' && ['limit', 'offset'].includes(parameter.input_path[1] ?? '') ? ['page']
          : modes;
      for (const mode of applicableModes) {
        const mapped = operation.argumentMap.some((mapping) => {
          if (mapping.call !== mode || mapping.argument !== destination.argument) return false;
          const source = parts(mapping.input);
          if (!source.every((part, index) => part === parameter.input_path[index])) return false;
          const target = [...(mapping.property === undefined ? [] : parts(mapping.property)), ...parameter.input_path.slice(source.length)];
          return target.length === destination.path.length && target.every((part, index) => part === destination.path[index]);
        });
        if (!mapped) errors.push(`${operation.tool}: no ${mode} argument mapping for ${parameter.id}`);
        // Declaring the mapping is not exercising it. Without a fixture that actually
        // carries the parameter in this mode, a branch that silently drops it still
        // matches every argument list the manifest promises.
        const exercised = manifest.cases.some((fixture) => fixture.expect.kind === 'accepted'
          && fixtureMode(fixture.input, controlled) === mode && supplies(fixture.input, parameter.input_path));
        if (!exercised) errors.push(`${operation.tool}: no accepted ${mode} fixture supplies ${parameter.id}`);
      }
    }
    const validateJson = new AjvJsonSchemaValidator().getValidator(operation.jsonSchema as unknown as JsonSchemaType);
    const exercisedModes = new Set<CallMode>();
    for (const fixture of manifest.cases) {
      const accepted = fixture.expect.kind === 'accepted';
      if (operation.inputSchema.safeParse(fixture.input).success !== accepted) errors.push(`${operation.tool}: runtime schema disagrees with fixture ${fixture.id}`);
      if (validateJson(fixture.input).valid !== accepted) errors.push(`${operation.tool}: JSON Schema disagrees with fixture ${fixture.id}`);
      if (fixture.expect.kind === 'accepted') {
        const control = fixture.input._mcp;
        const mode = operation.pagination.kind === 'none' ? 'single'
          : typeof control === 'object' && control !== null && !Array.isArray(control) && control.pagination === 'all' ? 'all' : 'page';
        const call = operation.pagination.kind === 'none' ? operation.pagination.single
          : mode === 'all' ? operation.pagination.all : operation.pagination.page;
        if (fixture.expect.driver.binding !== call.binding) {
          errors.push(`${operation.tool}: fixture ${fixture.id} expects ${fixture.expect.driver.binding}, but ${mode} mode selects ${call.binding}`);
        } else {
          exercisedModes.add(mode);
        }
      }
    }
    for (const mode of modes) if (!exercisedModes.has(mode)) errors.push(`${operation.tool}: no accepted ${mode} fixture`);
  }
  return errors;
}
