import { ProjectSchema } from '@dichovsky/testrail-api-client';
import { z } from 'zod';
import { positiveIdSchema, strictObject } from '../../contracts/inputs.js';
import { driverCall } from '../driver-call.js';
import { defineOperation, type OperationDefinition } from '../registry.js';

/** A usable JSON object response; entity fields are checked advisorily, not here. */
const recordResponse = z.record(z.string(), z.unknown());

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

/** Registered in tool-name order by the registry; listed here in reviewed order. */
export const t01 = [getProject] as const;
