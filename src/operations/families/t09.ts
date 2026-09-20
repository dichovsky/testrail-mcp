import {
  AddDatasetPayloadSchema, AddVariablePayloadSchema, DatasetSchema, UpdateDatasetPayloadSchema,
  UpdateVariablePayloadSchema, VariableSchema,
} from '@dichovsky/testrail-api-client';
import { z } from 'zod';
import { createListInput, payloadInput, positiveIdSchema, strictObject } from '../../contracts/inputs.js';
import { driverAllOptions } from '../../contracts/pagination.js';
import { driverCall } from '../driver-call.js';
import { defineOperation, type OperationDefinition } from '../registry.js';
import { allControls, pageResponse, recordResponse, safetyControlMappings } from './common.js';

/*
 * Every endpoint in this family answers 403 "Not an Enterprise license/subscription" on
 * an instance without one, which TestRail documents on all nine. The refusal is TestRail's
 * and is reported as it arrives: this server cannot know an instance's edition before it
 * calls, and guessing would turn a licensing answer into a made-up local one.
 *
 * The two write payloads carry no id of their own. TestRail's examples show one in the
 * request body while its documented parameter tables list only the path identifier, so a
 * caller's id has no documented meaning; the boundary refuses the field rather than
 * forwarding a value whose effect is unknown.
 */

// --------------------------------------------------------------------- datasets

const getDatasetInput = strictObject({ dataset_id: positiveIdSchema });

export const getDataset = defineOperation({
  token: 'get_dataset',
  method: 'GET',
  route: 'get_dataset/{dataset_id}',
  family: 'T09',
  driverBinding: 'datasets.getDataset',
  summary: 'Get a single TestRail dataset with its variable values. Each entry of the returned variables array names a variable and the value this dataset gives it; a value may be null where the dataset leaves the variable unset, and the array itself may be absent on a dataset that has none. Datasets are an Enterprise feature: TestRail answers 403 on an instance without an Enterprise license or subscription.',
  inputSchema: getDatasetInput,
  argumentMap: [{ input: 'dataset_id', call: 'single', argument: 0, serialization: 'path' }],
  response: { shape: 'record', outerSchema: recordResponse, entitySchema: DatasetSchema },
  pagination: {
    kind: 'none',
    single: driverCall(getDatasetInput, 'datasets.getDataset', (method, input) => method(input.dataset_id)),
  },
  files: { kind: 'none' },
  effects: { testRail: 'read', destructive: false, idempotent: true },
  retry: 'ordinary-read',
} as const satisfies OperationDefinition);

/*
 * TestRail documents no request controls for this list: its parameter table carries the
 * project alone while the reply carries an offset, a limit and continuation links the
 * server chose. The driver's executor is declared without request controls to match, so
 * neither helper sends one and a complete read that stops at one of its safety bounds
 * cannot be resumed from where it stopped.
 */
const getDatasetsInput = createListInput({
  path: { project_id: positiveIdSchema },
  pagination: 'response-driven',
});

export const getDatasets = defineOperation({
  token: 'get_datasets',
  method: 'GET',
  route: 'get_datasets/{project_id}',
  family: 'T09',
  driverBinding: 'datasets.getDatasets',
  summary: 'List the datasets of a TestRail project, each with its variable values. This endpoint accepts no paging controls, so the server chooses each page; a complete read that stops at one of its bounds cannot be resumed from where it stopped, and needs a larger bound instead. Datasets are an Enterprise feature: TestRail answers 403 on an instance without an Enterprise license or subscription.',
  inputSchema: getDatasetsInput,
  argumentMap: [
    { input: 'project_id', call: 'page', argument: 0, serialization: 'path' },
    { input: 'project_id', call: 'all', argument: 0, serialization: 'path' },
    ...safetyControlMappings(1),
  ],
  response: { shape: 'page', outerSchema: pageResponse, entitySchema: DatasetSchema },
  pagination: {
    kind: 'response_driven',
    page: driverCall(getDatasetsInput, 'datasets.getDatasetsPage', (method, input) => method(input.project_id)),
    all: driverCall(getDatasetsInput, 'datasets.getAllDatasets',
      (method, input, context) => method(input.project_id, driverAllOptions(allControls(input._mcp), context.limits))),
  },
  files: { kind: 'none' },
  effects: { testRail: 'read', destructive: false, idempotent: true },
  retry: 'ordinary-read',
} as const satisfies OperationDefinition);

/*
 * The write form of a dataset's values is a map from variable name to value, which is
 * not the array of identified entries the reads return. The map is the documented
 * extension point of this payload, so its keys stay open while the payload's own fields
 * do not: an unknown field beside name and variables is refused rather than forwarded.
 */
const addDatasetInput = strictObject({
  project_id: positiveIdSchema,
  body: payloadInput(AddDatasetPayloadSchema),
});

export const addDataset = defineOperation({
  token: 'add_dataset',
  method: 'POST',
  route: 'add_dataset/{project_id}',
  family: 'T09',
  driverBinding: 'datasets.addDataset',
  summary: 'Create a dataset in a TestRail project. body.variables maps variable name to value, unlike the array of identified entries the read tools return. Every name in it must already exist as a variable of that project, so create the variable first with testrail_add_variable; TestRail refuses a name that does not exist, a value that is not a string, and a dataset name already used in the project. Datasets are an Enterprise feature: TestRail answers 403 on an instance without an Enterprise license or subscription.',
  inputSchema: addDatasetInput,
  argumentMap: [
    { input: 'project_id', call: 'single', argument: 0, serialization: 'path' },
    { input: 'body', call: 'single', argument: 1, serialization: 'json-body' },
  ],
  response: { shape: 'record', outerSchema: recordResponse, entitySchema: DatasetSchema },
  pagination: {
    kind: 'none',
    single: driverCall(addDatasetInput, 'datasets.addDataset',
      (method, input) => method(input.project_id, input.body)),
  },
  files: { kind: 'none' },
  /*
   * Not idempotent: a repeat asks TestRail for a second dataset of the same name, which
   * it refuses within a project. The call is therefore not safe to replay blindly, even
   * though the refusal means a replay does not leave a duplicate behind.
   */
  effects: { testRail: 'write', destructive: false, idempotent: false },
  retry: 'json-write',
} as const satisfies OperationDefinition);

const updateDatasetInput = strictObject({
  dataset_id: positiveIdSchema,
  body: payloadInput(UpdateDatasetPayloadSchema),
});

export const updateDataset = defineOperation({
  token: 'update_dataset',
  method: 'POST',
  route: 'update_dataset/{dataset_id}',
  family: 'T09',
  driverBinding: 'datasets.updateDataset',
  summary: 'Update a TestRail dataset. Both fields are optional and TestRail accepts an empty body as a no-op. TestRail does not state whether a supplied body.variables replaces the dataset\'s values or merges into them, so send the full map the dataset should end up with, which is correct under either reading. Every name in it must already exist as a variable of the project. Datasets are an Enterprise feature: TestRail answers 403 on an instance without an Enterprise license or subscription.',
  inputSchema: updateDatasetInput,
  argumentMap: [
    { input: 'dataset_id', call: 'single', argument: 0, serialization: 'path' },
    { input: 'body', call: 'single', argument: 1, serialization: 'json-body' },
  ],
  response: { shape: 'record', outerSchema: recordResponse, entitySchema: DatasetSchema },
  pagination: {
    kind: 'none',
    single: driverCall(updateDatasetInput, 'datasets.updateDataset',
      (method, input) => method(input.dataset_id, input.body)),
  },
  files: { kind: 'none' },
  /*
   * Applying the same field values again leaves the dataset in the same state. It is not
   * marked destructive: a value this removes is an entry of the dataset rather than an
   * entity of its own, which is how this server already treats a replaced membership or
   * label list. The summary carries the replacement warning instead.
   */
  effects: { testRail: 'write', destructive: false, idempotent: true },
  retry: 'json-write',
} as const satisfies OperationDefinition);

const deleteDatasetInput = strictObject({ dataset_id: positiveIdSchema });

export const deleteDataset = defineOperation({
  token: 'delete_dataset',
  method: 'POST',
  route: 'delete_dataset/{dataset_id}',
  family: 'T09',
  driverBinding: 'datasets.deleteDataset',
  summary: 'Delete a TestRail dataset. TestRail states that this also removes the dataset\'s values, and that it refuses to delete a project\'s Default dataset. The project\'s variables themselves are not deleted. TestRail returns no dataset data. Datasets are an Enterprise feature: TestRail answers 403 on an instance without an Enterprise license or subscription.',
  inputSchema: deleteDatasetInput,
  argumentMap: [{ input: 'dataset_id', call: 'single', argument: 0, serialization: 'path' }],
  response: { shape: 'void', outerSchema: z.undefined(), entitySchema: null },
  pagination: {
    kind: 'none',
    single: driverCall(deleteDatasetInput, 'datasets.deleteDataset', (method, input) => method(input.dataset_id)),
  },
  files: { kind: 'none' },
  effects: { testRail: 'write', destructive: true, idempotent: false },
  retry: 'json-write',
} as const satisfies OperationDefinition);

// -------------------------------------------------------------------- variables

const getVariablesInput = createListInput({
  path: { project_id: positiveIdSchema },
  pagination: 'response-driven',
});

export const getVariables = defineOperation({
  token: 'get_variables',
  method: 'GET',
  route: 'get_variables/{project_id}',
  family: 'T09',
  driverBinding: 'variables.getVariables',
  summary: 'List the variables of a TestRail project. A variable carries an identifier and a name only; the value a dataset gives it is read through the dataset tools. This endpoint accepts no paging controls, so the server chooses each page; a complete read that stops at one of its bounds cannot be resumed from where it stopped, and needs a larger bound instead. Variables are an Enterprise feature: TestRail answers 403 on an instance without an Enterprise license or subscription.',
  inputSchema: getVariablesInput,
  argumentMap: [
    { input: 'project_id', call: 'page', argument: 0, serialization: 'path' },
    { input: 'project_id', call: 'all', argument: 0, serialization: 'path' },
    ...safetyControlMappings(1),
  ],
  response: { shape: 'page', outerSchema: pageResponse, entitySchema: VariableSchema },
  pagination: {
    kind: 'response_driven',
    page: driverCall(getVariablesInput, 'variables.getVariablesPage', (method, input) => method(input.project_id)),
    all: driverCall(getVariablesInput, 'variables.getAllVariables',
      (method, input, context) => method(input.project_id, driverAllOptions(allControls(input._mcp), context.limits))),
  },
  files: { kind: 'none' },
  effects: { testRail: 'read', destructive: false, idempotent: true },
  retry: 'ordinary-read',
} as const satisfies OperationDefinition);

const addVariableInput = strictObject({
  project_id: positiveIdSchema,
  body: payloadInput(AddVariablePayloadSchema),
});

export const addVariable = defineOperation({
  token: 'add_variable',
  method: 'POST',
  route: 'add_variable/{project_id}',
  family: 'T09',
  driverBinding: 'variables.addVariable',
  summary: 'Create a variable in a TestRail project. The variable is created without a value: a value belongs to a dataset and is set through the dataset tools. TestRail refuses a name already used in the project. Variables are an Enterprise feature: TestRail answers 403 on an instance without an Enterprise license or subscription.',
  inputSchema: addVariableInput,
  argumentMap: [
    { input: 'project_id', call: 'single', argument: 0, serialization: 'path' },
    { input: 'body', call: 'single', argument: 1, serialization: 'json-body' },
  ],
  response: { shape: 'record', outerSchema: recordResponse, entitySchema: VariableSchema },
  pagination: {
    kind: 'none',
    single: driverCall(addVariableInput, 'variables.addVariable',
      (method, input) => method(input.project_id, input.body)),
  },
  files: { kind: 'none' },
  // A repeat asks TestRail for a second variable of the same name, which it refuses.
  effects: { testRail: 'write', destructive: false, idempotent: false },
  retry: 'json-write',
} as const satisfies OperationDefinition);

const updateVariableInput = strictObject({
  variable_id: positiveIdSchema,
  body: payloadInput(UpdateVariablePayloadSchema),
});

export const updateVariable = defineOperation({
  token: 'update_variable',
  method: 'POST',
  route: 'update_variable/{variable_id}',
  family: 'T09',
  driverBinding: 'variables.updateVariable',
  summary: 'Rename a TestRail variable. The name is the only field, and TestRail accepts an empty body as a no-op. It refuses a name already used in the project. The values datasets give the variable are kept under the new name. Variables are an Enterprise feature: TestRail answers 403 on an instance without an Enterprise license or subscription.',
  inputSchema: updateVariableInput,
  argumentMap: [
    { input: 'variable_id', call: 'single', argument: 0, serialization: 'path' },
    { input: 'body', call: 'single', argument: 1, serialization: 'json-body' },
  ],
  response: { shape: 'record', outerSchema: recordResponse, entitySchema: VariableSchema },
  pagination: {
    kind: 'none',
    single: driverCall(updateVariableInput, 'variables.updateVariable',
      (method, input) => method(input.variable_id, input.body)),
  },
  files: { kind: 'none' },
  effects: { testRail: 'write', destructive: false, idempotent: true },
  retry: 'json-write',
} as const satisfies OperationDefinition);

const deleteVariableInput = strictObject({ variable_id: positiveIdSchema });

export const deleteVariable = defineOperation({
  token: 'delete_variable',
  method: 'POST',
  route: 'delete_variable/{variable_id}',
  family: 'T09',
  driverBinding: 'variables.deleteVariable',
  summary: 'Delete a TestRail variable. TestRail states that this also deletes the corresponding values from the project\'s datasets, so the loss reaches every dataset that gave the variable a value, not only the variable itself. The datasets are not deleted. TestRail returns no variable data. Variables are an Enterprise feature: TestRail answers 403 on an instance without an Enterprise license or subscription.',
  inputSchema: deleteVariableInput,
  argumentMap: [{ input: 'variable_id', call: 'single', argument: 0, serialization: 'path' }],
  response: { shape: 'void', outerSchema: z.undefined(), entitySchema: null },
  pagination: {
    kind: 'none',
    single: driverCall(deleteVariableInput, 'variables.deleteVariable', (method, input) => method(input.variable_id)),
  },
  files: { kind: 'none' },
  effects: { testRail: 'write', destructive: true, idempotent: false },
  retry: 'json-write',
} as const satisfies OperationDefinition);

/** Registered in tool-name order by the registry; listed here in reviewed order. */
export const t09 = [
  getDataset, getDatasets, addDataset, updateDataset, deleteDataset,
  getVariables, addVariable, updateVariable, deleteVariable,
] as const;
