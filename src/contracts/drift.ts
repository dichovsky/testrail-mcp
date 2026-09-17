import type { z } from 'zod';

export const WARNING_CODES = ['SCHEMA_DRIFT'] as const;
export type WarningCode = (typeof WARNING_CODES)[number];

export interface ResultWarning {
  readonly code: WarningCode;
  readonly count: number;
}

export const MAX_WARNINGS = 10;
/** Keep the count informative without turning a broad drift into an unbounded number. */
export const MAX_WARNING_COUNT = 1_000;

/**
 * Advisory entity validation, performed per caller against the original returned value.
 *
 * The parsed output is deliberately discarded: the caller receives what the driver
 * returned, including unknown fields and flat custom_* properties, and drift is
 * reported alongside rather than repaired. A shared driver hook cannot do this,
 * because coalesced GET joiners do not each trigger it — two concurrent callers of
 * the same read must each get their own warnings, so this is a plain function of
 * the value and runs once per caller.
 *
 * Only a bounded issue count crosses the boundary. Field names, paths and values
 * stay out: they are instance data.
 */
export function advisoryWarnings(
  entitySchema: z.ZodType | null,
  shape: string,
  value: unknown,
): readonly ResultWarning[] {
  if (entitySchema === null) return [];
  const items = (shape === 'array' || shape === 'page') && Array.isArray(value) ? value : [value];
  let issues = 0;
  for (const item of items) {
    const outcome = entitySchema.safeParse(item);
    if (!outcome.success) issues += outcome.error.issues.length;
    if (issues >= MAX_WARNING_COUNT) { issues = MAX_WARNING_COUNT; break; }
  }
  if (issues === 0) return [];
  return Object.freeze([Object.freeze({ code: 'SCHEMA_DRIFT' as const, count: issues })]);
}
