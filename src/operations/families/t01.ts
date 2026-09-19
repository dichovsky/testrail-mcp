import {
  AddProjectPayloadSchema, AddSectionPayloadSchema, AddSuitePayloadSchema, MoveSectionPayloadSchema,
  ProjectSchema, SectionSchema, SuiteSchema,
  UpdateProjectPayloadSchema, UpdateSectionPayloadSchema, UpdateSuitePayloadSchema,
} from '@dichovsky/testrail-api-client';
import { z } from 'zod';
import {
  createListInput, nonnegativeIntegerSchema, payloadInput, positiveIdSchema, strictObject,
} from '../../contracts/inputs.js';
import { driverAllOptions, pageRequestDefaults } from '../../contracts/pagination.js';
import { driverCall } from '../driver-call.js';
import { defineOperation, type OperationDefinition } from '../registry.js';
import { allControls, control, flag, pageResponse, recordResponse } from './common.js';

const getProjectInput = strictObject({ project_id: positiveIdSchema });

export const getProject = defineOperation({
  token: 'get_project',
  method: 'GET',
  route: 'get_project/{project_id}',
  family: 'T01',
  driverBinding: 'projects.getProject',
  summary: 'Get a single TestRail project by its ID.',
  inputSchema: getProjectInput,
  argumentMap: [{ input: 'project_id', call: 'single', argument: 0, serialization: 'path' }],
  response: { shape: 'record', outerSchema: recordResponse, entitySchema: ProjectSchema },
  pagination: {
    kind: 'none',
    single: driverCall(getProjectInput, 'projects.getProject', (method, input) => method(input.project_id)),
  },
  files: { kind: 'none' },
  effects: { testRail: 'read', destructive: false, idempotent: true },
  retry: 'ordinary-read',
} as const satisfies OperationDefinition);

const getProjectsInput = createListInput({
  query: { is_completed: z.boolean().optional() },
  pagination: 'controlled',
});

/** Renamed filter: the REST field is snake_case, the driver option is camelCase. */
function projectFilter(query: object | undefined): { isCompleted?: boolean } {
  const isCompleted = flag(query, 'is_completed');
  return isCompleted === undefined ? {} : { isCompleted };
}

export const getProjects = defineOperation({
  token: 'get_projects',
  method: 'GET',
  route: 'get_projects',
  family: 'T01',
  driverBinding: 'projects.getProjects',
  summary: 'List TestRail projects, optionally filtered by completion state.',
  inputSchema: getProjectsInput,
  argumentMap: [
    { input: 'query.is_completed', call: 'page', argument: 0, property: 'isCompleted', serialization: 'query-scalar' },
    { input: 'query.limit', call: 'page', argument: 0, property: 'limit', serialization: 'query-scalar' },
    { input: 'query.offset', call: 'page', argument: 0, property: 'offset', serialization: 'query-scalar' },
    { input: 'query.is_completed', call: 'all', argument: 0, property: 'isCompleted', serialization: 'query-scalar' },
    { input: '_mcp.page_size', call: 'all', argument: 0, property: 'pageSize', serialization: 'aggregate-control' },
    { input: '_mcp.start_offset', call: 'all', argument: 0, property: 'startOffset', serialization: 'aggregate-control' },
    { input: '_mcp.max_items', call: 'all', argument: 0, property: 'maxItems', serialization: 'aggregate-control' },
    { input: '_mcp.max_pages', call: 'all', argument: 0, property: 'maxPages', serialization: 'aggregate-control' },
    { input: '_mcp.max_bytes', call: 'all', argument: 0, property: 'maxBytes', serialization: 'aggregate-control' },
    { input: '_mcp.max_duration_ms', call: 'all', argument: 0, property: 'maxDurationMs', serialization: 'aggregate-control' },
  ],
  response: { shape: 'page', outerSchema: pageResponse, entitySchema: ProjectSchema },
  pagination: {
    kind: 'controlled',
    // The page helper is used rather than the convenience method, which discards the
    // metadata the result needs to describe continuation honestly.
    page: driverCall(getProjectsInput, 'projects.getProjectsPage', (method, input) => method({
      ...projectFilter(input.query),
      ...pageRequestDefaults({
        ...(control(input.query, 'limit') === undefined ? {} : { limit: control(input.query, 'limit') }),
        ...(control(input.query, 'offset') === undefined ? {} : { offset: control(input.query, 'offset') }),
      }),
    })),
    // A bound the caller left unset falls back to the configured limit, never to the
    // driver's own far larger default. Paging controls are forwarded only when supplied.
    all: driverCall(getProjectsInput, 'projects.getAllProjects', (method, input, context) => method({
      ...projectFilter(input.query),
      ...driverAllOptions(allControls(input._mcp), context.limits),
    })),
  },
  files: { kind: 'none' },
  effects: { testRail: 'read', destructive: false, idempotent: true },
  retry: 'ordinary-read',
} as const satisfies OperationDefinition);

const addProjectInput = strictObject({ body: payloadInput(AddProjectPayloadSchema) });

export const addProject = defineOperation({
  token: 'add_project',
  method: 'POST',
  route: 'add_project',
  family: 'T01',
  driverBinding: 'projects.addProject',
  summary: 'Create a TestRail project.',
  inputSchema: addProjectInput,
  argumentMap: [{ input: 'body', call: 'single', argument: 0, serialization: 'json-body' }],
  response: { shape: 'record', outerSchema: recordResponse, entitySchema: ProjectSchema },
  pagination: {
    kind: 'none',
    single: driverCall(addProjectInput, 'projects.addProject', (method, input) => method(input.body)),
  },
  files: { kind: 'none' },
  // Repeating the call creates another project, so this is not idempotent.
  effects: { testRail: 'write', destructive: false, idempotent: false },
  retry: 'json-write',
} as const satisfies OperationDefinition);

const updateProjectInput = strictObject({
  project_id: positiveIdSchema,
  body: payloadInput(UpdateProjectPayloadSchema),
});

export const updateProject = defineOperation({
  token: 'update_project',
  method: 'POST',
  route: 'update_project/{project_id}',
  family: 'T01',
  driverBinding: 'projects.updateProject',
  summary: 'Update a TestRail project. Supplied fields replace their current values.',
  inputSchema: updateProjectInput,
  argumentMap: [
    { input: 'project_id', call: 'single', argument: 0, serialization: 'path' },
    { input: 'body', call: 'single', argument: 1, serialization: 'json-body' },
  ],
  response: { shape: 'record', outerSchema: recordResponse, entitySchema: ProjectSchema },
  pagination: {
    kind: 'none',
    single: driverCall(updateProjectInput, 'projects.updateProject',
      (method, input) => method(input.project_id, input.body)),
  },
  files: { kind: 'none' },
  // Applying the same field values again leaves the project in the same state.
  effects: { testRail: 'write', destructive: false, idempotent: true },
  retry: 'json-write',
} as const satisfies OperationDefinition);

const deleteProjectInput = strictObject({ project_id: positiveIdSchema });

export const deleteProject = defineOperation({
  token: 'delete_project',
  method: 'POST',
  route: 'delete_project/{project_id}',
  family: 'T01',
  driverBinding: 'projects.deleteProject',
  summary: 'Delete a TestRail project and everything it contains. This cannot be undone.',
  inputSchema: deleteProjectInput,
  argumentMap: [{ input: 'project_id', call: 'single', argument: 0, serialization: 'path' }],
  // The method resolves with no value; the wrapper reports that as data: null.
  response: { shape: 'void', outerSchema: z.undefined(), entitySchema: null },
  pagination: {
    kind: 'none',
    single: driverCall(deleteProjectInput, 'projects.deleteProject',
      (method, input) => method(input.project_id)),
  },
  files: { kind: 'none' },
  // Removing a project removes its suites, cases, runs and results with it. A repeat
  // call does not restore anything, so it is neither reversible nor idempotent.
  effects: { testRail: 'write', destructive: true, idempotent: false },
  retry: 'json-write',
} as const satisfies OperationDefinition);

const getSuiteInput = strictObject({ suite_id: positiveIdSchema });

export const getSuite = defineOperation({
  token: 'get_suite',
  method: 'GET',
  route: 'get_suite/{suite_id}',
  family: 'T01',
  driverBinding: 'suites.getSuite',
  summary: 'Get a single TestRail test suite by its ID.',
  inputSchema: getSuiteInput,
  argumentMap: [{ input: 'suite_id', call: 'single', argument: 0, serialization: 'path' }],
  response: { shape: 'record', outerSchema: recordResponse, entitySchema: SuiteSchema },
  pagination: {
    kind: 'none',
    single: driverCall(getSuiteInput, 'suites.getSuite', (method, input) => method(input.suite_id)),
  },
  files: { kind: 'none' },
  effects: { testRail: 'read', destructive: false, idempotent: true },
  retry: 'ordinary-read',
} as const satisfies OperationDefinition);

const getSuitesInput = createListInput({ path: { project_id: positiveIdSchema }, pagination: 'controlled' });

export const getSuites = defineOperation({
  token: 'get_suites',
  method: 'GET',
  route: 'get_suites/{project_id}',
  family: 'T01',
  driverBinding: 'suites.getSuites',
  summary: 'List the test suites of a TestRail project.',
  inputSchema: getSuitesInput,
  argumentMap: [
    { input: 'project_id', call: 'page', argument: 0, serialization: 'path' },
    { input: 'query.limit', call: 'page', argument: 1, property: 'limit', serialization: 'query-scalar' },
    { input: 'query.offset', call: 'page', argument: 1, property: 'offset', serialization: 'query-scalar' },
    { input: 'project_id', call: 'all', argument: 0, serialization: 'path' },
    { input: '_mcp.page_size', call: 'all', argument: 1, property: 'pageSize', serialization: 'aggregate-control' },
    { input: '_mcp.start_offset', call: 'all', argument: 1, property: 'startOffset', serialization: 'aggregate-control' },
    { input: '_mcp.max_items', call: 'all', argument: 1, property: 'maxItems', serialization: 'aggregate-control' },
    { input: '_mcp.max_pages', call: 'all', argument: 1, property: 'maxPages', serialization: 'aggregate-control' },
    { input: '_mcp.max_bytes', call: 'all', argument: 1, property: 'maxBytes', serialization: 'aggregate-control' },
    { input: '_mcp.max_duration_ms', call: 'all', argument: 1, property: 'maxDurationMs', serialization: 'aggregate-control' },
  ],
  response: { shape: 'page', outerSchema: pageResponse, entitySchema: SuiteSchema },
  pagination: {
    kind: 'controlled',
    page: driverCall(getSuitesInput, 'suites.getSuitesPage', (method, input) => method(
      input.project_id,
      pageRequestDefaults({ limit: control(input.query, 'limit'), offset: control(input.query, 'offset') }),
    )),
    all: driverCall(getSuitesInput, 'suites.getAllSuites', (method, input, context) => method(
      input.project_id,
      driverAllOptions(allControls(input._mcp), context.limits),
    )),
  },
  files: { kind: 'none' },
  effects: { testRail: 'read', destructive: false, idempotent: true },
  retry: 'ordinary-read',
} as const satisfies OperationDefinition);

const addSuiteInput = strictObject({ project_id: positiveIdSchema, body: payloadInput(AddSuitePayloadSchema) });

export const addSuite = defineOperation({
  token: 'add_suite',
  method: 'POST',
  route: 'add_suite/{project_id}',
  family: 'T01',
  driverBinding: 'suites.addSuite',
  summary: 'Create a test suite in a TestRail project.',
  inputSchema: addSuiteInput,
  argumentMap: [
    { input: 'project_id', call: 'single', argument: 0, serialization: 'path' },
    { input: 'body', call: 'single', argument: 1, serialization: 'json-body' },
  ],
  response: { shape: 'record', outerSchema: recordResponse, entitySchema: SuiteSchema },
  pagination: {
    kind: 'none',
    single: driverCall(addSuiteInput, 'suites.addSuite', (method, input) => method(input.project_id, input.body)),
  },
  files: { kind: 'none' },
  // Repeating the call creates another suite, so this is not idempotent.
  effects: { testRail: 'write', destructive: false, idempotent: false },
  retry: 'json-write',
} as const satisfies OperationDefinition);

const updateSuiteInput = strictObject({ suite_id: positiveIdSchema, body: payloadInput(UpdateSuitePayloadSchema) });

export const updateSuite = defineOperation({
  token: 'update_suite',
  method: 'POST',
  route: 'update_suite/{suite_id}',
  family: 'T01',
  driverBinding: 'suites.updateSuite',
  summary: 'Update a TestRail test suite. Supplied fields replace their current values.',
  inputSchema: updateSuiteInput,
  argumentMap: [
    { input: 'suite_id', call: 'single', argument: 0, serialization: 'path' },
    { input: 'body', call: 'single', argument: 1, serialization: 'json-body' },
  ],
  response: { shape: 'record', outerSchema: recordResponse, entitySchema: SuiteSchema },
  pagination: {
    kind: 'none',
    single: driverCall(updateSuiteInput, 'suites.updateSuite', (method, input) => method(input.suite_id, input.body)),
  },
  files: { kind: 'none' },
  // Applying the same field values again leaves the suite in the same state.
  effects: { testRail: 'write', destructive: false, idempotent: true },
  retry: 'json-write',
} as const satisfies OperationDefinition);

const deleteSuiteInput = strictObject({
  suite_id: positiveIdSchema,
  query: strictObject({ soft: z.boolean().optional() }).optional(),
});

export const deleteSuite = defineOperation({
  token: 'delete_suite',
  method: 'POST',
  route: 'delete_suite/{suite_id}',
  family: 'T01',
  driverBinding: 'suites.deleteSuite',
  summary: 'Delete a TestRail test suite with its sections, cases and active runs and results. This cannot be undone. Set query.soft to true to preview the affected counts without deleting anything (TestRail 6.5 or later).',
  inputSchema: deleteSuiteInput,
  argumentMap: [
    { input: 'suite_id', call: 'single', argument: 0, serialization: 'path' },
    { input: 'query.soft', call: 'single', argument: 1, property: 'soft', serialization: 'query-scalar' },
  ],
  // Void after a deletion; TestRail's affected-entity counts after a preview. The
  // counts vary by TestRail version and are the driver's own parse, so they are not
  // drift-checked against an entity schema here.
  response: { shape: 'union', outerSchema: z.union([z.undefined(), recordResponse]), entitySchema: null },
  pagination: {
    kind: 'none',
    single: driverCall(deleteSuiteInput, 'suites.deleteSuite', (method, input) => {
      const soft = flag(input.query, 'soft');
      return soft === undefined ? method(input.suite_id) : method(input.suite_id, { soft });
    }),
  },
  files: { kind: 'none' },
  // Removing a suite removes its sections, cases and active runs with it. A preview
  // is possible, but the tool as a whole is destructive and never idempotent.
  effects: { testRail: 'write', destructive: true, idempotent: false },
  retry: 'json-write',
} as const satisfies OperationDefinition);

const getSectionInput = strictObject({ section_id: positiveIdSchema });

export const getSection = defineOperation({
  token: 'get_section',
  method: 'GET',
  route: 'get_section/{section_id}',
  family: 'T01',
  driverBinding: 'sections.getSection',
  summary: 'Get a single TestRail section by its ID.',
  inputSchema: getSectionInput,
  argumentMap: [{ input: 'section_id', call: 'single', argument: 0, serialization: 'path' }],
  response: { shape: 'record', outerSchema: recordResponse, entitySchema: SectionSchema },
  pagination: {
    kind: 'none',
    single: driverCall(getSectionInput, 'sections.getSection', (method, input) => method(input.section_id)),
  },
  files: { kind: 'none' },
  effects: { testRail: 'read', destructive: false, idempotent: true },
  retry: 'ordinary-read',
} as const satisfies OperationDefinition);

const getSectionsInput = createListInput({
  path: { project_id: positiveIdSchema },
  query: { suite_id: positiveIdSchema.optional() },
  pagination: 'controlled',
});

/** Renamed filter: the REST field is snake_case, the driver option is camelCase. */
function sectionFilter(query: object | undefined): { suiteId?: number } {
  const suiteId = control(query, 'suite_id');
  return suiteId === undefined ? {} : { suiteId };
}

export const getSections = defineOperation({
  token: 'get_sections',
  method: 'GET',
  route: 'get_sections/{project_id}',
  family: 'T01',
  driverBinding: 'sections.getSections',
  summary: 'List the sections of a TestRail project, optionally within one test suite. The suite is required unless the project runs in single-suite mode.',
  inputSchema: getSectionsInput,
  argumentMap: [
    { input: 'project_id', call: 'page', argument: 0, serialization: 'path' },
    { input: 'query.suite_id', call: 'page', argument: 1, property: 'suiteId', serialization: 'query-scalar' },
    { input: 'query.limit', call: 'page', argument: 1, property: 'limit', serialization: 'query-scalar' },
    { input: 'query.offset', call: 'page', argument: 1, property: 'offset', serialization: 'query-scalar' },
    { input: 'project_id', call: 'all', argument: 0, serialization: 'path' },
    { input: 'query.suite_id', call: 'all', argument: 1, property: 'suiteId', serialization: 'query-scalar' },
    { input: '_mcp.page_size', call: 'all', argument: 1, property: 'pageSize', serialization: 'aggregate-control' },
    { input: '_mcp.start_offset', call: 'all', argument: 1, property: 'startOffset', serialization: 'aggregate-control' },
    { input: '_mcp.max_items', call: 'all', argument: 1, property: 'maxItems', serialization: 'aggregate-control' },
    { input: '_mcp.max_pages', call: 'all', argument: 1, property: 'maxPages', serialization: 'aggregate-control' },
    { input: '_mcp.max_bytes', call: 'all', argument: 1, property: 'maxBytes', serialization: 'aggregate-control' },
    { input: '_mcp.max_duration_ms', call: 'all', argument: 1, property: 'maxDurationMs', serialization: 'aggregate-control' },
  ],
  response: { shape: 'page', outerSchema: pageResponse, entitySchema: SectionSchema },
  pagination: {
    kind: 'controlled',
    page: driverCall(getSectionsInput, 'sections.getSectionsPage', (method, input) => method(input.project_id, {
      ...sectionFilter(input.query),
      ...pageRequestDefaults({ limit: control(input.query, 'limit'), offset: control(input.query, 'offset') }),
    })),
    all: driverCall(getSectionsInput, 'sections.getAllSections', (method, input, context) => method(input.project_id, {
      ...sectionFilter(input.query),
      ...driverAllOptions(allControls(input._mcp), context.limits),
    })),
  },
  files: { kind: 'none' },
  effects: { testRail: 'read', destructive: false, idempotent: true },
  retry: 'ordinary-read',
} as const satisfies OperationDefinition);

// The driver forwards any number for these; a fractional, non-positive or unsafe value
// can never name an existing suite or section, so they are held to the identifier domain.
const addSectionInput = strictObject({
  project_id: positiveIdSchema,
  body: payloadInput(AddSectionPayloadSchema, {
    fields: { suite_id: positiveIdSchema.optional(), parent_id: positiveIdSchema.optional() },
  }),
});

export const addSection = defineOperation({
  token: 'add_section',
  method: 'POST',
  route: 'add_section/{project_id}',
  family: 'T01',
  driverBinding: 'sections.addSection',
  summary: 'Create a section in a TestRail project. suite_id is required unless the project runs in single-suite mode; parent_id nests the section.',
  inputSchema: addSectionInput,
  argumentMap: [
    { input: 'project_id', call: 'single', argument: 0, serialization: 'path' },
    { input: 'body', call: 'single', argument: 1, serialization: 'json-body' },
  ],
  response: { shape: 'record', outerSchema: recordResponse, entitySchema: SectionSchema },
  pagination: {
    kind: 'none',
    single: driverCall(addSectionInput, 'sections.addSection', (method, input) => method(input.project_id, input.body)),
  },
  files: { kind: 'none' },
  // Repeating the call creates another section, so this is not idempotent.
  effects: { testRail: 'write', destructive: false, idempotent: false },
  retry: 'json-write',
} as const satisfies OperationDefinition);

const updateSectionInput = strictObject({ section_id: positiveIdSchema, body: payloadInput(UpdateSectionPayloadSchema) });

export const updateSection = defineOperation({
  token: 'update_section',
  method: 'POST',
  route: 'update_section/{section_id}',
  family: 'T01',
  driverBinding: 'sections.updateSection',
  summary: 'Update a TestRail section\'s name or description. Supplied fields replace their current values; use move_section to change its position.',
  inputSchema: updateSectionInput,
  argumentMap: [
    { input: 'section_id', call: 'single', argument: 0, serialization: 'path' },
    { input: 'body', call: 'single', argument: 1, serialization: 'json-body' },
  ],
  response: { shape: 'record', outerSchema: recordResponse, entitySchema: SectionSchema },
  pagination: {
    kind: 'none',
    single: driverCall(updateSectionInput, 'sections.updateSection', (method, input) => method(input.section_id, input.body)),
  },
  files: { kind: 'none' },
  // Applying the same field values again leaves the section in the same state.
  effects: { testRail: 'write', destructive: false, idempotent: true },
  retry: 'json-write',
} as const satisfies OperationDefinition);

// Null is an explicit move to the root or the top and zero is a sentinel the driver
// deliberately keeps for some installs; only values that can never name a section go.
const moveSectionInput = strictObject({
  section_id: positiveIdSchema,
  body: payloadInput(MoveSectionPayloadSchema, {
    fields: {
      parent_id: nonnegativeIntegerSchema.nullable().optional(),
      after_id: nonnegativeIntegerSchema.nullable().optional(),
    },
  }),
});

export const moveSection = defineOperation({
  token: 'move_section',
  method: 'POST',
  route: 'move_section/{section_id}',
  family: 'T01',
  driverBinding: 'sections.moveSection',
  summary: 'Move a TestRail section under another parent (parent_id, null for the root) and/or after a sibling (after_id, null for the top) within its suite. Omit a field to leave that axis unchanged. Requires TestRail 6.5.2 or later; this tool returns nothing, so read the section afterwards for its new position.',
  inputSchema: moveSectionInput,
  argumentMap: [
    { input: 'section_id', call: 'single', argument: 0, serialization: 'path' },
    { input: 'body', call: 'single', argument: 1, serialization: 'json-body' },
  ],
  // The driver discards any body TestRail returns and resolves with no value.
  response: { shape: 'void', outerSchema: z.undefined(), entitySchema: null },
  pagination: {
    kind: 'none',
    single: driverCall(moveSectionInput, 'sections.moveSection', (method, input) => method(input.section_id, input.body)),
  },
  files: { kind: 'none' },
  // Moving to the same place again leaves the section where it is.
  effects: { testRail: 'write', destructive: false, idempotent: true },
  retry: 'json-write',
} as const satisfies OperationDefinition);

const deleteSectionInput = strictObject({
  section_id: positiveIdSchema,
  query: strictObject({ soft: z.boolean().optional() }).optional(),
});

export const deleteSection = defineOperation({
  token: 'delete_section',
  method: 'POST',
  route: 'delete_section/{section_id}',
  family: 'T01',
  driverBinding: 'sections.deleteSection',
  summary: 'Delete a TestRail section with its subsections, cases and active tests and results. This cannot be undone. Set query.soft to true to preview the affected counts without deleting anything (TestRail 6.5 or later).',
  inputSchema: deleteSectionInput,
  argumentMap: [
    { input: 'section_id', call: 'single', argument: 0, serialization: 'path' },
    { input: 'query.soft', call: 'single', argument: 1, property: 'soft', serialization: 'query-scalar' },
  ],
  // Void after a deletion; TestRail's affected-entity counts after a preview, which are
  // the driver's own parse and are not drift-checked here.
  response: { shape: 'union', outerSchema: z.union([z.undefined(), recordResponse]), entitySchema: null },
  pagination: {
    kind: 'none',
    single: driverCall(deleteSectionInput, 'sections.deleteSection', (method, input) => {
      const soft = flag(input.query, 'soft');
      return soft === undefined ? method(input.section_id) : method(input.section_id, { soft });
    }),
  },
  files: { kind: 'none' },
  // Removing a section removes its subsections, cases and active tests with it. A
  // preview is possible, but the tool as a whole is destructive and never idempotent.
  effects: { testRail: 'write', destructive: true, idempotent: false },
  retry: 'json-write',
} as const satisfies OperationDefinition);

/** Registered in tool-name order by the registry; listed here in reviewed order. */
export const t01 = [
  getProject, getProjects, addProject, updateProject, deleteProject,
  getSuite, getSuites, addSuite, updateSuite, deleteSuite,
  getSection, getSections, addSection, updateSection, moveSection, deleteSection,
] as const;
