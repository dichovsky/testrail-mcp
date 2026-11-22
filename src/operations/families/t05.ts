import {
  AddResultPayloadSchema, AddResultsForCasesPayloadSchema, AddResultsPayloadSchema,
  EditResultPayloadSchema, ResultSchema,
  type GetResultsForRunOptions, type GetResultsOptions,
} from '@dichovsky/testrail-api-client';
import { z } from 'zod';
import {
  nonnegativeIntegerSchema, payloadArray, payloadInput, positiveIdSchema, strictObject,
} from '../../contracts/inputs.js';
import { defineOperation } from '../registry.js';
import { createListDefinition, type ListFilters } from '../lists.js';
import { recordResponse } from './common.js';

/** Status and defect references are available on every Test Result list. */
const resultFilters = {
  status_id: { schema: z.array(positiveIdSchema).min(1).optional(), property: 'statusId', serialization: 'query-list' },
  defects_filter: { schema: z.string().optional(), property: 'defectsFilter', serialization: 'query-scalar' },
} satisfies ListFilters<GetResultsOptions>;

/** Creation filters are supported only when listing Test Results for a Test Run. */
const runResultFilters = {
  created_after: { schema: nonnegativeIntegerSchema.optional(), property: 'createdAfter', serialization: 'query-scalar' },
  created_before: { schema: nonnegativeIntegerSchema.optional(), property: 'createdBefore', serialization: 'query-scalar' },
  created_by: { schema: z.array(positiveIdSchema).min(1).optional(), property: 'createdBy', serialization: 'query-list' },
  ...resultFilters,
} satisfies ListFilters<GetResultsForRunOptions>;

const getResultsList = createListDefinition({
  path: { test_id: { schema: positiveIdSchema, argument: 0 } },
  pagination: 'controlled',
  optionsArgument: 1,
  filters: resultFilters,
  entitySchema: ResultSchema,
});

export const getResults = defineOperation({
  token: 'get_results',
  method: 'GET',
  route: 'get_results/{test_id}',
  family: 'T05',
  driverBinding: 'results.getResults',
  summary: 'List the results recorded against a single TestRail test, newest first, optionally filtered by status or by a defect reference. A test is one case inside one run; use the run or case tools to reach results without a test ID.',
  ...getResultsList.bind({
    page: {
      binding: 'results.getResultsPage',
      call: (method, input, options) => method(input.test_id, options),
    },
    all: {
      binding: 'results.getAllResults',
      call: (method, input, options) => method(input.test_id, options),
    },
  }),
  files: { kind: 'none' },
  effects: { testRail: 'read', destructive: false, idempotent: true },
  retry: 'ordinary-read',
});

const getResultsForCaseList = createListDefinition({
  path: { run_id: { schema: positiveIdSchema, argument: 0 }, case_id: { schema: positiveIdSchema, argument: 1 } },
  pagination: 'controlled',
  optionsArgument: 2,
  filters: resultFilters,
  entitySchema: ResultSchema,
});

export const getResultsForCase = defineOperation({
  token: 'get_results_for_case',
  method: 'GET',
  route: 'get_results_for_case/{run_id}/{case_id}',
  family: 'T05',
  driverBinding: 'results.getResultsForCase',
  summary: 'List the results recorded for one TestRail case within one run, naming the case rather than the test it became. Optionally filtered by status or by a defect reference.',
  ...getResultsForCaseList.bind({
    page: {
      binding: 'results.getResultsForCasePage',
      call: (method, input, options) => method(input.run_id, input.case_id, options),
    },
    all: {
      binding: 'results.getAllResultsForCase',
      call: (method, input, options) => method(input.run_id, input.case_id, options),
    },
  }),
  files: { kind: 'none' },
  effects: { testRail: 'read', destructive: false, idempotent: true },
  retry: 'ordinary-read',
});

const getResultsForRunList = createListDefinition({
  path: { run_id: { schema: positiveIdSchema, argument: 0 } },
  pagination: 'controlled',
  optionsArgument: 1,
  filters: runResultFilters,
  entitySchema: ResultSchema,
});

export const getResultsForRun = defineOperation({
  token: 'get_results_for_run',
  method: 'GET',
  route: 'get_results_for_run/{run_id}',
  family: 'T05',
  driverBinding: 'results.getResultsForRun',
  summary: 'List the results recorded across a whole TestRail run, optionally filtered by creation time (Unix seconds), creator, status or a defect reference. The creation filters are accepted here alone; the per-test and per-case lists do not carry them.',
  ...getResultsForRunList.bind({
    page: {
      binding: 'results.getResultsForRunPage',
      call: (method, input, options) => method(input.run_id, options),
    },
    all: {
      binding: 'results.getAllResultsForRun',
      call: (method, input, options) => method(input.run_id, options),
    },
  }),
  files: { kind: 'none' },
  effects: { testRail: 'read', destructive: false, idempotent: true },
  retry: 'ordinary-read',
});

/*
 * A result's own fields. The identifiers are held to the identifier domain because the
 * driver forwards any number for them, and the nested custom_fields container the
 * payload declares is refused: TestRail reads custom values only as flat custom_ names,
 * including the step results, so forwarding the container would drop them silently.
 *
 * TestRail records a result that carries a status, a comment or an assignee, any one of
 * them. The driver's payloads make status_id optional and refine them to require one of
 * the three, and the adapter advertises that refinement in JSON Schema, so each body
 * and each bulk entry is held to it here, before the driver forwards it unparsed.
 */
const resultBodyFields = {
  status_id: positiveIdSchema.optional(),
  assignedto_id: positiveIdSchema.optional(),
  custom_fields: z.never().optional(),
};

const resultBody = payloadInput(AddResultPayloadSchema, { extensions: 'custom', fields: resultBodyFields });

const addResultInput = strictObject({ test_id: positiveIdSchema, body: resultBody });

export const addResult = defineOperation({
  token: 'add_result',
  method: 'POST',
  route: 'add_result/{test_id}',
  family: 'T05',
  driverBinding: 'results.addResult',
  summary: 'Record a result against a single TestRail test. The body needs at least one of status_id, comment or assignedto_id. status_id names the outcome and is what changes the test\'s status; a result without it is recorded with a null status_id. Step results and other custom fields go in the body as flat custom_ properties. Use the bulk tool when recording results for several tests of one run.',
  inputSchema: addResultInput,
  argumentMap: [
    { input: 'test_id', call: 'single', argument: 0, serialization: 'path' },
    { input: 'body', call: 'single', argument: 1, serialization: 'json-body' },
  ],
  response: { shape: 'record', outerSchema: recordResponse, entitySchema: ResultSchema },
  pagination: (bind) => ({
    kind: 'none',
    single: bind('results.addResult', (method, input) => method(input.test_id, input.body)),
  }),
  files: { kind: 'none' },
  // Each call records another result; the test's history keeps both.
  effects: { testRail: 'write', destructive: false, idempotent: false },
  retry: 'json-write',
});

const addResultForCaseInput = strictObject({
  run_id: positiveIdSchema,
  case_id: positiveIdSchema,
  body: resultBody,
});

export const addResultForCase = defineOperation({
  token: 'add_result_for_case',
  method: 'POST',
  route: 'add_result_for_case/{run_id}/{case_id}',
  family: 'T05',
  driverBinding: 'results.addResultForCase',
  summary: 'Record a result for one TestRail case within one run, naming the case rather than the test it became. Takes the same body as add_result.',
  inputSchema: addResultForCaseInput,
  argumentMap: [
    { input: 'run_id', call: 'single', argument: 0, serialization: 'path' },
    { input: 'case_id', call: 'single', argument: 1, serialization: 'path' },
    { input: 'body', call: 'single', argument: 2, serialization: 'json-body' },
  ],
  response: { shape: 'record', outerSchema: recordResponse, entitySchema: ResultSchema },
  pagination: (bind) => ({
    kind: 'none',
    single: bind('results.addResultForCase',
      (method, input) => method(input.run_id, input.case_id, input.body)),
  }),
  files: { kind: 'none' },
  effects: { testRail: 'write', destructive: false, idempotent: false },
  retry: 'json-write',
});

/*
 * The bulk payloads carry the same result fields as the single ones, keyed by test or
 * by case. Each item is adapted from the driver's own element schema, so the identifier
 * it requires and the fields it declares stay exactly what the driver expects.
 *
 * The array is held to at least one entry. The driver states no minimum, but an empty
 * one asks TestRail to record nothing, which is a caller mistake rather than a
 * meaningful request: unlike a case selection, no other field gives it a purpose.
 */
const resultsForTests = payloadArray(AddResultsPayloadSchema.shape.results,
  payloadInput(AddResultsPayloadSchema.shape.results.element, {
    extensions: 'custom',
    fields: { test_id: positiveIdSchema, ...resultBodyFields },
  })).min(1);

const resultsForCases = payloadArray(AddResultsForCasesPayloadSchema.shape.results,
  payloadInput(AddResultsForCasesPayloadSchema.shape.results.element, {
    extensions: 'custom',
    fields: { case_id: positiveIdSchema, ...resultBodyFields },
  })).min(1);

const addResultsInput = strictObject({
  run_id: positiveIdSchema,
  body: payloadInput(AddResultsPayloadSchema, { fields: { results: resultsForTests } }),
});

export const addResults = defineOperation({
  token: 'add_results',
  method: 'POST',
  route: 'add_results/{run_id}',
  family: 'T05',
  driverBinding: 'results.addResults',
  summary: 'Record results for several tests of one TestRail run in a single call. Each entry of body.results names its test and takes the same fields as add_result, including at least one of status_id, comment or assignedto_id. Every test must belong to the named run, and TestRail returns the created results in the order they were sent.',
  inputSchema: addResultsInput,
  argumentMap: [
    { input: 'run_id', call: 'single', argument: 0, serialization: 'path' },
    { input: 'body', call: 'single', argument: 1, serialization: 'json-body' },
  ],
  response: { shape: 'array', outerSchema: z.array(z.unknown()), entitySchema: ResultSchema },
  pagination: (bind) => ({
    kind: 'none',
    single: bind('results.addResults', (method, input) => method(input.run_id, input.body)),
  }),
  files: { kind: 'none' },
  // Each call records another result for every entry; nothing is replaced.
  effects: { testRail: 'write', destructive: false, idempotent: false },
  retry: 'json-write',
});

const addResultsForCasesInput = strictObject({
  run_id: positiveIdSchema,
  body: payloadInput(AddResultsForCasesPayloadSchema, { fields: { results: resultsForCases } }),
});

export const addResultsForCases = defineOperation({
  token: 'add_results_for_cases',
  method: 'POST',
  route: 'add_results_for_cases/{run_id}',
  family: 'T05',
  driverBinding: 'results.addResultsForCases',
  summary: 'Record results for several cases of one TestRail run in a single call, naming each case rather than the test it became. Each entry of body.results takes the same fields as add_result, including at least one of status_id, comment or assignedto_id.',
  inputSchema: addResultsForCasesInput,
  argumentMap: [
    { input: 'run_id', call: 'single', argument: 0, serialization: 'path' },
    { input: 'body', call: 'single', argument: 1, serialization: 'json-body' },
  ],
  response: { shape: 'array', outerSchema: z.array(z.unknown()), entitySchema: ResultSchema },
  pagination: (bind) => ({
    kind: 'none',
    single: bind('results.addResultsForCases',
      (method, input) => method(input.run_id, input.body)),
  }),
  files: { kind: 'none' },
  effects: { testRail: 'write', destructive: false, idempotent: false },
  retry: 'json-write',
});

/*
 * The edit payload has no custom_fields container of its own and declares the step
 * results outright, so the flat extension point carries the remaining custom fields.
 * The driver refuses an empty payload before dispatch, which the boundary states as a
 * minimum property count so the emitted schema says the same thing.
 */
const editResultInput = strictObject({
  result_id: positiveIdSchema,
  body: payloadInput(EditResultPayloadSchema, {
    extensions: 'custom',
    fields: {
      status_id: positiveIdSchema.optional(),
      assignedto_id: positiveIdSchema.optional(),
      /*
       * This payload declares no custom_fields of its own, but the name would still
       * reach TestRail through the flat extension point, where it is read as an
       * ordinary custom field that does not exist. Refusing it here keeps the four
       * add-side writes and this one saying the same thing about the same name.
       */
      custom_fields: z.never().optional(),
    },
  }),
});

export const editResult = defineOperation({
  token: 'edit_result',
  method: 'POST',
  route: 'edit_result/{result_id}',
  family: 'T05',
  driverBinding: 'results.editResult',
  summary: 'Change a result already recorded in TestRail (TestRail 10.4 or later). Supplied fields replace their current values and at least one is required; sending custom_step_results replaces every step result rather than adding to them. This edits history rather than recording a new result.',
  inputSchema: editResultInput,
  argumentMap: [
    { input: 'result_id', call: 'single', argument: 0, serialization: 'path' },
    { input: 'body', call: 'single', argument: 1, serialization: 'json-body' },
  ],
  response: { shape: 'record', outerSchema: recordResponse, entitySchema: ResultSchema },
  pagination: (bind) => ({
    kind: 'none',
    single: bind('results.editResult', (method, input) => method(input.result_id, input.body)),
  }),
  files: { kind: 'none' },
  // Applying the same field values again leaves the result in the same state.
  effects: { testRail: 'write', destructive: false, idempotent: true },
  retry: 'json-write',
});

/** Registered in tool-name order by the registry; listed here in reviewed order. */
export const t05 = [
  getResults, getResultsForCase, getResultsForRun,
  addResult, addResultForCase, addResults, addResultsForCases, editResult,
] as const;
