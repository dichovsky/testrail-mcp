import { describe, expect, it } from 'vitest';
import { operationRegistry } from '../src/operations/catalog.js';

/*
 * What a client is told before it calls.
 *
 * `effects.destructive` is published as the MCP `destructiveHint`, which is what a host
 * uses to decide whether to ask a person before invoking a tool. Nothing else in this
 * suite compares it against anything: the manifests describe arguments and replies, and
 * the registration audits compare response shapes. A wrong flag therefore passes every
 * other gate while quietly removing the confirmation a destructive call should get.
 *
 * These are invariants over the whole registry rather than a per-endpoint restatement.
 * A restatement would only move the claim from one file to another and could be edited
 * to agree with a mistake; a rule has to be argued with.
 */

/** Whether the published schema admits a declared property at any reachable depth. */
function admits(schema: unknown, name: string, root: unknown = schema, seen = new Set<unknown>()): boolean {
  if (schema === null || typeof schema !== 'object' || seen.has(schema)) return false;
  seen.add(schema);
  const node = schema as Record<string, unknown>;
  if (typeof node.$ref === 'string' && node.$ref.startsWith('#/')) {
    const target = node.$ref.slice(2).split('/').reduce<unknown>((value, part) => {
      const key = part.replaceAll('~1', '/').replaceAll('~0', '~');
      return typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined;
    }, root);
    if (admits(target, name, root, seen)) return true;
  }
  if (typeof node.properties === 'object' && node.properties !== null) {
    for (const [key, value] of Object.entries(node.properties)) {
      // An impossible property is a declared refusal, not an accepted field.
      if (key === name && !refuses(value)) return true;
      if (admits(value, name, root, seen)) return true;
    }
  }
  for (const key of ['items', 'additionalProperties']) {
    if (admits(node[key], name, root, seen)) return true;
  }
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    const alternatives = node[key];
    if (Array.isArray(alternatives) && alternatives.some((value) => admits(value, name, root, seen))) return true;
  }
  return false;
}

function refuses(schema: unknown): boolean {
  if (schema === false) return true;
  if (schema === null || typeof schema !== 'object') return false;
  const not = (schema as Record<string, unknown>).not;
  return not !== null && typeof not === 'object' && Object.keys(not).length === 0;
}

const operations = operationRegistry.entries.map((operation) => ({
  tool: operation.tool,
  token: operation.tool.replace('testrail_', ''),
  effects: operation.effects,
  files: operation.files,
  annotations: operation.annotations,
  /** The pair that defines which cases a run covers. Narrowing it deletes tests. */
  selectsCoverage: admits(operation.jsonSchema, 'include_all') && admits(operation.jsonSchema, 'case_ids'),
}));

describe('published effect annotations', () => {
  it('registers every tool with an annotation that matches its declared effects', () => {
    for (const operation of operations) {
      expect(operation.annotations, operation.tool).toEqual({
        // A download only reads TestRail but writes a new local file, so it is not read-only.
        readOnlyHint: operation.effects.testRail === 'read' && operation.files.kind === 'none',
        destructiveHint: operation.effects.destructive,
        idempotentHint: operation.effects.idempotent,
        openWorldHint: true,
      });
    }
  });

  it('marks every removal destructive', () => {
    const removals = operations.filter(({ token }) => token.startsWith('delete_') || token.startsWith('close_'));
    // Closing is a removal too: TestRail archives the runs and results and the object
    // can no longer be changed.
    expect(removals.length).toBeGreaterThan(0);
    expect(removals.filter(({ effects }) => !effects.destructive).map(({ tool }) => tool)).toEqual([]);
  });

  it('never marks a read destructive', () => {
    expect(operations
      .filter(({ effects }) => effects.testRail === 'read' && effects.destructive)
      .map(({ tool }) => tool)).toEqual([]);
  });

  /*
   * The rule the T06 review found broken. A write that can change which cases an
   * existing run covers deletes the tests that fall outside the new selection, and
   * their recorded results with them. Creating a run cannot do that, because there is
   * nothing to narrow, so the rule is limited to writes that are not creations.
   *
   * This is why it is stated as a rule: update_plan_entry shipped as non-destructive
   * while update_run and update_run_in_plan_entry, which destroy strictly less, were
   * both correctly flagged. Reading the three registrations side by side is the only
   * thing that shows the odd one out, and no gate was doing that.
   */
  it('marks a write destructive when it can narrow an existing run\'s case selection', () => {
    const narrowing = operations.filter(({ token, effects, selectsCoverage }) =>
      effects.testRail === 'write' && selectsCoverage && !token.startsWith('add_'));
    expect(narrowing.map(({ tool }) => tool)).toEqual([
      'testrail_update_plan_entry', 'testrail_update_run', 'testrail_update_run_in_plan_entry',
    ]);
    expect(narrowing.filter(({ effects }) => !effects.destructive).map(({ tool }) => tool)).toEqual([]);
  });

  /*
   * The same fields on a creating write are not destructive, and saying so keeps the
   * rule above from being read as "any tool mentioning case_ids is dangerous", which
   * would make every creation ask for confirmation it does not need.
   */
  it('does not mark a creation destructive for carrying the same selection fields', () => {
    const creations = operations.filter(({ token, selectsCoverage }) => token.startsWith('add_') && selectsCoverage);
    expect(creations.map(({ tool }) => tool)).toEqual([
      'testrail_add_plan', 'testrail_add_plan_entry', 'testrail_add_run', 'testrail_add_run_to_plan_entry',
    ]);
    expect(creations.filter(({ effects }) => effects.destructive).map(({ tool }) => tool)).toEqual([]);
  });
});
