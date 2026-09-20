import { describe, expect, it } from 'vitest';
import { z } from 'zod';
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

/** Whether a schema accepts a property under `name` at any depth. */
function admits(schema: z.ZodType, name: string, depth = 0): boolean {
  if (depth > 8) return false;
  const definition = (schema as unknown as { _zod?: { def?: Record<string, unknown> } })._zod?.def;
  if (definition === undefined) return false;
  if (definition['type'] === 'object') {
    const shape = (definition['shape'] ?? {}) as Record<string, z.ZodType>;
    for (const [key, value] of Object.entries(shape)) {
      // A z.never() property is a declared refusal, not an acceptance: naming the field
      // is how a registration says the field cannot be sent.
      if (key === name && !refuses(value)) return true;
      if (admits(value, name, depth + 1)) return true;
    }
    return false;
  }
  for (const key of ['innerType', 'element', 'valueType'] as const) {
    const nested = definition[key] as z.ZodType | undefined;
    if (nested !== undefined && admits(nested, name, depth + 1)) return true;
  }
  for (const option of (definition['options'] ?? []) as z.ZodType[]) {
    if (admits(option, name, depth + 1)) return true;
  }
  return false;
}

function refuses(schema: z.ZodType): boolean {
  const definition = (schema as unknown as { _zod?: { def?: Record<string, unknown> } })._zod?.def;
  const inner = definition?.['innerType'] as { _zod?: { def?: { type?: string } } } | undefined;
  return (inner?._zod?.def?.type ?? definition?.['type']) === 'never';
}

const operations = operationRegistry.entries.map((operation) => ({
  tool: operation.tool,
  token: operation.tool.replace('testrail_', ''),
  effects: operation.effects,
  annotations: operation.annotations,
  /** The pair that defines which cases a run covers. Narrowing it deletes tests. */
  selectsCoverage: admits(operation.inputSchema, 'include_all') && admits(operation.inputSchema, 'case_ids'),
}));

describe('published effect annotations', () => {
  it('registers every tool with an annotation that matches its declared effects', () => {
    for (const operation of operations) {
      expect(operation.annotations, operation.tool).toEqual({
        readOnlyHint: operation.effects.testRail === 'read',
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
