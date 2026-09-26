import { AttachmentSchema } from '@dichovsky/testrail-api-client';
import { z } from 'zod';
import {
  attachmentIdSchema, contentTypeSchema, createListInput, entryIdSchema, filenameSchema, filePathSchema,
  positiveIdSchema, strictObject,
} from '../../contracts/inputs.js';
import { driverAllOptions, pageRequestDefaults } from '../../contracts/pagination.js';
import { driverCall } from '../driver-call.js';
import { defineOperation, type OperationDefinition } from '../registry.js';
import { aggregateControlMappings, allControls, control, pageResponse, recordResponse, staged } from './common.js';

/*
 * Attachments are the one family that moves files both ways. A download is a GET, but
 * every call writes a new file under the configured download directory, so it is
 * registered as a persistent download: not read-only and not idempotent, while TestRail
 * itself is only read and the driver's binary GET retries stay as they are. An upload
 * adds a new attachment each time and is never retried, by this server or by its
 * driver, since the multipart body is a consumed stream.
 *
 * TestRail's reference labels every attachment ID an integer, and also says TestRail
 * 7.1 (cloud) introduced a new format, which its list example shows as a UUID. The
 * driver accepts either and nothing else. It also accepts only a UUID for a plan entry,
 * which the reference labels an integer too.
 *
 * The case, plan and run lists document limit and offset and get page and all modes.
 * The test and plan-entry lists document neither and are not given them.
 */

const arrayResponse = z.array(z.unknown());

// ------------------------------------------------------------------ download

const getAttachmentInput = strictObject({ attachment_id: attachmentIdSchema });

export const getAttachment = defineOperation({
  token: 'get_attachment',
  method: 'GET',
  route: 'get_attachment/{attachment_id}',
  family: 'T12',
  driverBinding: 'attachments.getAttachment',
  summary: 'Download one TestRail attachment by its ID: a positive integer, or a UUID, the format TestRail introduced with release 7.1 (cloud). The testrail_get_attachments_for_* tools list the IDs with their names. The driver returns only the file\'s bytes, so the result carries no original filename or media type. Each call downloads the attachment again and writes another file, even for the same ID. One download runs at a time: a call made while another is in progress is refused as BUSY before anything is sent. TestRail answers 400 for an invalid attachment ID and 403 when the configured user has no access to the project.',
  inputSchema: getAttachmentInput,
  argumentMap: [{ input: 'attachment_id', call: 'single', argument: 0, serialization: 'path' }],
  response: { shape: 'binary', outerSchema: z.instanceof(ArrayBuffer), entitySchema: null },
  pagination: {
    kind: 'none',
    single: driverCall(getAttachmentInput, 'attachments.getAttachment', (method, input) => method(input.attachment_id)),
  },
  files: { kind: 'download' },
  // TestRail is only read; the new local file on every call is what makes this non-idempotent.
  effects: { testRail: 'read', destructive: false, idempotent: false },
  retry: 'ordinary-read',
} as const satisfies OperationDefinition);

// --------------------------------------------------------------------- lists

const getAttachmentsForCaseInput = createListInput({ path: { case_id: positiveIdSchema }, pagination: 'controlled' });

export const getAttachmentsForCase = defineOperation({
  token: 'get_attachments_for_case',
  method: 'GET',
  route: 'get_attachments_for_case/{case_id}',
  family: 'T12',
  driverBinding: 'attachments.getAttachmentsForCase',
  summary: 'List the attachments of a TestRail test case (TestRail 5.7 or later; limit and offset need 6.7 or later). Each entry carries the attachment\'s id, an integer or a UUID from release 7.1 (cloud) on, with its name, size and upload time; pass the id to testrail_get_attachment to download the file. TestRail answers 400 for an invalid case ID and 403 when the configured user has no access to the project.',
  inputSchema: getAttachmentsForCaseInput,
  argumentMap: [
    { input: 'case_id', call: 'page', argument: 0, serialization: 'path' },
    { input: 'query.limit', call: 'page', argument: 1, property: 'limit', serialization: 'query-scalar' },
    { input: 'query.offset', call: 'page', argument: 1, property: 'offset', serialization: 'query-scalar' },
    { input: 'case_id', call: 'all', argument: 0, serialization: 'path' },
    ...aggregateControlMappings(1),
  ],
  response: { shape: 'page', outerSchema: pageResponse, entitySchema: AttachmentSchema },
  pagination: {
    kind: 'controlled',
    page: driverCall(getAttachmentsForCaseInput, 'attachments.getAttachmentsForCasePage', (method, input) => method(
      input.case_id,
      pageRequestDefaults({ limit: control(input.query, 'limit'), offset: control(input.query, 'offset') }),
    )),
    all: driverCall(getAttachmentsForCaseInput, 'attachments.getAllAttachmentsForCase', (method, input, context) => method(
      input.case_id,
      driverAllOptions(allControls(input._mcp), context.limits),
    )),
  },
  files: { kind: 'none' },
  effects: { testRail: 'read', destructive: false, idempotent: true },
  retry: 'ordinary-read',
} as const satisfies OperationDefinition);

const getAttachmentsForPlanInput = createListInput({ path: { plan_id: positiveIdSchema }, pagination: 'controlled' });

export const getAttachmentsForPlan = defineOperation({
  token: 'get_attachments_for_plan',
  method: 'GET',
  route: 'get_attachments_for_plan/{plan_id}',
  family: 'T12',
  driverBinding: 'attachments.getAttachmentsForPlan',
  summary: 'List the attachments added to a TestRail test plan itself (TestRail 6.3 or later; limit and offset need 6.7 or later). Each entry carries the attachment\'s id, with its name, size and upload time; pass the id to testrail_get_attachment to download the file. An entry of the plan has its own list, testrail_get_attachments_for_plan_entry. TestRail answers 400 for an invalid ID and 403 when the configured user has no access to the project.',
  inputSchema: getAttachmentsForPlanInput,
  argumentMap: [
    { input: 'plan_id', call: 'page', argument: 0, serialization: 'path' },
    { input: 'query.limit', call: 'page', argument: 1, property: 'limit', serialization: 'query-scalar' },
    { input: 'query.offset', call: 'page', argument: 1, property: 'offset', serialization: 'query-scalar' },
    { input: 'plan_id', call: 'all', argument: 0, serialization: 'path' },
    ...aggregateControlMappings(1),
  ],
  response: { shape: 'page', outerSchema: pageResponse, entitySchema: AttachmentSchema },
  pagination: {
    kind: 'controlled',
    page: driverCall(getAttachmentsForPlanInput, 'attachments.getAttachmentsForPlanPage', (method, input) => method(
      input.plan_id,
      pageRequestDefaults({ limit: control(input.query, 'limit'), offset: control(input.query, 'offset') }),
    )),
    all: driverCall(getAttachmentsForPlanInput, 'attachments.getAllAttachmentsForPlan', (method, input, context) => method(
      input.plan_id,
      driverAllOptions(allControls(input._mcp), context.limits),
    )),
  },
  files: { kind: 'none' },
  effects: { testRail: 'read', destructive: false, idempotent: true },
  retry: 'ordinary-read',
} as const satisfies OperationDefinition);

const getAttachmentsForPlanEntryInput = strictObject({ plan_id: positiveIdSchema, entry_id: entryIdSchema });

export const getAttachmentsForPlanEntry = defineOperation({
  token: 'get_attachments_for_plan_entry',
  method: 'GET',
  route: 'get_attachments_for_plan_entry/{plan_id}/{entry_id}',
  family: 'T12',
  driverBinding: 'attachments.getAttachmentsForPlanEntry',
  summary: 'List the attachments of one entry of a TestRail test plan (TestRail 6.3 or later). entry_id is the entry\'s UUID, as testrail_get_plan returns it in entries[].id. TestRail\'s reference labels it an integer, but the driver accepts only a UUID and records that TestRail refuses a numeric one with 400. TestRail documents no limit or offset here. It answers 400 for an invalid ID and 403 when the configured user has no access to the project.',
  inputSchema: getAttachmentsForPlanEntryInput,
  argumentMap: [
    { input: 'plan_id', call: 'single', argument: 0, serialization: 'path' },
    { input: 'entry_id', call: 'single', argument: 1, serialization: 'path' },
  ],
  response: { shape: 'array', outerSchema: arrayResponse, entitySchema: AttachmentSchema },
  pagination: {
    kind: 'none',
    single: driverCall(getAttachmentsForPlanEntryInput, 'attachments.getAttachmentsForPlanEntry',
      (method, input) => method(input.plan_id, input.entry_id)),
  },
  files: { kind: 'none' },
  effects: { testRail: 'read', destructive: false, idempotent: true },
  retry: 'ordinary-read',
} as const satisfies OperationDefinition);

const getAttachmentsForRunInput = createListInput({ path: { run_id: positiveIdSchema }, pagination: 'controlled' });

export const getAttachmentsForRun = defineOperation({
  token: 'get_attachments_for_run',
  method: 'GET',
  route: 'get_attachments_for_run/{run_id}',
  family: 'T12',
  driverBinding: 'attachments.getAttachmentsForRun',
  summary: 'List the attachments added to a TestRail test run (TestRail 6.3 or later; limit and offset need 6.7 or later). Each entry carries the attachment\'s id, with its name, size and upload time; pass the id to testrail_get_attachment to download the file. TestRail answers 400 for an invalid ID and 403 when the configured user has no access to the project.',
  inputSchema: getAttachmentsForRunInput,
  argumentMap: [
    { input: 'run_id', call: 'page', argument: 0, serialization: 'path' },
    { input: 'query.limit', call: 'page', argument: 1, property: 'limit', serialization: 'query-scalar' },
    { input: 'query.offset', call: 'page', argument: 1, property: 'offset', serialization: 'query-scalar' },
    { input: 'run_id', call: 'all', argument: 0, serialization: 'path' },
    ...aggregateControlMappings(1),
  ],
  response: { shape: 'page', outerSchema: pageResponse, entitySchema: AttachmentSchema },
  pagination: {
    kind: 'controlled',
    page: driverCall(getAttachmentsForRunInput, 'attachments.getAttachmentsForRunPage', (method, input) => method(
      input.run_id,
      pageRequestDefaults({ limit: control(input.query, 'limit'), offset: control(input.query, 'offset') }),
    )),
    all: driverCall(getAttachmentsForRunInput, 'attachments.getAllAttachmentsForRun', (method, input, context) => method(
      input.run_id,
      driverAllOptions(allControls(input._mcp), context.limits),
    )),
  },
  files: { kind: 'none' },
  effects: { testRail: 'read', destructive: false, idempotent: true },
  retry: 'ordinary-read',
} as const satisfies OperationDefinition);

const getAttachmentsForTestInput = strictObject({ test_id: positiveIdSchema });

export const getAttachmentsForTest = defineOperation({
  token: 'get_attachments_for_test',
  method: 'GET',
  route: 'get_attachments_for_test/{test_id}',
  family: 'T12',
  driverBinding: 'attachments.getAttachmentsForTest',
  summary: 'List the attachments of a TestRail test\'s results (TestRail 5.7 or later). Each entry carries the attachment\'s id and the result_id it belongs to; pass the id to testrail_get_attachment to download the file. TestRail documents no limit or offset for this endpoint, yet gives its reply the format of get_attachments_for_case, which is paged. If TestRail pages it, only the attachments in that one reply are returned, with no sign that more exist, because the driver method returns the list alone. TestRail answers 400 for an invalid test ID and 403 when the configured user has no access to the project.',
  inputSchema: getAttachmentsForTestInput,
  argumentMap: [{ input: 'test_id', call: 'single', argument: 0, serialization: 'path' }],
  response: { shape: 'array', outerSchema: arrayResponse, entitySchema: AttachmentSchema },
  pagination: {
    kind: 'none',
    single: driverCall(getAttachmentsForTestInput, 'attachments.getAttachmentsForTest', (method, input) => method(input.test_id)),
  },
  files: { kind: 'none' },
  effects: { testRail: 'read', destructive: false, idempotent: true },
  retry: 'ordinary-read',
} as const satisfies OperationDefinition);

// ------------------------------------------------------------------- uploads

/** Every upload takes the caller's path, the name TestRail records and an optional media type. */
const uploadFields = {
  file_path: filePathSchema,
  filename: filenameSchema,
  content_type: contentTypeSchema.optional(),
};

/*
 * The same sentences close every upload summary, because the same driver pipeline and
 * the same staging carry each of them.
 */
const uploadContract = 'filename is the name TestRail records, and content_type, when given, is sent as the part\'s media type. Each call adds another attachment, even for the same file, and TestRail answers with the new attachment_id. TestRail accepts files up to 256 MB, but this server refuses a file above its configured file limit, at most 100 MiB, before anything is sent. Neither this server nor its driver retries an upload, not even after a 429: if it fails after the request was sent, write_outcome is unknown, and uploading again may add a second attachment.';

const addAttachmentToCaseInput = strictObject({ case_id: positiveIdSchema, ...uploadFields });

export const addAttachmentToCase = defineOperation({
  token: 'add_attachment_to_case',
  method: 'POST',
  route: 'add_attachment_to_case/{case_id}',
  family: 'T12',
  driverBinding: 'attachments.addAttachmentToCase',
  summary: `Upload a local file as a new attachment on a TestRail test case (TestRail 6.5.2 or later). ${uploadContract} TestRail answers 400 for an invalid or unknown test case and 403 when the configured user has no access to the project.`,
  inputSchema: addAttachmentToCaseInput,
  argumentMap: [
    { input: 'case_id', call: 'single', argument: 0, serialization: 'path' },
    { input: 'file_path', call: 'single', argument: 1, property: 'path', serialization: 'staged-file' },
    { input: 'content_type', call: 'single', argument: 1, property: 'type', serialization: 'multipart' },
    { input: 'filename', call: 'single', argument: 2, serialization: 'multipart' },
  ],
  response: { shape: 'record', outerSchema: recordResponse, entitySchema: AttachmentSchema },
  pagination: {
    kind: 'none',
    single: driverCall(addAttachmentToCaseInput, 'attachments.addAttachmentToCase',
      (method, input, context) => method(input.case_id, staged(context), input.filename)),
  },
  files: { kind: 'upload', featureFilename: false },
  effects: { testRail: 'write', destructive: false, idempotent: false },
  retry: 'never',
} as const satisfies OperationDefinition);

const addAttachmentToPlanInput = strictObject({ plan_id: positiveIdSchema, ...uploadFields });

export const addAttachmentToPlan = defineOperation({
  token: 'add_attachment_to_plan',
  method: 'POST',
  route: 'add_attachment_to_plan/{plan_id}',
  family: 'T12',
  driverBinding: 'attachments.addAttachmentToPlan',
  summary: `Upload a local file as a new attachment on a TestRail test plan itself (TestRail 6.3 or later); testrail_add_attachment_to_plan_entry attaches to one of its entries. ${uploadContract} TestRail answers 400 for an invalid or unknown test plan and 403 when the configured user has no access to the project.`,
  inputSchema: addAttachmentToPlanInput,
  argumentMap: [
    { input: 'plan_id', call: 'single', argument: 0, serialization: 'path' },
    { input: 'file_path', call: 'single', argument: 1, property: 'path', serialization: 'staged-file' },
    { input: 'content_type', call: 'single', argument: 1, property: 'type', serialization: 'multipart' },
    { input: 'filename', call: 'single', argument: 2, serialization: 'multipart' },
  ],
  response: { shape: 'record', outerSchema: recordResponse, entitySchema: AttachmentSchema },
  pagination: {
    kind: 'none',
    single: driverCall(addAttachmentToPlanInput, 'attachments.addAttachmentToPlan',
      (method, input, context) => method(input.plan_id, staged(context), input.filename)),
  },
  files: { kind: 'upload', featureFilename: false },
  effects: { testRail: 'write', destructive: false, idempotent: false },
  retry: 'never',
} as const satisfies OperationDefinition);

const addAttachmentToPlanEntryInput = strictObject({ plan_id: positiveIdSchema, entry_id: entryIdSchema, ...uploadFields });

export const addAttachmentToPlanEntry = defineOperation({
  token: 'add_attachment_to_plan_entry',
  method: 'POST',
  route: 'add_attachment_to_plan_entry/{plan_id}/{entry_id}',
  family: 'T12',
  driverBinding: 'attachments.addAttachmentToPlanEntry',
  summary: `Upload a local file as a new attachment on one entry of a TestRail test plan (TestRail 6.3 or later). entry_id is the entry's UUID, as testrail_get_plan returns it in entries[].id; TestRail's reference labels it an integer, but the driver accepts only a UUID. ${uploadContract} TestRail answers 400 for a malformed request or an invalid ID and 403 when the configured user has no access to the project or lacks permission.`,
  inputSchema: addAttachmentToPlanEntryInput,
  argumentMap: [
    { input: 'plan_id', call: 'single', argument: 0, serialization: 'path' },
    { input: 'entry_id', call: 'single', argument: 1, serialization: 'path' },
    { input: 'file_path', call: 'single', argument: 2, property: 'path', serialization: 'staged-file' },
    { input: 'content_type', call: 'single', argument: 2, property: 'type', serialization: 'multipart' },
    { input: 'filename', call: 'single', argument: 3, serialization: 'multipart' },
  ],
  response: { shape: 'record', outerSchema: recordResponse, entitySchema: AttachmentSchema },
  pagination: {
    kind: 'none',
    single: driverCall(addAttachmentToPlanEntryInput, 'attachments.addAttachmentToPlanEntry',
      (method, input, context) => method(input.plan_id, input.entry_id, staged(context), input.filename)),
  },
  files: { kind: 'upload', featureFilename: false },
  effects: { testRail: 'write', destructive: false, idempotent: false },
  retry: 'never',
} as const satisfies OperationDefinition);

const addAttachmentToResultInput = strictObject({ result_id: positiveIdSchema, ...uploadFields });

export const addAttachmentToResult = defineOperation({
  token: 'add_attachment_to_result',
  method: 'POST',
  route: 'add_attachment_to_result/{result_id}',
  family: 'T12',
  driverBinding: 'attachments.addAttachmentToResult',
  summary: `Upload a local file as a new attachment on a TestRail test result (TestRail 5.7 or later). TestRail requires the ability to edit test results to be enabled under Site Settings for this endpoint to work. ${uploadContract} TestRail answers 400 for a malformed request or an invalid result ID and 403 when the configured user has no access to the project or lacks permission.`,
  inputSchema: addAttachmentToResultInput,
  argumentMap: [
    { input: 'result_id', call: 'single', argument: 0, serialization: 'path' },
    { input: 'file_path', call: 'single', argument: 1, property: 'path', serialization: 'staged-file' },
    { input: 'content_type', call: 'single', argument: 1, property: 'type', serialization: 'multipart' },
    { input: 'filename', call: 'single', argument: 2, serialization: 'multipart' },
  ],
  response: { shape: 'record', outerSchema: recordResponse, entitySchema: AttachmentSchema },
  pagination: {
    kind: 'none',
    single: driverCall(addAttachmentToResultInput, 'attachments.addAttachmentToResult',
      (method, input, context) => method(input.result_id, staged(context), input.filename)),
  },
  files: { kind: 'upload', featureFilename: false },
  effects: { testRail: 'write', destructive: false, idempotent: false },
  retry: 'never',
} as const satisfies OperationDefinition);

const addAttachmentToRunInput = strictObject({ run_id: positiveIdSchema, ...uploadFields });

export const addAttachmentToRun = defineOperation({
  token: 'add_attachment_to_run',
  method: 'POST',
  route: 'add_attachment_to_run/{run_id}',
  family: 'T12',
  driverBinding: 'attachments.addAttachmentToRun',
  summary: `Upload a local file as a new attachment on a TestRail test run (TestRail 6.3 or later). ${uploadContract} TestRail answers 400 for a malformed request or an invalid run ID and 403 when the configured user has no access to the project or lacks permission.`,
  inputSchema: addAttachmentToRunInput,
  argumentMap: [
    { input: 'run_id', call: 'single', argument: 0, serialization: 'path' },
    { input: 'file_path', call: 'single', argument: 1, property: 'path', serialization: 'staged-file' },
    { input: 'content_type', call: 'single', argument: 1, property: 'type', serialization: 'multipart' },
    { input: 'filename', call: 'single', argument: 2, serialization: 'multipart' },
  ],
  response: { shape: 'record', outerSchema: recordResponse, entitySchema: AttachmentSchema },
  pagination: {
    kind: 'none',
    single: driverCall(addAttachmentToRunInput, 'attachments.addAttachmentToRun',
      (method, input, context) => method(input.run_id, staged(context), input.filename)),
  },
  files: { kind: 'upload', featureFilename: false },
  effects: { testRail: 'write', destructive: false, idempotent: false },
  retry: 'never',
} as const satisfies OperationDefinition);

// -------------------------------------------------------------------- delete

const deleteAttachmentInput = strictObject({ attachment_id: attachmentIdSchema });

export const deleteAttachment = defineOperation({
  token: 'delete_attachment',
  method: 'POST',
  route: 'delete_attachment/{attachment_id}',
  family: 'T12',
  driverBinding: 'attachments.deleteAttachment',
  summary: 'Delete a TestRail attachment by its ID: a positive integer, or a UUID from release 7.1 (cloud) on, as the testrail_get_attachments_for_* tools list them (TestRail 5.7 or later). TestRail answers an empty 200 on success, 400 for an invalid attachment ID and 403 when the configured user has no access to the project or lacks permission.',
  inputSchema: deleteAttachmentInput,
  argumentMap: [{ input: 'attachment_id', call: 'single', argument: 0, serialization: 'path' }],
  response: { shape: 'void', outerSchema: z.undefined(), entitySchema: null },
  pagination: {
    kind: 'none',
    single: driverCall(deleteAttachmentInput, 'attachments.deleteAttachment', (method, input) => method(input.attachment_id)),
  },
  files: { kind: 'none' },
  // The attachment is gone once TestRail accepts this, and a repeat names one that no longer exists.
  effects: { testRail: 'write', destructive: true, idempotent: false },
  retry: 'json-write',
} as const satisfies OperationDefinition);

/** Registered in tool-name order by the registry; listed here in reviewed order. */
export const t12 = [
  getAttachment,
  getAttachmentsForCase, getAttachmentsForPlan, getAttachmentsForPlanEntry, getAttachmentsForRun, getAttachmentsForTest,
  addAttachmentToCase, addAttachmentToPlan, addAttachmentToPlanEntry, addAttachmentToResult, addAttachmentToRun,
  deleteAttachment,
] as const;
