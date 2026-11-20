import {
  AddCasePayloadSchema, AddCasesBulkPayloadSchema, CaseSchema, CaseTitleSchema, CopyCasesToSectionPayloadSchema,
  DeleteCasesPayloadSchema, HistoryEntrySchema, MoveCasesToSectionPayloadSchema, UpdateCasePayloadSchema,
  UpdateCasesPayloadSchema, type GetCasesOptions,
} from '@dichovsky/testrail-api-client';
import { z } from 'zod';
import {
  caseIdsSchema, idFilterSchema, nonnegativeIntegerSchema, payloadArray, payloadInput,
  positiveIdSchema, strictObject,
} from '../../contracts/inputs.js';
import { defineOperation } from '../registry.js';
import { createListDefinition, type ListFilters } from '../lists.js';
import { flag, recordResponse, softDeletePreview } from './common.js';

const getCaseInput = strictObject({ case_id: positiveIdSchema });

export const getCase = defineOperation({
  token: 'get_case',
  method: 'GET',
  route: 'get_case/{case_id}',
  family: 'T02',
  driverBinding: 'cases.getCase',
  summary: 'Get a single TestRail test case by its ID. Custom fields are returned as flat custom_* properties.',
  inputSchema: getCaseInput,
  argumentMap: [{ input: 'case_id', call: 'single', argument: 0, serialization: 'path' }],
  response: { shape: 'record', outerSchema: recordResponse, entitySchema: CaseSchema },
  pagination: (bind) => ({
    kind: 'none',
    single: bind('cases.getCase', (method, input) => method(input.case_id)),
  }),
  files: { kind: 'none' },
  effects: { testRail: 'read', destructive: false, idempotent: true },
  retry: 'ordinary-read',
});

/** One reference sends refs=; several send the repeated refs[] form TestRail 10.7 accepts. */
const caseRefsSchema = z.union([z.string(), z.array(z.string()).min(1)]);

// Timestamps are Unix seconds. The driver forwards any number for them, so the
// integer bound is held here.
const getCasesList = createListDefinition({
  path: { project_id: { schema: positiveIdSchema, argument: 0 } },
  pagination: 'controlled',
  optionsArgument: 1,
  filters: {
    suite_id: { schema: positiveIdSchema.optional(), property: 'suiteId', serialization: 'query-scalar' },
    section_id: { schema: positiveIdSchema.optional(), property: 'sectionId', serialization: 'query-scalar' },
    type_id: { schema: idFilterSchema.optional(), property: 'typeId', serialization: 'query-list' },
    priority_id: { schema: idFilterSchema.optional(), property: 'priorityId', serialization: 'query-list' },
    template_id: { schema: idFilterSchema.optional(), property: 'templateId', serialization: 'query-list' },
    milestone_id: { schema: idFilterSchema.optional(), property: 'milestoneId', serialization: 'query-list' },
    created_after: { schema: nonnegativeIntegerSchema.optional(), property: 'createdAfter', serialization: 'query-scalar' },
    created_before: { schema: nonnegativeIntegerSchema.optional(), property: 'createdBefore', serialization: 'query-scalar' },
    created_by: { schema: idFilterSchema.optional(), property: 'createdBy', serialization: 'query-list' },
    filter: { schema: z.string().optional(), property: 'filter', serialization: 'query-scalar' },
    updated_after: { schema: nonnegativeIntegerSchema.optional(), property: 'updatedAfter', serialization: 'query-scalar' },
    updated_before: { schema: nonnegativeIntegerSchema.optional(), property: 'updatedBefore', serialization: 'query-scalar' },
    updated_by: { schema: idFilterSchema.optional(), property: 'updatedBy', serialization: 'query-list' },
    label_id: { schema: idFilterSchema.optional(), property: 'labelId', serialization: 'query-list' },
    refs: { schema: caseRefsSchema.optional(), property: 'refs', serialization: 'query-repeated' },
  } satisfies ListFilters<GetCasesOptions>,
  entitySchema: CaseSchema,
});

export const getCases = defineOperation({
  token: 'get_cases',
  method: 'GET',
  route: 'get_cases/{project_id}',
  family: 'T02',
  driverBinding: 'cases.getCases',
  summary: 'List the test cases of a TestRail project, optionally within one suite or section and filtered by type, priority, template, milestone, label, creator, updater, creation or update time (Unix seconds), a title substring (filter) or references (refs). An ID filter takes one ID or a non-empty array. The suite is required unless the project runs in single-suite mode. Custom fields are returned as flat custom_* properties.',
  ...getCasesList.bind({
    page: {
      binding: 'cases.getCasesPage',
      call: (method, input, options) => method(input.project_id, options),
    },
    all: {
      binding: 'cases.getAllCases',
      call: (method, input, options) => method(input.project_id, options),
    },
  }),
  files: { kind: 'none' },
  effects: { testRail: 'read', destructive: false, idempotent: true },
  retry: 'ordinary-read',
});

const getCaseTitlesInput = strictObject({ query: strictObject({ case_ids: caseIdsSchema }) });

export const getCaseTitles = defineOperation({
  token: 'get_case_titles',
  method: 'GET',
  route: 'get_case_titles',
  family: 'T02',
  driverBinding: 'cases.getCaseTitles',
  summary: 'Resolve TestRail case IDs to their titles in one call (TestRail 10.5 or later). query.case_ids takes one or more IDs; each result carries id and title only.',
  inputSchema: getCaseTitlesInput,
  argumentMap: [{ input: 'query.case_ids', call: 'single', argument: 0, serialization: 'query-list' }],
  response: { shape: 'array', outerSchema: z.array(z.unknown()), entitySchema: CaseTitleSchema },
  pagination: (bind) => ({
    kind: 'none',
    single: bind('cases.getCaseTitles', (method, input) => method(input.query.case_ids)),
  }),
  files: { kind: 'none' },
  effects: { testRail: 'read', destructive: false, idempotent: true },
  retry: 'ordinary-read',
});

const getHistoryForCaseList = createListDefinition({
  path: { case_id: { schema: positiveIdSchema, argument: 0 } },
  pagination: 'controlled',
  optionsArgument: 1,
  entitySchema: HistoryEntrySchema,
});

export const getHistoryForCase = defineOperation({
  token: 'get_history_for_case',
  method: 'GET',
  route: 'get_history_for_case/{case_id}',
  family: 'T02',
  driverBinding: 'cases.getHistoryForCase',
  summary: 'List the change history of a TestRail test case (TestRail 6.5.4 or later). Each entry records who changed which fields, with the old and new values.',
  ...getHistoryForCaseList.bind({
    page: {
      binding: 'cases.getHistoryForCasePage',
      call: (method, input, options) => method(input.case_id, options),
    },
    all: {
      binding: 'cases.getAllHistoryForCase',
      call: (method, input, options) => method(input.case_id, options),
    },
  }),
  files: { kind: 'none' },
  effects: { testRail: 'read', destructive: false, idempotent: true },
  retry: 'ordinary-read',
});

// The driver forwards any number for these; a fractional, non-positive or unsafe value can
// never name an existing template, type, priority, milestone or section, so they are held
// to the identifier domain. A label is named by its ID or its title.
//
// TestRail reads custom values only as flat custom_* properties. The driver's exported
// payloads also carry a nested custom_fields object that TestRail does not document;
// forwarding it would drop the caller's values silently, so it is refused instead.
const caseBodyFields = {
  template_id: positiveIdSchema.optional(),
  type_id: positiveIdSchema.optional(),
  priority_id: positiveIdSchema.optional(),
  milestone_id: positiveIdSchema.optional(),
  labels: z.array(z.union([positiveIdSchema, z.string()])).optional(),
  custom_fields: z.never().optional(),
};

const addCaseBody = payloadInput(AddCasePayloadSchema, { extensions: 'custom', fields: caseBodyFields });
const addCaseInput = strictObject({ section_id: positiveIdSchema, body: addCaseBody });

export const addCase = defineOperation({
  token: 'add_case',
  method: 'POST',
  route: 'add_case/{section_id}',
  family: 'T02',
  driverBinding: 'cases.addCase',
  summary: 'Create a test case in a TestRail section. Custom fields go in the body as flat custom_* properties with their JSON values.',
  inputSchema: addCaseInput,
  argumentMap: [
    { input: 'section_id', call: 'single', argument: 0, serialization: 'path' },
    { input: 'body', call: 'single', argument: 1, serialization: 'json-body' },
  ],
  response: { shape: 'record', outerSchema: recordResponse, entitySchema: CaseSchema },
  pagination: (bind) => ({
    kind: 'none',
    single: bind('cases.addCase', (method, input) => method(input.section_id, input.body)),
  }),
  files: { kind: 'none' },
  // Repeating the call creates another case, so this is not idempotent.
  effects: { testRail: 'write', destructive: false, idempotent: false },
  retry: 'json-write',
});

const addCasesInput = strictObject({
  section_id: positiveIdSchema,
  body: payloadArray(AddCasesBulkPayloadSchema, addCaseBody),
});

export const addCases = defineOperation({
  token: 'add_cases',
  method: 'POST',
  route: 'add_cases/{section_id}',
  family: 'T02',
  driverBinding: 'cases.addCases',
  summary: 'Create several test cases in one TestRail section with a single call. body is a non-empty array of case objects as accepted by add_case. Returns the created cases. If TestRail answers with an unrecognized shape the cases may still have been created, so the outcome is reported as unknown rather than retried.',
  inputSchema: addCasesInput,
  argumentMap: [
    { input: 'section_id', call: 'single', argument: 0, serialization: 'path' },
    { input: 'body', call: 'single', argument: 1, serialization: 'json-body' },
  ],
  // The driver unwraps TestRail's { cases: [...] } reply and fails closed on any other.
  response: { shape: 'array', outerSchema: z.array(z.unknown()), entitySchema: CaseSchema },
  pagination: (bind) => ({
    kind: 'none',
    single: bind('cases.addCases', (method, input) => method(input.section_id, input.body)),
  }),
  files: { kind: 'none' },
  // Repeating the call creates the cases again, so this is not idempotent.
  effects: { testRail: 'write', destructive: false, idempotent: false },
  retry: 'json-write',
});

const updateCaseInput = strictObject({
  case_id: positiveIdSchema,
  body: payloadInput(UpdateCasePayloadSchema, {
    extensions: 'custom',
    fields: { section_id: positiveIdSchema.optional(), ...caseBodyFields },
  }),
});

export const updateCase = defineOperation({
  token: 'update_case',
  method: 'POST',
  route: 'update_case/{case_id}',
  family: 'T02',
  driverBinding: 'cases.updateCase',
  summary: 'Update a TestRail test case. Supplied fields replace their current values and the rest are left unchanged; custom fields go in the body as flat custom_* properties. Changing section_id moves the case (TestRail 6.5.2 or later).',
  inputSchema: updateCaseInput,
  argumentMap: [
    { input: 'case_id', call: 'single', argument: 0, serialization: 'path' },
    { input: 'body', call: 'single', argument: 1, serialization: 'json-body' },
  ],
  response: { shape: 'record', outerSchema: recordResponse, entitySchema: CaseSchema },
  pagination: (bind) => ({
    kind: 'none',
    single: bind('cases.updateCase', (method, input) => method(input.case_id, input.body)),
  }),
  files: { kind: 'none' },
  // Applying the same field values again leaves the case in the same state.
  effects: { testRail: 'write', destructive: false, idempotent: true },
  retry: 'json-write',
});

const updateCasesInput = strictObject({
  suite_id: positiveIdSchema,
  body: payloadInput(UpdateCasesPayloadSchema, {
    extensions: 'custom',
    fields: { case_ids: caseIdsSchema, section_id: positiveIdSchema.optional(), ...caseBodyFields },
  }),
});

export const updateCases = defineOperation({
  token: 'update_cases',
  method: 'POST',
  route: 'update_cases/{suite_id}',
  family: 'T02',
  driverBinding: 'cases.updateCases',
  summary: 'Update several TestRail test cases with the same values in one call: body.case_ids names the cases and every other supplied field is applied to each of them. suite_id is required even in single-suite mode. Returns the updated cases; an unrecognized reply is reported as an unknown outcome rather than retried.',
  inputSchema: updateCasesInput,
  argumentMap: [
    { input: 'suite_id', call: 'single', argument: 0, serialization: 'path' },
    { input: 'body', call: 'single', argument: 1, serialization: 'json-body' },
  ],
  // The driver unwraps TestRail's { updated_cases: [...] } reply and fails closed on any other.
  response: { shape: 'array', outerSchema: z.array(z.unknown()), entitySchema: CaseSchema },
  pagination: (bind) => ({
    kind: 'none',
    single: bind('cases.updateCases', (method, input) => method(input.suite_id, input.body)),
  }),
  files: { kind: 'none' },
  // Applying the same field values again leaves the cases in the same state.
  effects: { testRail: 'write', destructive: false, idempotent: true },
  retry: 'json-write',
});

const deleteCaseInput = strictObject({
  case_id: positiveIdSchema,
  query: strictObject({ soft: z.boolean().optional() }).optional(),
});

export const deleteCase = defineOperation({
  token: 'delete_case',
  method: 'POST',
  route: 'delete_case/{case_id}',
  family: 'T02',
  driverBinding: 'cases.deleteCase',
  summary: 'Delete a TestRail test case together with its results in active runs. This cannot be undone. Set query.soft to true to preview the affected counts without deleting anything (TestRail 6.5 or later); a preview reply with no count is reported as an unknown outcome, since an instance that ignores the flag deletes.',
  inputSchema: deleteCaseInput,
  argumentMap: [
    { input: 'case_id', call: 'single', argument: 0, serialization: 'path' },
    { input: 'query.soft', call: 'single', argument: 1, property: 'soft', serialization: 'query-scalar' },
  ],
  // Void after a deletion; TestRail's affected-entity counts after a preview, which are
  // drift-checked advisorily and must carry at least one count (see softDeletePreview).
  response: { shape: 'union', outerSchema: z.union([z.undefined(), recordResponse]), entitySchema: null, preview: softDeletePreview },
  pagination: (bind) => ({
    kind: 'none',
    single: bind('cases.deleteCase', (method, input) => {
      const soft = flag(input.query, 'soft');
      return soft === undefined ? method(input.case_id) : method(input.case_id, { soft });
    }),
  }),
  files: { kind: 'none' },
  // A preview is possible, but the tool as a whole is destructive and never idempotent.
  effects: { testRail: 'write', destructive: true, idempotent: false },
  retry: 'json-write',
});

// TestRail takes the suite in the path and the project as a query control; the body
// carries only the case IDs, and the driver refuses a body-level soft flag.
const deleteCasesInput = strictObject({
  suite_id: positiveIdSchema,
  query: strictObject({ project_id: positiveIdSchema, soft: z.boolean().optional() }),
  body: payloadInput(DeleteCasesPayloadSchema, { fields: { case_ids: caseIdsSchema } }),
});

export const deleteCases = defineOperation({
  token: 'delete_cases',
  method: 'POST',
  route: 'delete_cases/{suite_id}',
  family: 'T02',
  driverBinding: 'cases.deleteCases',
  summary: 'Delete several TestRail test cases of one suite in a single call, together with their results in active runs. This cannot be undone. query.project_id is required and body.case_ids names the cases. Set query.soft to true to preview the affected counts without deleting anything; a preview reply with no count is reported as an unknown outcome, since an instance that ignores the flag deletes.',
  inputSchema: deleteCasesInput,
  argumentMap: [
    { input: 'suite_id', call: 'single', argument: 0, serialization: 'path' },
    { input: 'query.project_id', call: 'single', argument: 1, serialization: 'query-scalar' },
    { input: 'body', call: 'single', argument: 2, serialization: 'json-body' },
    { input: 'query.soft', call: 'single', argument: 3, property: 'soft', serialization: 'query-scalar' },
  ],
  response: { shape: 'union', outerSchema: z.union([z.undefined(), recordResponse]), entitySchema: null, preview: softDeletePreview },
  pagination: (bind) => ({
    kind: 'none',
    single: bind('cases.deleteCases', (method, input) => {
      const { project_id: projectId, soft } = input.query;
      return soft === undefined
        ? method(input.suite_id, projectId, input.body)
        : method(input.suite_id, projectId, input.body, { soft });
    }),
  }),
  files: { kind: 'none' },
  effects: { testRail: 'write', destructive: true, idempotent: false },
  retry: 'json-write',
});

const copyCasesToSectionInput = strictObject({
  section_id: positiveIdSchema,
  body: payloadInput(CopyCasesToSectionPayloadSchema, { fields: { case_ids: caseIdsSchema } }),
});

export const copyCasesToSection = defineOperation({
  token: 'copy_cases_to_section',
  method: 'POST',
  route: 'copy_cases_to_section/{section_id}',
  family: 'T02',
  driverBinding: 'cases.copyCasesToSection',
  summary: 'Copy TestRail test cases into a section, which may be in another suite; the originals stay where they are. This tool returns nothing, so list the target section afterwards to see the copies.',
  inputSchema: copyCasesToSectionInput,
  argumentMap: [
    { input: 'section_id', call: 'single', argument: 0, serialization: 'path' },
    { input: 'body', call: 'single', argument: 1, serialization: 'json-body' },
  ],
  // TestRail replies with an empty body and the driver resolves with no value.
  response: { shape: 'void', outerSchema: z.undefined(), entitySchema: null },
  pagination: (bind) => ({
    kind: 'none',
    single: bind('cases.copyCasesToSection',
      (method, input) => method(input.section_id, input.body)),
  }),
  files: { kind: 'none' },
  // Repeating the call creates another set of copies, so this is not idempotent.
  effects: { testRail: 'write', destructive: false, idempotent: false },
  retry: 'json-write',
});

const moveCasesToSectionInput = strictObject({
  section_id: positiveIdSchema,
  body: payloadInput(MoveCasesToSectionPayloadSchema, { fields: { case_ids: caseIdsSchema, suite_id: positiveIdSchema } }),
});

export const moveCasesToSection = defineOperation({
  token: 'move_cases_to_section',
  method: 'POST',
  route: 'move_cases_to_section/{section_id}',
  family: 'T02',
  driverBinding: 'cases.moveCasesToSection',
  summary: 'Move TestRail test cases into a section. body.suite_id is the suite that section belongs to and is required even for a move within the same suite. This tool returns nothing, so read a moved case afterwards for its new section.',
  inputSchema: moveCasesToSectionInput,
  argumentMap: [
    { input: 'section_id', call: 'single', argument: 0, serialization: 'path' },
    { input: 'body', call: 'single', argument: 1, serialization: 'json-body' },
  ],
  response: { shape: 'void', outerSchema: z.undefined(), entitySchema: null },
  pagination: (bind) => ({
    kind: 'none',
    single: bind('cases.moveCasesToSection',
      (method, input) => method(input.section_id, input.body)),
  }),
  files: { kind: 'none' },
  // Moving to the same section again leaves the cases where they are.
  effects: { testRail: 'write', destructive: false, idempotent: true },
  retry: 'json-write',
});

/** Registered in tool-name order by the registry; listed here in reviewed order. */
export const t02 = [
  getCase, getCases, getCaseTitles, getHistoryForCase,
  addCase, addCases, updateCase, updateCases,
  deleteCase, deleteCases, copyCasesToSection, moveCasesToSection,
] as const;
