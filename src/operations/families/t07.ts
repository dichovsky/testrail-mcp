import {
  AddLabelPayloadSchema, AddMilestonePayloadSchema, DeleteLabelsPayloadSchema, LabelSchema, MilestoneSchema,
  UpdateLabelPayloadSchema, UpdateMilestonePayloadSchema,
  type GetMilestonesOptions,
} from '@dichovsky/testrail-api-client';
import { z } from 'zod';
import {
  nonnegativeIntegerSchema, payloadInput, positiveIdSchema, strictObject,
} from '../../contracts/inputs.js';
import { defineOperation } from '../registry.js';
import { createListDefinition, type ListFilters } from '../lists.js';
import { recordResponse } from './common.js';

// ----------------------------------------------------------------------- labels

const getLabelInput = strictObject({ label_id: positiveIdSchema });

export const getLabel = defineOperation({
  token: 'get_label',
  method: 'GET',
  route: 'get_label/{label_id}',
  family: 'T07',
  driverBinding: 'labels.getLabel',
  summary: 'Get a single TestRail label (TestRail 10.5 or later). A label is a project-wide tag that cases and tests carry; this reads the label itself, not what is tagged with it.',
  inputSchema: getLabelInput,
  argumentMap: [{ input: 'label_id', call: 'single', argument: 0, serialization: 'path' }],
  response: { shape: 'record', outerSchema: recordResponse, entitySchema: LabelSchema },
  pagination: (bind) => ({
    kind: 'none',
    single: bind('labels.getLabel', (method, input) => method(input.label_id)),
  }),
  files: { kind: 'none' },
  effects: { testRail: 'read', destructive: false, idempotent: true },
  retry: 'ordinary-read',
});

/*
 * The one list in this family that documents no filter of its own. TestRail's reference
 * gives get_labels a project and the paging controls and nothing else, and the driver's
 * prepare step passes only the project, so there is no filter to map.
 */
const getLabelsList = createListDefinition({
  path: { project_id: { schema: positiveIdSchema, argument: 0 } },
  pagination: 'controlled',
  optionsArgument: 1,
  entitySchema: LabelSchema,
});

export const getLabels = defineOperation({
  token: 'get_labels',
  method: 'GET',
  route: 'get_labels/{project_id}',
  family: 'T07',
  driverBinding: 'labels.getLabels',
  summary: 'List the labels of a TestRail project (TestRail 10.5 or later). The endpoint takes no filter beyond the project, so narrow the result by reading the labels you need individually.',
  ...getLabelsList.bind({
    page: {
      binding: 'labels.getLabelsPage',
      call: (method, input, options) => method(input.project_id, options),
    },
    all: {
      binding: 'labels.getAllLabels',
      call: (method, input, options) => method(input.project_id, options),
    },
  }),
  files: { kind: 'none' },
  effects: { testRail: 'read', destructive: false, idempotent: true },
  retry: 'ordinary-read',
});

const addLabelInput = strictObject({
  project_id: positiveIdSchema,
  body: payloadInput(AddLabelPayloadSchema),
});

export const addLabel = defineOperation({
  token: 'add_label',
  method: 'POST',
  route: 'add_label/{project_id}',
  family: 'T07',
  driverBinding: 'labels.addLabel',
  summary: 'Create a label in a TestRail project (TestRail 10.5 or later). TestRail caps a title at 20 characters and refuses a longer one itself, so the limit is not applied here and its refusal is reported as TestRail gave it.',
  inputSchema: addLabelInput,
  argumentMap: [
    { input: 'project_id', call: 'single', argument: 0, serialization: 'path' },
    { input: 'body', call: 'single', argument: 1, serialization: 'json-body' },
  ],
  /*
   * TestRail has shipped this reply both flat and wrapped in a `label` key, which the
   * official TestRail CLI also handles both ways. The driver's response schema is a
   * union that unwraps the wrapper, so a caller sees one record either way.
   */
  response: { shape: 'record', outerSchema: recordResponse, entitySchema: LabelSchema },
  pagination: (bind) => ({
    kind: 'none',
    single: bind('labels.addLabel', (method, input) => method(input.project_id, input.body)),
  }),
  files: { kind: 'none' },
  // Repeating the call asks TestRail for another label of the same title.
  effects: { testRail: 'write', destructive: false, idempotent: false },
  retry: 'json-write',
});

const updateLabelInput = strictObject({
  label_id: positiveIdSchema,
  body: payloadInput(UpdateLabelPayloadSchema, { fields: { project_id: positiveIdSchema } }),
});

export const updateLabel = defineOperation({
  token: 'update_label',
  method: 'POST',
  route: 'update_label/{label_id}',
  family: 'T07',
  driverBinding: 'labels.updateLabel',
  summary: 'Rename a TestRail label (TestRail 10.5 or later). body.project_id is required and names the project the label belongs to, which TestRail asks for even though the label is identified by its own ID in the path.',
  inputSchema: updateLabelInput,
  argumentMap: [
    { input: 'label_id', call: 'single', argument: 0, serialization: 'path' },
    { input: 'body', call: 'single', argument: 1, serialization: 'json-body' },
  ],
  response: { shape: 'record', outerSchema: recordResponse, entitySchema: LabelSchema },
  pagination: (bind) => ({
    kind: 'none',
    single: bind('labels.updateLabel', (method, input) => method(input.label_id, input.body)),
  }),
  files: { kind: 'none' },
  // Applying the same title again leaves the label in the same state.
  effects: { testRail: 'write', destructive: false, idempotent: true },
  retry: 'json-write',
});

const deleteLabelInput = strictObject({ label_id: positiveIdSchema });

export const deleteLabel = defineOperation({
  token: 'delete_label',
  method: 'POST',
  route: 'delete_label/{label_id}',
  family: 'T07',
  driverBinding: 'labels.deleteLabel',
  summary: 'Delete one TestRail label (TestRail 10.5 or later). This cannot be undone, and the label is removed from every case and test carrying it.',
  inputSchema: deleteLabelInput,
  argumentMap: [{ input: 'label_id', call: 'single', argument: 0, serialization: 'path' }],
  response: { shape: 'void', outerSchema: z.undefined(), entitySchema: null },
  pagination: (bind) => ({
    kind: 'none',
    single: bind('labels.deleteLabel', (method, input) => method(input.label_id)),
  }),
  files: { kind: 'none' },
  effects: { testRail: 'write', destructive: true, idempotent: false },
  retry: 'json-write',
});

const deleteLabelsInput = strictObject({ body: payloadInput(DeleteLabelsPayloadSchema) });

export const deleteLabels = defineOperation({
  token: 'delete_labels',
  method: 'POST',
  route: 'delete_labels',
  family: 'T07',
  driverBinding: 'labels.deleteLabels',
  summary: 'Delete several TestRail labels in one call (TestRail 10.5 or later). This cannot be undone, and each label is removed from every case and test carrying it. The endpoint takes no project: the labels are named by their own IDs in the body.',
  inputSchema: deleteLabelsInput,
  argumentMap: [{ input: 'body', call: 'single', argument: 0, serialization: 'json-body' }],
  /*
   * TestRail answers with no entity, so there is no per-label outcome to report. A
   * caller that needs to know which labels are gone reads them afterwards; the adapter
   * does not follow up on its own.
   */
  response: { shape: 'void', outerSchema: z.undefined(), entitySchema: null },
  pagination: (bind) => ({
    kind: 'none',
    single: bind('labels.deleteLabels', (method, input) => method(input.body)),
  }),
  files: { kind: 'none' },
  effects: { testRail: 'write', destructive: true, idempotent: false },
  retry: 'json-write',
});

// ------------------------------------------------------------------- milestones

const getMilestoneInput = strictObject({ milestone_id: positiveIdSchema });

export const getMilestone = defineOperation({
  token: 'get_milestone',
  method: 'GET',
  route: 'get_milestone/{milestone_id}',
  family: 'T07',
  driverBinding: 'milestones.getMilestone',
  summary: 'Get a single TestRail milestone. A milestone may carry sub-milestones, which the reply nests under its milestones field.',
  inputSchema: getMilestoneInput,
  argumentMap: [{ input: 'milestone_id', call: 'single', argument: 0, serialization: 'path' }],
  response: { shape: 'record', outerSchema: recordResponse, entitySchema: MilestoneSchema },
  pagination: (bind) => ({
    kind: 'none',
    single: bind('milestones.getMilestone', (method, input) => method(input.milestone_id)),
  }),
  files: { kind: 'none' },
  effects: { testRail: 'read', destructive: false, idempotent: true },
  retry: 'ordinary-read',
});

const getMilestonesList = createListDefinition({
  path: { project_id: { schema: positiveIdSchema, argument: 0 } },
  pagination: 'controlled',
  optionsArgument: 1,
  filters: {
    is_completed: { schema: z.boolean().optional(), property: 'isCompleted', serialization: 'query-scalar' },
    is_started: { schema: z.boolean().optional(), property: 'isStarted', serialization: 'query-scalar' },
  } satisfies ListFilters<GetMilestonesOptions>,
  entitySchema: MilestoneSchema,
});

export const getMilestones = defineOperation({
  token: 'get_milestones',
  method: 'GET',
  route: 'get_milestones/{project_id}',
  family: 'T07',
  driverBinding: 'milestones.getMilestones',
  summary: 'List the milestones of a TestRail project, optionally filtered by completion or by whether they have started. Both filters are booleans here and reach TestRail as 1 or 0.',
  ...getMilestonesList.bind({
    page: {
      binding: 'milestones.getMilestonesPage',
      call: (method, input, options) => method(input.project_id, options),
    },
    all: {
      binding: 'milestones.getAllMilestones',
      call: (method, input, options) => method(input.project_id, options),
    },
  }),
  files: { kind: 'none' },
  effects: { testRail: 'read', destructive: false, idempotent: true },
  retry: 'ordinary-read',
});

/*
 * The identifiers and dates a milestone payload carries. The driver forwards any number
 * for each, so the boundary holds them to their domains. parent_id takes no null in the
 * driver's payload type and TestRail documents no way to clear it, so detaching a
 * sub-milestone is not reachable through the pinned driver.
 */
const milestoneFields = {
  parent_id: positiveIdSchema.optional(),
  start_on: nonnegativeIntegerSchema.optional(),
  due_on: nonnegativeIntegerSchema.optional(),
};

const addMilestoneInput = strictObject({
  project_id: positiveIdSchema,
  body: payloadInput(AddMilestonePayloadSchema, { fields: milestoneFields }),
});

export const addMilestone = defineOperation({
  token: 'add_milestone',
  method: 'POST',
  route: 'add_milestone/{project_id}',
  family: 'T07',
  driverBinding: 'milestones.addMilestone',
  summary: 'Create a milestone in a TestRail project. Give body.parent_id to create it as a sub-milestone of an existing one (TestRail 5.3 or later); body.refs takes a comma-separated list of references (TestRail 6.4 or later).',
  inputSchema: addMilestoneInput,
  argumentMap: [
    { input: 'project_id', call: 'single', argument: 0, serialization: 'path' },
    { input: 'body', call: 'single', argument: 1, serialization: 'json-body' },
  ],
  response: { shape: 'record', outerSchema: recordResponse, entitySchema: MilestoneSchema },
  pagination: (bind) => ({
    kind: 'none',
    single: bind('milestones.addMilestone',
      (method, input) => method(input.project_id, input.body)),
  }),
  files: { kind: 'none' },
  effects: { testRail: 'write', destructive: false, idempotent: false },
  retry: 'json-write',
});

const updateMilestoneInput = strictObject({
  milestone_id: positiveIdSchema,
  body: payloadInput(UpdateMilestonePayloadSchema, { fields: milestoneFields }),
});

export const updateMilestone = defineOperation({
  token: 'update_milestone',
  method: 'POST',
  route: 'update_milestone/{milestone_id}',
  family: 'T07',
  driverBinding: 'milestones.updateMilestone',
  summary: 'Update a TestRail milestone. Supplied fields replace their current values and the rest are left unchanged, so this is how a milestone is marked completed or started. The milestone keeps its runs and plans either way.',
  inputSchema: updateMilestoneInput,
  argumentMap: [
    { input: 'milestone_id', call: 'single', argument: 0, serialization: 'path' },
    { input: 'body', call: 'single', argument: 1, serialization: 'json-body' },
  ],
  response: { shape: 'record', outerSchema: recordResponse, entitySchema: MilestoneSchema },
  pagination: (bind) => ({
    kind: 'none',
    single: bind('milestones.updateMilestone',
      (method, input) => method(input.milestone_id, input.body)),
  }),
  files: { kind: 'none' },
  /*
   * Applying the same field values again leaves the milestone in the same state. Marking
   * one completed archives nothing and deletes nothing: the runs and plans that point at
   * it keep pointing at it, so this is a write rather than a removal.
   */
  effects: { testRail: 'write', destructive: false, idempotent: true },
  retry: 'json-write',
});

const deleteMilestoneInput = strictObject({ milestone_id: positiveIdSchema });

export const deleteMilestone = defineOperation({
  token: 'delete_milestone',
  method: 'POST',
  route: 'delete_milestone/{milestone_id}',
  family: 'T07',
  driverBinding: 'milestones.deleteMilestone',
  summary: 'Delete a TestRail milestone. This cannot be undone. TestRail\'s reference states nothing further: what becomes of the milestone\'s sub-milestones, and of the runs and plans that pointed at it, is not documented, so read the milestone first if that matters.',
  inputSchema: deleteMilestoneInput,
  argumentMap: [{ input: 'milestone_id', call: 'single', argument: 0, serialization: 'path' }],
  response: { shape: 'void', outerSchema: z.undefined(), entitySchema: null },
  pagination: (bind) => ({
    kind: 'none',
    single: bind('milestones.deleteMilestone',
      (method, input) => method(input.milestone_id)),
  }),
  files: { kind: 'none' },
  effects: { testRail: 'write', destructive: true, idempotent: false },
  retry: 'json-write',
});

/** Registered in tool-name order by the registry; listed here in reviewed order. */
export const t07 = [
  getLabel, getLabels, addLabel, updateLabel, deleteLabel, deleteLabels,
  getMilestone, getMilestones, addMilestone, updateMilestone, deleteMilestone,
] as const;
