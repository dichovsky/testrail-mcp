import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TestRailClient, TestRailValidationError } from '@dichovsky/testrail-api-client';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  aggregateLimitDefaults, caseIdsSchema, entryIdSchema, idFilterSchema, nonnegativeIntegerSchema, positiveIdSchema,
} from '../src/contracts/inputs.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/server/validators/ajv';
import { auditDomainLibrary, loadDomainLibrary, type ParameterDomain } from './contracts/domains.js';
import { loadParameterManifests, type ParameterManifest } from './contracts/parameter-manifest.js';
import { materializeFiles, substituteTokens } from './contracts/uploads.js';

const library = await loadDomainLibrary();

/** Count upstream requests so "rejected before dispatch" is observed, not assumed. */
function probeClient(): { client: TestRailClient; requests: () => number } {
  let requests = 0;
  const client = new TestRailClient({
    baseUrl: 'https://domains.testrail.io', email: 'user@example.com', apiKey: 'synthetic',
    registerProcessHandlers: false, maxRetries: 0,
    dnsLookup: () => Promise.resolve([{ address: '203.0.113.10', family: 4 }]),
    fetch: () => {
      requests += 1;
      return Promise.resolve(new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }));
    },
  });
  return { client, requests: () => requests };
}

/** Call the domain's declared public probe with `value` in the position it governs. */
async function probe(client: TestRailClient, binding: string, value: unknown): Promise<void> {
  switch (binding) {
    case 'projects.getProject':
      await client.projects.getProject(value as number);
      return;
    case 'projects.getProjectsPage':
      await client.projects.getProjectsPage(value as { limit?: number; offset?: number });
      return;
    case 'projects.getAllProjects':
      await client.projects.getAllProjects(value as { pageSize?: number; maxItems?: number });
      return;
    case 'cases.getCasesPage':
      await client.cases.getCasesPage(7, value as { typeId?: number; createdAfter?: number });
      return;
    case 'cases.getCaseTitles':
      await client.cases.getCaseTitles(value as number[]);
      return;
    case 'attachments.getAttachmentsForPlanEntry':
      await client.attachments.getAttachmentsForPlanEntry(1, value as string);
      return;
    default:
      throw new Error(`No probe harness for binding ${binding}`);
  }
}

/** Controls are carried in an options object under the driver's name; an identifier is positional. */
const optionNames: Readonly<Record<string, string>> = {
  pagination_limit: 'limit',
  pagination_offset: 'offset',
  aggregate_page_size: 'pageSize',
  aggregate_start_offset: 'startOffset',
  aggregate_max_items: 'maxItems',
  aggregate_max_pages: 'maxPages',
  aggregate_max_bytes: 'maxBytes',
  aggregate_max_duration_ms: 'maxDurationMs',
  id_filter: 'typeId',
  unix_timestamp: 'createdAfter',
};

function positioned(name: string, value: unknown): unknown {
  const option = optionNames[name];
  return option === undefined ? value : { [option]: value };
}

/** The adapter schema each domain claims to describe. */
const adapterSchema: Readonly<Record<string, z.ZodType>> = {
  positive_id: positiveIdSchema,
  pagination_limit: positiveIdSchema.max(250),
  pagination_offset: nonnegativeIntegerSchema,
  aggregate_page_size: positiveIdSchema.max(250),
  aggregate_start_offset: nonnegativeIntegerSchema,
  aggregate_max_items: positiveIdSchema.max(aggregateLimitDefaults.max_items),
  aggregate_max_pages: positiveIdSchema.max(aggregateLimitDefaults.max_pages),
  aggregate_max_bytes: positiveIdSchema.max(aggregateLimitDefaults.max_bytes),
  aggregate_max_duration_ms: positiveIdSchema.max(aggregateLimitDefaults.max_duration_ms),
  id_filter: idFilterSchema,
  unix_timestamp: nonnegativeIntegerSchema,
  case_ids: caseIdsSchema,
  entry_id: entryIdSchema,
};

describe('shared parameter domains', () => {
  it('is internally consistent', () => {
    expect(auditDomainLibrary(library)).toEqual([]);
  });

  it('records the driver release it was reviewed against', () => {
    expect(library.review.driver_version).toBe('7.2.0');
    expect(library.review.driver_commit).toBe('cc7751c01c3d3956d061073283bee6b23bf33422');
  });

  const entries = Object.entries(library.domains);

  /*
   * The point of these cases. A shared domain reused by many parameters is only safe
   * if it is evidence rather than a claim: one wrong entry would otherwise weaken every
   * parameter referencing it at once. The package does not export its validators, and
   * the contracts forbid importing internals, so each value is driven through the
   * public method the domain names.
   */
  it.each(entries)('proves %s rejections against the driver', async (name, domain: ParameterDomain) => {
    for (const invalid of domain.invalid) {
      const { client, requests } = probeClient();
      try {
        const attempt = probe(client, domain.probe.binding, positioned(name, invalid.value));
        if (invalid.rejected_by === 'adapter') {
          // The driver accepts it; only the MCP boundary refuses. Asserting this keeps
          // the library from overstating where the guarantee comes from.
          await attempt;
        } else {
          const error: unknown = await attempt.then(() => undefined, (reason: unknown) => reason);
          expect(error, `${name}/${invalid.id} was accepted`).toBeInstanceOf(Error);
          // Which kind of refusal it is matters: a stated check is a contract, while an
          // unguarded crash merely happens to stop the call today. The label is asserted
          // both ways, so a driver that starts or stops validating fails this test rather
          // than quietly leaving the library overstating its evidence.
          expect(error instanceof TestRailValidationError, `${name}/${invalid.id} rejected_by`)
            .toBe(invalid.rejected_by === 'driver');
          // Refused before dispatch, not merely surfaced as an upstream failure.
          expect(requests(), `${name}/${invalid.id} issued a request`).toBe(0);
        }
      } finally { client.destroy(); }
    }
  });

  it.each(entries)('proves %s acceptances against the driver', async (name, domain: ParameterDomain) => {
    for (const valid of domain.valid) {
      const { client, requests } = probeClient();
      try {
        await probe(client, domain.probe.binding, positioned(name, valid.value));
        expect(requests(), `${name}/${valid.id}`).toBe(1);
      } finally { client.destroy(); }
    }
  });

  /*
   * A domain's `domain` field is the only machine-readable statement of its shape, and
   * it is copied onto every parameter that references the domain. Left unexecuted it is
   * a claim rather than a check: the T06 review corrupted this library's UUID pattern to
   * `^[0-9]+$`, which contradicts every value beside it, and the whole suite stayed
   * green. Running it against the domain's own values costs nothing and means a declared
   * shape that drifts from the values it describes cannot pass.
   */
  it.each(entries)('executes the declared JSON Schema for %s', (name, domain: ParameterDomain) => {
    const validate = new AjvJsonSchemaValidator().getValidator(domain.domain);
    for (const valid of domain.valid) {
      expect(validate(valid.value).valid, `${name}/${valid.id}`).toBe(true);
    }
    for (const invalid of domain.invalid) {
      expect(validate(invalid.value).valid, `${name}/${invalid.id}`).toBe(false);
    }
  });

  it.each(entries)('agrees with the adapter schema for %s', (name, domain: ParameterDomain) => {
    const schema = adapterSchema[name];
    if (schema === undefined) throw new Error(`No adapter schema mapped for ${name}`);
    for (const valid of domain.valid) {
      expect(schema.safeParse(valid.value).success, `${name}/${valid.id}`).toBe(true);
    }
    for (const invalid of domain.invalid) {
      // Every invalid value is refused at the boundary, whichever layer would also
      // refuse it downstream.
      expect(schema.safeParse(invalid.value).success, `${name}/${invalid.id}`).toBe(false);
    }
  });
});

type Parameter = ParameterManifest['parameters'][number];
type Label = ParameterDomain['invalid'][number]['rejected_by'];

/** Every place a manifest uses a shared domain, with the accepted case it is driven from. */
const references = (await loadParameterManifests()).flatMap((manifest) => manifest.parameters
  .filter((parameter) => parameter.domain_ref !== undefined)
  .map((parameter) => {
    const baseline = manifest.cases.find(({ id }) => id === (parameter.baseline ?? manifest.baseline));
    if (baseline?.expect.kind !== 'accepted') throw new Error(`${manifest.endpoint.tool}: ${parameter.id} has no accepted baseline`);
    return { label: `${manifest.endpoint.tool} ${parameter.id}`, manifest, parameter, expected: baseline.expect };
  }));

/** The label a reference claims for one invalid value: its own override, else the domain's. */
function claimedLabel(parameter: Parameter, invalid: ParameterDomain['invalid'][number]): Label {
  const override = parameter.rejected_by;
  if (override === undefined) return invalid.rejected_by;
  return override === 'adapter' ? 'adapter' : override[invalid.id] ?? invalid.rejected_by;
}

/**
 * The baseline's literal driver arguments with one value put where the manifest says
 * the parameter lands. A path through an array names its first member, as a derived
 * rejection does, so every other member stays valid.
 */
function placed(args: readonly unknown[], destination: NonNullable<Parameter['driver']>, value: unknown): unknown[] {
  const copy = structuredClone([...args]);
  const { argument, path } = destination;
  if (path.length === 0) {
    copy[argument] = value;
    return copy;
  }
  let node: unknown = copy[argument];
  for (const part of path.slice(0, -1)) {
    node = part === '*' ? (node as unknown[])[0] : (node as Record<string, unknown>)[part];
  }
  (node as Record<string, unknown>)[path.at(-1) ?? ''] = value;
  return copy;
}

/**
 * What the pinned driver does with the value at this reference: refuses it with its own
 * validation error or by crashing, in either case before any request, or lets it reach
 * the wire, which leaves the refusal to the adapter. The upstream reply is the
 * baseline's own, so an accepted value can complete the call it was made for, and
 * `completed` says whether it did.
 */
async function observe(
  reference: (typeof references)[number], paths: Readonly<Record<string, string>>, value: unknown,
): Promise<{ label: Label; completed: boolean }> {
  const { expected, parameter } = reference;
  if (parameter.driver === null) throw new Error(`${reference.label} has no driver location`);
  let requests = 0;
  const reply = expected.upstream_response;
  const client = new TestRailClient({
    baseUrl: 'https://domains.testrail.io', email: 'user@example.com', apiKey: 'synthetic',
    registerProcessHandlers: false, maxRetries: 0, enableCache: false,
    dnsLookup: () => Promise.resolve([{ address: '203.0.113.10', family: 4 }]),
    fetch: (input) => {
      requests += 1;
      /*
       * A paged reply echoes the offset it was asked for, as TestRail's does (case history
       * wraps its envelope in a one-element array), so a start
       * offset under test gets a reply the driver can accept rather than the baseline's.
       */
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const offset = /[?&]offset=(\d+)/u.exec(url)?.[1];
      const echo = (envelope: unknown): unknown => offset !== undefined && typeof envelope === 'object' && envelope !== null
        && !Array.isArray(envelope) && typeof (envelope as { offset?: unknown }).offset === 'number'
        ? { ...envelope, offset: Number(offset) } : envelope;
      // Case history arrives as its envelope inside a one-element array.
      const body = reply.kind !== 'json' ? undefined
        : Array.isArray(reply.body) && reply.body.length === 1 ? [echo(reply.body[0])] : echo(reply.body);
      return Promise.resolve(reply.kind === 'json'
        ? new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
        : new Response(reply.kind === 'text' ? reply.text : reply.utf8, {
          headers: { 'content-type': reply.kind === 'text' ? 'text/plain' : 'application/octet-stream' },
        }));
    },
  });
  try {
    const [group, name] = expected.driver.binding.split('.');
    const module: unknown = Reflect.get(client, group ?? '');
    const method: unknown = typeof module === 'object' && module !== null ? Reflect.get(module, name ?? '') : undefined;
    if (typeof method !== 'function') throw new Error(`${reference.label}: no public driver method ${expected.driver.binding}`);
    const args = placed(substituteTokens(expected.driver.arguments, paths), parameter.driver, value);
    // Called inside an async function, so a synchronous throw is observed as a refusal too.
    const error: unknown = await (async () => { await Reflect.apply(method, module, args); })()
      .then(() => undefined, (reason: unknown) => reason);
    if (requests > 0) return { label: 'adapter', completed: error === undefined };
    if (error === undefined) throw new Error(`${reference.label}: the call neither failed nor reached the wire`);
    return { label: error instanceof TestRailValidationError ? 'driver' : 'driver_crash', completed: false };
  } finally { client.destroy(); }
}

describe('shared domains where they are used', () => {
  it('finds every reference and its binding', () => {
    expect(references.length).toBeGreaterThan(350);
    expect(new Set(references.map(({ expected }) => expected.driver.binding)).size).toBeGreaterThan(100);
  });

  /*
   * The case the issue measured. labels.deleteLabels checks a label list itself, and
   * refuses a bare number with a stated validation error where the identifier-list
   * domain's probe crashes. A reference there must relabel that one value and inherit
   * the rest, which is what the record form is for.
   */
  it('relabels only the values a binding treats differently', async () => {
    const manifest = (await loadParameterManifests()).find(({ endpoint }) => endpoint.tool === 'testrail_delete_labels');
    const inline = manifest?.parameters.find(({ id }) => id === 'body.label_ids');
    const baseline = manifest?.cases.find(({ id }) => id === 'representative-ids');
    const domain = library.domains.case_ids;
    if (!manifest || !inline || baseline?.expect.kind !== 'accepted' || !domain) throw new Error('Required delete_labels evidence is missing');
    const reference = (rejectedBy?: Parameter['rejected_by']) => {
      // The inline domain and requirements give way to the reference, as a manifest writes it.
      const rest = Object.fromEntries(Object.entries(inline).filter(([key]) => key !== 'domain' && key !== 'requirements')) as
        Omit<Parameter, 'domain' | 'requirements'>;
      const parameter: Parameter = { ...rest, domain_ref: 'case_ids', ...(rejectedBy === undefined ? {} : { rejected_by: rejectedBy }) };
      return { label: 'delete_labels body.label_ids', manifest, parameter, expected: baseline.expect as Extract<typeof baseline.expect, { kind: 'accepted' }> };
    };
    const observed = Object.fromEntries(await Promise.all(domain.invalid.map(async (invalid) =>
      [invalid.id, (await observe(reference(), {}, invalid.value)).label] as const)));
    expect(observed).toEqual({
      empty: 'driver', 'zero-member': 'driver', 'negative-member': 'driver', 'fractional-member': 'driver',
      'string-member': 'driver', scalar: 'driver', 'above-safe-member': 'adapter',
    });
    const claimed = (rejectedBy?: Parameter['rejected_by']) => Object.fromEntries(domain.invalid.map((invalid) =>
      [invalid.id, claimedLabel(reference(rejectedBy).parameter, invalid)]));
    // Inheriting the probe's labels overstates nothing but misnames the scalar's refusal.
    expect(claimed()).not.toEqual(observed);
    expect(claimed()).toMatchObject({ scalar: 'driver_crash' });
    expect(claimed({ scalar: 'driver' })).toEqual(observed);
    expect(claimed('adapter')).not.toEqual(observed);
  });

  it.each(references.map((reference) => [reference.label, reference] as const))(
    'holds %s to the labels its binding earns', async (_, reference) => {
      const { manifest, parameter } = reference;
      const domain = library.domains[parameter.domain_ref ?? ''];
      if (domain === undefined) throw new Error(`${reference.label}: unknown domain`);
      if (typeof parameter.rejected_by === 'object') {
        // A relabel names only values the domain has, so none can silently lapse.
        for (const id of Object.keys(parameter.rejected_by)) expect(domain.invalid.map((invalid) => invalid.id)).toContain(id);
      }
      if (parameter.rejected_by !== undefined) {
        // An override says the binding differs from the probe, so it must change a label
        // there; one restating what the reference inherits would be noise that hides that.
        const inherited = { ...parameter, rejected_by: undefined };
        const changes = domain.invalid.filter((invalid) => claimedLabel(parameter, invalid) !== claimedLabel(inherited, invalid));
        expect(changes.length, 'override changes no inherited label').toBeGreaterThan(0);
        if (typeof parameter.rejected_by === 'object') {
          for (const id of Object.keys(parameter.rejected_by)) expect(changes.map((invalid) => invalid.id), `${id} restates the probe`).toContain(id);
        }
      }
      const directory = manifest.files === undefined ? undefined : await mkdtemp(join(tmpdir(), 'testrail-mcp-domain-'));
      try {
        const paths = directory === undefined ? {} : await materializeFiles(manifest, directory);
        for (const valid of domain.valid) {
          // Accepted means the call went out and completed against the reply it was made for.
          expect(await observe(reference, paths, valid.value), `${valid.id} is accepted`).toEqual({ label: 'adapter', completed: true });
        }
        for (const invalid of domain.invalid) {
          expect((await observe(reference, paths, invalid.value)).label, invalid.id).toBe(claimedLabel(parameter, invalid));
        }
      } finally {
        if (directory !== undefined) await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
