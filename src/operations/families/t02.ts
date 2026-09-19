import {
  AddCasePayloadSchema, AddCasesBulkPayloadSchema, CaseSchema, CaseTitleSchema, CopyCasesToSectionPayloadSchema,
  DeleteCasesPayloadSchema, HistoryEntrySchema, MoveCasesToSectionPayloadSchema, UpdateCasePayloadSchema,
  UpdateCasesPayloadSchema, type GetCasesOptions,
} from '@dichovsky/testrail-api-client';
import { z } from 'zod';
import {
  caseIdsSchema, createListInput, idFilterSchema, nonnegativeIntegerSchema, payloadArray, payloadInput,
  positiveIdSchema, strictObject,
} from '../../contracts/inputs.js';
import { driverAllOptions, pageRequestDefaults } from '../../contracts/pagination.js';
import { driverCall } from '../driver-call.js';
import { defineOperation, type ArgumentMapping, type OperationDefinition } from '../registry.js';
import { aggregateControlMappings, allControls, control, flag, pageResponse, recordResponse } from './common.js';

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
  pagination: {
    kind: 'none',
    single: driverCall(getCaseInput, 'cases.getCase', (method, input) => method(input.case_id)),
  },
  files: { kind: 'none' },
  effects: { testRail: 'read', destructive: false, idempotent: true },
  retry: 'ordinary-read',
} as const satisfies OperationDefinition);

/** One reference sends refs=; several send the repeated refs[] form TestRail 10.7 accepts. */
const caseRefsSchema = z.union([z.string(), z.array(z.string()).min(1)]);

// Timestamps are Unix seconds. The driver forwards any number for them, so the
// integer bound is held here.
const getCasesInput = createListInput({
  path: { project_id: positiveIdSchema },
  query: {
    suite_id: positiveIdSchema.optional(),
    section_id: positiveIdSchema.optional(),
    type_id: idFilterSchema.optional(),
    priority_id: idFilterSchema.optional(),
    template_id: idFilterSchema.optional(),
    milestone_id: idFilterSchema.optional(),
    created_after: nonnegativeIntegerSchema.optional(),
    created_before: nonnegativeIntegerSchema.optional(),
    created_by: idFilterSchema.optional(),
    filter: z.string().optional(),
    updated_after: nonnegativeIntegerSchema.optional(),
    updated_before: nonnegativeIntegerSchema.optional(),
    updated_by: idFilterSchema.optional(),
    label_id: idFilterSchema.optional(),
    refs: caseRefsSchema.optional(),
  },
  pagination: 'controlled',
});

/** REST filter name to driver option name; every filter is renamed to camelCase. */
const caseFilterNames = {
  suite_id: 'suiteId', section_id: 'sectionId', type_id: 'typeId', priority_id: 'priorityId',
  template_id: 'templateId', milestone_id: 'milestoneId', created_after: 'createdAfter',
  created_before: 'createdBefore', created_by: 'createdBy', filter: 'filter', updated_after: 'updatedAfter',
  updated_before: 'updatedBefore', updated_by: 'updatedBy', label_id: 'labelId', refs: 'refs',
} as const;

/** Filters the driver joins with commas; refs is repeated instead and the rest are scalars. */
const listFilters = new Set(['type_id', 'priority_id', 'template_id', 'milestone_id', 'created_by', 'updated_by', 'label_id']);

function caseFilterMappings(call: 'page' | 'all'): readonly ArgumentMapping[] {
  return Object.entries(caseFilterNames).map(([name, property]) => ({
    input: `query.${name}`, call, argument: 1, property,
    serialization: name === 'refs' ? 'query-repeated' : listFilters.has(name) ? 'query-list' : 'query-scalar',
  }));
}

type CaseFilter = Omit<GetCasesOptions, 'limit' | 'offset'>;

/** Renamed filters, carried over only when supplied so the driver sends nothing for the rest. */
function caseFilter(query: object | undefined): CaseFilter {
  const source = (query ?? {}) as Record<string, unknown>;
  const filter: Record<string, unknown> = {};
  for (const [name, option] of Object.entries(caseFilterNames)) {
    if (source[name] !== undefined) filter[option] = source[name];
  }
  // The schema has validated each value already; the argument map declares the mapping
  // independently and the fixtures check the arguments actually sent.
  return filter;
}

export const getCases = defineOperation({
  token: 'get_cases',
  method: 'GET',
  route: 'get_cases/{project_id}',
  family: 'T02',
  driverBinding: 'cases.getCases',
  summary: 'List the test cases of a TestRail project, optionally within one suite or section and filtered by type, priority, template, milestone, label, creator, updater, creation or update time (Unix seconds), a title substring (filter) or references (refs). An ID filter takes one ID or a non-empty array. The suite is required unless the project runs in single-suite mode. Custom fields are returned as flat custom_* properties.',
  inputSchema: getCasesInput,
  argumentMap: [
    { input: 'project_id', call: 'page', argument: 0, serialization: 'path' },
    ...caseFilterMappings('page'),
    { input: 'query.limit', call: 'page', argument: 1, property: 'limit', serialization: 'query-scalar' },
    { input: 'query.offset', call: 'page', argument: 1, property: 'offset', serialization: 'query-scalar' },
    { input: 'project_id', call: 'all', argument: 0, serialization: 'path' },
    ...caseFilterMappings('all'),
    ...aggregateControlMappings(1),
  ],
  response: { shape: 'page', outerSchema: pageResponse, entitySchema: CaseSchema },
  pagination: {
    kind: 'controlled',
    page: driverCall(getCasesInput, 'cases.getCasesPage', (method, input) => method(input.project_id, {
      ...caseFilter(input.query),
      ...pageRequestDefaults({ limit: control(input.query, 'limit'), offset: control(input.query, 'offset') }),
    })),
    all: driverCall(getCasesInput, 'cases.getAllCases', (method, input, context) => method(input.project_id, {
      ...caseFilter(input.query),
      ...driverAllOptions(allControls(input._mcp), context.limits),
    })),
  },
  files: { kind: 'none' },
  effects: { testRail: 'read', destructive: false, idempotent: true },
  retry: 'ordinary-read',
} as const satisfies OperationDefinition);

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
  pagination: {
    kind: 'none',
    single: driverCall(getCaseTitlesInput, 'cases.getCaseTitles', (method, input) => method(input.query.case_ids)),
  },
  files: { kind: 'none' },
  effects: { testRail: 'read', destructive: false, idempotent: true },
  retry: 'ordinary-read',
} as const satisfies OperationDefinition);

const getHistoryForCaseInput = createListInput({ path: { case_id: positiveIdSchema }, pagination: 'controlled' });

export const getHistoryForCase = defineOperation({
  token: 'get_history_for_case',
  method: 'GET',
  route: 'get_history_for_case/{case_id}',
  family: 'T02',
  driverBinding: 'cases.getHistoryForCase',
  summary: 'List the change history of a TestRail test case (TestRail 6.5.4 or later). Each entry records who changed which fields, with the old and new values.',
  inputSchema: getHistoryForCaseInput,
  argumentMap: [
    { input: 'case_id', call: 'page', argument: 0, serialization: 'path' },
    { input: 'query.limit', call: 'page', argument: 1, property: 'limit', serialization: 'query-scalar' },
    { input: 'query.offset', call: 'page', argument: 1, property: 'offset', serialization: 'query-scalar' },
    { input: 'case_id', call: 'all', argument: 0, serialization: 'path' },
    ...aggregateControlMappings(1),
  ],
  response: { shape: 'page', outerSchema: pageResponse, entitySchema: HistoryEntrySchema },
  pagination: {
    kind: 'controlled',
    page: driverCall(getHistoryForCaseInput, 'cases.getHistoryForCasePage', (method, input) => method(
      input.case_id,
      pageRequestDefaults({ limit: control(input.query, 'limit'), offset: control(input.query, 'offset') }),
    )),
    all: driverCall(getHistoryForCaseInput, 'cases.getAllHistoryForCase', (method, input, context) => method(
      input.case_id,
      driverAllOptions(allControls(input._mcp), context.limits),
    )),
  },
  files: { kind: 'none' },
  effects: { testRail: 'read', destructive: false, idempotent: true },
  retry: 'ordinary-read',
} as const satisfies OperationDefinition);

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
  pagination: {
    kind: 'none',
    single: driverCall(addCaseInput, 'cases.addCase', (method, input) => method(input.section_id, input.body)),
  },
  files: { kind: 'none' },
  // Repeating the call creates another case, so this is not idempotent.
  effects: { testRail: 'write', destructive: false, idempotent: false },
  retry: 'json-write',
} as const satisfies OperationDefinition);

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
  pagination: {
    kind: 'none',
    single: driverCall(addCasesInput, 'cases.addCases', (method, input) => method(input.section_id, input.body)),
  },
  files: { kind: 'none' },
  // Repeating the call creates the cases again, so this is not idempotent.
  effects: { testRail: 'write', destructive: false, idempotent: false },
  retry: 'json-write',
} as const satisfies OperationDefinition);

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
  pagination: {
    kind: 'none',
    single: driverCall(updateCaseInput, 'cases.updateCase', (method, input) => method(input.case_id, input.body)),
  },
  files: { kind: 'none' },
  // Applying the same field values again leaves the case in the same state.
  effects: { testRail: 'write', destructive: false, idempotent: true },
  retry: 'json-write',
} as const satisfies OperationDefinition);

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
  pagination: {
    kind: 'none',
    single: driverCall(updateCasesInput, 'cases.updateCases', (method, input) => method(input.suite_id, input.body)),
  },
  files: { kind: 'none' },
  // Applying the same field values again leaves the cases in the same state.
  effects: { testRail: 'write', destructive: false, idempotent: true },
  retry: 'json-write',
} as const satisfies OperationDefinition);

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
  summary: 'Delete a TestRail test case together with its results in active runs. This cannot be undone. Set query.soft to true to preview the affected counts without deleting anything (TestRail 6.5 or later).',
  inputSchema: deleteCaseInput,
  argumentMap: [
    { input: 'case_id', call: 'single', argument: 0, serialization: 'path' },
    { input: 'query.soft', call: 'single', argument: 1, property: 'soft', serialization: 'query-scalar' },
  ],
  // Void after a deletion; TestRail's affected-entity counts after a preview, which are
  // the driver's own parse and are not drift-checked here.
  response: { shape: 'union', outerSchema: z.union([z.undefined(), recordResponse]), entitySchema: null },
  pagination: {
    kind: 'none',
    single: driverCall(deleteCaseInput, 'cases.deleteCase', (method, input) => {
      const soft = flag(input.query, 'soft');
      return soft === undefined ? method(input.case_id) : method(input.case_id, { soft });
    }),
  },
  files: { kind: 'none' },
  // A preview is possible, but the tool as a whole is destructive and never idempotent.
  effects: { testRail: 'write', destructive: true, idempotent: false },
  retry: 'json-write',
} as const satisfies OperationDefinition);

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
  summary: 'Delete several TestRail test cases of one suite in a single call, together with their results in active runs. This cannot be undone. query.project_id is required and body.case_ids names the cases. Set query.soft to true to preview the affected counts without deleting anything.',
  inputSchema: deleteCasesInput,
  argumentMap: [
    { input: 'suite_id', call: 'single', argument: 0, serialization: 'path' },
    { input: 'query.project_id', call: 'single', argument: 1, serialization: 'query-scalar' },
    { input: 'body', call: 'single', argument: 2, serialization: 'json-body' },
    { input: 'query.soft', call: 'single', argument: 3, property: 'soft', serialization: 'query-scalar' },
  ],
  response: { shape: 'union', outerSchema: z.union([z.undefined(), recordResponse]), entitySchema: null },
  pagination: {
    kind: 'none',
    single: driverCall(deleteCasesInput, 'cases.deleteCases', (method, input) => {
      const { project_id: projectId, soft } = input.query;
      return soft === undefined
        ? method(input.suite_id, projectId, input.body)
        : method(input.suite_id, projectId, input.body, { soft });
    }),
  },
  files: { kind: 'none' },
  effects: { testRail: 'write', destructive: true, idempotent: false },
  retry: 'json-write',
} as const satisfies OperationDefinition);

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
  pagination: {
    kind: 'none',
    single: driverCall(copyCasesToSectionInput, 'cases.copyCasesToSection',
      (method, input) => method(input.section_id, input.body)),
  },
  files: { kind: 'none' },
  // Repeating the call creates another set of copies, so this is not idempotent.
  effects: { testRail: 'write', destructive: false, idempotent: false },
  retry: 'json-write',
} as const satisfies OperationDefinition);

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
  pagination: {
    kind: 'none',
    single: driverCall(moveCasesToSectionInput, 'cases.moveCasesToSection',
      (method, input) => method(input.section_id, input.body)),
  },
  files: { kind: 'none' },
  // Moving to the same section again leaves the cases where they are.
  effects: { testRail: 'write', destructive: false, idempotent: true },
  retry: 'json-write',
} as const satisfies OperationDefinition);

/** Registered in tool-name order by the registry; listed here in reviewed order. */
export const t02 = [
  getCase, getCases, getCaseTitles, getHistoryForCase,
  addCase, addCases, updateCase, updateCases,
  deleteCase, deleteCases, copyCasesToSection, moveCasesToSection,
] as const;
