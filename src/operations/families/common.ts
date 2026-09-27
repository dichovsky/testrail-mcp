import { SoftDeletePreviewSchema, type UploadFilePathInput } from '@dichovsky/testrail-api-client';
import { z } from 'zod';
import { AdapterError } from '../../contracts/errors.js';
import type { AllControls } from '../../contracts/pagination.js';
import type { CallContext } from '../driver-call.js';
import type { ArgumentMapping, PreviewContract } from '../registry.js';

/** A usable JSON object response; entity fields are checked advisorily, not here. */
export const recordResponse = z.record(z.string(), z.unknown());
/** The driver's normalized page, whichever shape TestRail actually returned. */
export const pageResponse = z.object({
  kind: z.enum(['envelope', 'legacy-array']),
  items: z.array(z.unknown()),
});

/**
 * The soft-delete preview shared by delete_case, delete_cases, delete_section,
 * delete_suite and delete_run: `query.soft` true asks TestRail what the delete would
 * remove instead of removing it.
 *
 * The counters are checked against the driver's own preview schema so drift is reported
 * rather than invisible, and are its seven affected-entity counts. A reply carrying none
 * of them with a value is not an empty preview: a TestRail that ignores the flag deletes
 * and answers just the same, so it is reported as an unknown outcome instead.
 */
export const softDeletePreview: PreviewContract = {
  requested: (input) => typeof input === 'object' && input !== null
    && flag((input as { query?: object }).query, 'soft') === true,
  entitySchema: SoftDeletePreviewSchema,
  counters: Object.keys(SoftDeletePreviewSchema.shape),
};

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

/**
 * The safety bounds every aggregate accepts, whichever paging the endpoint supports.
 *
 * A response-driven list takes only these: it has no documented request controls, so
 * the driver chooses each page itself and a page size or start offset would be a
 * control the endpoint does not have.
 */
export function safetyControlMappings(argument: number): readonly ArgumentMapping[] {
  return [
    { input: '_mcp.max_items', call: 'all', argument, property: 'maxItems', serialization: 'aggregate-control' },
    { input: '_mcp.max_pages', call: 'all', argument, property: 'maxPages', serialization: 'aggregate-control' },
    { input: '_mcp.max_bytes', call: 'all', argument, property: 'maxBytes', serialization: 'aggregate-control' },
    { input: '_mcp.max_duration_ms', call: 'all', argument, property: 'maxDurationMs', serialization: 'aggregate-control' },
  ];
}

/** The aggregate bounds reach the same driver option names on every controlled list. */
export function aggregateControlMappings(argument: number): readonly ArgumentMapping[] {
  return [
    { input: '_mcp.page_size', call: 'all', argument, property: 'pageSize', serialization: 'aggregate-control' },
    { input: '_mcp.start_offset', call: 'all', argument, property: 'startOffset', serialization: 'aggregate-control' },
    ...safetyControlMappings(argument),
  ];
}

/**
 * The staged copy of the caller's file.
 *
 * The adapter stages an owned copy before the call and passes it here. Its absence
 * would mean the transport dispatched an upload it never staged, which is a fault in
 * this adapter rather than anything the caller did.
 */
export function staged(context: CallContext): UploadFilePathInput {
  if (context.upload === undefined) throw new AdapterError('INTERNAL_ERROR');
  return context.upload;
}
