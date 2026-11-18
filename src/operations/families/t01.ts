import {
  AddProjectPayloadSchema, AddSectionPayloadSchema, AddSuitePayloadSchema, MoveSectionPayloadSchema,
  ProjectSchema, SectionSchema, SuiteSchema, type GetProjectsOptions, type GetSectionsOptions,
  UpdateProjectPayloadSchema, UpdateSectionPayloadSchema, UpdateSuitePayloadSchema,
} from '@dichovsky/testrail-api-client';
import { z } from 'zod';
import {
  nonnegativeIntegerSchema, payloadInput, positiveIdSchema, strictObject,
} from '../../contracts/inputs.js';
import { defineOperation } from '../registry.js';
import { createListDefinition, type ListFilters } from '../lists.js';
import { flag, recordResponse, softDeletePreview } from './common.js';

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
  pagination: (bind) => ({
    kind: 'none',
    single: bind('projects.getProject', (method, input) => method(input.project_id)),
  }),
  files: { kind: 'none' },
  effects: { testRail: 'read', destructive: false, idempotent: true },
  retry: 'ordinary-read',
});

const getProjectsList = createListDefinition({
  pagination: 'controlled',
  optionsArgument: 0,
  filters: {
    is_completed: { schema: z.boolean().optional(), property: 'isCompleted', serialization: 'query-scalar' },
  } satisfies ListFilters<GetProjectsOptions>,
  entitySchema: ProjectSchema,
});

export const getProjects = defineOperation({
  token: 'get_projects',
  method: 'GET',
  route: 'get_projects',
  family: 'T01',
  driverBinding: 'projects.getProjects',
  summary: 'List TestRail projects, optionally filtered by completion state.',
  ...getProjectsList.bind({
    page: {
      binding: 'projects.getProjectsPage',
      call: (method, _input, options) => method(options),
    },
    all: {
      binding: 'projects.getAllProjects',
      call: (method, _input, options) => method(options),
    },
  }),
  files: { kind: 'none' },
  effects: { testRail: 'read', destructive: false, idempotent: true },
  retry: 'ordinary-read',
});

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
  pagination: (bind) => ({
    kind: 'none',
    single: bind('projects.addProject', (method, input) => method(input.body)),
  }),
  files: { kind: 'none' },
  // Repeating the call creates another project, so this is not idempotent.
  effects: { testRail: 'write', destructive: false, idempotent: false },
  retry: 'json-write',
});

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
  pagination: (bind) => ({
    kind: 'none',
    single: bind('projects.updateProject',
      (method, input) => method(input.project_id, input.body)),
  }),
  files: { kind: 'none' },
  // Applying the same field values again leaves the project in the same state.
  effects: { testRail: 'write', destructive: false, idempotent: true },
  retry: 'json-write',
});

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
  pagination: (bind) => ({
    kind: 'none',
    single: bind('projects.deleteProject',
      (method, input) => method(input.project_id)),
  }),
  files: { kind: 'none' },
  // Removing a project removes its suites, cases, runs and results with it. A repeat
  // call does not restore anything, so it is neither reversible nor idempotent.
  effects: { testRail: 'write', destructive: true, idempotent: false },
  retry: 'json-write',
});

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
  pagination: (bind) => ({
    kind: 'none',
    single: bind('suites.getSuite', (method, input) => method(input.suite_id)),
  }),
  files: { kind: 'none' },
  effects: { testRail: 'read', destructive: false, idempotent: true },
  retry: 'ordinary-read',
});

const getSuitesList = createListDefinition({
  path: { project_id: { schema: positiveIdSchema, argument: 0 } },
  pagination: 'controlled',
  optionsArgument: 1,
  entitySchema: SuiteSchema,
});

export const getSuites = defineOperation({
  token: 'get_suites',
  method: 'GET',
  route: 'get_suites/{project_id}',
  family: 'T01',
  driverBinding: 'suites.getSuites',
  summary: 'List the test suites of a TestRail project.',
  ...getSuitesList.bind({
    page: {
      binding: 'suites.getSuitesPage',
      call: (method, input, options) => method(input.project_id, options),
    },
    all: {
      binding: 'suites.getAllSuites',
      call: (method, input, options) => method(input.project_id, options),
    },
  }),
  files: { kind: 'none' },
  effects: { testRail: 'read', destructive: false, idempotent: true },
  retry: 'ordinary-read',
});

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
  pagination: (bind) => ({
    kind: 'none',
    single: bind('suites.addSuite', (method, input) => method(input.project_id, input.body)),
  }),
  files: { kind: 'none' },
  // Repeating the call creates another suite, so this is not idempotent.
  effects: { testRail: 'write', destructive: false, idempotent: false },
  retry: 'json-write',
});

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
  pagination: (bind) => ({
    kind: 'none',
    single: bind('suites.updateSuite', (method, input) => method(input.suite_id, input.body)),
  }),
  files: { kind: 'none' },
  // Applying the same field values again leaves the suite in the same state.
  effects: { testRail: 'write', destructive: false, idempotent: true },
  retry: 'json-write',
});

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
  summary: 'Delete a TestRail test suite with its sections, cases and active runs and results. This cannot be undone. Set query.soft to true to preview the affected counts without deleting anything (TestRail 6.5 or later); a preview reply with no count is reported as an unknown outcome, since an instance that ignores the flag deletes.',
  inputSchema: deleteSuiteInput,
  argumentMap: [
    { input: 'suite_id', call: 'single', argument: 0, serialization: 'path' },
    { input: 'query.soft', call: 'single', argument: 1, property: 'soft', serialization: 'query-scalar' },
  ],
  // Void after a deletion; TestRail's affected-entity counts after a preview, which are
  // drift-checked advisorily and must carry at least one count (see softDeletePreview).
  response: { shape: 'union', outerSchema: z.union([z.undefined(), recordResponse]), entitySchema: null, preview: softDeletePreview },
  pagination: (bind) => ({
    kind: 'none',
    single: bind('suites.deleteSuite', (method, input) => {
      const soft = flag(input.query, 'soft');
      return soft === undefined ? method(input.suite_id) : method(input.suite_id, { soft });
    }),
  }),
  files: { kind: 'none' },
  // Removing a suite removes its sections, cases and active runs with it. A preview
  // is possible, but the tool as a whole is destructive and never idempotent.
  effects: { testRail: 'write', destructive: true, idempotent: false },
  retry: 'json-write',
});

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
  pagination: (bind) => ({
    kind: 'none',
    single: bind('sections.getSection', (method, input) => method(input.section_id)),
  }),
  files: { kind: 'none' },
  effects: { testRail: 'read', destructive: false, idempotent: true },
  retry: 'ordinary-read',
});

const getSectionsList = createListDefinition({
  path: { project_id: { schema: positiveIdSchema, argument: 0 } },
  pagination: 'controlled',
  optionsArgument: 1,
  filters: {
    suite_id: { schema: positiveIdSchema.optional(), property: 'suiteId', serialization: 'query-scalar' },
  } satisfies ListFilters<GetSectionsOptions>,
  entitySchema: SectionSchema,
});

export const getSections = defineOperation({
  token: 'get_sections',
  method: 'GET',
  route: 'get_sections/{project_id}',
  family: 'T01',
  driverBinding: 'sections.getSections',
  summary: 'List the sections of a TestRail project, optionally within one test suite. The suite is required unless the project runs in single-suite mode.',
  ...getSectionsList.bind({
    page: {
      binding: 'sections.getSectionsPage',
      call: (method, input, options) => method(input.project_id, options),
    },
    all: {
      binding: 'sections.getAllSections',
      call: (method, input, options) => method(input.project_id, options),
    },
  }),
  files: { kind: 'none' },
  effects: { testRail: 'read', destructive: false, idempotent: true },
  retry: 'ordinary-read',
});

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
  pagination: (bind) => ({
    kind: 'none',
    single: bind('sections.addSection', (method, input) => method(input.project_id, input.body)),
  }),
  files: { kind: 'none' },
  // Repeating the call creates another section, so this is not idempotent.
  effects: { testRail: 'write', destructive: false, idempotent: false },
  retry: 'json-write',
});

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
  pagination: (bind) => ({
    kind: 'none',
    single: bind('sections.updateSection', (method, input) => method(input.section_id, input.body)),
  }),
  files: { kind: 'none' },
  // Applying the same field values again leaves the section in the same state.
  effects: { testRail: 'write', destructive: false, idempotent: true },
  retry: 'json-write',
});

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
  pagination: (bind) => ({
    kind: 'none',
    single: bind('sections.moveSection', (method, input) => method(input.section_id, input.body)),
  }),
  files: { kind: 'none' },
  // Moving to the same place again leaves the section where it is.
  effects: { testRail: 'write', destructive: false, idempotent: true },
  retry: 'json-write',
});

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
  summary: 'Delete a TestRail section with its subsections, cases and active tests and results. This cannot be undone. Set query.soft to true to preview the affected counts without deleting anything (TestRail 6.5 or later); a preview reply with no count is reported as an unknown outcome, since an instance that ignores the flag deletes.',
  inputSchema: deleteSectionInput,
  argumentMap: [
    { input: 'section_id', call: 'single', argument: 0, serialization: 'path' },
    { input: 'query.soft', call: 'single', argument: 1, property: 'soft', serialization: 'query-scalar' },
  ],
  // Void after a deletion; TestRail's affected-entity counts after a preview, which are
  // drift-checked advisorily and must carry at least one count (see softDeletePreview).
  response: { shape: 'union', outerSchema: z.union([z.undefined(), recordResponse]), entitySchema: null, preview: softDeletePreview },
  pagination: (bind) => ({
    kind: 'none',
    single: bind('sections.deleteSection', (method, input) => {
      const soft = flag(input.query, 'soft');
      return soft === undefined ? method(input.section_id) : method(input.section_id, { soft });
    }),
  }),
  files: { kind: 'none' },
  // Removing a section removes its subsections, cases and active tests with it. A
  // preview is possible, but the tool as a whole is destructive and never idempotent.
  effects: { testRail: 'write', destructive: true, idempotent: false },
  retry: 'json-write',
});

/** Registered in tool-name order by the registry; listed here in reviewed order. */
export const t01 = [
  getProject, getProjects, addProject, updateProject, deleteProject,
  getSuite, getSuites, addSuite, updateSuite, deleteSuite,
  getSection, getSections, addSection, updateSection, moveSection, deleteSection,
] as const;
