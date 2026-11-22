import { SoftDeletePreviewSchema, type UploadFilePathInput } from '@dichovsky/testrail-api-client';
import { z } from 'zod';
import { AdapterError } from '../../contracts/errors.js';
import type { CallContext } from '../driver-call.js';
import type { PreviewContract } from '../registry.js';

/** A usable JSON object response; entity fields are checked advisorily, not here. */
export const recordResponse = z.record(z.string(), z.unknown());

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

export function flag(source: object | undefined, name: string): boolean | undefined {
  const value = (source as Record<string, unknown> | undefined)?.[name];
  return typeof value === 'boolean' ? value : undefined;
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
