import {
  AddRunPayloadSchema, RunSchema, TestSchema, UpdateRunPayloadSchema,
  UpdateTestLabelsPayloadSchema, UpdateTestsLabelsPayloadSchema, UpdateTestsResponseSchema,
  type GetRunsOptions, type GetTestsOptions,
} from '@dichovsky/testrail-api-client';
import { z } from 'zod';
import {
  idFilterSchema, nonnegativeIntegerSchema, payloadInput, positiveIdSchema, strictObject,
} from '../../contracts/inputs.js';
import { defineOperation } from '../registry.js';
import { createListDefinition, type ListFilters } from '../lists.js';
import { flag, recordResponse, softDeletePreview } from './common.js';

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
  pagination: (bind) => ({
    kind: 'none',
    single: bind('runs.getRun', (method, input) => method(input.run_id)),
  }),
  files: { kind: 'none' },
  effects: { testRail: 'read', destructive: false, idempotent: true },
  retry: 'ordinary-read',
});

// TestRail documents every creator as a comma-separated list, but the driver's option
// for this one filter is an array alone, so this tool takes an array rather than
// widening the value on the way through.
const getRunsList = createListDefinition({
  path: { project_id: { schema: positiveIdSchema, argument: 0 } },
  pagination: 'controlled',
  optionsArgument: 1,
  filters: {
    created_after: { schema: nonnegativeIntegerSchema.optional(), property: 'createdAfter', serialization: 'query-scalar' },
    created_before: { schema: nonnegativeIntegerSchema.optional(), property: 'createdBefore', serialization: 'query-scalar' },
    created_by: { schema: z.array(positiveIdSchema).min(1).optional(), property: 'createdBy', serialization: 'query-list' },
    include_plan_runs: { schema: z.boolean().optional(), property: 'includePlanRuns', serialization: 'query-scalar' },
    is_completed: { schema: z.boolean().optional(), property: 'isCompleted', serialization: 'query-scalar' },
    milestone_id: { schema: idFilterSchema.optional(), property: 'milestoneId', serialization: 'query-list' },
    refs: { schema: z.string().optional(), property: 'refs', serialization: 'query-scalar' },
    suite_id: { schema: idFilterSchema.optional(), property: 'suiteId', serialization: 'query-list' },
  } satisfies ListFilters<GetRunsOptions>,
  entitySchema: RunSchema,
});

export const getRuns = defineOperation({
  token: 'get_runs',
  method: 'GET',
  route: 'get_runs/{project_id}',
  family: 'T04',
  driverBinding: 'runs.getRuns',
  summary: 'List the test runs of a TestRail project that do not belong to a test plan, unless query.include_plan_runs asks for those as well. Filter by creation time (Unix seconds), creator, completion, milestone, suite or a single reference. Read a plan for the runs inside it.',
  ...getRunsList.bind({
    page: {
      binding: 'runs.getRunsPage',
      call: (method, input, options) => method(input.project_id, options),
    },
    all: {
      binding: 'runs.getAllRuns',
      call: (method, input, options) => method(input.project_id, options),
    },
  }),
  files: { kind: 'none' },
  effects: { testRail: 'read', destructive: false, idempotent: true },
  retry: 'ordinary-read',
});

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
  pagination: (bind) => ({
    kind: 'none',
    single: bind('runs.addRun', (method, input) => method(input.project_id, input.body)),
  }),
  files: { kind: 'none' },
  // Repeating the call creates another run, so this is not idempotent.
  effects: { testRail: 'write', destructive: false, idempotent: false },
  retry: 'json-write',
});

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
  pagination: (bind) => ({
    kind: 'none',
    single: bind('runs.updateRun', (method, input) => method(input.run_id, input.body)),
  }),
  files: { kind: 'none' },
  /*
   * Applying the same field values again leaves the run in the same state, so this is
   * idempotent. It is also destructive: narrowing the case selection removes the tests
   * that fall outside it, and their results with them, which no later call restores.
   */
  effects: { testRail: 'write', destructive: true, idempotent: true },
  retry: 'json-write',
});

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
  pagination: (bind) => ({
    kind: 'none',
    single: bind('runs.closeRun', (method, input) => method(input.run_id)),
  }),
  files: { kind: 'none' },
  // Archiving cannot be undone, and a second call has nothing left to close.
  effects: { testRail: 'write', destructive: true, idempotent: false },
  retry: 'json-write',
});

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
  summary: 'Delete a TestRail test run with its tests and results. This cannot be undone. Set query.soft to true to preview the affected counts without deleting anything (TestRail 6.5 or later); a preview reply with no count is reported as an unknown outcome, since an instance that ignores the flag deletes. A run inside a plan is deleted through the plan instead.',
  inputSchema: deleteRunInput,
  argumentMap: [
    { input: 'run_id', call: 'single', argument: 0, serialization: 'path' },
    { input: 'query.soft', call: 'single', argument: 1, property: 'soft', serialization: 'query-scalar' },
  ],
  // Void after a deletion; TestRail's affected-entity counts after a preview, which are
  // drift-checked advisorily and must carry at least one count (see softDeletePreview).
  response: { shape: 'union', outerSchema: z.union([z.undefined(), recordResponse]), entitySchema: null, preview: softDeletePreview },
  pagination: (bind) => ({
    kind: 'none',
    single: bind('runs.deleteRun', (method, input) => {
      const soft = flag(input.query, 'soft');
      return soft === undefined ? method(input.run_id) : method(input.run_id, { soft });
    }),
  }),
  files: { kind: 'none' },
  effects: { testRail: 'write', destructive: true, idempotent: false },
  retry: 'json-write',
});

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
  pagination: (bind) => ({
    kind: 'none',
    single: bind('tests.getTest', async (method, input) => {
      const data = withData(input.query);
      // With the data, the driver assembles one record from TestRail's test, results and
      // attachments, and refuses a reply that is not that shape as an invalid response.
      return data === undefined ? method(input.test_id) : method(input.test_id, { withData: data });
    }),
  }),
  files: { kind: 'none' },
  effects: { testRail: 'read', destructive: false, idempotent: true },
  retry: 'ordinary-read',
});

// Both filters are arrays in the driver's option type and comma-joined on the wire.
const getTestsList = createListDefinition({
  path: { run_id: { schema: positiveIdSchema, argument: 0 } },
  pagination: 'controlled',
  optionsArgument: 1,
  filters: {
    status_id: { schema: z.array(positiveIdSchema).min(1).optional(), property: 'statusId', serialization: 'query-list' },
    label_id: { schema: z.array(positiveIdSchema).min(1).optional(), property: 'labelId', serialization: 'query-list' },
  } satisfies ListFilters<GetTestsOptions>,
  entitySchema: TestSchema,
});

export const getTests = defineOperation({
  token: 'get_tests',
  method: 'GET',
  route: 'get_tests/{run_id}',
  family: 'T04',
  driverBinding: 'tests.getTests',
  summary: 'List the tests of a TestRail test run, optionally filtered by current status or by label. Each filter takes a non-empty array of IDs.',
  ...getTestsList.bind({
    page: {
      binding: 'tests.getTestsPage',
      call: (method, input, options) => method(input.run_id, options),
    },
    all: {
      binding: 'tests.getAllTests',
      call: (method, input, options) => method(input.run_id, options),
    },
  }),
  files: { kind: 'none' },
  effects: { testRail: 'read', destructive: false, idempotent: true },
  retry: 'ordinary-read',
});

/**
 * A label is named by its ID or its title, as TestRail documents for these two tools.
 *
 * The array is not held to a minimum length. These endpoints replace a test's labels
 * rather than adding to them, so the empty array is how a caller clears them, and this
 * is the only field of a test the API can change: refusing it would leave the server
 * able to attach a label and never to remove one. The Cases family takes the same view
 * of the identical field.
 */
const labelListSchema = z.array(z.union([positiveIdSchema, z.string()]));

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
  pagination: (bind) => ({
    kind: 'none',
    single: bind('tests.updateTest', (method, input) => method(input.test_id, input.body)),
  }),
  files: { kind: 'none' },
  // Assigning the same labels again leaves the test in the same state.
  effects: { testRail: 'write', destructive: false, idempotent: true },
  retry: 'json-write',
});

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
  pagination: (bind) => ({
    kind: 'none',
    single: bind('tests.updateTests', (method, input) => method(input.body)),
  }),
  files: { kind: 'none' },
  // Assigning the same labels again leaves every named test in the same state.
  effects: { testRail: 'write', destructive: false, idempotent: true },
  retry: 'json-write',
});

/** Registered in tool-name order by the registry; listed here in reviewed order. */
export const t04 = [
  getRun, getRuns, addRun, updateRun, closeRun, deleteRun,
  getTest, getTests, updateTest, updateTests,
] as const;
