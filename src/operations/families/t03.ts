import {
  AddSharedStepPayloadSchema, BddSchema, CaseSchema, SharedStepSchema, StepHistoryEntrySchema,
  UpdateSharedStepPayloadSchema,
  type GetBddsOptions, type GetSharedStepsOptions, type UploadFilePathInput,
} from '@dichovsky/testrail-api-client';
import { z } from 'zod';
import { AdapterError } from '../../contracts/errors.js';
import {
  bddFilenameSchema, contentTypeSchema, createListInput, filePathSchema, idFilterSchema,
  nonnegativeIntegerSchema, payloadInput, positiveIdSchema, strictObject,
} from '../../contracts/inputs.js';
import { driverAllOptions, pageRequestDefaults } from '../../contracts/pagination.js';
import { driverCall, type CallContext } from '../driver-call.js';
import { defineOperation, type OperationDefinition } from '../registry.js';
import {
  aggregateControlMappings, allControls, control, flag, pageResponse, recordResponse, safetyControlMappings,
} from './common.js';

const getBddInput = strictObject({ case_id: positiveIdSchema });

export const getBdd = defineOperation({
  token: 'get_bdd',
  method: 'GET',
  route: 'get_bdd/{case_id}',
  family: 'T03',
  driverBinding: 'bdd.getBdd',
  summary: 'Export a TestRail case\'s BDD scenario as Gherkin feature text. The text is returned as it stands, and a case with no scenario answers with an empty string rather than an error.',
  inputSchema: getBddInput,
  argumentMap: [{ input: 'case_id', call: 'single', argument: 0, serialization: 'path' }],
  // The only endpoint of the API that answers with text rather than JSON.
  response: { shape: 'text', outerSchema: z.string(), entitySchema: null },
  pagination: {
    kind: 'none',
    single: driverCall(getBddInput, 'bdd.getBdd', (method, input) => method(input.case_id)),
  },
  files: { kind: 'none' },
  effects: { testRail: 'read', destructive: false, idempotent: true },
  retry: 'ordinary-read',
} as const satisfies OperationDefinition);

/** One reference sends refs=; several send the repeated refs[] form TestRail 10.7 accepts. */
const bddRefsSchema = z.union([z.string(), z.array(z.string()).min(1)]);

const getBddsInput = createListInput({
  path: { project_id: positiveIdSchema },
  query: {
    suite_id: positiveIdSchema.optional(),
    section_id: positiveIdSchema.optional(),
    label_id: idFilterSchema.optional(),
    refs: bddRefsSchema.optional(),
  },
  pagination: 'controlled',
});

/** Derived from the driver's own option type, so a rename there fails the build here. */
type BddFilter = Omit<GetBddsOptions, 'limit' | 'offset'>;

/** Renamed filters, carried over only when supplied so the driver sends nothing for the rest. */
function bddFilter(query: object | undefined): BddFilter {
  const source = (query ?? {}) as Record<string, unknown>;
  const filter: Record<string, unknown> = {};
  for (const [name, option] of [['suite_id', 'suiteId'], ['section_id', 'sectionId'], ['label_id', 'labelId'], ['refs', 'refs']] as const) {
    if (source[name] !== undefined) filter[option] = source[name];
  }
  return filter;
}

function bddFilterMappings(call: 'page' | 'all') {
  return [
    { input: 'query.suite_id', call, argument: 1, property: 'suiteId', serialization: 'query-scalar' },
    { input: 'query.section_id', call, argument: 1, property: 'sectionId', serialization: 'query-scalar' },
    { input: 'query.label_id', call, argument: 1, property: 'labelId', serialization: 'query-list' },
    { input: 'query.refs', call, argument: 1, property: 'refs', serialization: 'query-repeated' },
  ] as const;
}

export const getBdds = defineOperation({
  token: 'get_bdds',
  method: 'GET',
  route: 'get_bdds/{project_id}',
  family: 'T03',
  driverBinding: 'bdd.getBdds',
  summary: 'List the BDD feature content of a TestRail project (TestRail 10.5 or later), optionally filtered by suite, section, label or references. A label filter takes one ID or a non-empty array.',
  inputSchema: getBddsInput,
  argumentMap: [
    { input: 'project_id', call: 'page', argument: 0, serialization: 'path' },
    ...bddFilterMappings('page'),
    { input: 'query.limit', call: 'page', argument: 1, property: 'limit', serialization: 'query-scalar' },
    { input: 'query.offset', call: 'page', argument: 1, property: 'offset', serialization: 'query-scalar' },
    { input: 'project_id', call: 'all', argument: 0, serialization: 'path' },
    ...bddFilterMappings('all'),
    ...aggregateControlMappings(1),
  ],
  // The driver's item schema for this endpoint is an open record, so no field of a row
  // is checked. It still says a row is an object, which is worth keeping: a page of
  // strings or nulls would otherwise reach the caller with nothing said about it.
  response: { shape: 'page', outerSchema: pageResponse, entitySchema: BddSchema },
  pagination: {
    kind: 'controlled',
    page: driverCall(getBddsInput, 'bdd.getBddsPage', (method, input) => method(input.project_id, {
      ...bddFilter(input.query),
      ...pageRequestDefaults({ limit: control(input.query, 'limit'), offset: control(input.query, 'offset') }),
    })),
    all: driverCall(getBddsInput, 'bdd.getAllBdds', (method, input, context) => method(input.project_id, {
      ...bddFilter(input.query),
      ...driverAllOptions(allControls(input._mcp), context.limits),
    })),
  },
  files: { kind: 'none' },
  effects: { testRail: 'read', destructive: false, idempotent: true },
  retry: 'ordinary-read',
} as const satisfies OperationDefinition);

/**
 * The staged copy of the caller's file.
 *
 * The adapter stages an owned copy before the call and passes it here. Its absence
 * would mean the transport dispatched an upload it never staged, which is a fault in
 * this adapter rather than anything the caller did.
 */
function staged(context: CallContext): UploadFilePathInput {
  if (context.upload === undefined) throw new AdapterError('INTERNAL_ERROR');
  return context.upload;
}

/** Every upload takes the caller's path, the multipart filename and an optional media type. */
const uploadFields = {
  file_path: filePathSchema,
  filename: bddFilenameSchema,
  content_type: contentTypeSchema.optional(),
};

const addBddInput = strictObject({ section_id: positiveIdSchema, ...uploadFields });

export const addBdd = defineOperation({
  token: 'add_bdd',
  method: 'POST',
  route: 'add_bdd/{section_id}',
  family: 'T03',
  driverBinding: 'bdd.addBdd',
  summary: 'Import a Gherkin feature file into a TestRail section, creating a BDD test case from it. Returns the created case.',
  inputSchema: addBddInput,
  argumentMap: [
    { input: 'section_id', call: 'single', argument: 0, serialization: 'path' },
    { input: 'file_path', call: 'single', argument: 1, property: 'path', serialization: 'staged-file' },
    { input: 'content_type', call: 'single', argument: 1, property: 'type', serialization: 'multipart' },
    { input: 'filename', call: 'single', argument: 2, serialization: 'multipart' },
  ],
  response: { shape: 'record', outerSchema: recordResponse, entitySchema: CaseSchema },
  pagination: {
    kind: 'none',
    single: driverCall(addBddInput, 'bdd.addBdd',
      (method, input, context) => method(input.section_id, staged(context), input.filename)),
  },
  files: { kind: 'upload', featureFilename: true },
  // Repeating the call creates another case, so this is not idempotent. A multipart
  // upload is never retried: the request body is a consumed stream.
  effects: { testRail: 'write', destructive: false, idempotent: false },
  retry: 'never',
} as const satisfies OperationDefinition);

const updateBddInput = strictObject({ case_id: positiveIdSchema, ...uploadFields });

export const updateBdd = defineOperation({
  token: 'update_bdd',
  method: 'POST',
  route: 'update_bdd/{case_id}',
  family: 'T03',
  driverBinding: 'bdd.updateBdd',
  summary: 'Replace a TestRail case\'s BDD scenario with the contents of a Gherkin feature file. The previous scenario is overwritten. Returns the updated case.',
  inputSchema: updateBddInput,
  argumentMap: [
    { input: 'case_id', call: 'single', argument: 0, serialization: 'path' },
    { input: 'file_path', call: 'single', argument: 1, property: 'path', serialization: 'staged-file' },
    { input: 'content_type', call: 'single', argument: 1, property: 'type', serialization: 'multipart' },
    { input: 'filename', call: 'single', argument: 2, serialization: 'multipart' },
  ],
  response: { shape: 'record', outerSchema: recordResponse, entitySchema: CaseSchema },
  pagination: {
    kind: 'none',
    single: driverCall(updateBddInput, 'bdd.updateBdd',
      (method, input, context) => method(input.case_id, staged(context), input.filename)),
  },
  files: { kind: 'upload', featureFilename: true },
  // Sending the same feature file again leaves the case with the same scenario.
  effects: { testRail: 'write', destructive: false, idempotent: true },
  retry: 'never',
} as const satisfies OperationDefinition);

const getSharedStepInput = strictObject({ shared_step_id: positiveIdSchema });

export const getSharedStep = defineOperation({
  token: 'get_shared_step',
  method: 'GET',
  route: 'get_shared_step/{shared_step_id}',
  family: 'T03',
  driverBinding: 'sharedSteps.getSharedStep',
  summary: 'Get a single TestRail shared step set by its ID, with its separated steps and the cases using it (TestRail 7.0 or later).',
  inputSchema: getSharedStepInput,
  argumentMap: [{ input: 'shared_step_id', call: 'single', argument: 0, serialization: 'path' }],
  response: { shape: 'record', outerSchema: recordResponse, entitySchema: SharedStepSchema },
  pagination: {
    kind: 'none',
    single: driverCall(getSharedStepInput, 'sharedSteps.getSharedStep', (method, input) => method(input.shared_step_id)),
  },
  files: { kind: 'none' },
  effects: { testRail: 'read', destructive: false, idempotent: true },
  retry: 'ordinary-read',
} as const satisfies OperationDefinition);

const getSharedStepsInput = createListInput({
  path: { project_id: positiveIdSchema },
  query: {
    created_after: nonnegativeIntegerSchema.optional(),
    created_before: nonnegativeIntegerSchema.optional(),
    created_by: idFilterSchema.optional(),
    updated_after: nonnegativeIntegerSchema.optional(),
    updated_before: nonnegativeIntegerSchema.optional(),
    refs: z.string().optional(),
  },
  pagination: 'controlled',
});

const sharedStepFilterNames = {
  created_after: 'createdAfter', created_before: 'createdBefore', created_by: 'createdBy',
  updated_after: 'updatedAfter', updated_before: 'updatedBefore', refs: 'refs',
} as const;

/** Derived from the driver's own option type, so a rename there fails the build here. */
type SharedStepFilter = Omit<GetSharedStepsOptions, 'limit' | 'offset'>;

function sharedStepFilter(query: object | undefined): SharedStepFilter {
  const source = (query ?? {}) as Record<string, unknown>;
  const filter: Record<string, unknown> = {};
  for (const [name, option] of Object.entries(sharedStepFilterNames)) {
    if (source[name] !== undefined) filter[option] = source[name];
  }
  return filter;
}

function sharedStepFilterMappings(call: 'page' | 'all') {
  return Object.entries(sharedStepFilterNames).map(([name, property]) => ({
    input: `query.${name}`, call, argument: 1, property,
    serialization: name === 'created_by' ? 'query-list' as const : 'query-scalar' as const,
  }));
}

export const getSharedSteps = defineOperation({
  token: 'get_shared_steps',
  method: 'GET',
  route: 'get_shared_steps/{project_id}',
  family: 'T03',
  driverBinding: 'sharedSteps.getSharedSteps',
  summary: 'List the shared step sets of a TestRail project (TestRail 7.0 or later), optionally filtered by creation or update time (Unix seconds), creator or a single reference. TestRail returns only the ID and title of each set in this list; read one set for its steps.',
  inputSchema: getSharedStepsInput,
  argumentMap: [
    { input: 'project_id', call: 'page', argument: 0, serialization: 'path' },
    ...sharedStepFilterMappings('page'),
    { input: 'query.limit', call: 'page', argument: 1, property: 'limit', serialization: 'query-scalar' },
    { input: 'query.offset', call: 'page', argument: 1, property: 'offset', serialization: 'query-scalar' },
    { input: 'project_id', call: 'all', argument: 0, serialization: 'path' },
    ...sharedStepFilterMappings('all'),
    ...aggregateControlMappings(1),
  ],
  response: { shape: 'page', outerSchema: pageResponse, entitySchema: SharedStepSchema },
  pagination: {
    kind: 'controlled',
    page: driverCall(getSharedStepsInput, 'sharedSteps.getSharedStepsPage', (method, input) => method(input.project_id, {
      ...sharedStepFilter(input.query),
      ...pageRequestDefaults({ limit: control(input.query, 'limit'), offset: control(input.query, 'offset') }),
    })),
    all: driverCall(getSharedStepsInput, 'sharedSteps.getAllSharedSteps', (method, input, context) => method(input.project_id, {
      ...sharedStepFilter(input.query),
      ...driverAllOptions(allControls(input._mcp), context.limits),
    })),
  },
  files: { kind: 'none' },
  effects: { testRail: 'read', destructive: false, idempotent: true },
  retry: 'ordinary-read',
} as const satisfies OperationDefinition);

// TestRail documents no request controls for this endpoint, so the driver's page helper
// sends none and the caller cannot choose an offset: the server picks each page.
const getSharedStepHistoryInput = createListInput({
  path: { shared_step_id: positiveIdSchema },
  pagination: 'response-driven',
});

export const getSharedStepHistory = defineOperation({
  token: 'get_shared_step_history',
  method: 'GET',
  route: 'get_shared_step_history/{shared_step_id}',
  family: 'T03',
  driverBinding: 'sharedSteps.getSharedStepHistory',
  summary: 'List the change history of a TestRail shared step set (TestRail 7.3 or later). Each entry records who changed the set, when, and the steps as they stood. This endpoint accepts no paging controls, so the server chooses each page; a complete read that stops at one of its bounds cannot be resumed from where it stopped, and needs a larger bound instead.',
  inputSchema: getSharedStepHistoryInput,
  argumentMap: [
    { input: 'shared_step_id', call: 'page', argument: 0, serialization: 'path' },
    { input: 'shared_step_id', call: 'all', argument: 0, serialization: 'path' },
    ...safetyControlMappings(1),
  ],
  response: { shape: 'page', outerSchema: pageResponse, entitySchema: StepHistoryEntrySchema },
  pagination: {
    kind: 'response_driven',
    page: driverCall(getSharedStepHistoryInput, 'sharedSteps.getSharedStepHistoryPage',
      (method, input) => method(input.shared_step_id)),
    all: driverCall(getSharedStepHistoryInput, 'sharedSteps.getAllSharedStepHistory',
      (method, input, context) => method(input.shared_step_id, driverAllOptions(allControls(input._mcp), context.limits))),
  },
  files: { kind: 'none' },
  effects: { testRail: 'read', destructive: false, idempotent: true },
  retry: 'ordinary-read',
} as const satisfies OperationDefinition);

/*
 * TestRail warns that the separated-steps field carries a per-instance system name: an
 * administrator who removes and recreates it gets a different custom_ name. Refusing
 * every other custom_ name would make this tool unusable on such an instance, so the
 * payload keeps the documented field and admits flat custom_ extensions beside it.
 */
const addSharedStepInput = strictObject({
  project_id: positiveIdSchema,
  body: payloadInput(AddSharedStepPayloadSchema, { extensions: 'custom' }),
});

export const addSharedStep = defineOperation({
  token: 'add_shared_step',
  method: 'POST',
  route: 'add_shared_step/{project_id}',
  family: 'T03',
  driverBinding: 'sharedSteps.addSharedStep',
  summary: 'Create a shared step set in a TestRail project (TestRail 7.0 or later). Each entry of custom_steps_separated describes one step through content, expected, additional_info and refs. An instance whose separated-steps field was recreated under another system name takes that flat custom_ name instead.',
  inputSchema: addSharedStepInput,
  argumentMap: [
    { input: 'project_id', call: 'single', argument: 0, serialization: 'path' },
    { input: 'body', call: 'single', argument: 1, serialization: 'json-body' },
  ],
  response: { shape: 'record', outerSchema: recordResponse, entitySchema: SharedStepSchema },
  pagination: {
    kind: 'none',
    single: driverCall(addSharedStepInput, 'sharedSteps.addSharedStep',
      (method, input) => method(input.project_id, input.body)),
  },
  files: { kind: 'none' },
  // Repeating the call creates another set, so this is not idempotent.
  effects: { testRail: 'write', destructive: false, idempotent: false },
  retry: 'json-write',
} as const satisfies OperationDefinition);

const updateSharedStepInput = strictObject({
  shared_step_id: positiveIdSchema,
  body: payloadInput(UpdateSharedStepPayloadSchema, { extensions: 'custom' }),
});

export const updateSharedStep = defineOperation({
  token: 'update_shared_step',
  method: 'POST',
  route: 'update_shared_step/{shared_step_id}',
  family: 'T03',
  driverBinding: 'sharedSteps.updateSharedStep',
  summary: 'Update a TestRail shared step set. Supplied fields replace their current values, and sending custom_steps_separated replaces every existing step rather than adding to them.',
  inputSchema: updateSharedStepInput,
  argumentMap: [
    { input: 'shared_step_id', call: 'single', argument: 0, serialization: 'path' },
    { input: 'body', call: 'single', argument: 1, serialization: 'json-body' },
  ],
  response: { shape: 'record', outerSchema: recordResponse, entitySchema: SharedStepSchema },
  pagination: {
    kind: 'none',
    single: driverCall(updateSharedStepInput, 'sharedSteps.updateSharedStep',
      (method, input) => method(input.shared_step_id, input.body)),
  },
  files: { kind: 'none' },
  // Applying the same field values again leaves the set in the same state.
  effects: { testRail: 'write', destructive: false, idempotent: true },
  retry: 'json-write',
} as const satisfies OperationDefinition);

const deleteSharedStepInput = strictObject({
  shared_step_id: positiveIdSchema,
  body: strictObject({ keep_in_cases: z.boolean().optional() }).optional(),
});

export const deleteSharedStep = defineOperation({
  token: 'delete_shared_step',
  method: 'POST',
  route: 'delete_shared_step/{shared_step_id}',
  family: 'T03',
  driverBinding: 'sharedSteps.deleteSharedStep',
  summary: 'Delete a TestRail shared step set. This cannot be undone. By default the steps stay in the cases that used them; set body.keep_in_cases to false to remove them from those cases as well.',
  inputSchema: deleteSharedStepInput,
  argumentMap: [
    { input: 'shared_step_id', call: 'single', argument: 0, serialization: 'path' },
    { input: 'body.keep_in_cases', call: 'single', argument: 1, property: 'keepInCases', serialization: 'json-body' },
  ],
  response: { shape: 'void', outerSchema: z.undefined(), entitySchema: null },
  pagination: {
    kind: 'none',
    single: driverCall(deleteSharedStepInput, 'sharedSteps.deleteSharedStep', (method, input) => {
      const keepInCases = flag(input.body, 'keep_in_cases');
      return keepInCases === undefined ? method(input.shared_step_id) : method(input.shared_step_id, { keepInCases });
    }),
  },
  files: { kind: 'none' },
  // Removing a set is irreversible, and removing its steps from cases doubly so.
  effects: { testRail: 'write', destructive: true, idempotent: false },
  retry: 'json-write',
} as const satisfies OperationDefinition);

/** Registered in tool-name order by the registry; listed here in reviewed order. */
export const t03 = [
  getBdd, getBdds, addBdd, updateBdd,
  getSharedStep, getSharedSteps, getSharedStepHistory,
  addSharedStep, updateSharedStep, deleteSharedStep,
] as const;
