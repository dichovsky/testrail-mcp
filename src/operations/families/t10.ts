import {
  AddCaseFieldPayloadSchema, AddCaseFieldResponseSchema, CaseFieldSchema, CaseStatusSchema, CaseTypeSchema,
  DynamicFilterFieldSchema, PrioritySchema, ResultFieldSchema, StatusSchema, TemplateSchema, TestRailVersionSchema,
} from '@dichovsky/testrail-api-client';
import { z } from 'zod';
import { createListInput, payloadInput, positiveIdSchema, strictObject } from '../../contracts/inputs.js';
import { driverAllOptions } from '../../contracts/pagination.js';
import { driverCall } from '../driver-call.js';
import { defineOperation, type OperationDefinition } from '../registry.js';
import { allControls, pageResponse, recordResponse, safetyControlMappings } from './common.js';

/*
 * Every read in this family describes how the instance is configured rather than the
 * test data in it: the fields, types, priorities, statuses and templates that other
 * endpoints' identifiers refer to. Most take nothing at all, so their tools have no
 * parameters and refuse every field; two are scoped to a project.
 *
 * Two vocabularies here share a word and must not be confused. get_statuses lists the
 * execution statuses a test result records; get_case_statuses lists the statuses of a
 * test case itself, such as Draft or Approved. Each summary names the other tool so a
 * caller asking about one is pointed away from the wrong list.
 *
 * Nothing in this server calls get_version on its own or decides anything by its answer.
 * A version gate would turn an unreadable or older reply into a missing tool, which is
 * the one outcome the one-tool-per-endpoint rule exists to prevent; TestRail's own
 * refusal is reported instead when an endpoint is unavailable.
 */

const noInput = strictObject({});
const arrayResponse = z.array(z.unknown());

// ----------------------------------------------------------------- case fields

export const getCaseFields = defineOperation({
  token: 'get_case_fields',
  method: 'GET',
  route: 'get_case_fields',
  family: 'T10',
  driverBinding: 'metadata.getCaseFields',
  summary: 'List the test case field definitions of the TestRail instance. A field can be configured differently per project: each entry of its configs applies where its context is global (is_global) or its project_ids include the project, and carries the options, such as is_required, used there. project_ids arrives as null, an empty string or an array depending on the server, and is returned as sent. type_id names the field type, for example 6 Dropdown, 10 Steps and 12 Multiselect. TestRail\'s 10.6.1 release notes say the list now carries system fields alongside custom ones, each flagged by is_system; before that it held custom fields only. These are the fields of test cases; the fields of test results are listed by testrail_get_result_fields.',
  inputSchema: noInput,
  argumentMap: [],
  response: { shape: 'array', outerSchema: arrayResponse, entitySchema: CaseFieldSchema },
  pagination: {
    kind: 'none',
    single: driverCall(noInput, 'metadata.getCaseFields', (method) => method()),
  },
  files: { kind: 'none' },
  effects: { testRail: 'read', destructive: false, idempotent: true },
  retry: 'ordinary-read',
} as const satisfies OperationDefinition);

/*
 * The driver parses none of this payload: addCaseField posts it as given. Its exported
 * schema is therefore the boundary's only statement of the shape, and it is adopted as
 * the fields to accept rather than as the rules to enforce. The nested context and
 * options objects become closed like every other payload here, so an option neither
 * TestRail's add_case_field reference nor the driver declares is refused rather than
 * forwarded with an effect nobody documents; the step toggles a read reply carries
 * (has_expected and its siblings) are such options.
 *
 * Per-type rules stay TestRail's. It states which types take default_value, what rows
 * and format accept, and which types can be indexed, and it may change any of them in a
 * release; a copy here would refuse what a newer server accepts. The driver's comment
 * takes the same position and so do the manifests, which forward a request TestRail
 * would refuse on those grounds.
 */
const addCaseFieldInput = strictObject({
  body: payloadInput(AddCaseFieldPayloadSchema, {
    fields: { template_ids: z.array(positiveIdSchema).optional() },
  }),
});

export const addCaseField = defineOperation({
  token: 'add_case_field',
  method: 'POST',
  route: 'add_case_field',
  family: 'T10',
  driverBinding: 'metadata.addCaseField',
  summary: 'Create a custom field for TestRail test cases. body.type is a string: a type name such as "Dropdown" or its number written as a string such as "6"; a bare number is refused here, as TestRail refuses it with a 400. body.name is the name without a prefix, from which TestRail derives system_name (custom_case_ from TestRail 9.0). body.configs needs at least one entry, each with a context {is_global, project_ids: the project IDs it applies to, or [] or "" for a global field} and options holding is_required plus the options of its type: items for a dropdown or multiselect ("1, First\\n2, Second"), format ("plain" or "markdown") and rows for text. TestRail does not allow default_value on Multiselect, Milestone and Date fields; such per-type rules are TestRail\'s and are not checked here. include_all or template_ids choose the templates the field is included in. is_indexed is TestRail Cloud only, for Checkbox, Date, Dropdown, Integer, Milestone and User fields, at most five per instance. TestRail\'s documentation says managing custom case fields needs administrator access. The reply\'s configs is a JSON-encoded string rather than the array testrail_get_case_fields returns, and its flags are 0 or 1; both are returned as TestRail sent them.',
  inputSchema: addCaseFieldInput,
  argumentMap: [{ input: 'body', call: 'single', argument: 0, serialization: 'json-body' }],
  response: { shape: 'record', outerSchema: recordResponse, entitySchema: AddCaseFieldResponseSchema },
  pagination: {
    kind: 'none',
    single: driverCall(addCaseFieldInput, 'metadata.addCaseField', (method, input) => method(input.body)),
  },
  files: { kind: 'none' },
  /*
   * Not idempotent: a repeat asks TestRail for a second field of the same name. Neither
   * TestRail nor the driver says whether it refuses that or creates a duplicate, so the
   * call is not safe to replay whichever it does.
   */
  effects: { testRail: 'write', destructive: false, idempotent: false },
  retry: 'json-write',
} as const satisfies OperationDefinition);

// ------------------------------------------------------------------ case types

export const getCaseTypes = defineOperation({
  token: 'get_case_types',
  method: 'GET',
  route: 'get_case_types',
  family: 'T10',
  driverBinding: 'metadata.getCaseTypes',
  summary: 'List the TestRail case types, such as Automated or Functionality: the types a test case\'s type_id identifies. is_default marks the default type.',
  inputSchema: noInput,
  argumentMap: [],
  response: { shape: 'array', outerSchema: arrayResponse, entitySchema: CaseTypeSchema },
  pagination: {
    kind: 'none',
    single: driverCall(noInput, 'metadata.getCaseTypes', (method) => method()),
  },
  files: { kind: 'none' },
  effects: { testRail: 'read', destructive: false, idempotent: true },
  retry: 'ordinary-read',
} as const satisfies OperationDefinition);

// ------------------------------------------------------- dynamic filter fields

const getDynamicFilterFieldsInput = strictObject({ project_id: positiveIdSchema });

export const getDynamicFilterFields = defineOperation({
  token: 'get_dynamic_filter_fields',
  method: 'GET',
  route: 'get_dynamic_filter_fields/{project_id}',
  family: 'T10',
  driverBinding: 'metadata.getDynamicFilterFields',
  summary: 'List the fields a TestRail project can filter test cases by in the dynamic_filters of a run or plan, matching the Selection Filter in TestRail\'s UI. Each field carries type_id, system_name and label; one with selectable values carries options, and one filtered by a condition carries sub_filters, both of them in TestRail\'s examples newline-separated "id, label" pairs. Name a field in dynamic_filters by its system_name prefixed with "cases:", for example "cases:priority_id". TestRail leaves out field types it cannot filter on, such as Text and Steps. It answers 400 for an invalid or unknown project and 403 when the configured user has no access to it.',
  inputSchema: getDynamicFilterFieldsInput,
  argumentMap: [{ input: 'project_id', call: 'single', argument: 0, serialization: 'path' }],
  response: { shape: 'array', outerSchema: arrayResponse, entitySchema: DynamicFilterFieldSchema },
  pagination: {
    kind: 'none',
    single: driverCall(getDynamicFilterFieldsInput, 'metadata.getDynamicFilterFields',
      (method, input) => method(input.project_id)),
  },
  files: { kind: 'none' },
  effects: { testRail: 'read', destructive: false, idempotent: true },
  retry: 'ordinary-read',
} as const satisfies OperationDefinition);

// ------------------------------------------------------------------ priorities

export const getPriorities = defineOperation({
  token: 'get_priorities',
  method: 'GET',
  route: 'get_priorities',
  family: 'T10',
  driverBinding: 'metadata.getPriorities',
  summary: 'List the TestRail case priorities: the priorities a test case\'s priority_id identifies. Each has a name and a short_name; priority gives their order and is_default marks the default one.',
  inputSchema: noInput,
  argumentMap: [],
  response: { shape: 'array', outerSchema: arrayResponse, entitySchema: PrioritySchema },
  pagination: {
    kind: 'none',
    single: driverCall(noInput, 'metadata.getPriorities', (method) => method()),
  },
  files: { kind: 'none' },
  effects: { testRail: 'read', destructive: false, idempotent: true },
  retry: 'ordinary-read',
} as const satisfies OperationDefinition);

// --------------------------------------------------------------- result fields

export const getResultFields = defineOperation({
  token: 'get_result_fields',
  method: 'GET',
  route: 'get_result_fields',
  family: 'T10',
  driverBinding: 'metadata.getResultFields',
  summary: 'List the test result field definitions of the TestRail instance: the fields a test result can carry, as opposed to the fields of a test case, which testrail_get_case_fields lists. Each field\'s configs work as they do for case fields: an entry applies where its context is global (is_global) or its project_ids include the project, and carries the options used there. Result fields have types of their own, such as 11 Step Results and, from TestRail 10.3, 16 Rating. TestRail\'s 10.6.1 release notes say the list now carries system fields alongside custom ones, each flagged by is_system; before that it held custom fields only.',
  inputSchema: noInput,
  argumentMap: [],
  response: { shape: 'array', outerSchema: arrayResponse, entitySchema: ResultFieldSchema },
  pagination: {
    kind: 'none',
    single: driverCall(noInput, 'metadata.getResultFields', (method) => method()),
  },
  files: { kind: 'none' },
  effects: { testRail: 'read', destructive: false, idempotent: true },
  retry: 'ordinary-read',
} as const satisfies OperationDefinition);

// -------------------------------------------------------------------- statuses

/*
 * TestRail's reference contradicts itself on this reply: its example is a bare array,
 * while its field table documents an envelope carrying offset, limit, size, links and
 * case_statuses. The driver's executor reads either, and no request control is declared
 * because the reference documents none, so neither helper sends one. As with the other
 * response-driven lists, the aggregate walks the envelope's next link, and a complete
 * read that stops at a safety bound cannot be resumed from where it stopped.
 */
const getCaseStatusesInput = createListInput({ path: {}, pagination: 'response-driven' });

export const getCaseStatuses = defineOperation({
  token: 'get_case_statuses',
  method: 'GET',
  route: 'get_case_statuses',
  family: 'T10',
  driverBinding: 'metadata.getCaseStatuses',
  summary: 'List the TestRail case statuses: the statuses of test cases themselves, such as Draft or Approved, identified by case_status_id. is_approved marks an approved status and is_default the default status for test cases. These are not the execution statuses a test result records, which testrail_get_statuses lists. TestRail documents this endpoint as requiring TestRail Enterprise 7.3 or later. This endpoint accepts no paging controls, so the server chooses each page; a complete read that stops at one of its bounds cannot be resumed from where it stopped, and needs a larger bound instead.',
  inputSchema: getCaseStatusesInput,
  argumentMap: [...safetyControlMappings(0)],
  response: { shape: 'page', outerSchema: pageResponse, entitySchema: CaseStatusSchema },
  pagination: {
    kind: 'response_driven',
    page: driverCall(getCaseStatusesInput, 'metadata.getCaseStatusesPage', (method) => method()),
    all: driverCall(getCaseStatusesInput, 'metadata.getAllCaseStatuses',
      (method, input, context) => method(driverAllOptions(allControls(input._mcp), context.limits))),
  },
  files: { kind: 'none' },
  effects: { testRail: 'read', destructive: false, idempotent: true },
  retry: 'ordinary-read',
} as const satisfies OperationDefinition);

export const getStatuses = defineOperation({
  token: 'get_statuses',
  method: 'GET',
  route: 'get_statuses',
  family: 'T10',
  driverBinding: 'metadata.getStatuses',
  summary: 'List the TestRail test statuses: the execution statuses, such as Passed or Failed, that a test result\'s status_id identifies. The list holds the system statuses, by default 1 Passed, 2 Blocked, 3 Untested, 4 Retest and 5 Failed, and any custom ones; name is the system name and label the display name. These are not case statuses, the statuses of test cases themselves, which testrail_get_case_statuses lists.',
  inputSchema: noInput,
  argumentMap: [],
  response: { shape: 'array', outerSchema: arrayResponse, entitySchema: StatusSchema },
  pagination: {
    kind: 'none',
    single: driverCall(noInput, 'metadata.getStatuses', (method) => method()),
  },
  files: { kind: 'none' },
  effects: { testRail: 'read', destructive: false, idempotent: true },
  retry: 'ordinary-read',
} as const satisfies OperationDefinition);

// ------------------------------------------------------------------- templates

const getTemplatesInput = strictObject({ project_id: positiveIdSchema });

export const getTemplates = defineOperation({
  token: 'get_templates',
  method: 'GET',
  route: 'get_templates/{project_id}',
  family: 'T10',
  driverBinding: 'metadata.getTemplates',
  summary: 'List the templates available to a TestRail project: the field layouts of test cases and results, one of which a test case\'s template_id identifies. is_default marks the default template. TestRail answers 400 for an invalid or unknown project and 403 when the configured user has no access to it.',
  inputSchema: getTemplatesInput,
  argumentMap: [{ input: 'project_id', call: 'single', argument: 0, serialization: 'path' }],
  response: { shape: 'array', outerSchema: arrayResponse, entitySchema: TemplateSchema },
  pagination: {
    kind: 'none',
    single: driverCall(getTemplatesInput, 'metadata.getTemplates', (method, input) => method(input.project_id)),
  },
  files: { kind: 'none' },
  effects: { testRail: 'read', destructive: false, idempotent: true },
  retry: 'ordinary-read',
} as const satisfies OperationDefinition);

// --------------------------------------------------------------------- version

export const getVersion = defineOperation({
  token: 'get_version',
  method: 'GET',
  route: 'get_version',
  family: 'T10',
  driverBinding: 'metadata.getVersion',
  summary: 'Get the version of the TestRail instance, for example {"version": "10.6.0.1041"}. TestRail\'s 10.6.1 release notes introduce this endpoint as new, so an older server may not offer it. This server never calls it on its own and decides nothing by its answer: every tool is offered whatever version is reported.',
  inputSchema: noInput,
  argumentMap: [],
  response: { shape: 'record', outerSchema: recordResponse, entitySchema: TestRailVersionSchema },
  pagination: {
    kind: 'none',
    single: driverCall(noInput, 'metadata.getVersion', (method) => method()),
  },
  files: { kind: 'none' },
  effects: { testRail: 'read', destructive: false, idempotent: true },
  retry: 'ordinary-read',
} as const satisfies OperationDefinition);

/** Registered in tool-name order by the registry; listed here in reviewed order. */
export const t10 = [
  getCaseFields, addCaseField, getCaseTypes, getDynamicFilterFields, getPriorities, getResultFields,
  getCaseStatuses, getStatuses, getTemplates, getVersion,
] as const;
