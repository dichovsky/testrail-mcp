import {
  AddConfigurationGroupPayloadSchema, AddConfigurationPayloadSchema, AddPlanEntryPayloadSchema, AddPlanPayloadSchema,
  AddRunToPlanEntryPayloadSchema, ConfigurationGroupSchema, ConfigurationSchema, PlanEntrySchema, PlanSchema, RunSchema,
  UpdateConfigurationGroupPayloadSchema, UpdateConfigurationPayloadSchema, UpdatePlanEntryPayloadSchema,
  UpdatePlanPayloadSchema, UpdateRunInPlanEntryPayloadSchema,
  type GetPlansOptions,
} from '@dichovsky/testrail-api-client';
import { z } from 'zod';
import {
  createListInput, entryIdSchema, nonnegativeIntegerSchema, payloadArray, payloadInput, positiveIdSchema, strictObject,
} from '../../contracts/inputs.js';
import { driverAllOptions, pageRequestDefaults } from '../../contracts/pagination.js';
import { driverCall } from '../driver-call.js';
import { defineOperation, type ArgumentMapping, type OperationDefinition } from '../registry.js';
import {
  aggregateControlMappings, allControls, control, pageResponse, recordResponse,
} from './common.js';

// ---------------------------------------------------------------- configurations

const getConfigsInput = strictObject({ project_id: positiveIdSchema });

export const getConfigs = defineOperation({
  token: 'get_configs',
  method: 'GET',
  route: 'get_configs/{project_id}',
  family: 'T06',
  driverBinding: 'configurations.getConfigurations',
  summary: 'List the configuration groups of a TestRail project, each with the configurations it contains. A plan entry selects one configuration from each group to make a combination.',
  inputSchema: getConfigsInput,
  argumentMap: [{ input: 'project_id', call: 'single', argument: 0, serialization: 'path' }],
  response: { shape: 'array', outerSchema: z.array(z.unknown()), entitySchema: ConfigurationGroupSchema },
  pagination: {
    kind: 'none',
    single: driverCall(getConfigsInput, 'configurations.getConfigurations', (method, input) => method(input.project_id)),
  },
  files: { kind: 'none' },
  effects: { testRail: 'read', destructive: false, idempotent: true },
  retry: 'ordinary-read',
} as const satisfies OperationDefinition);

const addConfigGroupInput = strictObject({
  project_id: positiveIdSchema,
  body: payloadInput(AddConfigurationGroupPayloadSchema),
});

export const addConfigGroup = defineOperation({
  token: 'add_config_group',
  method: 'POST',
  route: 'add_config_group/{project_id}',
  family: 'T06',
  driverBinding: 'configurations.addConfigurationGroup',
  summary: 'Create a configuration group in a TestRail project (TestRail 5.2 or later). The group holds the configurations a plan entry chooses between, such as browsers or operating systems.',
  inputSchema: addConfigGroupInput,
  argumentMap: [
    { input: 'project_id', call: 'single', argument: 0, serialization: 'path' },
    { input: 'body', call: 'single', argument: 1, serialization: 'json-body' },
  ],
  response: { shape: 'record', outerSchema: recordResponse, entitySchema: ConfigurationGroupSchema },
  pagination: {
    kind: 'none',
    single: driverCall(addConfigGroupInput, 'configurations.addConfigurationGroup',
      (method, input) => method(input.project_id, input.body)),
  },
  files: { kind: 'none' },
  // Repeating the call creates another group, so this is not idempotent.
  effects: { testRail: 'write', destructive: false, idempotent: false },
  retry: 'json-write',
} as const satisfies OperationDefinition);

const updateConfigGroupInput = strictObject({
  config_group_id: positiveIdSchema,
  body: payloadInput(UpdateConfigurationGroupPayloadSchema),
});

export const updateConfigGroup = defineOperation({
  token: 'update_config_group',
  method: 'POST',
  route: 'update_config_group/{config_group_id}',
  family: 'T06',
  driverBinding: 'configurations.updateConfigurationGroup',
  summary: 'Rename a TestRail configuration group (TestRail 5.2 or later).',
  inputSchema: updateConfigGroupInput,
  argumentMap: [
    { input: 'config_group_id', call: 'single', argument: 0, serialization: 'path' },
    { input: 'body', call: 'single', argument: 1, serialization: 'json-body' },
  ],
  response: { shape: 'record', outerSchema: recordResponse, entitySchema: ConfigurationGroupSchema },
  pagination: {
    kind: 'none',
    single: driverCall(updateConfigGroupInput, 'configurations.updateConfigurationGroup',
      (method, input) => method(input.config_group_id, input.body)),
  },
  files: { kind: 'none' },
  // Applying the same name again leaves the group in the same state.
  effects: { testRail: 'write', destructive: false, idempotent: true },
  retry: 'json-write',
} as const satisfies OperationDefinition);

const deleteConfigGroupInput = strictObject({ config_group_id: positiveIdSchema });

export const deleteConfigGroup = defineOperation({
  token: 'delete_config_group',
  method: 'POST',
  route: 'delete_config_group/{config_group_id}',
  family: 'T06',
  driverBinding: 'configurations.deleteConfigurationGroup',
  summary: 'Delete a TestRail configuration group with every configuration in it (TestRail 5.2 or later). This cannot be undone. Closed plans and runs keep the configurations they already recorded, and active ones keep them until they are next updated.',
  inputSchema: deleteConfigGroupInput,
  argumentMap: [{ input: 'config_group_id', call: 'single', argument: 0, serialization: 'path' }],
  response: { shape: 'void', outerSchema: z.undefined(), entitySchema: null },
  pagination: {
    kind: 'none',
    single: driverCall(deleteConfigGroupInput, 'configurations.deleteConfigurationGroup',
      (method, input) => method(input.config_group_id)),
  },
  files: { kind: 'none' },
  // Removing a group removes its configurations with it, and nothing restores them.
  effects: { testRail: 'write', destructive: true, idempotent: false },
  retry: 'json-write',
} as const satisfies OperationDefinition);

const addConfigInput = strictObject({
  config_group_id: positiveIdSchema,
  body: payloadInput(AddConfigurationPayloadSchema),
});

export const addConfig = defineOperation({
  token: 'add_config',
  method: 'POST',
  route: 'add_config/{config_group_id}',
  family: 'T06',
  driverBinding: 'configurations.addConfiguration',
  summary: 'Create a configuration inside a TestRail configuration group (TestRail 5.2 or later), such as a single browser within the browsers group.',
  inputSchema: addConfigInput,
  argumentMap: [
    { input: 'config_group_id', call: 'single', argument: 0, serialization: 'path' },
    { input: 'body', call: 'single', argument: 1, serialization: 'json-body' },
  ],
  response: { shape: 'record', outerSchema: recordResponse, entitySchema: ConfigurationSchema },
  pagination: {
    kind: 'none',
    single: driverCall(addConfigInput, 'configurations.addConfiguration',
      (method, input) => method(input.config_group_id, input.body)),
  },
  files: { kind: 'none' },
  effects: { testRail: 'write', destructive: false, idempotent: false },
  retry: 'json-write',
} as const satisfies OperationDefinition);

const updateConfigInput = strictObject({
  config_id: positiveIdSchema,
  body: payloadInput(UpdateConfigurationPayloadSchema),
});

export const updateConfig = defineOperation({
  token: 'update_config',
  method: 'POST',
  route: 'update_config/{config_id}',
  family: 'T06',
  driverBinding: 'configurations.updateConfiguration',
  summary: 'Rename a TestRail configuration (TestRail 5.2 or later).',
  inputSchema: updateConfigInput,
  argumentMap: [
    { input: 'config_id', call: 'single', argument: 0, serialization: 'path' },
    { input: 'body', call: 'single', argument: 1, serialization: 'json-body' },
  ],
  response: { shape: 'record', outerSchema: recordResponse, entitySchema: ConfigurationSchema },
  pagination: {
    kind: 'none',
    single: driverCall(updateConfigInput, 'configurations.updateConfiguration',
      (method, input) => method(input.config_id, input.body)),
  },
  files: { kind: 'none' },
  effects: { testRail: 'write', destructive: false, idempotent: true },
  retry: 'json-write',
} as const satisfies OperationDefinition);

const deleteConfigInput = strictObject({ config_id: positiveIdSchema });

export const deleteConfig = defineOperation({
  token: 'delete_config',
  method: 'POST',
  route: 'delete_config/{config_id}',
  family: 'T06',
  driverBinding: 'configurations.deleteConfiguration',
  summary: 'Delete a TestRail configuration (TestRail 5.2 or later). This cannot be undone. Closed plans and runs keep the configuration they already recorded, and active ones keep it until they are next updated.',
  inputSchema: deleteConfigInput,
  argumentMap: [{ input: 'config_id', call: 'single', argument: 0, serialization: 'path' }],
  response: { shape: 'void', outerSchema: z.undefined(), entitySchema: null },
  pagination: {
    kind: 'none',
    single: driverCall(deleteConfigInput, 'configurations.deleteConfiguration',
      (method, input) => method(input.config_id)),
  },
  files: { kind: 'none' },
  effects: { testRail: 'write', destructive: true, idempotent: false },
  retry: 'json-write',
} as const satisfies OperationDefinition);

// ------------------------------------------------------------------------ plans

const getPlanInput = strictObject({ plan_id: positiveIdSchema });

export const getPlan = defineOperation({
  token: 'get_plan',
  method: 'GET',
  route: 'get_plan/{plan_id}',
  family: 'T06',
  driverBinding: 'plans.getPlan',
  summary: 'Get a single TestRail test plan with its entries and the runs inside them. An entry groups the runs generated for one suite across configuration combinations, and carries the entry ID the entry tools take.',
  inputSchema: getPlanInput,
  argumentMap: [{ input: 'plan_id', call: 'single', argument: 0, serialization: 'path' }],
  response: { shape: 'record', outerSchema: recordResponse, entitySchema: PlanSchema },
  pagination: {
    kind: 'none',
    single: driverCall(getPlanInput, 'plans.getPlan', (method, input) => method(input.plan_id)),
  },
  files: { kind: 'none' },
  effects: { testRail: 'read', destructive: false, idempotent: true },
  retry: 'ordinary-read',
} as const satisfies OperationDefinition);

const getPlansInput = createListInput({
  path: { project_id: positiveIdSchema },
  query: {
    created_after: nonnegativeIntegerSchema.optional(),
    created_before: nonnegativeIntegerSchema.optional(),
    created_by: z.array(positiveIdSchema).min(1).optional(),
    is_completed: z.boolean().optional(),
    milestone_id: z.array(positiveIdSchema).min(1).optional(),
    refs: z.string().optional(),
  },
  pagination: 'controlled',
});

/** Derived from the driver's own option type, so a rename there fails the build here. */
type PlanFilter = Omit<GetPlansOptions,
  'limit' | 'offset' | 'created_after' | 'created_before' | 'created_by' | 'is_completed' | 'milestone_id'>;

/*
 * Each value is checked to be an option the driver still has. Deriving the type alone
 * would not do that: the helper below builds its object dynamically, and a record of
 * unknown values stays assignable to a type whose properties are all optional.
 */
const planFilterNames = {
  created_after: 'createdAfter', created_before: 'createdBefore', created_by: 'createdBy',
  is_completed: 'isCompleted', milestone_id: 'milestoneId', refs: 'refs',
} as const satisfies Readonly<Record<string, keyof PlanFilter>>;

/** Two of these are comma-joined lists; the rest are scalars. */
const listValuedPlanFilters = new Set(['created_by', 'milestone_id']);

function planFilter(query: object | undefined): PlanFilter {
  const source = (query ?? {}) as Record<string, unknown>;
  const filter: Record<string, unknown> = {};
  for (const [name, option] of Object.entries(planFilterNames)) {
    if (source[name] !== undefined) filter[option] = source[name];
  }
  return filter;
}

function planFilterMappings(call: 'page' | 'all'): readonly ArgumentMapping[] {
  return Object.entries(planFilterNames).map(([name, property]) => ({
    input: `query.${name}`, call, argument: 1, property,
    serialization: listValuedPlanFilters.has(name) ? 'query-list' as const : 'query-scalar' as const,
  }));
}

export const getPlans = defineOperation({
  token: 'get_plans',
  method: 'GET',
  route: 'get_plans/{project_id}',
  family: 'T06',
  driverBinding: 'plans.getPlans',
  summary: 'List the test plans of a TestRail project, optionally filtered by creation time (Unix seconds), creator, completion, milestone or a single reference. The listed plans carry no entries; read one plan for those.',
  inputSchema: getPlansInput,
  argumentMap: [
    { input: 'project_id', call: 'page', argument: 0, serialization: 'path' },
    ...planFilterMappings('page'),
    { input: 'query.limit', call: 'page', argument: 1, property: 'limit', serialization: 'query-scalar' },
    { input: 'query.offset', call: 'page', argument: 1, property: 'offset', serialization: 'query-scalar' },
    { input: 'project_id', call: 'all', argument: 0, serialization: 'path' },
    ...planFilterMappings('all'),
    ...aggregateControlMappings(1),
  ],
  response: { shape: 'page', outerSchema: pageResponse, entitySchema: PlanSchema },
  pagination: {
    kind: 'controlled',
    page: driverCall(getPlansInput, 'plans.getPlansPage', (method, input) => method(input.project_id, {
      ...planFilter(input.query),
      ...pageRequestDefaults({ limit: control(input.query, 'limit'), offset: control(input.query, 'offset') }),
    })),
    all: driverCall(getPlansInput, 'plans.getAllPlans', (method, input, context) => method(input.project_id, {
      ...planFilter(input.query),
      ...driverAllOptions(allControls(input._mcp), context.limits),
    })),
  },
  files: { kind: 'none' },
  effects: { testRail: 'read', destructive: false, idempotent: true },
  retry: 'ordinary-read',
} as const satisfies OperationDefinition);

/*
 * The identifiers a plan payload carries, at whatever depth. The driver forwards any
 * number for them, so each is held to the identifier domain; case_ids keeps no minimum
 * length because an empty selection is what lets a dynamic filter apply, exactly as on
 * a standalone run.
 */
const selectionFields = {
  assignedto_id: positiveIdSchema.optional(),
  case_ids: z.array(positiveIdSchema).optional(),
  config_ids: z.array(positiveIdSchema).optional(),
};
const scheduleFields = {
  start_on: nonnegativeIntegerSchema.optional(),
  due_on: nonnegativeIntegerSchema.optional(),
};

/** A run nested inside a plan entry: every field optional, overriding the entry's own. */
const nestedRunPayload = payloadInput(
  AddPlanEntryPayloadSchema.shape.runs.unwrap().element,
  { fields: selectionFields },
);

const planEntryPayload = payloadInput(AddPlanPayloadSchema.shape.entries.unwrap().element, {
  fields: {
    suite_id: positiveIdSchema.optional(),
    ...selectionFields,
    ...scheduleFields,
    runs: payloadArray(AddPlanPayloadSchema.shape.entries.unwrap().element.shape.runs.unwrap(), nestedRunPayload).optional(),
  },
});

const addPlanInput = strictObject({
  project_id: positiveIdSchema,
  body: payloadInput(AddPlanPayloadSchema, {
    fields: {
      milestone_id: positiveIdSchema.optional(),
      ...scheduleFields,
      entries: payloadArray(AddPlanPayloadSchema.shape.entries.unwrap(), planEntryPayload).optional(),
    },
  }),
});

export const addPlan = defineOperation({
  token: 'add_plan',
  method: 'POST',
  route: 'add_plan/{project_id}',
  family: 'T06',
  driverBinding: 'plans.addPlan',
  summary: 'Create a test plan in a TestRail project, optionally with its entries. Each entry groups the runs for one suite: its config_ids lists every configuration the entry spans, and each nested run names one full combination drawn from that list, one configuration per group. Entry-level assignee and case selection are the defaults each run may override.',
  inputSchema: addPlanInput,
  argumentMap: [
    { input: 'project_id', call: 'single', argument: 0, serialization: 'path' },
    { input: 'body', call: 'single', argument: 1, serialization: 'json-body' },
  ],
  response: { shape: 'record', outerSchema: recordResponse, entitySchema: PlanSchema },
  pagination: {
    kind: 'none',
    single: driverCall(addPlanInput, 'plans.addPlan', (method, input) => method(input.project_id, input.body)),
  },
  files: { kind: 'none' },
  // Repeating the call creates another plan, so this is not idempotent.
  effects: { testRail: 'write', destructive: false, idempotent: false },
  retry: 'json-write',
} as const satisfies OperationDefinition);

const updatePlanInput = strictObject({
  plan_id: positiveIdSchema,
  body: payloadInput(UpdatePlanPayloadSchema, {
    fields: { milestone_id: positiveIdSchema.optional(), ...scheduleFields },
  }),
});

export const updatePlan = defineOperation({
  token: 'update_plan',
  method: 'POST',
  route: 'update_plan/{plan_id}',
  family: 'T06',
  driverBinding: 'plans.updatePlan',
  summary: 'Update a TestRail test plan. Supplied fields replace their current values and the rest are left unchanged. The plan\'s entries cannot be changed here; use the entry tools for those.',
  inputSchema: updatePlanInput,
  argumentMap: [
    { input: 'plan_id', call: 'single', argument: 0, serialization: 'path' },
    { input: 'body', call: 'single', argument: 1, serialization: 'json-body' },
  ],
  response: { shape: 'record', outerSchema: recordResponse, entitySchema: PlanSchema },
  pagination: {
    kind: 'none',
    single: driverCall(updatePlanInput, 'plans.updatePlan', (method, input) => method(input.plan_id, input.body)),
  },
  files: { kind: 'none' },
  effects: { testRail: 'write', destructive: false, idempotent: true },
  retry: 'json-write',
} as const satisfies OperationDefinition);

const closePlanInput = strictObject({ plan_id: positiveIdSchema });

export const closePlan = defineOperation({
  token: 'close_plan',
  method: 'POST',
  route: 'close_plan/{plan_id}',
  family: 'T06',
  driverBinding: 'plans.closePlan',
  summary: 'Close a TestRail test plan, archiving every run and result inside it. This cannot be undone and the plan can no longer be changed. Returns the closed plan.',
  inputSchema: closePlanInput,
  argumentMap: [{ input: 'plan_id', call: 'single', argument: 0, serialization: 'path' }],
  response: { shape: 'record', outerSchema: recordResponse, entitySchema: PlanSchema },
  pagination: {
    kind: 'none',
    single: driverCall(closePlanInput, 'plans.closePlan', (method, input) => method(input.plan_id)),
  },
  files: { kind: 'none' },
  // Archiving cannot be undone, and a second call has nothing left to close.
  effects: { testRail: 'write', destructive: true, idempotent: false },
  retry: 'json-write',
} as const satisfies OperationDefinition);

const deletePlanInput = strictObject({ plan_id: positiveIdSchema });

export const deletePlan = defineOperation({
  token: 'delete_plan',
  method: 'POST',
  route: 'delete_plan/{plan_id}',
  family: 'T06',
  driverBinding: 'plans.deletePlan',
  summary: 'Delete a TestRail test plan with every run, test and result inside it. This cannot be undone.',
  inputSchema: deletePlanInput,
  argumentMap: [{ input: 'plan_id', call: 'single', argument: 0, serialization: 'path' }],
  response: { shape: 'void', outerSchema: z.undefined(), entitySchema: null },
  pagination: {
    kind: 'none',
    single: driverCall(deletePlanInput, 'plans.deletePlan', (method, input) => method(input.plan_id)),
  },
  files: { kind: 'none' },
  effects: { testRail: 'write', destructive: true, idempotent: false },
  retry: 'json-write',
} as const satisfies OperationDefinition);

const addPlanEntryInput = strictObject({
  plan_id: positiveIdSchema,
  body: payloadInput(AddPlanEntryPayloadSchema, {
    fields: {
      suite_id: positiveIdSchema.optional(),
      ...selectionFields,
      ...scheduleFields,
      runs: payloadArray(AddPlanEntryPayloadSchema.shape.runs.unwrap(), nestedRunPayload).optional(),
    },
  }),
});

export const addPlanEntry = defineOperation({
  token: 'add_plan_entry',
  method: 'POST',
  route: 'add_plan_entry/{plan_id}',
  family: 'T06',
  driverBinding: 'plans.addPlanEntry',
  summary: 'Add an entry to a TestRail test plan, which creates one run per configuration combination it names. body.suite_id is required unless the project runs in single-suite mode. body.config_ids lists every configuration the entry spans, and each nested run names one full combination drawn from it. Returns the entry with its runs and the entry ID the other entry tools take.',
  inputSchema: addPlanEntryInput,
  argumentMap: [
    { input: 'plan_id', call: 'single', argument: 0, serialization: 'path' },
    { input: 'body', call: 'single', argument: 1, serialization: 'json-body' },
  ],
  response: { shape: 'record', outerSchema: recordResponse, entitySchema: PlanEntrySchema },
  pagination: {
    kind: 'none',
    single: driverCall(addPlanEntryInput, 'plans.addPlanEntry', (method, input) => method(input.plan_id, input.body)),
  },
  files: { kind: 'none' },
  effects: { testRail: 'write', destructive: false, idempotent: false },
  retry: 'json-write',
} as const satisfies OperationDefinition);

const updatePlanEntryInput = strictObject({
  plan_id: positiveIdSchema,
  entry_id: entryIdSchema,
  body: payloadInput(UpdatePlanEntryPayloadSchema, {
    fields: { ...selectionFields, ...scheduleFields, config_ids: z.never().optional() },
  }),
});

export const updatePlanEntry = defineOperation({
  token: 'update_plan_entry',
  method: 'POST',
  route: 'update_plan_entry/{plan_id}/{entry_id}',
  family: 'T06',
  driverBinding: 'plans.updatePlanEntry',
  summary: 'Update an entry of a TestRail test plan, which changes every run the entry generated. Supplied fields replace their current values. The configurations and the runs of an entry cannot be changed here: TestRail does not accept them, and a run is changed or removed through its own tools.',
  inputSchema: updatePlanEntryInput,
  argumentMap: [
    { input: 'plan_id', call: 'single', argument: 0, serialization: 'path' },
    { input: 'entry_id', call: 'single', argument: 1, serialization: 'path' },
    { input: 'body', call: 'single', argument: 2, serialization: 'json-body' },
  ],
  response: { shape: 'record', outerSchema: recordResponse, entitySchema: PlanEntrySchema },
  pagination: {
    kind: 'none',
    single: driverCall(updatePlanEntryInput, 'plans.updatePlanEntry',
      (method, input) => method(input.plan_id, input.entry_id, input.body)),
  },
  files: { kind: 'none' },
  effects: { testRail: 'write', destructive: false, idempotent: true },
  retry: 'json-write',
} as const satisfies OperationDefinition);

const deletePlanEntryInput = strictObject({ plan_id: positiveIdSchema, entry_id: entryIdSchema });

export const deletePlanEntry = defineOperation({
  token: 'delete_plan_entry',
  method: 'POST',
  route: 'delete_plan_entry/{plan_id}/{entry_id}',
  family: 'T06',
  driverBinding: 'plans.deletePlanEntry',
  summary: 'Delete an entry of a TestRail test plan with every run it generated, and their tests and results. This cannot be undone. The entry ID comes from reading the plan, and is not a run ID.',
  inputSchema: deletePlanEntryInput,
  argumentMap: [
    { input: 'plan_id', call: 'single', argument: 0, serialization: 'path' },
    { input: 'entry_id', call: 'single', argument: 1, serialization: 'path' },
  ],
  response: { shape: 'void', outerSchema: z.undefined(), entitySchema: null },
  pagination: {
    kind: 'none',
    single: driverCall(deletePlanEntryInput, 'plans.deletePlanEntry',
      (method, input) => method(input.plan_id, input.entry_id)),
  },
  files: { kind: 'none' },
  effects: { testRail: 'write', destructive: true, idempotent: false },
  retry: 'json-write',
} as const satisfies OperationDefinition);

const addRunToPlanEntryInput = strictObject({
  plan_id: positiveIdSchema,
  entry_id: entryIdSchema,
  body: payloadInput(AddRunToPlanEntryPayloadSchema, {
    fields: {
      config_ids: z.array(positiveIdSchema).min(1),
      assignedto_id: positiveIdSchema.optional(),
      case_ids: z.array(positiveIdSchema).optional(),
      ...scheduleFields,
    },
  }),
});

export const addRunToPlanEntry = defineOperation({
  token: 'add_run_to_plan_entry',
  method: 'POST',
  route: 'add_run_to_plan_entry/{plan_id}/{entry_id}',
  family: 'T06',
  driverBinding: 'plans.addRunToPlanEntry',
  summary: 'Add one run to an existing entry of a TestRail test plan. body.config_ids is required and names the combination the run covers, one configuration per group, drawn from the configurations the entry spans. The run takes its name from that combination rather than from the caller.',
  inputSchema: addRunToPlanEntryInput,
  argumentMap: [
    { input: 'plan_id', call: 'single', argument: 0, serialization: 'path' },
    { input: 'entry_id', call: 'single', argument: 1, serialization: 'path' },
    { input: 'body', call: 'single', argument: 2, serialization: 'json-body' },
  ],
  response: { shape: 'record', outerSchema: recordResponse, entitySchema: RunSchema },
  pagination: {
    kind: 'none',
    single: driverCall(addRunToPlanEntryInput, 'plans.addRunToPlanEntry',
      (method, input) => method(input.plan_id, input.entry_id, input.body)),
  },
  files: { kind: 'none' },
  effects: { testRail: 'write', destructive: false, idempotent: false },
  retry: 'json-write',
} as const satisfies OperationDefinition);

const updateRunInPlanEntryInput = strictObject({
  run_id: positiveIdSchema,
  body: payloadInput(UpdateRunInPlanEntryPayloadSchema, {
    fields: {
      assignedto_id: positiveIdSchema.optional(),
      case_ids: z.array(positiveIdSchema).optional(),
      ...scheduleFields,
    },
  }),
});

export const updateRunInPlanEntry = defineOperation({
  token: 'update_run_in_plan_entry',
  method: 'POST',
  route: 'update_run_in_plan_entry/{run_id}',
  family: 'T06',
  driverBinding: 'plans.updateRunInPlanEntry',
  summary: 'Update one run inside a TestRail test plan entry, named by its own run ID. Supplied fields replace their current values. The run\'s configurations and its name cannot be changed here, since TestRail derives the name from the combination.',
  inputSchema: updateRunInPlanEntryInput,
  argumentMap: [
    { input: 'run_id', call: 'single', argument: 0, serialization: 'path' },
    { input: 'body', call: 'single', argument: 1, serialization: 'json-body' },
  ],
  response: { shape: 'record', outerSchema: recordResponse, entitySchema: RunSchema },
  pagination: {
    kind: 'none',
    single: driverCall(updateRunInPlanEntryInput, 'plans.updateRunInPlanEntry',
      (method, input) => method(input.run_id, input.body)),
  },
  files: { kind: 'none' },
  /*
   * Applying the same field values again leaves the run in the same state, so this is
   * idempotent. It is also destructive: narrowing the case selection removes the tests
   * that fall outside it, and their results with them, as on a standalone run.
   */
  effects: { testRail: 'write', destructive: true, idempotent: true },
  retry: 'json-write',
} as const satisfies OperationDefinition);

const deleteRunFromPlanEntryInput = strictObject({ run_id: positiveIdSchema });

export const deleteRunFromPlanEntry = defineOperation({
  token: 'delete_run_from_plan_entry',
  method: 'POST',
  route: 'delete_run_from_plan_entry/{run_id}',
  family: 'T06',
  driverBinding: 'plans.deleteRunFromPlanEntry',
  summary: 'Remove one run from a TestRail test plan entry, with its tests and results. This cannot be undone. The run is named by its own ID; deleting the whole entry is a different tool.',
  inputSchema: deleteRunFromPlanEntryInput,
  argumentMap: [{ input: 'run_id', call: 'single', argument: 0, serialization: 'path' }],
  response: { shape: 'void', outerSchema: z.undefined(), entitySchema: null },
  pagination: {
    kind: 'none',
    single: driverCall(deleteRunFromPlanEntryInput, 'plans.deleteRunFromPlanEntry',
      (method, input) => method(input.run_id)),
  },
  files: { kind: 'none' },
  effects: { testRail: 'write', destructive: true, idempotent: false },
  retry: 'json-write',
} as const satisfies OperationDefinition);

/** Registered in tool-name order by the registry; listed here in reviewed order. */
export const t06 = [
  getConfigs, addConfigGroup, updateConfigGroup, deleteConfigGroup, addConfig, updateConfig, deleteConfig,
  getPlan, getPlans, addPlan, updatePlan, closePlan, deletePlan,
  addPlanEntry, updatePlanEntry, deletePlanEntry,
  addRunToPlanEntry, updateRunInPlanEntry, deleteRunFromPlanEntry,
] as const;
