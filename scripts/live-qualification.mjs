#!/usr/bin/env node
/*
 * R03's live qualification: drive every tool of an MCP server against a real TestRail
 * instance and record, per tool, whether it passed, failed, was blocked by a missing
 * licence or permission, or was not run and why.
 *
 * It must not change or delete data that existed before the run:
 * - it creates one qualification project and makes every write inside it, to entities it
 *   created itself. A guard checks each write's target IDs against what the run created
 *   and refuses anything else before the call is made;
 * - reads may read existing data;
 * - writes outside the project (users, groups, case fields) run only with
 *   --instance-writes, meant for a disposable instance; TestRail cannot delete users or
 *   case fields through its API, so those stay behind and the evidence lists them;
 * - reports run only from templates the operator names;
 * - the project is deleted at the end, and again on the way out if the run stops early.
 *
 * The evidence holds statuses, error codes and warning codes, never TestRail data, the
 * address or the credentials, and the runner refuses to write it if any of them appear.
 *
 *   TESTRAIL_BASE_URL=... TESTRAIL_EMAIL=... TESTRAIL_API_KEY=... \
 *   node scripts/live-qualification.mjs --create-qualification-project --out evidence.json \
 *     [--instance-writes] [--report-template-id N] [--cross-project-report-template-id N] \
 *     [--command testrail-mcp] [--arg ...]
 */
import { randomBytes } from 'node:crypto';
import { realpathSync, rmSync } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { NotApplicable, PLAN, QUALIFICATION_PREFIX, UPLOADS } from './live-plan.mjs';

export { PLAN };

export const TOOL_PREFIX = 'testrail_';
/** Codes that mean the instance lacks a licensed feature or the user a permission. */
const BLOCKING = new Set(['LICENSE_REQUIRED', 'PERMISSION_DENIED']);
const REQUIRED_VARIABLES = ['TESTRAIL_BASE_URL', 'TESTRAIL_EMAIL', 'TESTRAIL_API_KEY'];
/** Ctrl-C, a closed terminal, and a polite kill. */
const SIGNALS = ['SIGINT', 'SIGHUP', 'SIGTERM'];

/**
 * The entity kind each argument names. A write may name only entities of that kind the
 * run created. Other IDs a write carries, such as status, priority, type, template, role
 * or user references, choose among the instance's own settings and change nothing. The
 * templates add_case_field's template_ids names are changed, since the field is added to
 * them, and the run creates none, so any it names is refused.
 */
export const TARGET_KINDS = Object.freeze({
  project_id: 'project', project_ids: 'project', assigned_projects: 'project',
  suite_id: 'suite', section_id: 'section', case_id: 'case', case_ids: 'case',
  run_id: 'run', test_id: 'test', test_ids: 'test', result_id: 'result',
  plan_id: 'plan', entry_id: 'entry', milestone_id: 'milestone',
  config_group_id: 'config_group', config_id: 'config', config_ids: 'config',
  label_id: 'label', label_ids: 'label', labels: 'label',
  shared_step_id: 'shared_step', dataset_id: 'dataset', variable_id: 'variable',
  attachment_id: 'attachment', group_id: 'group', group_ids: 'group', user_id: 'user',
  template_ids: 'template',
});

/** The kind a bare `id` names inside each list that holds one, as update_project's access rows do. */
export const ITEM_KINDS = Object.freeze({ groups: 'group', users: 'user' });

// By sound: an entry, an attachment, but a user.
const article = (word) => (/^[aeio]/u.test(word) ? 'an' : 'a');

/** A parent or neighbour is a section in section tools and a milestone in milestone tools. */
function relativeKind(tool) {
  if (/_sections?$/u.test(tool)) return 'section';
  if (/_milestones?$/u.test(tool)) return 'milestone';
  return undefined;
}

export class MissingDependency extends Error {
  constructor(name) {
    super(`needs the ${name} an earlier step did not provide`);
    this.name = 'MissingDependency';
  }
}

export class GuardRefusal extends Error {
  constructor(message) {
    super(message);
    this.name = 'GuardRefusal';
  }
}

/** What the run created, by kind, and what it has deleted since. */
export class Ledger {
  #kinds = new Map();
  #gone = new Set();

  add(kind, id) {
    if (!this.#kinds.has(kind)) this.#kinds.set(kind, new Map());
    this.#kinds.get(kind).set(String(id), id);
  }

  /** Every ID of a kind the run created, deleted or not, as TestRail gave it. */
  ids(kind) {
    return [...(this.#kinds.get(kind)?.values() ?? [])];
  }

  has(kind, id) {
    return this.#kinds.get(kind)?.has(String(id)) ?? false;
  }

  remove(kind, id) {
    this.#gone.add(`${kind}:${String(id)}`);
  }

  isGone(kind, id) {
    return this.#gone.has(`${kind}:${String(id)}`);
  }
}

/** Every entity ID a tool's arguments name, with its kind. */
export function targetsOf(tool, input) {
  const targets = [];
  const relative = relativeKind(tool);
  const visit = (value, key, holder) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key, holder);
      return;
    }
    if (value !== null && typeof value === 'object') {
      for (const [inner, innerValue] of Object.entries(value)) if (inner !== '_mcp') visit(innerValue, inner, key);
      return;
    }
    const kind = key === 'id' ? ITEM_KINDS[holder] : key === 'parent_id' || key === 'after_id' ? relative : TARGET_KINDS[key];
    if (kind === undefined || value === null || value === undefined) return;
    // Labels are named by ID or by title; a title names no existing entity.
    if (key === 'labels' && typeof value === 'string') return;
    targets.push({ key, kind, id: value });
  };
  visit(input, undefined, undefined);
  return targets;
}

/**
 * Refuse a write that names anything the run did not create. A read may name anything,
 * unless later steps use its answer: what it returns, such as a run's tests, can become the
 * run's own, so it must read only what the run created. The refusal names the argument and
 * the kind, never the ID, since it goes into the evidence.
 */
export function guard(step, input, ledger) {
  if (step.scope === 'read' && step.capture === undefined) return;
  const tool = `${TOOL_PREFIX}${step.tool}`;
  for (const { key, kind, id } of targetsOf(tool, input)) {
    if (!ledger.has(kind, id)) {
      const noun = kind.replaceAll('_', ' ');
      throw new GuardRefusal(`${tool}: ${key} names ${article(noun)} ${noun} this run did not create`);
    }
  }
}

/** The runner's view of what each step needs and makes. */
function createContext({ ledger, options, stamp, uploads }) {
  const named = new Map();
  const values = new Map();
  const leftBehind = new Map();
  const short = stamp.slice(-6);
  return {
    named, values, leftBehind,
    own(kind, id, name = kind) {
      ledger.add(kind, id);
      named.set(name, { kind, id });
      return id;
    },
    has(name) {
      const entry = named.get(name);
      return entry !== undefined && !ledger.isGone(entry.kind, entry.id);
    },
    id(name) {
      const entry = named.get(name);
      if (entry === undefined || ledger.isGone(entry.kind, entry.id)) throw new MissingDependency(name);
      return entry.id;
    },
    gone(name) {
      const entry = named.get(name);
      if (entry !== undefined) ledger.remove(entry.kind, entry.id);
    },
    set(name, value) { values.set(name, value); },
    value(name) {
      if (!values.has(name)) throw new MissingDependency(name.replaceAll('_', ' '));
      return values.get(name);
    },
    option(name) {
      if (options[name] === undefined) throw new MissingDependency(name);
      return options[name];
    },
    residue(kind) { leftBehind.set(kind, (leftBehind.get(kind) ?? 0) + 1); },
    name(suffix) { return `${QUALIFICATION_PREFIX} ${stamp} ${suffix}`; },
    short(tag) { return `tmq-${short}-${tag}`; },
    email() { return `testrail-mcp-qualification-${short}@example.invalid`; },
    upload(name) {
      const file = uploads[name];
      if (file === undefined) throw new Error(`no upload named ${name}`);
      return { file_path: file.path, filename: file.filename, content_type: file.content_type };
    },
  };
}

function classify(result) {
  const payload = result.structuredContent ?? {};
  const warnings = (payload.warnings ?? []).map(({ code }) => code).filter((code) => typeof code === 'string');
  if (result.isError !== true) return { status: 'pass', data: payload.data, warnings };
  const code = payload.error?.code ?? 'UNKNOWN';
  const outcome = { status: BLOCKING.has(code) ? 'blocked' : 'fail', code, warnings, message: payload.error?.message, writeOutcome: payload.error?.write_outcome };
  if (payload.error?.http_status !== undefined) outcome.http_status = payload.error.http_status;
  return outcome;
}

/**
 * The server's driver allows 100 TestRail requests a minute and refuses the rest as
 * RATE_LIMITED before sending them, so the run keeps under that pace. A 429, from the
 * driver or from TestRail, means the request was not handled, so it is safe to repeat
 * after the window has moved on.
 */
export const LIVE_PACING = Object.freeze({ minIntervalMs: 700, retryDelayMs: 61_000, attempts: 3 });

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** Call at most once every `minIntervalMs`, and repeat a rate-limited call, and only that, up to `attempts` times. */
export function pacedCaller(call, { minIntervalMs, retryDelayMs, attempts }) {
  let last = 0;
  return async (tool, input) => {
    for (let attempt = 1; ; attempt += 1) {
      const wait = last + minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      last = Date.now();
      const result = await call(tool, input);
      if (result.structuredContent?.error?.code !== 'RATE_LIMITED' || attempt >= attempts) return { result, retries: attempt - 1 };
      await sleep(retryDelayMs);
    }
  };
}

/**
 * Run the plan through `call(tool, input)`, which returns an MCP tool result. Returns one
 * record per step and what cleanup did. `shouldStop` is polled between steps. When a
 * cleanup call cannot reach the server, because the session broke or Ctrl-C stopped the
 * server too, `reconnect` gives a fresh `call` to clean up through.
 */
export async function runQualification({
  call, plan = PLAN, options = {}, stamp, uploads, pacing = LIVE_PACING, onStep = () => undefined, onCleanup = () => undefined,
  shouldStop = () => undefined, reconnect,
}) {
  const invoke = pacedCaller(call, pacing);
  const ledger = new Ledger();
  const c = createContext({ ledger, options, stamp, uploads });
  const steps = [];
  let stopped;
  const record = (step, outcome) => {
    const entry = { tool: `${TOOL_PREFIX}${step.tool}`, label: step.label ?? null, scope: step.scope, ...outcome };
    steps.push(entry);
    onStep(entry);
  };
  const cleanup = { project: 'not_created', group: 'not_created' };
  let verified;
  let residue;
  try {
    for (const step of plan) {
      stopped ??= shouldStop();
      if (stopped !== undefined) {
        record(step, { status: 'not_run', reason: stopped });
        continue;
      }
      if (step.requires !== undefined && !options[step.requires]) {
        record(step, { status: 'not_run', reason: `needs --${step.requires.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)}` });
        continue;
      }
      let input;
      try {
        input = step.input(c);
        guard(step, input, ledger);
      } catch (error) {
        if (error instanceof MissingDependency) record(step, { status: 'blocked', reason: error.message });
        // A refused write is a fault in the plan or an answer it did not expect: a failure.
        else if (error instanceof GuardRefusal) record(step, { status: 'fail', reason: `refused by the guard: ${error.message}` });
        else if (error instanceof NotApplicable) record(step, { status: 'not_run', reason: error.message });
        else throw error;
        continue;
      }
      let result;
      let retries;
      try {
        ({ result, retries } = await invoke(`${TOOL_PREFIX}${step.tool}`, input));
      } catch (error) {
        if (step.unconfirmed !== undefined) c.residue(`possible ${step.unconfirmed}`);
        // Ctrl-C reaches the server too, which ends the call in flight: the step was cut
        // short, not failed.
        const interrupted = shouldStop();
        if (interrupted !== undefined) {
          stopped = interrupted;
          record(step, { status: 'not_run', reason: `${interrupted} during the call` });
          continue;
        }
        // The server or the connection failed, not the tool: nothing further can be trusted.
        stopped = 'the MCP session failed';
        record(step, { status: 'fail', reason: `the call failed: ${error instanceof Error ? error.message : String(error)}` });
        continue;
      }
      const { data, message, writeOutcome, ...classified } = classify(result);
      const outcome = retries > 0 ? { ...classified, retries } : classified;
      // A write that may have reached TestRail may have created what the run cannot delete;
      // one TestRail refused with a 4xx, or never received, did not. A 408 is no refusal: the
      // driver raises one itself when TestRail has not answered in time, and TestRail may
      // still have acted.
      const refused = outcome.http_status !== undefined && outcome.http_status >= 400 && outcome.http_status < 500 && outcome.http_status !== 408;
      if (step.unconfirmed !== undefined && outcome.status !== 'pass' && writeOutcome !== 'not_started' && !refused) c.residue(`possible ${step.unconfirmed}`);
      if (outcome.status === 'pass' && step.capture !== undefined) {
        try {
          step.capture(data, c);
        } catch (error) {
          if (step.unconfirmed !== undefined) c.residue(`possible ${step.unconfirmed}`);
          record(step, { ...outcome, status: 'fail', reason: `unexpected response: ${error instanceof Error ? error.message : String(error)}` });
          continue;
        }
      }
      if (outcome.code === 'AUTHENTICATION_FAILED') stopped = 'TestRail refused the credentials';
      record(step, message === undefined ? outcome : { ...outcome, message });
    }
  } finally {
    // Clean up through the session while it answers; once it cannot, through a fresh one.
    let cleaner = invoke;
    let fresh = false;
    const clean = async (tool, input) => {
      try {
        return (await cleaner(tool, input)).result;
      } catch (error) {
        if (fresh || reconnect === undefined) throw error;
        fresh = true;
        cleaner = pacedCaller(await reconnect(), pacing);
        return (await cleaner(tool, input)).result;
      }
    };
    const deleteAttachments = async () => {
      for (const id of ledger.ids('attachment')) {
        // One the plan already deleted is refused, and the check below decides.
        await clean(`${TOOL_PREFIX}delete_attachment`, { attachment_id: id }).catch(() => undefined);
      }
    };
    // Attachments are stored apart from what they hang on, so a run that stops early deletes
    // each one itself before the project, rather than leaving them to go with it.
    const project = c.named.get('project');
    if (project !== undefined && !ledger.isGone(project.kind, project.id)) await deleteAttachments();
    for (const [kind, tool, key] of [['project', 'delete_project', 'project_id'], ['group', 'delete_group', 'group_id']]) {
      const entry = c.named.get(kind);
      if (entry === undefined) continue;
      if (ledger.isGone(entry.kind, entry.id)) {
        cleanup[kind] = 'deleted';
        continue;
      }
      try {
        const { status } = classify(await clean(`${TOOL_PREFIX}${tool}`, { [key]: entry.id }));
        cleanup[kind] = status === 'pass' ? 'deleted_in_cleanup' : 'left_behind';
      } catch {
        cleanup[kind] = 'left_behind';
      }
    }
    /*
     * Then TestRail is asked for each one again. A deleted ID is answered NOT_FOUND, or 400 as
     * TestRail answers an ID it does not have; any other answer leaves it unverified. An
     * attachment still served is deleted once more and asked for again.
     */
    const state = async (tool, input) => {
      try {
        const { status, code, http_status: httpStatus } = classify(await clean(`${TOOL_PREFIX}${tool}`, input));
        if (status === 'pass') return 'present';
        return code === 'NOT_FOUND' || httpStatus === 400 ? 'gone' : 'unverified';
      } catch {
        return 'unverified';
      }
    };
    verified = { gone: 0, present: 0, unverified: 0 };
    for (const [kind, tool, key] of [['project', 'get_project', 'project_id'], ['group', 'get_group', 'group_id']]) {
      const entry = c.named.get(kind);
      if (entry === undefined) continue;
      const found = await state(tool, { [key]: entry.id });
      verified[found] += 1;
      // One whose deletion failed and that TestRail cannot be asked about is left behind.
      if (found === 'present' || (found === 'unverified' && cleanup[kind] === 'left_behind')) c.residue(kind);
      else if (found === 'unverified') c.residue(`unverified ${kind}`);
    }
    for (const id of ledger.ids('attachment')) {
      let found = await state('get_attachment', { attachment_id: id });
      if (found === 'present') {
        await clean(`${TOOL_PREFIX}delete_attachment`, { attachment_id: id }).catch(() => undefined);
        found = await state('get_attachment', { attachment_id: id });
      }
      verified[found] += 1;
      if (found !== 'gone') c.residue(found === 'present' ? 'attachment' : 'unverified attachment');
    }
    residue = [...c.leftBehind].map(([kind, count]) => ({ kind, count }));
    // Said here, so a run that throws still says what cleanup did.
    onCleanup({ ...cleanup, verified, residue });
  }
  // The signed-in user's address is kept only to prove the evidence does not carry it.
  const personal = [c.values.get('current_user_email')].filter((value) => typeof value === 'string');
  return {
    steps, cleanup: { ...cleanup, verified, residue }, stopped: stopped ?? null, testrailVersion: c.values.get('testrail_version') ?? null, personal,
  };
}

const RANK = ['pass', 'not_run', 'blocked', 'fail'];

/** One status per tool: its worst step, except that a pass outranks steps not run. */
export function toolStatus(steps) {
  const statuses = steps.map(({ status }) => status);
  if (statuses.includes('fail')) return 'fail';
  if (statuses.includes('blocked')) return 'blocked';
  if (statuses.includes('pass')) return 'pass';
  return 'not_run';
}

/** The evidence record: statuses and codes only. */
export function buildEvidence({ run, tools, options, testedOn, server }) {
  const byTool = Object.fromEntries([...tools].sort().map((tool) => {
    const steps = run.steps.filter((step) => step.tool === tool).map(({ label, status, code, http_status: httpStatus, reason, warnings, retries }) => ({
      label, status, ...(code === undefined ? {} : { code }), ...(httpStatus === undefined ? {} : { http_status: httpStatus }),
      ...(reason === undefined ? {} : { reason }), ...(retries === undefined ? {} : { retries }), warnings: warnings ?? [],
    }));
    return [tool, { status: steps.length === 0 ? 'not_run' : toolStatus(steps), steps }];
  }));
  const summary = Object.fromEntries(RANK.map((status) => [status, Object.values(byTool).filter((entry) => entry.status === status).length]));
  return {
    schema_version: 2,
    provenance: 'live_testrail',
    tested_on: testedOn,
    testrail_version: run.testrailVersion,
    server,
    options: {
      instance_writes: options.instanceWrites === true,
      report_template: options.reportTemplateId !== undefined,
      cross_project_report_template: options.crossProjectReportTemplateId !== undefined,
    },
    // Why the run stopped before its end, or null when it ran to the end.
    stopped: run.stopped ?? null,
    summary,
    tools: byTool,
    cleanup: run.cleanup,
  };
}

/**
 * A failed tool, anything left behind that should have been deleted, anything TestRail still
 * serves or could not be asked about after cleanup, or a run cut short is a failed run.
 */
export function exitCode(evidence) {
  const { project, group, verified } = evidence.cleanup;
  const leftBehind = project === 'left_behind' || group === 'left_behind' || verified.present > 0 || verified.unverified > 0;
  return evidence.summary.fail > 0 || leftBehind || evidence.stopped !== null ? 1 : 0;
}

/** Whether `text` names `value` whole, not as part of a longer name: a host `testrail` is not in `testrail_add_case`. */
function namesWhole(text, value) {
  return new RegExp(`(?<![A-Za-z0-9_.-])${value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(?![A-Za-z0-9_-]|\\.[A-Za-z0-9])`, 'u').test(text);
}

/**
 * The evidence must name none of these: the address, the identity, the key or the Basic
 * credential anywhere, and the host as a whole name.
 */
export function assertSanitized(text, { exact = [], whole = [] }) {
  const usable = (secret) => typeof secret === 'string' && secret.length >= 4;
  const found = [...exact.filter((secret) => usable(secret) && text.includes(secret)), ...whole.filter((secret) => usable(secret) && namesWhole(text, secret))];
  if (found.length > 0) throw new Error(`the evidence would carry ${String(found.length)} configured or personal value(s); it was not written`);
}

export function secretsOf(env, extra = []) {
  const exact = [env.TESTRAIL_BASE_URL, env.TESTRAIL_EMAIL, env.TESTRAIL_API_KEY, ...extra];
  const whole = [];
  try {
    const { host, hostname } = new URL(env.TESTRAIL_BASE_URL);
    whole.push(host, hostname);
  } catch {
    // An unusable address is reported by the server itself.
  }
  if (env.TESTRAIL_EMAIL !== undefined && env.TESTRAIL_API_KEY !== undefined) {
    exact.push(Buffer.from(`${env.TESTRAIL_EMAIL}:${env.TESTRAIL_API_KEY}`).toString('base64'));
  }
  return { exact, whole };
}

/** Call a tool over an MCP client session. */
export function mcpCaller(client) {
  return (name, input) => client.callTool({ name, arguments: input }, undefined, { timeout: 130_000 });
}

const USAGE = `Usage: node scripts/live-qualification.mjs --create-qualification-project --out <evidence.json>
  [--instance-writes] [--report-template-id N] [--cross-project-report-template-id N] [--command testrail-mcp] [--arg ...]
Reads TESTRAIL_BASE_URL, TESTRAIL_EMAIL and TESTRAIL_API_KEY from the environment. See docs/live-qualification.md.`;

function positiveInteger(value, flag) {
  if (value === undefined) return undefined;
  if (!/^[1-9]\d*$/u.test(value)) throw new Error(`${flag} must be a positive integer`);
  return Number(value);
}

/** Parse the command line; throws with the usage on anything unusable. */
export function parseOptions(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      'create-qualification-project': { type: 'boolean', default: false },
      out: { type: 'string' },
      'instance-writes': { type: 'boolean', default: false },
      'report-template-id': { type: 'string' },
      'cross-project-report-template-id': { type: 'string' },
      command: { type: 'string' },
      arg: { type: 'string', multiple: true, default: [] },
    },
  });
  if (!values['create-qualification-project']) throw new Error(`The run creates, uses and deletes a TestRail project; pass --create-qualification-project to confirm.\n${USAGE}`);
  if (values.out === undefined || values.out === '') throw new Error(`Name the evidence file with --out.\n${USAGE}`);
  const options = { instanceWrites: values['instance-writes'] };
  const report = positiveInteger(values['report-template-id'], '--report-template-id');
  const crossProject = positiveInteger(values['cross-project-report-template-id'], '--cross-project-report-template-id');
  if (report !== undefined) options.reportTemplateId = report;
  if (crossProject !== undefined) options.crossProjectReportTemplateId = crossProject;
  const server = values.command === undefined
    ? { command: process.execPath, args: [fileURLToPath(new URL('../dist/cli.js', import.meta.url))] }
    : { command: values.command, args: values.arg };
  return { out: values.out, options, server, ownServer: values.command === undefined };
}

/** Write the plan's upload files into a fresh directory. */
export async function prepareUploads(directory) {
  const uploads = {};
  for (const [name, { filename, content_type: contentType, content }] of Object.entries(UPLOADS)) {
    const path = join(directory, filename);
    await writeFile(path, content);
    uploads[name] = { path, filename, content_type: contentType };
  }
  return uploads;
}

export function newStamp(now = new Date()) {
  return `${now.toISOString().replace(/[-:]/gu, '').replace(/\.\d+Z$/u, 'z').toLowerCase()}-${randomBytes(3).toString('hex')}`;
}

/** Refuse, before anything touches TestRail, evidence that could never be written: an --out that is a directory or cannot be written. */
async function checkOut(out) {
  await mkdir(dirname(out), { recursive: true });
  const existing = await stat(out).catch(() => undefined);
  if (existing?.isDirectory() === true) throw new Error(`--out ${out} is a directory; name the evidence file.`);
  try {
    if (existing === undefined) {
      const probe = `${out}.${randomBytes(4).toString('hex')}.tmp`;
      await writeFile(probe, '');
      await rm(probe, { force: true });
    } else {
      // Opened for writing without truncating it, so a refusal leaves the file as it was.
      await (await open(out, 'r+')).close();
    }
  } catch (error) {
    throw new Error(`--out ${out} cannot be written: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

const DRIVER = '@dichovsky/testrail-api-client';

/** The driver installed beside the runner, which the server in this checkout loads; null if it cannot be read. */
async function installedDriverVersion() {
  try {
    const entry = createRequire(import.meta.url).resolve(DRIVER);
    const manifest = JSON.parse(await readFile(join(dirname(dirname(entry)), 'package.json'), 'utf8'));
    return manifest.name === DRIVER && typeof manifest.version === 'string' ? manifest.version : null;
  } catch {
    return null;
  }
}

/**
 * The whole run: check the environment, start the server over stdio, run the plan and
 * write the evidence. `connect` is replaceable so the offline test can drive the same
 * path through the registered tools in-process.
 */
export async function main({
  argv = process.argv.slice(2), env = process.env, connect = connectStdio, pacing = LIVE_PACING, log = (line) => { process.stderr.write(`${line}\n`); },
  signals = process, exit = (code) => process.exit(code),
} = {}) {
  const { out, options, server, ownServer } = parseOptions(argv);
  const missing = REQUIRED_VARIABLES.filter((key) => (env[key] ?? '') === '');
  if (missing.length > 0) throw new Error(`Set ${missing.join(', ')} in the environment; the runner never takes credentials as arguments.`);
  // Before any request: a configured value that the evidence's own words contain would make
  // every run's evidence unwritable, and a finished run is never lost to an unusable --out.
  const tools = new Set(PLAN.map(({ tool }) => `${TOOL_PREFIX}${tool}`));
  const blank = buildEvidence({
    run: {
      steps: PLAN.map((step) => ({ tool: `${TOOL_PREFIX}${step.tool}`, label: step.label ?? null, status: 'not_run', reason: 'interrupted' })),
      cleanup: { project: 'left_behind', group: 'left_behind', verified: { gone: 0, present: 0, unverified: 0 }, residue: [] }, stopped: 'interrupted', testrailVersion: null,
    },
    tools, options, testedOn: '2000-01-01', server: { package_version: null, protocol: null, driver_version: null },
  });
  try {
    assertSanitized(JSON.stringify(blank), secretsOf(env));
  } catch {
    throw new Error('A configured TestRail value appears in the evidence\'s own words, such as its tool names or statuses, so the evidence could not be checked. Nothing was sent to TestRail.');
  }
  await checkOut(out);
  const work = await mkdtemp(join(tmpdir(), 'testrail-mcp-live-'));
  const stamp = newStamp();
  let stop;
  // The first Ctrl-C stops the run after the current step and deletes the project; a second
  // abandons that cleanup, leaves no evidence and exits at once. A closed terminal (SIGHUP)
  // or SIGTERM stops the run the same way.
  const onSignal = () => {
    if (stop === undefined) {
      stop = 'interrupted';
      log('Stopping: the qualification project will be deleted. Press Ctrl-C again to abandon that cleanup.');
      return;
    }
    log(`Cleanup abandoned: anything named "${QUALIFICATION_PREFIX} ${stamp} …" may be left behind, and no evidence was written.`);
    rmSync(work, { recursive: true, force: true });
    exit(2);
  };
  for (const signal of SIGNALS) signals.on(signal, onSignal);
  const sessions = [];
  try {
    const uploadRoot = join(work, 'uploads');
    const downloadDirectory = join(work, 'downloads');
    await Promise.all([uploadRoot, downloadDirectory].map((directory) => mkdir(directory)));
    const uploads = await prepareUploads(uploadRoot);
    const serverEnv = { ...env, TESTRAIL_MCP_UPLOAD_ROOTS: JSON.stringify([uploadRoot]), TESTRAIL_MCP_DOWNLOAD_DIR: downloadDirectory };
    delete serverEnv.NODE_OPTIONS;
    const open = async () => {
      const opened = await connect({ ...server, env: serverEnv });
      sessions.push(opened);
      return opened;
    };
    const session = await open();
    log(`Qualification project: ${QUALIFICATION_PREFIX} ${stamp} project`);
    let run;
    try {
      run = await runQualification({
        call: session.call, options, stamp, uploads, pacing, shouldStop: () => stop,
        reconnect: async () => {
          log('The session to the server has ended; starting a fresh one to clean up.');
          return (await open()).call;
        },
        onStep: ({ tool, label, status, code, reason, message }) => {
          const detail = [code, reason, message].filter((part) => part !== undefined).join(': ');
          log(`${status.padEnd(7)} ${tool}${label === null ? '' : ` (${label})`}${detail === '' ? '' : ` ${detail}`}`);
        },
        // What cleanup did is said before anything else can fail: it names kinds and outcomes only.
        onCleanup: ({ project, group, verified, residue }) => {
          const left = residue.map(({ kind, count }) => `${String(count)} ${kind}`).join(', ');
          const checked = `checked afterwards: ${String(verified.gone)} gone, ${String(verified.present)} still there, ${String(verified.unverified)} unverified`;
          log(`Cleanup: project ${project}, group ${group}; ${checked}${left === '' ? '' : `; left behind: ${left}`}.`);
        },
      });
    } finally {
      await Promise.all(sessions.map(async (opened) => { await opened.close().catch(() => undefined); }));
    }
    const evidence = buildEvidence({
      run,
      tools,
      options,
      testedOn: new Date().toISOString().slice(0, 10),
      server: {
        package_version: session.serverVersion ?? null,
        protocol: session.protocol ?? null,
        // Another server's driver cannot be seen from here; its package version names the release.
        driver_version: ownServer ? await installedDriverVersion() : null,
      },
    });
    const text = `${JSON.stringify(evidence, null, 2)}\n`;
    assertSanitized(text, secretsOf(env, run.personal));
    await writeFile(out, text);
    log(`Evidence written to ${out}: ${Object.entries(evidence.summary).map(([status, count]) => `${String(count)} ${status}`).join(', ')}${evidence.stopped === null ? '' : `; stopped early: ${evidence.stopped}`}.`);
    return evidence;
  } finally {
    for (const signal of SIGNALS) signals.removeListener(signal, onSignal);
    await rm(work, { recursive: true, force: true });
  }
}

/** Start the server's executable and open an MCP session to it; a server that will not start says why. */
export async function connectStdio({ command, args, env }) {
  const { Client } = await import('@modelcontextprotocol/client');
  const { StdioClientTransport } = await import('@modelcontextprotocol/client/stdio');
  const client = new Client({ name: 'testrail-mcp-live-qualification', version: '1.0.0' });
  const transport = new StdioClientTransport({ command, args, env, stderr: 'pipe' });
  // The server's diagnostics name no values; the last few kilobytes are kept to explain a failed start.
  let diagnostics = '';
  transport.stderr?.on('data', (chunk) => { diagnostics = `${diagnostics}${String(chunk)}`.slice(-8_192); });
  try {
    await client.connect(transport);
  } catch (error) {
    const reason = diagnostics.trim().split('\n').at(-1);
    throw new Error(`The server did not start: ${reason === undefined || reason === '' ? (error instanceof Error ? error.message : String(error)) : reason}`, { cause: error });
  }
  return {
    call: mcpCaller(client),
    serverVersion: client.getServerVersion()?.version,
    protocol: client.getNegotiatedProtocolVersion(),
    close: () => client.close(),
  };
}

// Compared through the real path, so a clone under a symlinked directory still runs.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  // Output nobody can read any more, such as through a `| tee` that Ctrl-C stopped too, must
  // not stop the run before it cleans up.
  process.stderr.on('error', () => undefined);
  main().then(
    // A blocked tool is recorded, not failed.
    (evidence) => { process.exitCode = exitCode(evidence); },
    (error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 2; },
  );
}
