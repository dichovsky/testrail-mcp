import { CrossProjectReportSchema, ReportResultSchema, ReportSchema } from '@dichovsky/testrail-api-client';
import { z } from 'zod';
import { positiveIdSchema, strictObject } from '../../contracts/inputs.js';
import { driverCall } from '../driver-call.js';
import { defineOperation, type OperationDefinition } from '../registry.js';
import { recordResponse } from './common.js';

/*
 * Two of these endpoints read report templates and two run them. Running one is a GET
 * that generates a report and may send the email its template is configured to send, so
 * those two are registered with report effects: not read-only, not idempotent, and never
 * retried by this server. The driver's report methods bypass its GET cache and in-flight
 * coalescing, so every call reaches TestRail, and they retry nothing but a rate-limited
 * (429) response, which TestRail rejects before handling. F01 qualified that behaviour and
 * accepted the 429 exemption; the family suite proves it again through the tools.
 *
 * A generation returns URLs TestRail says may not be ready yet. Nothing here polls them or
 * runs the template again to find out, since a second run would be a second report and a
 * second email.
 *
 * TestRail documents the cross-project endpoints as Enterprise only. The driver reports a
 * 403 as a licence restriction only when its message names an Enterprise licence in the
 * phrasing the driver recognises, so an Enterprise refusal worded otherwise arrives as an
 * ordinary permission denial. Both summaries say so rather than promise a distinction the
 * server cannot always draw.
 */

const arrayResponse = z.array(z.unknown());

// ------------------------------------------------------------ single-project

const getReportsInput = strictObject({ project_id: positiveIdSchema });

export const getReports = defineOperation({
  token: 'get_reports',
  method: 'GET',
  route: 'get_reports/{project_id}',
  family: 'T11',
  driverBinding: 'reports.getReports',
  summary: 'List the report templates of a TestRail project that are available to the API: those created with "On-demand via the API" checked, which TestRail shows under API Templates and which testrail_run_report runs by id. A template\'s notify_* fields record whether and to whom running it sends email. TestRail answers 400 for an invalid or unknown project and 403 when the configured user has no access to it.',
  inputSchema: getReportsInput,
  argumentMap: [{ input: 'project_id', call: 'single', argument: 0, serialization: 'path' }],
  response: { shape: 'array', outerSchema: arrayResponse, entitySchema: ReportSchema },
  pagination: {
    kind: 'none',
    single: driverCall(getReportsInput, 'reports.getReports', (method, input) => method(input.project_id)),
  },
  files: { kind: 'none' },
  effects: { testRail: 'read', destructive: false, idempotent: true },
  retry: 'ordinary-read',
} as const satisfies OperationDefinition);

const runReportInput = strictObject({ report_template_id: positiveIdSchema });

export const runReport = defineOperation({
  token: 'run_report',
  method: 'GET',
  route: 'run_report/{report_template_id}',
  family: 'T11',
  driverBinding: 'reports.runReport',
  summary: 'Run a single-project report template, one listed by testrail_get_reports, and return the URLs TestRail gives for the new report: report_url, with report_html and report_pdf. Every call generates a new report, and the template\'s notify settings may email it. TestRail requires 5.7 or later here, and states that a report may not be available immediately after being run, especially on TestRail Server. Neither this server nor its driver retries a run after a network error or a 5xx, since TestRail may already have begun it; the driver re-sends only a rate-limited (429) request, which TestRail rejects before handling. An error after the request was sent leaves the outcome unknown, and running the template again to check could generate and email a second report. TestRail answers 400 for an invalid report template ID and 403 when the configured user has no access to the project.',
  inputSchema: runReportInput,
  argumentMap: [{ input: 'report_template_id', call: 'single', argument: 0, serialization: 'path' }],
  response: { shape: 'record', outerSchema: recordResponse, entitySchema: ReportResultSchema },
  pagination: {
    kind: 'none',
    single: driverCall(runReportInput, 'reports.runReport', (method, input) => method(input.report_template_id)),
  },
  files: { kind: 'none' },
  // Nothing is removed, so it is not destructive; a repeat is a second report and a second email.
  effects: { testRail: 'report', destructive: false, idempotent: false },
  retry: 'never',
} as const satisfies OperationDefinition);

// -------------------------------------------------------------- cross-project

const noInput = strictObject({});

export const getCrossProjectReports = defineOperation({
  token: 'get_cross_project_reports',
  method: 'GET',
  route: 'get_cross_project_reports',
  family: 'T11',
  driverBinding: 'reports.getCrossProjectReports',
  summary: 'List the cross-project report templates available to the API that the configured user can access, which testrail_run_cross_project_report runs by id. A template\'s notify_* fields record whether and to whom running it sends email. TestRail documents this endpoint as Enterprise only and answers 403 on an instance without Enterprise or when the user\'s role does not grant access. Only a refusal whose message names an Enterprise licence or subscription is reported as LICENSE_REQUIRED; any other 403 arrives as PERMISSION_DENIED, which here may still mean the instance lacks Enterprise.',
  inputSchema: noInput,
  argumentMap: [],
  response: { shape: 'array', outerSchema: arrayResponse, entitySchema: CrossProjectReportSchema },
  pagination: {
    kind: 'none',
    single: driverCall(noInput, 'reports.getCrossProjectReports', (method) => method()),
  },
  files: { kind: 'none' },
  effects: { testRail: 'read', destructive: false, idempotent: true },
  retry: 'ordinary-read',
} as const satisfies OperationDefinition);

const runCrossProjectReportInput = strictObject({ report_template_id: positiveIdSchema });

export const runCrossProjectReport = defineOperation({
  token: 'run_cross_project_report',
  method: 'GET',
  route: 'run_cross_project_report/{report_template_id}',
  family: 'T11',
  driverBinding: 'reports.runCrossProjectReport',
  summary: 'Run a cross-project report template, one listed by testrail_get_cross_project_reports, and return the URLs TestRail gives for the new report: report_url, with report_html and report_pdf. TestRail documents this endpoint as Enterprise only. Every call generates a new report, and the template\'s notify settings may email it. TestRail states that a report may not be available immediately after being run, especially on TestRail Server. Neither this server nor its driver retries a run after a network error or a 5xx, since TestRail may already have begun it; the driver re-sends only a rate-limited (429) request, which TestRail rejects before handling. An error after the request was sent leaves the outcome unknown, and running the template again to check could generate and email a second report. TestRail answers 400 for an invalid report template ID and 403 when the configured user has no access to the project.',
  inputSchema: runCrossProjectReportInput,
  argumentMap: [{ input: 'report_template_id', call: 'single', argument: 0, serialization: 'path' }],
  response: { shape: 'record', outerSchema: recordResponse, entitySchema: ReportResultSchema },
  pagination: {
    kind: 'none',
    single: driverCall(runCrossProjectReportInput, 'reports.runCrossProjectReport',
      (method, input) => method(input.report_template_id)),
  },
  files: { kind: 'none' },
  effects: { testRail: 'report', destructive: false, idempotent: false },
  retry: 'never',
} as const satisfies OperationDefinition);

/** Registered in tool-name order by the registry; listed here in reviewed order. */
export const t11 = [getReports, runReport, getCrossProjectReports, runCrossProjectReport] as const;
