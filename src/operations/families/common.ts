import { z } from 'zod';
import type { AllControls } from '../../contracts/pagination.js';
import type { ArgumentMapping } from '../registry.js';

/** A usable JSON object response; entity fields are checked advisorily, not here. */
export const recordResponse = z.record(z.string(), z.unknown());
/** The driver's normalized page, whichever shape TestRail actually returned. */
export const pageResponse = z.object({
  kind: z.enum(['envelope', 'legacy-array']),
  items: z.array(z.unknown()),
});

/**
 * Read one control from a validated list input.
 *
 * The input type is a union of the page and all branches, so a field present in one is
 * absent from the other. These read it totally instead of asserting a shape: an
 * assertion here could hide a genuine mismatch, while the argument map declares the
 * mapping independently and the fixtures check the arguments actually sent.
 */
export function control(source: object | undefined, name: string): number | undefined {
  const value = (source as Record<string, unknown> | undefined)?.[name];
  return typeof value === 'number' ? value : undefined;
}

export function flag(source: object | undefined, name: string): boolean | undefined {
  const value = (source as Record<string, unknown> | undefined)?.[name];
  return typeof value === 'boolean' ? value : undefined;
}

/** Read the caller's aggregate controls; which bounds fill the gaps is decided by the caller. */
export function allControls(mcp: object | undefined): AllControls {
  return {
    page_size: control(mcp, 'page_size'),
    start_offset: control(mcp, 'start_offset'),
    max_items: control(mcp, 'max_items'),
    max_pages: control(mcp, 'max_pages'),
    max_bytes: control(mcp, 'max_bytes'),
    max_duration_ms: control(mcp, 'max_duration_ms'),
  };
}

/** The aggregate bounds reach the same driver option names on every controlled list. */
export function aggregateControlMappings(argument: number): readonly ArgumentMapping[] {
  return [
    { input: '_mcp.page_size', call: 'all', argument, property: 'pageSize', serialization: 'aggregate-control' },
    { input: '_mcp.start_offset', call: 'all', argument, property: 'startOffset', serialization: 'aggregate-control' },
    { input: '_mcp.max_items', call: 'all', argument, property: 'maxItems', serialization: 'aggregate-control' },
    { input: '_mcp.max_pages', call: 'all', argument, property: 'maxPages', serialization: 'aggregate-control' },
    { input: '_mcp.max_bytes', call: 'all', argument, property: 'maxBytes', serialization: 'aggregate-control' },
    { input: '_mcp.max_duration_ms', call: 'all', argument, property: 'maxDurationMs', serialization: 'aggregate-control' },
  ];
}
