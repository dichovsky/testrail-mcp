import {
  AddResultPayloadSchema, AddResultsForCasesPayloadSchema, AddResultsPayloadSchema,
  EditResultPayloadSchema, ResultSchema,
  type GetResultsForRunOptions, type GetResultsOptions,
} from '@dichovsky/testrail-api-client';
import { z } from 'zod';
import {
  createListInput, nonnegativeIntegerSchema, payloadArray, payloadInput, positiveIdSchema, strictObject,
} from '../../contracts/inputs.js';
import { driverAllOptions, pageRequestDefaults } from '../../contracts/pagination.js';
import { driverCall } from '../driver-call.js';
import { defineOperation, type ArgumentMapping, type OperationDefinition } from '../registry.js';
import {
  aggregateControlMappings, allControls, control, pageResponse, recordResponse,
} from './common.js';

/** Statuses and the defect text are the filters every result list accepts. */
const sharedResultFilters = {
  status_id: z.array(positiveIdSchema).min(1).optional(),
  defects_filter: z.string().optional(),
};

/** Only the run-wide list carries the creation filters; the driver drops them elsewhere. */
const runOnlyResultFilters = {
  created_after: nonnegativeIntegerSchema.optional(),
  created_before: nonnegativeIntegerSchema.optional(),
  created_by: z.array(positiveIdSchema).min(1).optional(),
};

type ResultFilter = Omit<GetResultsOptions, 'limit' | 'offset' | 'status_id' | 'defects_filter'>;
type RunResultFilter = Omit<GetResultsForRunOptions,
  'limit' | 'offset' | 'status_id' | 'defects_filter' | 'created_after' | 'created_before' | 'created_by'>;

/*
 * Each value is checked to be an option the driver still has. Deriving the type alone
 * would not do that: the helper below builds its object dynamically, and a record of
 * unknown values stays assignable to a type whose properties are all optional, so a
 * renamed option would silently stop being sent rather than fail to compile.
 */
const resultFilterNames = {
  status_id: 'statusId', defects_filter: 'defectsFilter',
} as const satisfies Readonly<Record<string, keyof ResultFilter>>;

const runResultFilterNames = {
  created_after: 'createdAfter', created_before: 'createdBefore', created_by: 'createdBy',
  ...resultFilterNames,
} as const satisfies Readonly<Record<string, keyof RunResultFilter>>;

function resultFilter(query: object | undefined, names: Readonly<Record<string, string>>): RunResultFilter {
  const source = (query ?? {}) as Record<string, unknown>;
  const filter: Record<string, unknown> = {};
  for (const [name, option] of Object.entries(names)) {
    if (source[name] !== undefined) filter[option] = source[name];
  }
  return filter;
}

/** Both comma-joined lists; the defect text is a single string. */
function filterMappings(
  names: Readonly<Record<string, string>>,
  call: 'page' | 'all',
  argument: number,
): readonly ArgumentMapping[] {
  return Object.entries(names).map(([name, property]) => ({
    input: `query.${name}`, call, argument, property,
    serialization: name === 'defects_filter' ? 'query-scalar' as const : 'query-list' as const,
  }));
}

function pagingMappings(call: 'page', argument: number): readonly ArgumentMapping[] {
  return [
    { input: 'query.limit', call, argument, property: 'limit', serialization: 'query-scalar' },
    { input: 'query.offset', call, argument, property: 'offset', serialization: 'query-scalar' },
  ];
}

const getResultsInput = createListInput({
  path: { test_id: positiveIdSchema },
  query: sharedResultFilters,
  pagination: 'controlled',
});

export const getResults = defineOperation({
  token: 'get_results',
  method: 'GET',
  route: 'get_results/{test_id}',
  family: 'T05',
  driverBinding: 'results.getResults',
  summary: 'List the results recorded against a single TestRail test, newest first, optionally filtered by status or by a defect reference. A test is one case inside one run; use the run or case tools to reach results without a test ID.',
  inputSchema: getResultsInput,
  argumentMap: [
    { input: 'test_id', call: 'page', argument: 0, serialization: 'path' },
    ...filterMappings(resultFilterNames, 'page', 1),
    ...pagingMappings('page', 1),
    { input: 'test_id', call: 'all', argument: 0, serialization: 'path' },
    ...filterMappings(resultFilterNames, 'all', 1),
    ...aggregateControlMappings(1),
  ],
  response: { shape: 'page', outerSchema: pageResponse, entitySchema: ResultSchema },
  pagination: {
    kind: 'controlled',
    page: driverCall(getResultsInput, 'results.getResultsPage', (method, input) => method(input.test_id, {
      ...resultFilter(input.query, resultFilterNames),
      ...pageRequestDefaults({ limit: control(input.query, 'limit'), offset: control(input.query, 'offset') }),
    })),
    all: driverCall(getResultsInput, 'results.getAllResults', (method, input, context) => method(input.test_id, {
      ...resultFilter(input.query, resultFilterNames),
      ...driverAllOptions(allControls(input._mcp), context.limits),
    })),
  },
  files: { kind: 'none' },
  effects: { testRail: 'read', destructive: false, idempotent: true },
  retry: 'ordinary-read',
} as const satisfies OperationDefinition);

const getResultsForCaseInput = createListInput({
  path: { run_id: positiveIdSchema, case_id: positiveIdSchema },
  query: sharedResultFilters,
  pagination: 'controlled',
});

export const getResultsForCase = defineOperation({
  token: 'get_results_for_case',
  method: 'GET',
  route: 'get_results_for_case/{run_id}/{case_id}',
  family: 'T05',
  driverBinding: 'results.getResultsForCase',
  summary: 'List the results recorded for one TestRail case within one run, naming the case rather than the test it became. Optionally filtered by status or by a defect reference.',
  inputSchema: getResultsForCaseInput,
  argumentMap: [
    { input: 'run_id', call: 'page', argument: 0, serialization: 'path' },
    { input: 'case_id', call: 'page', argument: 1, serialization: 'path' },
    ...filterMappings(resultFilterNames, 'page', 2),
    ...pagingMappings('page', 2),
    { input: 'run_id', call: 'all', argument: 0, serialization: 'path' },
    { input: 'case_id', call: 'all', argument: 1, serialization: 'path' },
    ...filterMappings(resultFilterNames, 'all', 2),
    ...aggregateControlMappings(2),
  ],
  response: { shape: 'page', outerSchema: pageResponse, entitySchema: ResultSchema },
  pagination: {
    kind: 'controlled',
    page: driverCall(getResultsForCaseInput, 'results.getResultsForCasePage',
      (method, input) => method(input.run_id, input.case_id, {
        ...resultFilter(input.query, resultFilterNames),
        ...pageRequestDefaults({ limit: control(input.query, 'limit'), offset: control(input.query, 'offset') }),
      })),
    all: driverCall(getResultsForCaseInput, 'results.getAllResultsForCase',
      (method, input, context) => method(input.run_id, input.case_id, {
        ...resultFilter(input.query, resultFilterNames),
        ...driverAllOptions(allControls(input._mcp), context.limits),
      })),
  },
  files: { kind: 'none' },
  effects: { testRail: 'read', destructive: false, idempotent: true },
  retry: 'ordinary-read',
} as const satisfies OperationDefinition);

const getResultsForRunInput = createListInput({
  path: { run_id: positiveIdSchema },
  query: { ...runOnlyResultFilters, ...sharedResultFilters },
  pagination: 'controlled',
});

export const getResultsForRun = defineOperation({
  token: 'get_results_for_run',
  method: 'GET',
  route: 'get_results_for_run/{run_id}',
  family: 'T05',
  driverBinding: 'results.getResultsForRun',
  summary: 'List the results recorded across a whole TestRail run, optionally filtered by creation time (Unix seconds), creator, status or a defect reference. The creation filters are accepted here alone; the per-test and per-case lists do not carry them.',
  inputSchema: getResultsForRunInput,
  argumentMap: [
    { input: 'run_id', call: 'page', argument: 0, serialization: 'path' },
    ...filterMappings(runResultFilterNames, 'page', 1),
    ...pagingMappings('page', 1),
    { input: 'run_id', call: 'all', argument: 0, serialization: 'path' },
    ...filterMappings(runResultFilterNames, 'all', 1),
    ...aggregateControlMappings(1),
  ],
  response: { shape: 'page', outerSchema: pageResponse, entitySchema: ResultSchema },
  pagination: {
    kind: 'controlled',
    page: driverCall(getResultsForRunInput, 'results.getResultsForRunPage', (method, input) => method(input.run_id, {
      ...resultFilter(input.query, runResultFilterNames),
      ...pageRequestDefaults({ limit: control(input.query, 'limit'), offset: control(input.query, 'offset') }),
    })),
    all: driverCall(getResultsForRunInput, 'results.getAllResultsForRun', (method, input, context) => method(input.run_id, {
      ...resultFilter(input.query, runResultFilterNames),
      ...driverAllOptions(allControls(input._mcp), context.limits),
    })),
  },
  files: { kind: 'none' },
  effects: { testRail: 'read', destructive: false, idempotent: true },
  retry: 'ordinary-read',
} as const satisfies OperationDefinition);

/*
 * A result's own fields. The identifiers are held to the identifier domain because the
 * driver forwards any number for them, and the nested custom_fields container the
 * payload declares is refused: TestRail reads custom values only as flat custom_ names,
 * including the step results, so forwarding the container would drop them silently.
 */
const resultBodyFields = {
  status_id: positiveIdSchema,
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
  summary: 'Record a result against a single TestRail test. body.status_id names the outcome, and step results and other custom fields go in the body as flat custom_ properties. Adding a result is what changes a test\'s status. Use the bulk tool when recording results for several tests of one run.',
  inputSchema: addResultInput,
  argumentMap: [
    { input: 'test_id', call: 'single', argument: 0, serialization: 'path' },
    { input: 'body', call: 'single', argument: 1, serialization: 'json-body' },
  ],
  response: { shape: 'record', outerSchema: recordResponse, entitySchema: ResultSchema },
  pagination: {
    kind: 'none',
    single: driverCall(addResultInput, 'results.addResult', (method, input) => method(input.test_id, input.body)),
  },
  files: { kind: 'none' },
  // Each call records another result; the test's history keeps both.
  effects: { testRail: 'write', destructive: false, idempotent: false },
  retry: 'json-write',
} as const satisfies OperationDefinition);

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
  pagination: {
    kind: 'none',
    single: driverCall(addResultForCaseInput, 'results.addResultForCase',
      (method, input) => method(input.run_id, input.case_id, input.body)),
  },
  files: { kind: 'none' },
  effects: { testRail: 'write', destructive: false, idempotent: false },
  retry: 'json-write',
} as const satisfies OperationDefinition);

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
  summary: 'Record results for several tests of one TestRail run in a single call. Each entry of body.results names its test and takes the same fields as add_result. Every test must belong to the named run, and TestRail returns the created results in the order they were sent.',
  inputSchema: addResultsInput,
  argumentMap: [
    { input: 'run_id', call: 'single', argument: 0, serialization: 'path' },
    { input: 'body', call: 'single', argument: 1, serialization: 'json-body' },
  ],
  response: { shape: 'array', outerSchema: z.array(z.unknown()), entitySchema: ResultSchema },
  pagination: {
    kind: 'none',
    single: driverCall(addResultsInput, 'results.addResults', (method, input) => method(input.run_id, input.body)),
  },
  files: { kind: 'none' },
  // Each call records another result for every entry; nothing is replaced.
  effects: { testRail: 'write', destructive: false, idempotent: false },
  retry: 'json-write',
} as const satisfies OperationDefinition);

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
  summary: 'Record results for several cases of one TestRail run in a single call, naming each case rather than the test it became. Each entry of body.results takes the same fields as add_result.',
  inputSchema: addResultsForCasesInput,
  argumentMap: [
    { input: 'run_id', call: 'single', argument: 0, serialization: 'path' },
    { input: 'body', call: 'single', argument: 1, serialization: 'json-body' },
  ],
  response: { shape: 'array', outerSchema: z.array(z.unknown()), entitySchema: ResultSchema },
  pagination: {
    kind: 'none',
    single: driverCall(addResultsForCasesInput, 'results.addResultsForCases',
      (method, input) => method(input.run_id, input.body)),
  },
  files: { kind: 'none' },
  effects: { testRail: 'write', destructive: false, idempotent: false },
  retry: 'json-write',
} as const satisfies OperationDefinition);

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
    fields: { status_id: positiveIdSchema.optional(), assignedto_id: positiveIdSchema.optional() },
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
  pagination: {
    kind: 'none',
    single: driverCall(editResultInput, 'results.editResult', (method, input) => method(input.result_id, input.body)),
  },
  files: { kind: 'none' },
  // Applying the same field values again leaves the result in the same state.
  effects: { testRail: 'write', destructive: false, idempotent: true },
  retry: 'json-write',
} as const satisfies OperationDefinition);

/** Registered in tool-name order by the registry; listed here in reviewed order. */
export const t05 = [
  getResults, getResultsForCase, getResultsForRun,
  addResult, addResultForCase, addResults, addResultsForCases, editResult,
] as const;
