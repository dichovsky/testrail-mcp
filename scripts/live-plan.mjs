/*
 * The live qualification plan: every one of the 133 tools, called in an order that builds
 * each entity before it is read, updated, closed or deleted. Hand-authored, like the
 * parameter manifests, and never derived from the registry it qualifies.
 *
 * Each step has a scope:
 * - read: reads, which may read data that existed before the run;
 * - own: writes inside the qualification project the run creates, to entities it created;
 * - instance: writes outside that project. They create entities of their own, and some of
 *   them cannot be removed through the API, so they run only with --instance-writes on a
 *   disposable instance;
 * - report: report generation from a template the operator configured for the test.
 *
 * A step's `input` builds its arguments from the context, and asking the context for an
 * entity an earlier step failed to create blocks the step instead of calling the tool.
 * `capture` records what a step created, which is what the runner's guard lets later
 * writes touch. `unconfirmed` names what a step may have created when the run cannot
 * tell, so the evidence can say it may have been left behind.
 */

/** Names start with this, so an operator can find anything a run left behind. */
export const QUALIFICATION_PREFIX = 'testrail-mcp qualification';

/** A step with nothing to act on in this instance, such as a group read where there are no groups. */
export class NotApplicable extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotApplicable';
  }
}

const TEXT = { filename: 'qualification.txt', content_type: 'text/plain' };
const FEATURE = { filename: 'qualification.feature', content_type: 'text/plain' };

/** The files the plan uploads, keyed by the name steps use. */
export const UPLOADS = {
  text: { ...TEXT, content: 'testrail-mcp live qualification attachment\n' },
  feature: {
    ...FEATURE,
    content: [
      'Feature: testrail-mcp live qualification',
      '',
      '  Scenario: A qualification scenario',
      '    Given a qualification project',
      '    When the server imports this feature',
      '    Then TestRail stores it as a case',
      '',
    ].join('\n'),
  },
};

const ids = (items) => (Array.isArray(items) ? items : []).map((item) => item?.id).filter((id) => id !== undefined && id !== null);

/** A list result's items: the page itself, or the one collection a creating call returns. */
function itemsOf(data, key) {
  if (Array.isArray(data)) return data;
  if (data !== null && typeof data === 'object' && Array.isArray(data[key])) return data[key];
  throw new Error(`the response has no ${key} list`);
}

function idOf(data, key = 'id') {
  const id = data?.[key];
  if (typeof id !== 'number' && typeof id !== 'string') throw new Error(`the response has no ${key}`);
  return id;
}

/** The plan, in order. `c` is the runner's context; see live-qualification.mjs. */
export const PLAN = [
  // Instance metadata and the running user. Reads only.
  { tool: 'get_version', scope: 'read', input: () => ({}), capture: (data, c) => { c.set('testrail_version', idOf(data, 'version')); } },
  {
    tool: 'get_current_user', scope: 'read', input: () => ({}),
    capture: (data, c) => { c.set('current_user', idOf(data)); c.set('current_user_email', idOf(data, 'email')); },
  },
  { tool: 'get_user', scope: 'read', input: (c) => ({ user_id: c.value('current_user') }) },
  { tool: 'get_user_by_email', scope: 'read', input: (c) => ({ query: { email: c.value('current_user_email') } }) },
  { tool: 'get_users', label: 'instance', scope: 'read', input: () => ({}) },
  { tool: 'get_roles', scope: 'read', input: () => ({}) },
  {
    tool: 'get_groups', scope: 'read', input: () => ({}),
    capture: (data, c) => { c.set('existing_group', ids(data)[0] ?? null); },
  },
  {
    tool: 'get_group', label: 'existing group', scope: 'read',
    input: (c) => {
      const group = c.value('existing_group');
      if (group === null) throw new NotApplicable('the instance has no group to read');
      return { group_id: group };
    },
  },
  { tool: 'get_case_fields', scope: 'read', input: () => ({}) },
  { tool: 'get_case_types', scope: 'read', input: () => ({}) },
  { tool: 'get_case_statuses', scope: 'read', input: () => ({}) },
  { tool: 'get_priorities', scope: 'read', input: () => ({}) },
  { tool: 'get_result_fields', scope: 'read', input: () => ({}) },
  {
    tool: 'get_statuses', scope: 'read', input: () => ({}),
    capture: (data, c) => {
      const statuses = itemsOf(data, 'statuses');
      const byName = (name, fallback) => statuses.find((status) => status?.name === name)?.id ?? fallback;
      c.set('passed', byName('passed', 1));
      c.set('failed', byName('failed', 5));
    },
  },
  { tool: 'get_projects', scope: 'read', input: () => ({}) },
  { tool: 'get_cross_project_reports', scope: 'read', input: () => ({}) },

  // The qualification project. Everything the run creates below lives in it.
  {
    tool: 'add_project', scope: 'own', unconfirmed: 'project',
    input: (c) => ({ body: {
      name: c.name('project'),
      announcement: 'Created by the testrail-mcp live qualification and deleted when the run ends.',
      show_announcement: false,
      suite_mode: 3,
    } }),
    capture: (data, c) => { c.own('project', idOf(data)); },
  },
  { tool: 'get_project', scope: 'read', input: (c) => ({ project_id: c.id('project') }) },
  { tool: 'update_project', scope: 'own', input: (c) => ({ project_id: c.id('project'), body: { announcement: 'Updated by the testrail-mcp live qualification.' } }) },
  { tool: 'get_templates', scope: 'read', input: (c) => ({ project_id: c.id('project') }) },
  { tool: 'get_dynamic_filter_fields', scope: 'read', input: (c) => ({ project_id: c.id('project') }) },
  { tool: 'get_users', label: 'project', scope: 'read', input: (c) => ({ query: { project_id: c.id('project') } }) },
  { tool: 'get_reports', scope: 'read', input: (c) => ({ project_id: c.id('project') }) },

  // Suites.
  { tool: 'add_suite', scope: 'own', input: (c) => ({ project_id: c.id('project'), body: { name: 'Suite' } }), capture: (data, c) => { c.own('suite', idOf(data)); } },
  {
    tool: 'add_suite', label: 'to delete', scope: 'own', input: (c) => ({ project_id: c.id('project'), body: { name: 'Suite to delete' } }),
    capture: (data, c) => { c.own('suite', idOf(data), 'suite to delete'); },
  },
  { tool: 'get_suite', scope: 'read', input: (c) => ({ suite_id: c.id('suite') }) },
  { tool: 'get_suites', scope: 'read', input: (c) => ({ project_id: c.id('project') }) },
  { tool: 'update_suite', scope: 'own', input: (c) => ({ suite_id: c.id('suite'), body: { description: 'Updated.' } }) },
  { tool: 'delete_suite', scope: 'own', input: (c) => ({ suite_id: c.id('suite to delete') }) },

  // Sections.
  {
    tool: 'add_section', scope: 'own', input: (c) => ({ project_id: c.id('project'), body: { name: 'Section', suite_id: c.id('suite') } }),
    capture: (data, c) => { c.own('section', idOf(data)); },
  },
  {
    tool: 'add_section', label: 'child', scope: 'own',
    input: (c) => ({ project_id: c.id('project'), body: { name: 'Child section', suite_id: c.id('suite'), parent_id: c.id('section') } }),
    capture: (data, c) => { c.own('section', idOf(data), 'child section'); },
  },
  {
    tool: 'add_section', label: 'target', scope: 'own', input: (c) => ({ project_id: c.id('project'), body: { name: 'Target section', suite_id: c.id('suite') } }),
    capture: (data, c) => { c.own('section', idOf(data), 'target section'); },
  },
  {
    tool: 'add_section', label: 'to delete', scope: 'own', input: (c) => ({ project_id: c.id('project'), body: { name: 'Section to delete', suite_id: c.id('suite') } }),
    capture: (data, c) => { c.own('section', idOf(data), 'section to delete'); },
  },
  { tool: 'get_section', scope: 'read', input: (c) => ({ section_id: c.id('section') }) },
  { tool: 'get_sections', scope: 'read', input: (c) => ({ project_id: c.id('project'), query: { suite_id: c.id('suite') } }) },
  { tool: 'update_section', scope: 'own', input: (c) => ({ section_id: c.id('section'), body: { description: 'Updated.' } }) },
  { tool: 'move_section', scope: 'own', input: (c) => ({ section_id: c.id('child section'), body: { parent_id: c.id('target section') } }) },
  { tool: 'delete_section', scope: 'own', input: (c) => ({ section_id: c.id('section to delete') }) },

  // Milestones.
  { tool: 'add_milestone', scope: 'own', input: (c) => ({ project_id: c.id('project'), body: { name: 'Milestone' } }), capture: (data, c) => { c.own('milestone', idOf(data)); } },
  {
    tool: 'add_milestone', label: 'to delete', scope: 'own',
    input: (c) => ({ project_id: c.id('project'), body: { name: 'Milestone to delete', parent_id: c.id('milestone') } }),
    capture: (data, c) => { c.own('milestone', idOf(data), 'milestone to delete'); },
  },
  { tool: 'get_milestone', scope: 'read', input: (c) => ({ milestone_id: c.id('milestone') }) },
  { tool: 'get_milestones', scope: 'read', input: (c) => ({ project_id: c.id('project') }) },
  { tool: 'update_milestone', scope: 'own', input: (c) => ({ milestone_id: c.id('milestone'), body: { description: 'Updated.' } }) },
  { tool: 'delete_milestone', scope: 'own', input: (c) => ({ milestone_id: c.id('milestone to delete') }) },

  // Labels.
  // TestRail keeps label titles short, so these use brief tags.
  ...[['label', 'l1'], ['label to delete', 'l2'], ['label to bulk delete', 'l3']].map(([name, tag]) => ({
    tool: 'add_label', label: name === 'label' ? undefined : name.replace(/^label /u, ''), scope: 'own',
    input: (c) => ({ project_id: c.id('project'), body: { title: c.short(tag) } }),
    capture: (data, c) => { c.own('label', idOf(data), name); },
  })),
  { tool: 'get_label', scope: 'read', input: (c) => ({ label_id: c.id('label') }) },
  { tool: 'get_labels', scope: 'read', input: (c) => ({ project_id: c.id('project') }) },
  { tool: 'update_label', scope: 'own', input: (c) => ({ label_id: c.id('label'), body: { project_id: c.id('project'), title: c.short('l1u') } }) },
  { tool: 'delete_label', scope: 'own', input: (c) => ({ label_id: c.id('label to delete') }) },
  { tool: 'delete_labels', scope: 'own', input: (c) => ({ body: { label_ids: [c.id('label to bulk delete')] } }) },

  // Cases.
  { tool: 'add_case', scope: 'own', input: (c) => ({ section_id: c.id('section'), body: { title: 'Case one' } }), capture: (data, c) => { c.own('case', idOf(data)); } },
  {
    tool: 'add_case', label: 'second', scope: 'own', input: (c) => ({ section_id: c.id('section'), body: { title: 'Case two' } }),
    capture: (data, c) => { c.own('case', idOf(data), 'second case'); },
  },
  {
    tool: 'add_cases', scope: 'own', input: (c) => ({ section_id: c.id('section'), body: [{ title: 'Case to move' }, { title: 'Case to bulk delete' }] }),
    capture: (data, c) => {
      const [moved, deleted] = ids(itemsOf(data, 'cases'));
      if (moved === undefined || deleted === undefined) throw new Error('the response lists fewer than the two cases added');
      c.own('case', moved, 'case to move');
      c.own('case', deleted, 'case to bulk delete');
    },
  },
  {
    tool: 'add_case', label: 'to delete', scope: 'own', input: (c) => ({ section_id: c.id('section'), body: { title: 'Case to delete' } }),
    capture: (data, c) => { c.own('case', idOf(data), 'case to delete'); },
  },
  { tool: 'get_case', scope: 'read', input: (c) => ({ case_id: c.id('case') }) },
  { tool: 'get_cases', scope: 'read', input: (c) => ({ project_id: c.id('project'), query: { suite_id: c.id('suite') } }) },
  { tool: 'get_case_titles', scope: 'read', input: (c) => ({ query: { case_ids: [c.id('case'), c.id('second case')] } }) },
  { tool: 'update_case', scope: 'own', input: (c) => ({ case_id: c.id('case'), body: { title: 'Case one, updated', labels: [c.id('label')] } }) },
  { tool: 'get_history_for_case', scope: 'read', input: (c) => ({ case_id: c.id('case') }) },
  { tool: 'update_cases', scope: 'own', input: (c) => ({ suite_id: c.id('suite'), body: { case_ids: [c.id('case'), c.id('second case')], estimate: '1m' } }) },
  { tool: 'copy_cases_to_section', scope: 'own', input: (c) => ({ section_id: c.id('target section'), body: { case_ids: [c.id('second case')] } }) },
  {
    tool: 'move_cases_to_section', scope: 'own',
    input: (c) => ({ section_id: c.id('target section'), body: { case_ids: [c.id('case to move')], suite_id: c.id('suite') } }),
  },
  { tool: 'delete_case', scope: 'own', input: (c) => ({ case_id: c.id('case to delete') }) },
  {
    tool: 'delete_cases', scope: 'own',
    input: (c) => ({ suite_id: c.id('suite'), query: { project_id: c.id('project') }, body: { case_ids: [c.id('case to bulk delete')] } }),
  },

  // Shared steps.
  {
    tool: 'add_shared_step', scope: 'own',
    input: (c) => ({ project_id: c.id('project'), body: { title: 'Shared step', custom_steps_separated: [{ content: 'Open the page', expected: 'The page opens' }] } }),
    capture: (data, c) => { c.own('shared_step', idOf(data)); },
  },
  { tool: 'get_shared_step', scope: 'read', input: (c) => ({ shared_step_id: c.id('shared_step') }) },
  { tool: 'get_shared_steps', scope: 'read', input: (c) => ({ project_id: c.id('project') }) },
  { tool: 'update_shared_step', scope: 'own', input: (c) => ({ shared_step_id: c.id('shared_step'), body: { title: 'Shared step, updated' } }) },
  { tool: 'get_shared_step_history', scope: 'read', input: (c) => ({ shared_step_id: c.id('shared_step') }) },
  { tool: 'delete_shared_step', scope: 'own', input: (c) => ({ shared_step_id: c.id('shared_step'), body: { keep_in_cases: false } }) },

  // Variables and datasets.
  {
    tool: 'add_variable', scope: 'own', input: (c) => ({ project_id: c.id('project'), body: { name: 'qualification_variable' } }),
    capture: (data, c) => { c.own('variable', idOf(data)); },
  },
  { tool: 'get_variables', scope: 'read', input: (c) => ({ project_id: c.id('project') }) },
  {
    tool: 'add_dataset', scope: 'own',
    input: (c) => ({ project_id: c.id('project'), body: { name: 'Qualification dataset', variables: { qualification_variable: 'one' } } }),
    capture: (data, c) => { c.own('dataset', idOf(data)); },
  },
  { tool: 'get_dataset', scope: 'read', input: (c) => ({ dataset_id: c.id('dataset') }) },
  { tool: 'get_datasets', scope: 'read', input: (c) => ({ project_id: c.id('project') }) },
  { tool: 'update_dataset', scope: 'own', input: (c) => ({ dataset_id: c.id('dataset'), body: { name: 'Qualification dataset, updated' } }) },
  { tool: 'update_variable', scope: 'own', input: (c) => ({ variable_id: c.id('variable'), body: { name: 'qualification_variable_updated' } }) },
  { tool: 'delete_dataset', scope: 'own', input: (c) => ({ dataset_id: c.id('dataset') }) },
  { tool: 'delete_variable', scope: 'own', input: (c) => ({ variable_id: c.id('variable') }) },

  // Configurations.
  {
    tool: 'add_config_group', scope: 'own', input: (c) => ({ project_id: c.id('project'), body: { name: 'Browsers' } }),
    capture: (data, c) => { c.own('config_group', idOf(data)); },
  },
  ...['Chrome', 'Firefox'].map((name) => ({
    tool: 'add_config', label: name, scope: 'own', input: (c) => ({ config_group_id: c.id('config_group'), body: { name } }),
    capture: (data, c) => { c.own('config', idOf(data), name); },
  })),
  { tool: 'get_configs', scope: 'read', input: (c) => ({ project_id: c.id('project') }) },
  { tool: 'update_config_group', scope: 'own', input: (c) => ({ config_group_id: c.id('config_group'), body: { name: 'Web browsers' } }) },
  { tool: 'update_config', scope: 'own', input: (c) => ({ config_id: c.id('Chrome'), body: { name: 'Chromium' } }) },
  {
    tool: 'add_config_group', label: 'to delete', scope: 'own', input: (c) => ({ project_id: c.id('project'), body: { name: 'Config group to delete' } }),
    capture: (data, c) => { c.own('config_group', idOf(data), 'config group to delete'); },
  },
  {
    tool: 'add_config', label: 'to delete', scope: 'own', input: (c) => ({ config_group_id: c.id('config group to delete'), body: { name: 'Config to delete' } }),
    capture: (data, c) => { c.own('config', idOf(data), 'config to delete'); },
  },
  { tool: 'delete_config', scope: 'own', input: (c) => ({ config_id: c.id('config to delete') }) },
  { tool: 'delete_config_group', scope: 'own', input: (c) => ({ config_group_id: c.id('config group to delete') }) },

  // BDD.
  { tool: 'add_bdd', scope: 'own', input: (c) => ({ section_id: c.id('section'), ...c.upload('feature') }), capture: (data, c) => { c.own('case', idOf(data), 'bdd case'); } },
  { tool: 'get_bdd', scope: 'read', input: (c) => ({ case_id: c.id('bdd case') }) },
  { tool: 'get_bdds', scope: 'read', input: (c) => ({ project_id: c.id('project'), query: { suite_id: c.id('suite') } }) },
  { tool: 'update_bdd', scope: 'own', input: (c) => ({ case_id: c.id('bdd case'), ...c.upload('feature') }) },

  // A run, its tests and their results.
  {
    tool: 'add_run', scope: 'own',
    input: (c) => ({ project_id: c.id('project'), body: {
      name: 'Run', suite_id: c.id('suite'), milestone_id: c.id('milestone'), include_all: false, case_ids: [c.id('case'), c.id('second case')],
    } }),
    capture: (data, c) => { c.own('run', idOf(data)); },
  },
  { tool: 'get_run', scope: 'read', input: (c) => ({ run_id: c.id('run') }) },
  { tool: 'get_runs', scope: 'read', input: (c) => ({ project_id: c.id('project') }) },
  { tool: 'update_run', scope: 'own', input: (c) => ({ run_id: c.id('run'), body: { description: 'Updated.' } }) },
  {
    tool: 'get_tests', scope: 'read', input: (c) => ({ run_id: c.id('run'), _mcp: { pagination: 'all' } }),
    capture: (data, c) => {
      // The run's tests are the run's own: TestRail created them from the run's cases.
      const tests = itemsOf(data, 'tests');
      const first = tests.find((test) => String(test?.case_id) === String(c.id('case'))) ?? tests[0];
      const second = tests.find((test) => String(test?.case_id) === String(c.id('second case')) && test !== first)
        ?? tests.find((test) => test !== first);
      if (first === undefined || second === undefined) throw new Error('the run lists fewer than its two tests');
      c.own('test', idOf(first));
      c.own('test', idOf(second), 'second test');
    },
  },
  { tool: 'get_test', scope: 'read', input: (c) => ({ test_id: c.id('test') }) },
  { tool: 'update_test', scope: 'own', input: (c) => ({ test_id: c.id('test'), body: { labels: [c.id('label')] } }) },
  { tool: 'update_tests', scope: 'own', input: (c) => ({ body: { test_ids: [c.id('test'), c.id('second test')], labels: [c.id('label')] } }) },
  {
    tool: 'add_result', scope: 'own', input: (c) => ({ test_id: c.id('test'), body: { status_id: c.value('failed'), comment: 'Qualification result.' } }),
    capture: (data, c) => { c.own('result', idOf(data)); },
  },
  {
    tool: 'add_result_for_case', scope: 'own',
    input: (c) => ({ run_id: c.id('run'), case_id: c.id('case'), body: { status_id: c.value('passed'), comment: 'Qualification result for the case.' } }),
    capture: (data, c) => { c.own('result', idOf(data), 'result for case'); },
  },
  {
    tool: 'add_results', scope: 'own',
    input: (c) => ({ run_id: c.id('run'), body: { results: [{ test_id: c.id('second test'), status_id: c.value('passed') }] } }),
    capture: (data, c) => { for (const id of ids(itemsOf(data, 'results'))) c.own('result', id, `result ${String(id)}`); },
  },
  {
    tool: 'add_results_for_cases', scope: 'own',
    input: (c) => ({ run_id: c.id('run'), body: { results: [{ case_id: c.id('second case'), status_id: c.value('passed') }] } }),
    capture: (data, c) => { for (const id of ids(itemsOf(data, 'results'))) c.own('result', id, `result ${String(id)}`); },
  },
  { tool: 'get_results', scope: 'read', input: (c) => ({ test_id: c.id('test') }) },
  { tool: 'get_results_for_case', scope: 'read', input: (c) => ({ run_id: c.id('run'), case_id: c.id('case') }) },
  { tool: 'get_results_for_run', scope: 'read', input: (c) => ({ run_id: c.id('run') }) },
  { tool: 'edit_result', scope: 'own', input: (c) => ({ result_id: c.id('result'), body: { comment: 'Qualification result, edited.' } }) },

  // Attachments on the case, run and result.
  {
    tool: 'add_attachment_to_case', scope: 'own', unconfirmed: 'attachment', input: (c) => ({ case_id: c.id('case'), ...c.upload('text') }),
    capture: (data, c) => { c.own('attachment', idOf(data, 'attachment_id')); },
  },
  {
    tool: 'add_attachment_to_run', scope: 'own', unconfirmed: 'attachment', input: (c) => ({ run_id: c.id('run'), ...c.upload('text') }),
    capture: (data, c) => { c.own('attachment', idOf(data, 'attachment_id'), 'run attachment'); },
  },
  {
    tool: 'add_attachment_to_result', scope: 'own', unconfirmed: 'attachment', input: (c) => ({ result_id: c.id('result'), ...c.upload('text') }),
    capture: (data, c) => { c.own('attachment', idOf(data, 'attachment_id'), 'result attachment'); },
  },
  { tool: 'get_attachments_for_case', scope: 'read', input: (c) => ({ case_id: c.id('case') }) },
  { tool: 'get_attachments_for_run', scope: 'read', input: (c) => ({ run_id: c.id('run') }) },
  { tool: 'get_attachments_for_test', scope: 'read', input: (c) => ({ test_id: c.id('test') }) },
  { tool: 'get_attachment', scope: 'read', input: (c) => ({ attachment_id: c.id('attachment') }) },
  { tool: 'delete_attachment', label: 'run attachment', scope: 'own', input: (c) => ({ attachment_id: c.id('run attachment') }) },

  // A plan with configured entries.
  {
    tool: 'add_plan', scope: 'own', input: (c) => ({ project_id: c.id('project'), body: { name: 'Plan', milestone_id: c.id('milestone') } }),
    capture: (data, c) => { c.own('plan', idOf(data)); },
  },
  {
    tool: 'add_plan_entry', scope: 'own',
    input: (c) => ({ plan_id: c.id('plan'), body: {
      suite_id: c.id('suite'), name: 'Entry', include_all: false, case_ids: [c.id('case'), c.id('second case')],
      config_ids: [c.id('Chrome'), c.id('Firefox')],
      runs: [{ include_all: false, case_ids: [c.id('case')], config_ids: [c.id('Chrome')] }],
    } }),
    capture: (data, c) => {
      c.own('entry', idOf(data));
      const [run] = ids(data?.runs);
      if (run === undefined) throw new Error('the entry lists no run');
      c.own('run', run, 'plan run');
    },
  },
  {
    tool: 'add_run_to_plan_entry', scope: 'own',
    input: (c) => ({ plan_id: c.id('plan'), entry_id: c.id('entry'), body: { config_ids: [c.id('Firefox')], include_all: false, case_ids: [c.id('second case')] } }),
    capture: (data, c) => {
      // TestRail answers with the new run, or with the entry that now holds it.
      const run = Array.isArray(data?.runs) ? ids(data.runs).find((id) => String(id) !== String(c.id('plan run'))) : idOf(data);
      if (run === undefined) throw new Error('the response names no new run');
      c.own('run', run, 'second plan run');
    },
  },
  { tool: 'update_plan_entry', scope: 'own', input: (c) => ({ plan_id: c.id('plan'), entry_id: c.id('entry'), body: { description: 'Updated.' } }) },
  { tool: 'update_run_in_plan_entry', scope: 'own', input: (c) => ({ run_id: c.id('plan run'), body: { description: 'Updated.' } }) },
  {
    tool: 'add_attachment_to_plan', scope: 'own', unconfirmed: 'attachment', input: (c) => ({ plan_id: c.id('plan'), ...c.upload('text') }),
    capture: (data, c) => { c.own('attachment', idOf(data, 'attachment_id'), 'plan attachment'); },
  },
  {
    tool: 'add_attachment_to_plan_entry', scope: 'own', unconfirmed: 'attachment', input: (c) => ({ plan_id: c.id('plan'), entry_id: c.id('entry'), ...c.upload('text') }),
    capture: (data, c) => { c.own('attachment', idOf(data, 'attachment_id'), 'entry attachment'); },
  },
  { tool: 'get_attachments_for_plan', scope: 'read', input: (c) => ({ plan_id: c.id('plan') }) },
  { tool: 'get_attachments_for_plan_entry', scope: 'read', input: (c) => ({ plan_id: c.id('plan'), entry_id: c.id('entry') }) },
  { tool: 'get_plan', scope: 'read', input: (c) => ({ plan_id: c.id('plan') }) },
  { tool: 'get_plans', scope: 'read', input: (c) => ({ project_id: c.id('project') }) },
  { tool: 'update_plan', scope: 'own', input: (c) => ({ plan_id: c.id('plan'), body: { description: 'Updated.' } }) },
  { tool: 'delete_run_from_plan_entry', scope: 'own', input: (c) => ({ run_id: c.id('second plan run') }) },
  {
    tool: 'add_plan_entry', label: 'to delete', scope: 'own', input: (c) => ({ plan_id: c.id('plan'), body: { suite_id: c.id('suite'), name: 'Entry to delete' } }),
    capture: (data, c) => { c.own('entry', idOf(data), 'entry to delete'); },
  },
  { tool: 'delete_plan_entry', scope: 'own', input: (c) => ({ plan_id: c.id('plan'), entry_id: c.id('entry to delete') }) },
  { tool: 'close_plan', scope: 'own', input: (c) => ({ plan_id: c.id('plan') }) },
  {
    tool: 'add_plan', label: 'to delete', scope: 'own', input: (c) => ({ project_id: c.id('project'), body: { name: 'Plan to delete' } }),
    capture: (data, c) => { c.own('plan', idOf(data), 'plan to delete'); },
  },
  { tool: 'delete_plan', scope: 'own', input: (c) => ({ plan_id: c.id('plan to delete') }) },

  // Closing and deleting runs.
  { tool: 'close_run', scope: 'own', input: (c) => ({ run_id: c.id('run') }) },
  {
    tool: 'add_run', label: 'to delete', scope: 'own', input: (c) => ({ project_id: c.id('project'), body: { name: 'Run to delete', suite_id: c.id('suite') } }),
    capture: (data, c) => { c.own('run', idOf(data), 'run to delete'); },
  },
  { tool: 'delete_run', scope: 'own', input: (c) => ({ run_id: c.id('run to delete') }) },

  // Reports, only from templates the operator configured for the test. TestRail's API cannot
  // delete a generated report, so each one is left behind for the operator to delete.
  {
    tool: 'run_report', scope: 'report', requires: 'reportTemplateId', unconfirmed: 'generated report',
    input: (c) => ({ report_template_id: c.option('reportTemplateId') }), capture: (_data, c) => { c.residue('generated report'); },
  },
  {
    tool: 'run_cross_project_report', scope: 'report', requires: 'crossProjectReportTemplateId', unconfirmed: 'generated cross-project report',
    input: (c) => ({ report_template_id: c.option('crossProjectReportTemplateId') }), capture: (_data, c) => { c.residue('generated cross-project report'); },
  },

  // Writes outside the project: a disposable instance only.
  {
    tool: 'add_group', scope: 'instance', requires: 'instanceWrites', unconfirmed: 'group', input: (c) => ({ body: { name: c.name('group'), user_ids: [c.value('current_user')] } }),
    capture: (data, c) => { c.own('group', idOf(data)); },
  },
  { tool: 'get_group', label: 'own group', scope: 'read', requires: 'instanceWrites', input: (c) => ({ group_id: c.id('group') }) },
  { tool: 'update_group', scope: 'instance', requires: 'instanceWrites', input: (c) => ({ group_id: c.id('group'), body: { name: c.name('group, updated') } }) },
  { tool: 'delete_group', scope: 'instance', requires: 'instanceWrites', input: (c) => ({ group_id: c.id('group') }), capture: (_data, c) => { c.gone('group'); } },
  {
    tool: 'add_user', scope: 'instance', requires: 'instanceWrites', unconfirmed: 'user',
    input: (c) => ({ body: { name: c.name('user'), email: c.email(), is_active: false, email_notifications: false } }),
    capture: (data, c) => {
      const id = idOf(data);
      c.residue('user');
      c.own('user', id);
    },
  },
  { tool: 'update_user', scope: 'instance', requires: 'instanceWrites', input: (c) => ({ user_id: c.id('user'), body: { name: c.name('user, updated') } }) },
  {
    tool: 'add_case_field', scope: 'instance', requires: 'instanceWrites', unconfirmed: 'case_field',
    input: (c) => ({ body: {
      type: 'String', name: c.short('f').replaceAll('-', '_'), label: c.name('field'), include_all: false,
      configs: [{ context: { is_global: false, project_ids: [c.id('project')] }, options: { is_required: false } }],
    } }),
    capture: (_data, c) => { c.residue('case_field'); },
  },

  // Each remaining attachment is deleted itself: attachments are stored apart from what they
  // hang on, so they are not left to go with the project.
  ...[['case attachment', 'attachment'], ['result attachment'], ['plan attachment'], ['entry attachment']].map(([label, name = label]) => ({
    tool: 'delete_attachment', label, scope: 'own',
    input: (c) => {
      if (!c.has(name)) throw new NotApplicable(`no ${label} was made`);
      return { attachment_id: c.id(name) };
    },
  })),

  // Last, the project itself, and everything still in it.
  { tool: 'delete_project', scope: 'own', input: (c) => ({ project_id: c.id('project') }), capture: (_data, c) => { c.gone('project'); } },
];
