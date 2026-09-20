import {
  AddGroupPayloadSchema, GroupSchema, RoleSchema, UpdateGroupPayloadSchema, UserAddPayloadSchema, UserSchema,
  UserUpdatePayloadSchema,
} from '@dichovsky/testrail-api-client';
import { z } from 'zod';
import {
  createListInput, lookupEmailSchema, payloadInput, positiveIdSchema, strictObject, writeEmailSchema,
} from '../../contracts/inputs.js';
import { driverAllOptions } from '../../contracts/pagination.js';
import { driverCall } from '../driver-call.js';
import { defineOperation, type OperationDefinition } from '../registry.js';
import { allControls, control, pageResponse, recordResponse, safetyControlMappings } from './common.js';

// ------------------------------------------------------------------------ users

const noInput = strictObject({});

export const getCurrentUser = defineOperation({
  token: 'get_current_user',
  method: 'GET',
  route: 'get_current_user',
  family: 'T08',
  driverBinding: 'users.getCurrentUser',
  summary: 'Get the TestRail user whose credentials this server is configured with (TestRail 6.6 or later). Takes no arguments: the identity comes from the configured credentials, not from the call. The reply is a reduced user record, so fields such as group_ids may be absent even on a server that has them.',
  inputSchema: noInput,
  argumentMap: [],
  response: { shape: 'record', outerSchema: recordResponse, entitySchema: UserSchema },
  pagination: {
    kind: 'none',
    single: driverCall(noInput, 'users.getCurrentUser', (method) => method()),
  },
  files: { kind: 'none' },
  effects: { testRail: 'read', destructive: false, idempotent: true },
  retry: 'ordinary-read',
} as const satisfies OperationDefinition);

const getUserInput = strictObject({ user_id: positiveIdSchema });

export const getUser = defineOperation({
  token: 'get_user',
  method: 'GET',
  route: 'get_user/{user_id}',
  family: 'T08',
  driverBinding: 'users.getUser',
  summary: 'Get a single TestRail user. Reading a user other than the configured one requires administrator access, which TestRail enforces.',
  inputSchema: getUserInput,
  argumentMap: [{ input: 'user_id', call: 'single', argument: 0, serialization: 'path' }],
  response: { shape: 'record', outerSchema: recordResponse, entitySchema: UserSchema },
  pagination: {
    kind: 'none',
    single: driverCall(getUserInput, 'users.getUser', (method, input) => method(input.user_id)),
  },
  files: { kind: 'none' },
  effects: { testRail: 'read', destructive: false, idempotent: true },
  retry: 'ordinary-read',
} as const satisfies OperationDefinition);

/*
 * The address is a query parameter rather than a path segment, so it lives under query
 * as every non-path scalar in this server does.
 */
const getUserByEmailInput = strictObject({ query: strictObject({ email: lookupEmailSchema }) });

export const getUserByEmail = defineOperation({
  token: 'get_user_by_email',
  method: 'GET',
  route: 'get_user_by_email',
  family: 'T08',
  driverBinding: 'users.getUserByEmail',
  summary: 'Look a TestRail user up by email address. The address is checked only for shape, one @ with no whitespace, so a single-label or literal domain from a self-hosted, LDAP or SSO instance reaches TestRail rather than being refused here. Note that the user write tools require a stricter, dotted address than this lookup accepts.',
  inputSchema: getUserByEmailInput,
  argumentMap: [{ input: 'query.email', call: 'single', argument: 0, serialization: 'query-scalar' }],
  response: { shape: 'record', outerSchema: recordResponse, entitySchema: UserSchema },
  pagination: {
    kind: 'none',
    single: driverCall(getUserByEmailInput, 'users.getUserByEmail', (method, input) => method(input.query.email)),
  },
  files: { kind: 'none' },
  effects: { testRail: 'read', destructive: false, idempotent: true },
  retry: 'ordinary-read',
} as const satisfies OperationDefinition);

/*
 * The project is optional and changes the endpoint rather than a query parameter:
 * omitted it reads every user, supplied it reads get_users/{project_id}. TestRail
 * requires the project form for non-administrators from 6.6, and narrows what it
 * returns there, so the two forms are not the same list with a filter applied.
 */
const getUsersInput = strictObject({
  query: strictObject({ project_id: positiveIdSchema.optional() }).optional(),
});

export const getUsers = defineOperation({
  token: 'get_users',
  method: 'GET',
  route: 'get_users',
  family: 'T08',
  driverBinding: 'users.getUsers',
  summary: 'List TestRail users. Supplying project_id reads the users with explicit access to that project, which TestRail requires of non-administrators from 6.6; it also omits inactive users, omits users who hold only global access, and reports each role at its project level. Omitting it reads every user and needs administrator access.',
  inputSchema: getUsersInput,
  // Structurally a query input because the route carries no placeholder, but it is sent
  // as a path segment: get_users/{project_id}. The manifest records that encoding.
  argumentMap: [{ input: 'query.project_id', call: 'single', argument: 0, serialization: 'path' }],
  // TestRail documents a bare array here while every sibling list documents an
  // envelope. The driver accepts both and a null collection, and hands back an array.
  response: { shape: 'array', outerSchema: z.array(z.unknown()), entitySchema: UserSchema },
  pagination: {
    kind: 'none',
    single: driverCall(getUsersInput, 'users.getUsers', (method, input) => {
      const project = control(input.query, 'project_id');
      return project === undefined ? method() : method(project);
    }),
  },
  files: { kind: 'none' },
  effects: { testRail: 'read', destructive: false, idempotent: true },
  retry: 'ordinary-read',
} as const satisfies OperationDefinition);

const addUserInput = strictObject({
  body: payloadInput(UserAddPayloadSchema, {
    fields: {
      email: writeEmailSchema,
      role_id: positiveIdSchema.optional(),
      group_ids: z.array(positiveIdSchema).optional(),
      assigned_projects: z.array(positiveIdSchema).optional(),
    },
  }),
});

export const addUser = defineOperation({
  token: 'add_user',
  method: 'POST',
  route: 'add_user',
  family: 'T08',
  driverBinding: 'users.addUser',
  summary: 'Create a TestRail user (TestRail 7.3 or later). body.name and body.email are required, and the address must carry a dotted domain, which is stricter than the lookup tool accepts. TestRail defaults is_active to false, so a new user is created inactive unless the field is sent.',
  inputSchema: addUserInput,
  argumentMap: [{ input: 'body', call: 'single', argument: 0, serialization: 'json-body' }],
  response: { shape: 'record', outerSchema: recordResponse, entitySchema: UserSchema },
  pagination: {
    kind: 'none',
    single: driverCall(addUserInput, 'users.addUser', (method, input) => method(input.body)),
  },
  files: { kind: 'none' },
  // Repeating the call asks TestRail for another user with the same address.
  effects: { testRail: 'write', destructive: false, idempotent: false },
  retry: 'json-write',
} as const satisfies OperationDefinition);

const updateUserInput = strictObject({
  user_id: positiveIdSchema,
  body: payloadInput(UserUpdatePayloadSchema, {
    fields: {
      email: writeEmailSchema.optional(),
      role_id: positiveIdSchema.optional(),
      group_ids: z.array(positiveIdSchema).optional(),
      assigned_projects: z.array(positiveIdSchema).optional(),
    },
  }),
});

export const updateUser = defineOperation({
  token: 'update_user',
  method: 'POST',
  route: 'update_user/{user_id}',
  family: 'T08',
  driverBinding: 'users.updateUser',
  summary: 'Update a TestRail user (TestRail 7.3 or later). Supplied fields replace their current values and the rest are left unchanged. A supplied group_ids or assigned_projects replaces the whole list rather than adding to it, so send the full list you want the user to end up with.',
  inputSchema: updateUserInput,
  argumentMap: [
    { input: 'user_id', call: 'single', argument: 0, serialization: 'path' },
    { input: 'body', call: 'single', argument: 1, serialization: 'json-body' },
  ],
  response: { shape: 'record', outerSchema: recordResponse, entitySchema: UserSchema },
  pagination: {
    kind: 'none',
    single: driverCall(updateUserInput, 'users.updateUser', (method, input) => method(input.user_id, input.body)),
  },
  files: { kind: 'none' },
  // Applying the same field values again leaves the user in the same state.
  effects: { testRail: 'write', destructive: false, idempotent: true },
  retry: 'json-write',
} as const satisfies OperationDefinition);

// ----------------------------------------------------------------------- groups

const getGroupInput = strictObject({ group_id: positiveIdSchema });

export const getGroup = defineOperation({
  token: 'get_group',
  method: 'GET',
  route: 'get_group/{group_id}',
  family: 'T08',
  driverBinding: 'users.getGroup',
  summary: 'Get a single TestRail user group with the IDs of the users in it.',
  inputSchema: getGroupInput,
  argumentMap: [{ input: 'group_id', call: 'single', argument: 0, serialization: 'path' }],
  response: { shape: 'record', outerSchema: recordResponse, entitySchema: GroupSchema },
  pagination: {
    kind: 'none',
    single: driverCall(getGroupInput, 'users.getGroup', (method, input) => method(input.group_id)),
  },
  files: { kind: 'none' },
  effects: { testRail: 'read', destructive: false, idempotent: true },
  retry: 'ordinary-read',
} as const satisfies OperationDefinition);

/*
 * TestRail documents no request controls for this list, so the driver sends none and
 * the server chooses each page. A complete read that stops at one of its safety bounds
 * cannot be resumed from where it stopped; it needs a larger bound instead.
 */
const getGroupsInput = createListInput({ path: {}, pagination: 'response-driven' });

export const getGroups = defineOperation({
  token: 'get_groups',
  method: 'GET',
  route: 'get_groups',
  family: 'T08',
  driverBinding: 'users.getGroups',
  summary: 'List the TestRail user groups of the instance. This endpoint accepts no paging controls, so the server chooses each page; a complete read that stops at one of its bounds cannot be resumed from where it stopped, and needs a larger bound instead.',
  inputSchema: getGroupsInput,
  argumentMap: [...safetyControlMappings(0)],
  response: { shape: 'page', outerSchema: pageResponse, entitySchema: GroupSchema },
  pagination: {
    kind: 'response_driven',
    page: driverCall(getGroupsInput, 'users.getGroupsPage', (method) => method()),
    all: driverCall(getGroupsInput, 'users.getAllGroups',
      (method, input, context) => method(driverAllOptions(allControls(input._mcp), context.limits))),
  },
  files: { kind: 'none' },
  effects: { testRail: 'read', destructive: false, idempotent: true },
  retry: 'ordinary-read',
} as const satisfies OperationDefinition);

const addGroupInput = strictObject({
  body: payloadInput(AddGroupPayloadSchema, { fields: { user_ids: z.array(positiveIdSchema).optional() } }),
});

export const addGroup = defineOperation({
  token: 'add_group',
  method: 'POST',
  route: 'add_group',
  family: 'T08',
  driverBinding: 'users.addGroup',
  summary: 'Create a TestRail user group (TestRail 7.5 or later). body.user_ids lists the users it starts with.',
  inputSchema: addGroupInput,
  argumentMap: [{ input: 'body', call: 'single', argument: 0, serialization: 'json-body' }],
  response: { shape: 'record', outerSchema: recordResponse, entitySchema: GroupSchema },
  pagination: {
    kind: 'none',
    single: driverCall(addGroupInput, 'users.addGroup', (method, input) => method(input.body)),
  },
  files: { kind: 'none' },
  effects: { testRail: 'write', destructive: false, idempotent: false },
  retry: 'json-write',
} as const satisfies OperationDefinition);

/*
 * The body carries the group's own ID as well as the path, which TestRail requires and
 * the driver injects from the path segment. A caller's own group_id would be overwritten
 * rather than sent, so the boundary refuses the field instead of accepting one that
 * cannot take effect.
 */
const updateGroupInput = strictObject({
  group_id: positiveIdSchema,
  body: payloadInput(UpdateGroupPayloadSchema, {
    fields: { user_ids: z.array(positiveIdSchema).optional(), group_id: z.never().optional() },
  }),
});

export const updateGroup = defineOperation({
  token: 'update_group',
  method: 'POST',
  route: 'update_group/{group_id}',
  family: 'T08',
  driverBinding: 'users.updateGroup',
  summary: 'Update a TestRail user group (TestRail 7.5 or later). A supplied body.user_ids replaces the group\'s membership outright: TestRail offers no way to add or remove one member, so send the full list the group should end up with or the users you left out are removed. The group\'s own ID is taken from the path and cannot be sent in the body.',
  inputSchema: updateGroupInput,
  argumentMap: [
    { input: 'group_id', call: 'single', argument: 0, serialization: 'path' },
    { input: 'body', call: 'single', argument: 1, serialization: 'json-body' },
  ],
  response: { shape: 'record', outerSchema: recordResponse, entitySchema: GroupSchema },
  pagination: {
    kind: 'none',
    single: driverCall(updateGroupInput, 'users.updateGroup', (method, input) => method(input.group_id, input.body)),
  },
  files: { kind: 'none' },
  /*
   * Applying the same field values again leaves the group in the same state. It is not
   * marked destructive: replacing a membership list removes an association rather than
   * an entity, which is how this server already treats the label set of a test. The
   * summary carries TestRail's own warning instead.
   */
  effects: { testRail: 'write', destructive: false, idempotent: true },
  retry: 'json-write',
} as const satisfies OperationDefinition);

const deleteGroupInput = strictObject({ group_id: positiveIdSchema });

export const deleteGroup = defineOperation({
  token: 'delete_group',
  method: 'POST',
  route: 'delete_group/{group_id}',
  family: 'T08',
  driverBinding: 'users.deleteGroup',
  summary: 'Delete a TestRail user group. The users in it are not deleted; they simply stop belonging to the group. TestRail returns no group data. Neither TestRail\'s reference nor the driver states a version requirement for this endpoint, unlike the two group writes, so none is claimed here.',
  inputSchema: deleteGroupInput,
  argumentMap: [{ input: 'group_id', call: 'single', argument: 0, serialization: 'path' }],
  response: { shape: 'void', outerSchema: z.undefined(), entitySchema: null },
  pagination: {
    kind: 'none',
    single: driverCall(deleteGroupInput, 'users.deleteGroup', (method, input) => method(input.group_id)),
  },
  files: { kind: 'none' },
  effects: { testRail: 'write', destructive: true, idempotent: false },
  retry: 'json-write',
} as const satisfies OperationDefinition);

// ------------------------------------------------------------------------ roles

const getRolesInput = createListInput({ path: {}, pagination: 'response-driven' });

export const getRoles = defineOperation({
  token: 'get_roles',
  method: 'GET',
  route: 'get_roles',
  family: 'T08',
  driverBinding: 'metadata.getRoles',
  summary: 'List the TestRail user roles of the instance (TestRail 7.3 or later). is_project_admin appears on TestRail Enterprise only. This endpoint accepts no paging controls, so the server chooses each page; a complete read that stops at one of its bounds cannot be resumed from where it stopped, and needs a larger bound instead.',
  inputSchema: getRolesInput,
  argumentMap: [...safetyControlMappings(0)],
  response: { shape: 'page', outerSchema: pageResponse, entitySchema: RoleSchema },
  pagination: {
    kind: 'response_driven',
    page: driverCall(getRolesInput, 'metadata.getRolesPage', (method) => method()),
    all: driverCall(getRolesInput, 'metadata.getAllRoles',
      (method, input, context) => method(driverAllOptions(allControls(input._mcp), context.limits))),
  },
  files: { kind: 'none' },
  effects: { testRail: 'read', destructive: false, idempotent: true },
  retry: 'ordinary-read',
} as const satisfies OperationDefinition);

/** Registered in tool-name order by the registry; listed here in reviewed order. */
export const t08 = [
  getCurrentUser, getUser, getUserByEmail, getUsers, addUser, updateUser,
  getGroup, getGroups, addGroup, updateGroup, deleteGroup,
  getRoles,
] as const;
