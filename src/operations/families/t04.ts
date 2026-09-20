import {
  AddRunPayloadSchema, RunSchema, TestSchema, UpdateRunPayloadSchema,
  UpdateTestLabelsPayloadSchema, UpdateTestsLabelsPayloadSchema, UpdateTestsResponseSchema,
  type GetRunsOptions, type GetTestsOptions,
} from '@dichovsky/testrail-api-client';
import { z } from 'zod';
import {
  createListInput, idFilterSchema, nonnegativeIntegerSchema, payloadInput, positiveIdSchema, strictObject,
} from '../../contracts/inputs.js';
import { driverAllOptions, pageRequestDefaults } from '../../contracts/pagination.js';
import { driverCall } from '../driver-call.js';
import { defineOperation, type ArgumentMapping, type OperationDefinition } from '../registry.js';
import {
  aggregateControlMappings, allControls, control, flag, pageResponse, recordResponse,
} from './common.js';

const getRunInput = strictObject({ run_id: positiveIdSchema });

export const getRun = defineOperation({
  token: 'get_run',
  method: 'GET',
  route: 'get_run/{run_id}',
  family: 'T04',
  driverBinding: 'runs.getRun',
  summary: 'Get a single TestRail test run by its ID, with its per-status counts and its case selection. Read the run\'s tests separately to see them.',
  inputSchema: getRunInput,
  argumentMap: [{ input: 'run_id', call: 'single', argument: 0, serialization: 'path' }],
  response: { shape: 'record', outerSchema: recordResponse, entitySchema: RunSchema },
  pagination: {
    kind: 'none',
    single: driverCall(getRunInput, 'runs.getRun', (method, input) => method(input.run_id)),
  },
  files: { kind: 'none' },
  effects: { testRail: 'read', destructive: false, idempotent: true },
  retry: 'ordinary-read',
} as const satisfies OperationDefinition);

// TestRail documents every creator as a comma-separated list, but the driver's option
// for this one filter is an array alone, so this tool takes an array rather than
// widening the value on the way through.
const getRunsInput = createListInput({
  path: { project_id: positiveIdSchema },
  query: {
    created_after: nonnegativeIntegerSchema.optional(),
    created_before: nonnegativeIntegerSchema.optional(),
    created_by: z.array(positiveIdSchema).min(1).optional(),
    include_plan_runs: z.boolean().optional(),
    is_completed: z.boolean().optional(),
    milestone_id: idFilterSchema.optional(),
    refs: z.string().optional(),
    suite_id: idFilterSchema.optional(),
  },
  pagination: 'controlled',
});

const runFilterNames = {
  created_after: 'createdAfter', created_before: 'createdBefore', created_by: 'createdBy',
  include_plan_runs: 'includePlanRuns', is_completed: 'isCompleted', milestone_id: 'milestoneId',
  refs: 'refs', suite_id: 'suiteId',
} as const;

/** Derived from the driver's own option type, so a rename there fails the build here. */
type RunFilter = Omit<GetRunsOptions, 'limit' | 'offset'>;

function runFilter(query: object | undefined): RunFilter {
  const source = (query ?? {}) as Record<string, unknown>;
  const filter: Record<string, unknown> = {};
  for (const [name, option] of Object.entries(runFilterNames)) {
    if (source[name] !== undefined) filter[option] = source[name];
  }
  return filter;
}

/** Two filters are booleans here and 1 or 0 on the wire; the driver does that conversion. */
const runListSerialization: Readonly<Record<string, ArgumentMapping['serialization']>> = {
  created_by: 'query-list', milestone_id: 'query-list', suite_id: 'query-list',
};

function runFilterMappings(call: 'page' | 'all'): readonly ArgumentMapping[] {
  return Object.entries(runFilterNames).map(([name, property]) => ({
    input: `query.${name}`, call, argument: 1, property,
    serialization: runListSerialization[name] ?? 'query-scalar',
  }));
}

export const getRuns = defineOperation({
  token: 'get_runs',
  method: 'GET',
  route: 'get_runs/{project_id}',
  family: 'T04',
  driverBinding: 'runs.getRuns',
  summary: 'List the test runs of a TestRail project that do not belong to a test plan, unless query.include_plan_runs asks for those as well. Filter by creation time (Unix seconds), creator, completion, milestone, suite or a single reference. Read a plan for the runs inside it.',
  inputSchema: getRunsInput,
  argumentMap: [
    { input: 'project_id', call: 'page', argument: 0, serialization: 'path' },
    ...runFilterMappings('page'),
    { input: 'query.limit', call: 'page', argument: 1, property: 'limit', serialization: 'query-scalar' },
    { input: 'query.offset', call: 'page', argument: 1, property: 'offset', serialization: 'query-scalar' },
    { input: 'project_id', call: 'all', argument: 0, serialization: 'path' },
    ...runFilterMappings('all'),
    ...aggregateControlMappings(1),
  ],
  response: { shape: 'page', outerSchema: pageResponse, entitySchema: RunSchema },
  pagination: {
    kind: 'controlled',
    page: driverCall(getRunsInput, 'runs.getRunsPage', (method, input) => method(input.project_id, {
      ...runFilter(input.query),
      ...pageRequestDefaults({ limit: control(input.query, 'limit'), offset: control(input.query, 'offset') }),
    })),
    all: driverCall(getRunsInput, 'runs.getAllRuns', (method, input, context) => method(input.project_id, {
      ...runFilter(input.query),
      ...driverAllOptions(allControls(input._mcp), context.limits),
    })),
  },
  files: { kind: 'none' },
  effects: { testRail: 'read', destructive: false, idempotent: true },
  retry: 'ordinary-read',
} as const satisfies OperationDefinition);

/*
 * The case selection. TestRail reads include_all, case_ids and dynamic_filters together
 * under documented precedence rules, and an empty case_ids is what makes a dynamic
 * filter effective, so the list is not held to a minimum length here.
 */
const runSelectionFields = {
  milestone_id: positiveIdSchema.optional(),
  assignedto_id: positiveIdSchema.optional(),
  case_ids: z.array(positiveIdSchema).optional(),
  start_on: nonnegativeIntegerSchema.optional(),
  due_on: nonnegativeIntegerSchema.optional(),
};

const addRunInput = strictObject({
  project_id: positiveIdSchema,
  body: payloadInput(AddRunPayloadSchema, {
    fields: { suite_id: positiveIdSchema.optional(), ...runSelectionFields },
  }),
});

export const addRun = defineOperation({
  token: 'add_run',
  method: 'POST',
  route: 'add_run/{project_id}',
  family: 'T04',
  driverBinding: 'runs.addRun',
  summary: 'Create a test run in a TestRail project. body.suite_id is required unless the project runs in single-suite mode. The run takes every case by default; send include_all false with case_ids for a fixed selection, or with an empty case_ids and dynamic_filters to select cases by filter. TestRail prefers case_ids over dynamic_filters whenever both name cases.',
  inputSchema: addRunInput,
  argumentMap: [
    { input: 'project_id', call: 'single', argument: 0, serialization: 'path' },
    { input: 'body', call: 'single', argument: 1, serialization: 'json-body' },
  ],
  response: { shape: 'record', outerSchema: recordResponse, entitySchema: RunSchema },
  pagination: {
    kind: 'none',
    single: driverCall(addRunInput, 'runs.addRun', (method, input) => method(input.project_id, input.body)),
  },
  files: { kind: 'none' },
  // Repeating the call creates another run, so this is not idempotent.
  effects: { testRail: 'write', destructive: false, idempotent: false },
  retry: 'json-write',
} as const satisfies OperationDefinition);

const updateRunInput = strictObject({
  run_id: positiveIdSchema,
  body: payloadInput(UpdateRunPayloadSchema, { fields: runSelectionFields }),
});

export const updateRun = defineOperation({
  token: 'update_run',
  method: 'POST',
  route: 'update_run/{run_id}',
  family: 'T04',
  driverBinding: 'runs.updateRun',
  summary: 'Update a TestRail test run. Supplied fields replace their current values and the rest are left unchanged; the suite cannot be changed after the run exists. Sending include_all or case_ids replaces the run\'s case selection.',
  inputSchema: updateRunInput,
  argumentMap: [
    { input: 'run_id', call: 'single', argument: 0, serialization: 'path' },
    { input: 'body', call: 'single', argument: 1, serialization: 'json-body' },
  ],
  response: { shape: 'record', outerSchema: recordResponse, entitySchema: RunSchema },
  pagination: {
    kind: 'none',
    single: driverCall(updateRunInput, 'runs.updateRun', (method, input) => method(input.run_id, input.body)),
  },
  files: { kind: 'none' },
  // Applying the same field values again leaves the run in the same state.
  effects: { testRail: 'write', destructive: false, idempotent: true },
  retry: 'json-write',
} as const satisfies OperationDefinition);

const closeRunInput = strictObject({ run_id: positiveIdSchema });

export const closeRun = defineOperation({
  token: 'close_run',
  method: 'POST',
  route: 'close_run/{run_id}',
  family: 'T04',
  driverBinding: 'runs.closeRun',
  summary: 'Close a TestRail test run, archiving its tests and results. This cannot be undone and the run can no longer be changed. Returns the closed run.',
  inputSchema: closeRunInput,
  argumentMap: [{ input: 'run_id', call: 'single', argument: 0, serialization: 'path' }],
  response: { shape: 'record', outerSchema: recordResponse, entitySchema: RunSchema },
  pagination: {
    kind: 'none',
    single: driverCall(closeRunInput, 'runs.closeRun', (method, input) => method(input.run_id)),
  },
  files: { kind: 'none' },
  // Archiving cannot be undone, and a second call has nothing left to close.
  effects: { testRail: 'write', destructive: true, idempotent: false },
  retry: 'json-write',
} as const satisfies OperationDefinition);

const deleteRunInput = strictObject({
  run_id: positiveIdSchema,
  query: strictObject({ soft: z.boolean().optional() }).optional(),
});

export const deleteRun = defineOperation({
  token: 'delete_run',
  method: 'POST',
  route: 'delete_run/{run_id}',
  family: 'T04',
  driverBinding: 'runs.deleteRun',
  summary: 'Delete a TestRail test run with its tests and results. This cannot be undone. Set query.soft to true to preview the affected counts without deleting anything (TestRail 6.5 or later). A run inside a plan is deleted through the plan instead.',
  inputSchema: deleteRunInput,
  argumentMap: [
    { input: 'run_id', call: 'single', argument: 0, serialization: 'path' },
    { input: 'query.soft', call: 'single', argument: 1, property: 'soft', serialization: 'query-scalar' },
  ],
  // Void after a deletion; TestRail's affected-entity counts after a preview, which are
  // the driver's own parse and are not drift-checked here.
  response: { shape: 'union', outerSchema: z.union([z.undefined(), recordResponse]), entitySchema: null },
  pagination: {
    kind: 'none',
    single: driverCall(deleteRunInput, 'runs.deleteRun', (method, input) => {
      const soft = flag(input.query, 'soft');
      return soft === undefined ? method(input.run_id) : method(input.run_id, { soft });
    }),
  },
  files: { kind: 'none' },
  effects: { testRail: 'write', destructive: true, idempotent: false },
  retry: 'json-write',
} as const satisfies OperationDefinition);

// The driver takes this control as the string TestRail reads, not as a boolean, and
// rejects any other value before dispatch.
const getTestInput = strictObject({
  test_id: positiveIdSchema,
  query: strictObject({ with_data: z.enum(['0', '1']).optional() }).optional(),
});

function withData(query: object | undefined): '0' | '1' | undefined {
  const value = (query as Record<string, unknown> | undefined)?.with_data;
  return value === '0' || value === '1' ? value : undefined;
}

export const getTest = defineOperation({
  token: 'get_test',
  method: 'GET',
  route: 'get_test/{test_id}',
  family: 'T04',
  driverBinding: 'tests.getTest',
  summary: 'Get a single TestRail test, one case as instantiated in a run, with its current status and the case fields copied into it. Set query.with_data to "1" to receive its results and attachments alongside. Use the results tools for result history.',
  inputSchema: getTestInput,
  argumentMap: [
    { input: 'test_id', call: 'single', argument: 0, serialization: 'path' },
    { input: 'query.with_data', call: 'single', argument: 1, property: 'withData', serialization: 'query-scalar' },
  ],
  response: { shape: 'record', outerSchema: recordResponse, entitySchema: TestSchema },
  pagination: {
    kind: 'none',
    single: driverCall(getTestInput, 'tests.getTest', (method, input) => {
      const data = withData(input.query);
      return data === undefined ? method(input.test_id) : method(input.test_id, { withData: data });
    }),
  },
  files: { kind: 'none' },
  effects: { testRail: 'read', destructive: false, idempotent: true },
  retry: 'ordinary-read',
} as const satisfies OperationDefinition);

// Both filters are arrays in the driver's option type and comma-joined on the wire.
const getTestsInput = createListInput({
  path: { run_id: positiveIdSchema },
  query: {
    status_id: z.array(positiveIdSchema).min(1).optional(),
    label_id: z.array(positiveIdSchema).min(1).optional(),
  },
  pagination: 'controlled',
});

type TestFilter = Omit<GetTestsOptions, 'limit' | 'offset' | 'status_id' | 'label_id'>;

function testFilter(query: object | undefined): TestFilter {
  const source = (query ?? {}) as Record<string, unknown>;
  const filter: Record<string, unknown> = {};
  if (source.status_id !== undefined) filter.statusId = source.status_id;
  if (source.label_id !== undefined) filter.labelId = source.label_id;
  return filter;
}

function testFilterMappings(call: 'page' | 'all'): readonly ArgumentMapping[] {
  return [
    { input: 'query.status_id', call, argument: 1, property: 'statusId', serialization: 'query-list' },
    { input: 'query.label_id', call, argument: 1, property: 'labelId', serialization: 'query-list' },
  ];
}

export const getTests = defineOperation({
  token: 'get_tests',
  method: 'GET',
  route: 'get_tests/{run_id}',
  family: 'T04',
  driverBinding: 'tests.getTests',
  summary: 'List the tests of a TestRail test run, optionally filtered by current status or by label. Each filter takes a non-empty array of IDs.',
  inputSchema: getTestsInput,
  argumentMap: [
    { input: 'run_id', call: 'page', argument: 0, serialization: 'path' },
    ...testFilterMappings('page'),
    { input: 'query.limit', call: 'page', argument: 1, property: 'limit', serialization: 'query-scalar' },
    { input: 'query.offset', call: 'page', argument: 1, property: 'offset', serialization: 'query-scalar' },
    { input: 'run_id', call: 'all', argument: 0, serialization: 'path' },
    ...testFilterMappings('all'),
    ...aggregateControlMappings(1),
  ],
  response: { shape: 'page', outerSchema: pageResponse, entitySchema: TestSchema },
  pagination: {
    kind: 'controlled',
    page: driverCall(getTestsInput, 'tests.getTestsPage', (method, input) => method(input.run_id, {
      ...testFilter(input.query),
      ...pageRequestDefaults({ limit: control(input.query, 'limit'), offset: control(input.query, 'offset') }),
    })),
    all: driverCall(getTestsInput, 'tests.getAllTests', (method, input, context) => method(input.run_id, {
      ...testFilter(input.query),
      ...driverAllOptions(allControls(input._mcp), context.limits),
    })),
  },
  files: { kind: 'none' },
  effects: { testRail: 'read', destructive: false, idempotent: true },
  retry: 'ordinary-read',
} as const satisfies OperationDefinition);

/** A label is named by its ID or its title, as TestRail documents for these two tools. */
const labelListSchema = z.array(z.union([positiveIdSchema, z.string()])).min(1);

const updateTestInput = strictObject({
  test_id: positiveIdSchema,
  body: payloadInput(UpdateTestLabelsPayloadSchema, { fields: { labels: labelListSchema } }),
});

export const updateTest = defineOperation({
  token: 'update_test',
  method: 'POST',
  route: 'update_test/{test_id}',
  family: 'T04',
  driverBinding: 'tests.updateTest',
  summary: 'Replace the labels assigned to a TestRail test. This is the only field of a test the API can change: a test\'s status comes from adding a result, and its other fields come from the case it was created from. Returns the updated test.',
  inputSchema: updateTestInput,
  argumentMap: [
    { input: 'test_id', call: 'single', argument: 0, serialization: 'path' },
    { input: 'body', call: 'single', argument: 1, serialization: 'json-body' },
  ],
  response: { shape: 'record', outerSchema: recordResponse, entitySchema: TestSchema },
  pagination: {
    kind: 'none',
    single: driverCall(updateTestInput, 'tests.updateTest', (method, input) => method(input.test_id, input.body)),
  },
  files: { kind: 'none' },
  // Assigning the same labels again leaves the test in the same state.
  effects: { testRail: 'write', destructive: false, idempotent: true },
  retry: 'json-write',
} as const satisfies OperationDefinition);

const updateTestsInput = strictObject({
  body: payloadInput(UpdateTestsLabelsPayloadSchema, {
    fields: { test_ids: z.array(positiveIdSchema).min(1), labels: labelListSchema },
  }),
});

export const updateTests = defineOperation({
  token: 'update_tests',
  method: 'POST',
  route: 'update_tests',
  family: 'T04',
  driverBinding: 'tests.updateTests',
  summary: 'Replace the labels of several TestRail tests with the same set in one call. body.test_ids names the tests, which may belong to different runs. TestRail acknowledges the assignment by echoing the IDs and labels rather than returning the tests, so read a test afterwards to see it.',
  inputSchema: updateTestsInput,
  argumentMap: [{ input: 'body', call: 'single', argument: 0, serialization: 'json-body' }],
  // The acknowledgement, not the tests: it carries the IDs and the labels applied.
  response: { shape: 'record', outerSchema: recordResponse, entitySchema: UpdateTestsResponseSchema },
  pagination: {
    kind: 'none',
    single: driverCall(updateTestsInput, 'tests.updateTests', (method, input) => method(input.body)),
  },
  files: { kind: 'none' },
  // Assigning the same labels again leaves every named test in the same state.
  effects: { testRail: 'write', destructive: false, idempotent: true },
  retry: 'json-write',
} as const satisfies OperationDefinition);

/** Registered in tool-name order by the registry; listed here in reviewed order. */
export const t04 = [
  getRun, getRuns, addRun, updateRun, closeRun, deleteRun,
  getTest, getTests, updateTest, updateTests,
] as const;
