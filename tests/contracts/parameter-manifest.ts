import { readFile, readdir } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/server/validators/ajv';
import { z } from 'zod';
import { loadDomainLibrary, type DomainLibrary } from './domains.js';
import { fileChanged, loadDriverReleases, type DriverReleases } from './driver-releases.js';

const identifier = z.string().min(1);
const jsonObject = z.record(z.string(), z.json());
type JsonObject = z.infer<typeof jsonObject>;
const requirementSchema = z.strictObject({
  id: identifier,
  kind: z.enum(['mapping', 'valid', 'invalid', 'required', 'omitted']),
  description: identifier,
});

const coverageSchema = z.strictObject({
  // $input refers to endpoint-wide rules; other IDs refer to parameters.
  parameter: identifier,
  requirements: z.array(identifier).min(1),
});

const acceptedSchema = z.strictObject({
  kind: z.literal('accepted'),
  driver: z.strictObject({ binding: identifier, arguments: z.array(z.json()) }),
  wire: z.strictObject({
    method: z.enum(['GET', 'POST']),
    // Literal TestRail endpoint including encoded path-style query parameters.
    endpoint: identifier,
    json: z.json().optional(),
    // Inspect multipart fields independently of the generated boundary string. These
    // are read out of the encoded request, so they record what the encoder wrote rather
    // than what it was handed: a part with no declared media type carries
    // application/octet-stream, not an empty one.
    multipart: z.array(z.strictObject({
      name: identifier,
      filename: identifier,
      content_type: z.string(),
      utf8: z.string(),
    })).min(1).optional(),
  }),
  upstream_response: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('json'), body: z.json() }),
    z.strictObject({ kind: z.literal('binary'), utf8: z.string() }),
    z.strictObject({ kind: z.literal('text'), text: z.string() }),
  ]),
  driver_result: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('json'), value: z.json() }),
    z.strictObject({ kind: z.literal('binary'), utf8: z.string() }),
    z.strictObject({ kind: z.literal('void') }),
  ]),
});

export const ParameterManifestSchema = z.strictObject({
  schema_version: z.literal(1),
  review: z.strictObject({
    status: z.enum(['partial', 'complete']),
    pending: z.array(identifier),
    driver_version: identifier,
    driver_commit: z.string().regex(/^[0-9a-f]{40}$/),
    // The driver commit the manifest was first reviewed against. It never moves, so a
    // driver_commit that differs from it has advanced and must carry evidence.
    authored_commit: z.string().regex(/^[0-9a-f]{40}$/),
    reviewed_on: z.iso.date(),
    // One step per advance, chained from authored_commit to driver_commit. Each names
    // every driver file the manifest cites and whether it changed; the audit checks the
    // claim against the recorded release hashes rather than taking it on trust.
    evidence: z.array(z.strictObject({
      from_commit: z.string().regex(/^[0-9a-f]{40}$/),
      to_commit: z.string().regex(/^[0-9a-f]{40}$/),
      reviewed_on: z.iso.date(),
      files: z.array(z.strictObject({
        path: identifier,
        changed: z.boolean(),
        note: identifier.optional(),
      })).min(1),
    })).min(1).optional(),
  }),
  endpoint: z.strictObject({
    family_id: z.string().regex(/^T\d{2}$/),
    http_method: z.enum(['GET', 'POST']),
    route: identifier,
    tool: z.string().regex(/^testrail_[a-z_]+$/),
    driver_method: identifier,
  }),
  sources: z.array(z.strictObject({ id: identifier, url: z.url(), supports: identifier })).min(1),
  input_policy: z.strictObject({
    ordinary_fields: z.literal('reject'),
    custom_fields: z.enum(['reject', 'flat_custom_prefix', 'endpoint_specific']),
    notes: z.string(),
  }),
  outer_result: z.strictObject({
    driver: z.enum(['record', 'array', 'page', 'text', 'binary', 'void', 'record_or_void', 'record_or_array']),
    tool_data: z.enum(['record', 'array', 'text', 'download_metadata', 'null', 'record_or_null', 'record_or_array']),
    notes: identifier,
  }),
  requirements: z.array(requirementSchema).min(1),
  // Future file-family harnesses materialize only these declared synthetic files.
  files: z.array(z.strictObject({ token: identifier, filename: identifier, utf8: z.string() })).optional(),
  /**
   * An accepted case whose input a referenced domain mutates at exactly one path to
   * derive its rejections. Required once any parameter uses `domain_ref`, because a
   * rejection is only attributable when everything else in the input stayed valid.
   */
  baseline: identifier.optional(),
  parameters: z.array(z.strictObject({
    id: identifier,
    input_path: z.array(identifier).min(1),
    scope: z.enum(['path', 'query', 'body', 'file', 'mcp']),
    requiredness: z.enum(['required', 'optional', 'conditional']),
    /**
     * A shared domain from the library, in place of an inline `domain` and
     * `requirements`. The library is authored from the driver's validation source and
     * each of its values is proven against a public driver method, so a reference is
     * evidence rather than a shortcut. Exactly one of `domain_ref` or `domain` is given.
     */
    domain_ref: identifier.optional(),
    /**
     * Where this reference's rejections are enforced, when that differs from the
     * domain's own labels. The domain labels each invalid value by what happened at its
     * probe, but another binding can treat the same value differently: a body field the
     * driver forwards unchecked leaves every refusal to the adapter. `adapter` says so
     * for all of the domain's invalid values; a record relabels only the values it
     * names. Each reference is driven through its own binding to hold this to the
     * pinned driver's observed behaviour.
     */
    rejected_by: z.union([
      z.literal('adapter'),
      z.record(identifier, z.enum(['driver', 'driver_crash', 'adapter'])),
    ]).optional(),
    /**
     * The accepted case this parameter's derived rejections mutate, when the manifest
     * baseline is in the other call mode: an aggregate control must be mutated on an
     * all-mode case, a page control on a page-mode one, or the refusal would come from
     * the mode mismatch rather than from the parameter under test.
     */
    baseline: identifier.optional(),
    // Independently authored JSON Schema fragment, never exported from the registry.
    domain: jsonObject.optional(),
    semantics: identifier,
    driver: z.union([
      z.strictObject({ argument: z.number().int().nonnegative(), path: z.array(identifier) }),
      z.null(),
    ]),
    wire: z.strictObject({
      location: z.enum(['path', 'query', 'json', 'multipart', 'adapter_only']),
      names: z.array(identifier),
      encoding: identifier,
    }),
    sources: z.array(identifier).min(1),
    requirements: z.array(requirementSchema).min(1).optional(),
  }).refine((parameter) => parameter.driver !== null
    || (parameter.scope === 'mcp' && parameter.wire.location === 'adapter_only'), {
    message: 'A null driver mapping is only valid for an adapter-only MCP control',
    path: ['driver'],
  }).refine((parameter) => (parameter.domain_ref === undefined)
    !== (parameter.domain === undefined && parameter.requirements === undefined), {
    message: 'Give exactly one of domain_ref or an inline domain with requirements',
    path: ['domain_ref'],
  }).refine((parameter) => parameter.rejected_by === undefined || parameter.domain_ref !== undefined, {
    message: 'Only a domain reference inherits enforcement labels to override',
    path: ['rejected_by'],
  })),
  cases: z.array(z.strictObject({
    id: identifier,
    input: jsonObject,
    covers: z.array(coverageSchema).min(1),
    expect: z.discriminatedUnion('kind', [
      acceptedSchema,
      z.strictObject({ kind: z.literal('rejected'), code: z.literal('INVALID_ARGUMENT') }),
    ]),
  })).min(1),
});

export type ParameterManifest = z.infer<typeof ParameterManifestSchema>;
export type ParameterFixture = ParameterManifest['cases'][number];
export type EndpointIdentity = ParameterManifest['endpoint'];

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Apply a mutation inside an array, to its first member alone.
 *
 * A wildcard path names a member of a reviewed array, and a derived rejection has to
 * change exactly one thing for the refusal to be attributable. Mutating the first
 * member does that: every other member stays valid, so only the member under test can
 * be the reason the input was refused.
 */
function atFirstMember(value: unknown, mutate: (member: JsonObject) => JsonObject): JsonObject[string] {
  if (!Array.isArray(value) || value.length === 0) return value as JsonObject[string];
  const members = value as JsonObject[string][];
  const [first] = members;
  return [mutate(isObject(first) ? first : {}), ...members.slice(1)];
}

function replaceAt(input: JsonObject, path: readonly string[], value: JsonObject[string]): JsonObject {
  const [head, ...rest] = path;
  if (head === undefined) throw new Error('Empty input path');
  const nested = input[head];
  if (rest[0] === '*') {
    const inner = rest.slice(1);
    return { ...input, [head]: atFirstMember(nested, (member) => replaceAt(member, inner, value)) };
  }
  return {
    ...input,
    [head]: rest.length === 0 ? value : replaceAt(isObject(nested) ? nested : {}, rest, value),
  };
}

function removeAt(input: JsonObject, path: readonly string[]): JsonObject {
  const [head, ...rest] = path;
  if (head === undefined) throw new Error('Empty input path');
  if (rest.length === 0) {
    return Object.fromEntries(Object.entries(input).filter(([key]) => key !== head));
  }
  const nested = input[head];
  if (rest[0] === '*') {
    const inner = rest.slice(1);
    return { ...input, [head]: atFirstMember(nested, (member) => removeAt(member, inner)) };
  }
  if (!isObject(nested)) return input;
  return { ...input, [head]: removeAt(nested, rest) };
}

/**
 * Inline every referenced domain, so the audits below see one complete shape whether a
 * manifest wrote its parameter out or referenced the shared library.
 *
 * Rejections are derived by mutating the declared baseline at exactly one input path.
 * That is what makes a derived case attributable: everything else in the input stayed
 * valid, so the refusal can only have come from the parameter under test.
 */
export function resolveDomains(manifest: ParameterManifest, library: DomainLibrary): ParameterManifest {
  const referencing = manifest.parameters.filter(({ domain_ref: reference }) => reference !== undefined);
  if (referencing.length === 0) return manifest;

  const baselineFor = (parameter: ParameterManifest['parameters'][number]): ParameterManifest['cases'][number] => {
    const id = parameter.baseline ?? manifest.baseline;
    const baseline = manifest.cases.find((candidate) => candidate.id === id);
    if (baseline === undefined || baseline.expect.kind !== 'accepted') {
      throw new Error(`${manifest.endpoint.tool}: ${parameter.id} requires an accepted baseline case`);
    }
    return baseline;
  };

  const derived: ParameterManifest['cases'] = [];
  const parameters = manifest.parameters.map((parameter) => {
    const reference = parameter.domain_ref;
    if (reference === undefined) return parameter;
    const domain = library.domains[reference];
    if (domain === undefined) throw new Error(`${manifest.endpoint.tool}: unknown domain ${reference}`);
    const baseline = baselineFor(parameter);
    // A control is live only in its own call mode. Mutating a case of the other mode
    // is refused by the mode mismatch and proves nothing about the parameter, so the
    // derived rejections would pass vacuously for a registration that stopped
    // enforcing the domain.
    const control = baseline.input._mcp;
    const allMode = typeof control === 'object' && control !== null && !Array.isArray(control) && control.pagination === 'all';
    const wantsAll = parameter.scope === 'mcp';
    const wantsPage = parameter.scope === 'query' && ['limit', 'offset'].includes(parameter.input_path[1] ?? '');
    if ((wantsAll && !allMode) || (wantsPage && allMode)) {
      throw new Error(`${manifest.endpoint.tool}: ${parameter.id} baseline is a case of the other call mode`);
    }

    /*
     * A derivation that leaves the baseline untouched would be recorded as a proof of
     * the domain while exercising nothing: a mis-authored path reaches no value, and an
     * omission of a field the baseline never carried removes nothing. Both are
     * authoring faults, and a silent pass is the one outcome they must not have.
     */
    const changed = (input: JsonObject, id: string): JsonObject => {
      if (JSON.stringify(input) === JSON.stringify(baseline.input)) {
        throw new Error(`${manifest.endpoint.tool}: ${parameter.id} derivation ${id} changed nothing in ${baseline.id}`);
      }
      return input;
    };

    for (const invalid of domain.invalid) {
      derived.push({
        id: `${parameter.id}:${invalid.id}`,
        input: changed(replaceAt(baseline.input, parameter.input_path, invalid.value), invalid.id),
        covers: [{ parameter: parameter.id, requirements: invalid.requirements }],
        expect: { kind: 'rejected', code: 'INVALID_ARGUMENT' },
      });
    }
    if (domain.omitted !== undefined && parameter.requiredness === 'required') {
      derived.push({
        id: `${parameter.id}:${domain.omitted.id}`,
        input: changed(removeAt(baseline.input, parameter.input_path), domain.omitted.id),
        covers: [{ parameter: parameter.id, requirements: domain.omitted.requirements }],
        expect: { kind: 'rejected', code: 'INVALID_ARGUMENT' },
      });
    }
    // A required parameter is never accepted without a value and an optional one is
    // never refused for lacking it, so each drops the presence requirement it cannot
    // cover rather than leaving one nothing covers.
    const requirements = domain.requirements.filter(({ kind }) =>
      kind !== (parameter.requiredness === 'required' ? 'omitted' : 'required'));
    return { ...parameter, domain: domain.domain, requirements };
  });

  return { ...manifest, parameters, cases: [...manifest.cases, ...derived] };
}

export async function loadParameterManifests(): Promise<ParameterManifest[]> {
  const directory = new URL('../fixtures/parameters/', import.meta.url);
  const names = (await readdir(directory)).filter((name) => name.endsWith('.json')).sort();
  const library = await loadDomainLibrary();
  return Promise.all(names.map(async (name) => {
    const raw: unknown = JSON.parse(await readFile(new URL(name, directory), 'utf8'));
    const manifest = ParameterManifestSchema.parse(raw);
    // Zod's record parser drops an own __proto__ key from its clone, so a case naming one
    // would run without it. The case schema is strict throughout, so the validated raw
    // cases differ from the clone in nothing else, and they are what the fixtures promise.
    return resolveDomains({ ...manifest, cases: (raw as ParameterManifest).cases }, library);
  }));
}

/**
 * Whether a case input carries a value at the path.
 *
 * A bare `*` means any array member. A name ending in `*`, such as `custom_*`, is an
 * extension point rather than a literal key, so any own property with that prefix
 * satisfies it; reading it literally would report every custom-field example as
 * supplying nothing.
 */
export function supplies(value: unknown, path: readonly string[]): boolean {
  const [head, ...rest] = path;
  if (head === undefined) return true;
  if (head === '*') return Array.isArray(value) && value.some((item) => supplies(item, rest));
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (head.endsWith('*')) {
    const prefix = head.slice(0, -1);
    return Object.keys(record).some((name) => name.startsWith(prefix) && supplies(record[name], rest));
  }
  return Object.hasOwn(record, head) && supplies(record[head], rest);
}

/**
 * Every value the path reaches, in document order. A bare `*` fans out over an array's
 * members, and a name ending in `*` gathers the own properties with that prefix into one
 * record, which is how both an input and a driver argument carry an extension point.
 */
export function reach(value: unknown, path: readonly string[]): unknown[] {
  const [head, ...rest] = path;
  if (head === undefined) return [value];
  if (head === '*') return Array.isArray(value) ? value.flatMap((item) => reach(item, rest)) : [];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
  const record = value as Record<string, unknown>;
  if (head.endsWith('*')) {
    const prefix = head.slice(0, -1);
    const matching = Object.entries(record).filter(([name]) => name.startsWith(prefix));
    return matching.length === 0 ? [] : reach(Object.fromEntries(matching), rest);
  }
  return Object.hasOwn(record, head) ? reach(record[head], rest) : [];
}

/**
 * Whether the path's last key is missing while everything leading to it is present and
 * well-typed: at the top, or in at least one member of an array on the way. A missing or
 * malformed parent is a different fault, the parent's, and is not evidence of this one.
 */
function lacksLeaf(value: unknown, path: readonly string[]): boolean {
  const [head, ...rest] = path;
  if (head === undefined) return false;
  if (head === '*') return Array.isArray(value) && value.some((item) => lacksLeaf(item, rest));
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  if (rest.length === 0) return !Object.hasOwn(value, head);
  return Object.hasOwn(value, head) && lacksLeaf((value as Record<string, unknown>)[head], rest);
}

/** Whether one path leads to or through the other, so their values are not independent. */
function nested(left: readonly string[], right: readonly string[]): boolean {
  const shorter = Math.min(left.length, right.length);
  return left.slice(0, shorter).every((part, index) => part === right[index]);
}

/** An extension point such as `custom_*`, whose rejection is a key rather than a value. */
function isExtension(path: readonly string[]): boolean {
  return path.some((part) => part !== '*' && part.endsWith('*'));
}

function duplicates(values: readonly string[]): string[] {
  return [...new Set(values.filter((value, index) => values.indexOf(value) !== index))];
}

/**
 * The shared domain library the manifests reference. A domain reference is audited
 * against it by default, so omitting the argument can never skip the check.
 */
const sharedDomains = await loadDomainLibrary();

/** The recorded driver releases, audited against by default for the same reason. */
const sharedReleases = await loadDriverReleases();

const driverSourcePrefix = 'https://github.com/dichovsky/testrail-api-client/blob/';
/**
 * Whether a URL names the driver repository in any spelling GitHub would serve. It is
 * parsed rather than matched as text, so an explicit port, a trailing-dot host, user
 * information, letter case and percent-encoded path segments are all seen through.
 */
function citesDriver(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/u, '');
  if (!/(?:^|\.)(?:github\.com|githubusercontent\.com)$/u.test(host)) return false;
  const [owner, repository] = parsed.pathname.split('/').filter((segment) => segment !== '').map((segment) => {
    try {
      return decodeURIComponent(segment).toLowerCase();
    } catch {
      return segment.toLowerCase();
    }
  });
  return owner === 'dichovsky' && (repository === 'testrail-api-client' || repository === 'testrail-api-client.git');
}

/**
 * Hold a manifest's driver provenance to the release ledger. A driver_commit that has
 * moved off authored_commit needs an unbroken chain of evidence steps, each covering
 * every driver file the manifest cites, and each changed or unchanged claim has to agree
 * with the ledger's hashes for both commits. A bare pointer bump therefore fails, and
 * so does evidence that calls a changed file unchanged.
 */
function auditProvenance(manifest: ParameterManifest, ledger: DriverReleases, fail: (message: string) => void): void {
  const { review } = manifest;
  const releases = new Map(ledger.releases.map((release) => [release.commit, release]));
  const short = (commit: string): string => commit.slice(0, 8);
  const current = releases.get(review.driver_commit);
  if (current === undefined) fail(`Driver commit ${short(review.driver_commit)} is not a recorded release`);
  else if (current.version !== review.driver_version) {
    fail(`Driver version ${review.driver_version} disagrees with release ${current.version} recorded for ${short(review.driver_commit)}`);
  }
  if (!releases.has(review.authored_commit)) fail(`Authored commit ${short(review.authored_commit)} is not a recorded release`);
  if (`${ledger.repository}/blob/` !== driverSourcePrefix) fail(`Release ledger describes ${ledger.repository}, not the driver the manifests cite`);

  const pinned = `${driverSourcePrefix}${review.driver_commit}/`;
  const paths = new Set<string>();
  for (const source of manifest.sources) {
    if (!source.url.startsWith(pinned)) {
      // Any other spelling of a driver link (raw, blame, tree, another host, port or
      // letter case) would escape both the revision check and the evidence rule.
      if (!source.url.startsWith(driverSourcePrefix) && citesDriver(source.url)) {
        fail(`Source ${source.id} cites the driver outside a blob URL pinned at ${short(review.driver_commit)}`);
      }
      continue;
    }
    // A line anchor or query names part of a file, not another file.
    const encoded = source.url.slice(pinned.length).split(/[?#]/)[0] ?? '';
    try {
      paths.add(decodeURIComponent(encoded));
    } catch {
      fail(`Source ${source.id} has a malformed driver path: ${encoded}`);
    }
  }
  const cited = [...paths].sort();
  if (current !== undefined) {
    for (const path of cited) {
      if (current.files[path]?.git_blob == null) fail(`Release ledger does not record cited file ${path} at ${short(review.driver_commit)}`);
    }
  }

  const steps = review.evidence ?? [];
  if (review.authored_commit === review.driver_commit) {
    if (steps.length > 0) fail('Evidence is recorded for a driver commit that never advanced');
    return;
  }
  if (steps.length === 0) {
    fail(`Driver commit advanced from ${short(review.authored_commit)} to ${short(review.driver_commit)} without evidence`);
    return;
  }
  const order = new Map(ledger.releases.map((release, index) => [release.commit, index]));
  let at = review.authored_commit;
  let reviewed = '';
  for (const [index, step] of steps.entries()) {
    const span = `${short(step.from_commit)}..${short(step.to_commit)}`;
    if (step.from_commit !== at) fail(`Evidence step ${index + 1} starts at ${short(step.from_commit)}, not ${short(at)}`);
    if (step.from_commit === step.to_commit) fail(`Evidence step ${index + 1} does not advance`);
    else if ((order.get(step.to_commit) ?? Infinity) < (order.get(step.from_commit) ?? -Infinity)) {
      fail(`Evidence step ${index + 1} moves back to an earlier release`);
    }
    // ISO dates compare as strings: a step is reviewed no earlier than the one before it
    // and no later than the manifest's own review.
    if (step.reviewed_on < reviewed || step.reviewed_on > review.reviewed_on) {
      fail(`Evidence step ${index + 1} reviewed on ${step.reviewed_on}, out of order with the review dates around it`);
    }
    reviewed = step.reviewed_on;
    at = step.to_commit;
    const from = releases.get(step.from_commit);
    const to = releases.get(step.to_commit);
    if (from === undefined || to === undefined) {
      fail(`Evidence ${span} names a commit that is not a recorded release`);
      continue;
    }
    for (const duplicate of duplicates(step.files.map(({ path }) => path))) fail(`Evidence ${span} names ${duplicate} twice`);
    const named = new Set(step.files.map(({ path }) => path));
    for (const path of cited) if (!named.has(path)) fail(`Evidence ${span} does not cover cited file ${path}`);
    for (const entry of step.files) {
      const before = from.files[entry.path];
      const after = to.files[entry.path];
      if (before === undefined || after === undefined) {
        fail(`Evidence ${span} names ${entry.path}, which the release ledger does not record at both commits`);
        continue;
      }
      const changed = fileChanged(before, after);
      if (entry.changed !== changed) {
        fail(`Evidence ${span} claims ${entry.path} ${entry.changed ? 'changed' : 'unchanged'}, but the release ledger records it ${changed ? 'changed' : 'unchanged'}`);
      }
      if (entry.changed && entry.note === undefined) fail(`Evidence ${span} gives no note for changed file ${entry.path}`);
    }
  }
  if (at !== review.driver_commit) fail(`Evidence ends at ${short(at)}, not at driver commit ${short(review.driver_commit)}`);
}

const validators = new WeakMap<object, (value: unknown) => boolean>();

/** A domain's JSON Schema fragment as a predicate, compiled once per fragment. */
function domainValidator(domain: JsonObject): (value: unknown) => boolean {
  let validate = validators.get(domain);
  if (validate === undefined) {
    const compiled = new AjvJsonSchemaValidator().getValidator(domain);
    validate = (value) => compiled(value).valid;
    validators.set(domain, validate);
  }
  return validate;
}

/** Audit authored coverage; this does not certify an adapter or infer missing API fields. */
export function auditParameterManifests(
  manifests: readonly ParameterManifest[],
  inventory?: readonly EndpointIdentity[],
  library: DomainLibrary = sharedDomains,
  releases: DriverReleases = sharedReleases,
): string[] {
  const errors: string[] = [];
  for (const duplicate of duplicates(manifests.map((manifest) => manifest.endpoint.tool))) {
    errors.push(`Duplicate endpoint: ${duplicate}`);
  }
  for (const duplicate of duplicates(manifests.map(({ endpoint }) => `${endpoint.http_method} ${endpoint.route}`))) {
    errors.push(`Duplicate route: ${duplicate}`);
  }
  for (const manifest of manifests) {
    const label = manifest.endpoint.tool;
    const fail = (message: string): void => { errors.push(`${label}: ${message}`); };
    if (!manifest.cases.some(({ expect }) => expect.kind === 'accepted')) {
      fail('No accepted fixture provides driver and wire evidence');
    }
    if ((manifest.review.status === 'complete') !== (manifest.review.pending.length === 0)) {
      fail('Review status disagrees with pending work');
    }
    if (manifest.endpoint.tool !== `testrail_${manifest.endpoint.route.split('/')[0] ?? ''}`) {
      fail('Tool name does not match endpoint token');
    }
    if (inventory) {
      const endpoint = inventory.find((entry) => entry.tool === label);
      if (!endpoint) fail('Endpoint is absent from inventory');
      else for (const key of ['family_id', 'http_method', 'route', 'driver_method'] as const) {
        if (manifest.endpoint[key] !== endpoint[key]) fail(`Inventory mismatch: ${key}`);
      }
    }
    const sources = new Set(manifest.sources.map(({ id }) => id));
    if (!manifest.sources.some(({ url }) => url.startsWith(`${driverSourcePrefix}${manifest.review.driver_commit}/`))) {
      fail('Missing pinned driver source evidence');
    }
    for (const source of manifest.sources) {
      if (source.url.startsWith(driverSourcePrefix) && !source.url.startsWith(`${driverSourcePrefix}${manifest.review.driver_commit}/`)) {
        fail(`Source ${source.id} uses a different driver revision`);
      }
    }
    auditProvenance(manifest, releases, fail);
    for (const duplicate of duplicates(manifest.sources.map(({ id }) => id))) fail(`Duplicate source: ${duplicate}`);
    for (const duplicate of duplicates(manifest.parameters.map(({ id }) => id))) fail(`Duplicate parameter: ${duplicate}`);
    for (const duplicate of duplicates(manifest.cases.map(({ id }) => id))) fail(`Duplicate case: ${duplicate}`);
    const targets = [
      { id: '$input', requirements: manifest.requirements },
      ...manifest.parameters,
    ];
    const requirements = new Map<string, z.infer<typeof requirementSchema>>();
    for (const target of targets) {
      // Domain references are inlined at load, so an absent list means a manifest was
      // audited without resolution rather than a parameter having no requirements.
      const declared = target.requirements ?? [];
      for (const duplicate of duplicates(declared.map(({ id }) => id))) {
        fail(`Duplicate requirement: ${target.id}/${duplicate}`);
      }
      for (const requirement of declared) requirements.set(`${target.id}/${requirement.id}`, requirement);
    }
    for (const parameter of manifest.parameters) {
      if (parameter.id === '$input') fail('Parameter uses reserved ID $input');
      for (const source of parameter.sources) if (!sources.has(source)) fail(`Unknown source: ${source}`);
      const kinds = new Set((parameter.requirements ?? []).map(({ kind }) => kind));
      for (const kind of ['mapping', 'valid', 'invalid'] as const) {
        if (!kinds.has(kind)) fail(`Parameter ${parameter.id} has no ${kind} requirement`);
      }
      const presence = parameter.requiredness === 'required' ? 'required' : 'omitted';
      if (!kinds.has(presence)) fail(`Parameter ${parameter.id} has no ${presence} requirement`);
    }
    const covered = new Set<string>();
    for (const fixture of manifest.cases) {
      const caseReferences: string[] = [];
      for (const coverage of fixture.covers) {
        for (const id of coverage.requirements) {
          const reference = `${coverage.parameter}/${id}`;
          caseReferences.push(reference);
          const requirement = requirements.get(reference);
          if (!requirement) { fail(`Case ${fixture.id} references unknown requirement ${reference}`); continue; }
          const shouldReject = requirement.kind === 'invalid' || requirement.kind === 'required';
          if (shouldReject !== (fixture.expect.kind === 'rejected')) {
            fail(`Case ${fixture.id} has wrong outcome for ${reference}`);
          }
          // An omission is only evidence when the case actually leaves the parameter out.
          const parameter = manifest.parameters.find(({ id }) => id === coverage.parameter);
          if (requirement.kind === 'omitted' && parameter !== undefined && supplies(fixture.input, parameter.input_path)) {
            fail(`Case ${fixture.id} supplies ${reference} it claims to omit`);
          }
          covered.add(reference);
        }
      }
      for (const duplicate of duplicates(caseReferences)) fail(`Case ${fixture.id} repeats coverage ${duplicate}`);
      if (fixture.expect.kind === 'accepted') {
        /*
         * The manifest says where each parameter lands among the driver's arguments, and
         * the case lists those arguments literally. Nothing else holds the two together,
         * so a location both the manifest and the registration misdescribe would stand
         * while the literal arguments and the adapter were right. Every parameter the case
         * supplies is checked, not only those it claims to cover, since an argument list
         * is evidence for every value it carries.
         */
        const { arguments: driverArguments } = fixture.expect.driver;
        for (const parameter of manifest.parameters) {
          if (parameter.driver === null) continue;
          const given = reach(fixture.input, parameter.input_path);
          if (given.length === 0) continue;
          const { argument, path } = parameter.driver;
          const passed = argument < driverArguments.length ? reach(driverArguments[argument], path) : [];
          if (!isDeepStrictEqual(given, passed)) {
            fail(`Case ${fixture.id} passes ${parameter.id} to argument ${argument}${path.length === 0 ? '' : ` at ${path.join('.')}`} as ${JSON.stringify(passed)}, not ${JSON.stringify(given)}`);
          }
        }
        /*
         * A shared domain proves its values against the driver, so an accepted case that
         * claims one of the domain's requirements must use a value the domain proved for
         * it: covering `upper-bound` with 7 would otherwise pass. The representative pair
         * is the exception. Any value inside the domain represents it as well as the
         * domain's own example, and the case's accepted driver evidence proves the value
         * it uses, so there it is enough that the domain's schema admits the value. Either
         * way every member of a fan-out is judged, and a case must supply the value at all.
         */
        for (const coverage of fixture.covers) {
          const parameter = manifest.parameters.find(({ id }) => id === coverage.parameter);
          const domain = parameter?.domain_ref === undefined ? undefined : library.domains[parameter.domain_ref];
          if (parameter === undefined || domain === undefined) continue;
          const given = reach(fixture.input, parameter.input_path);
          const representative = domain.valid.find(({ id }) => id === 'representative')?.requirements ?? [];
          for (const id of coverage.requirements) {
            const kind = domain.requirements.find((requirement) => requirement.id === id)?.kind;
            if (kind !== 'mapping' && kind !== 'valid') continue;
            if (representative.includes(id)) {
              const inDomain = domainValidator(domain.domain);
              if (given.length === 0 || !given.every((value) => inDomain(value))) {
                fail(`Case ${fixture.id} covers ${parameter.id}/${id} with ${JSON.stringify(given)}, outside the ${parameter.domain_ref} domain`);
              }
              continue;
            }
            const proven = domain.valid.filter(({ requirements }) => requirements.includes(id)).map(({ value }) => value);
            if (given.length === 0 || !given.every((value) => proven.some((candidate) => isDeepStrictEqual(value, candidate)))) {
              fail(`Case ${fixture.id} covers ${parameter.id}/${id} with ${JSON.stringify(given)}, not a value ${parameter.domain_ref} proves for it: ${JSON.stringify(proven)}`);
            }
          }
        }
      }
      // A refusal names no field, so an input malformed in one place could otherwise
      // claim the rejections of every parameter it carries, and a constraint weakened on
      // any of the others would still look covered. Endpoint-wide rules are not a
      // parameter target and do not count.
      const rejectedTargets = new Set(fixture.covers.map(({ parameter }) => parameter).filter((id) => id !== '$input'));
      if (fixture.expect.kind === 'rejected' && rejectedTargets.size > 1) {
        fail(`Case ${fixture.id} attributes one rejection to ${rejectedTargets.size} parameters: ${[...rejectedTargets].join(', ')}`);
      }
      /*
       * Naming one parameter is not yet evidence that it caused the refusal: an input
       * malformed elsewhere, or carrying an unknown key, is refused just the same. So a
       * rejected case must have exactly one cause, and it must be the one it names. The
       * named parameter is what is wrong, judged by its own independently authored
       * domain: its leaf is absent for a presence requirement, and for any other its
       * value is outside the domain, or for a shared domain is a value the library
       * proved refused for that very requirement. Every other parameter the case
       * supplies stays inside its own domain, and no top-level key is unknown.
       *
       * An extension point such as `custom_*` is refused for a key outside its pattern,
       * which no value domain describes and the unknown-key rule is the same fact as, so
       * it alone may share its case with an endpoint-wide rule and is spared the value
       * and unknown-key rules.
       */
      const [target, ...others] = [...rejectedTargets];
      const parameter = manifest.parameters.find(({ id }) => id === target);
      /*
       * Every parameter but the named one must be sound, or it could have caused the
       * refusal alone: a value outside its own domain, or a required parameter left out
       * where its parent is present, is a second cause. A parameter on the named one's
       * own path is judged with it rather than beside it.
       */
      const secondCauses = (named: string, path: readonly string[] | undefined): void => {
        for (const other of manifest.parameters) {
          if (path !== undefined && nested(other.input_path, path)) continue;
          if (other.requiredness === 'required' && lacksLeaf(fixture.input, other.input_path)) {
            fail(`Case ${fixture.id} also leaves out the required ${other.id}, so its refusal is not evidence for ${named}`);
          }
          if (other.domain === undefined) continue;
          const inDomain = domainValidator(other.domain);
          if (!reach(fixture.input, other.input_path).every((value) => inDomain(value))) {
            fail(`Case ${fixture.id} also gives ${other.id} a value outside its domain, so its refusal is not evidence for ${named}`);
          }
        }
      };
      // An endpoint-wide refusal is attributable only when no parameter is wrong too.
      if (fixture.expect.kind === 'rejected' && rejectedTargets.size === 0) secondCauses('$input', undefined);
      if (fixture.expect.kind === 'rejected' && parameter !== undefined && others.length === 0) {
        const extension = isExtension(parameter.input_path);
        const endpointWide = fixture.covers.some(({ parameter: id }) => id === '$input');
        if (endpointWide && !extension) fail(`Case ${fixture.id} shares its refusal between $input and ${parameter.id}`);
        const shared = parameter.domain_ref === undefined ? undefined : library.domains[parameter.domain_ref];
        for (const coverage of extension ? [] : fixture.covers.filter(({ parameter: id }) => id === parameter.id)) {
          for (const id of coverage.requirements) {
            const reference = `${parameter.id}/${id}`;
            const kind = requirements.get(reference)?.kind;
            if (kind === 'required') {
              if (!lacksLeaf(fixture.input, parameter.input_path)) {
                fail(`Case ${fixture.id} does not leave out only ${parameter.id}, so its refusal is not evidence for ${reference}`);
              }
              continue;
            }
            if (kind !== 'invalid' || parameter.domain === undefined) continue;
            const values = reach(fixture.input, parameter.input_path);
            const inDomain = domainValidator(parameter.domain);
            if (values.length === 0) fail(`Case ${fixture.id} carries no ${parameter.id}, so its refusal is not evidence for ${reference}`);
            else if (values.every((value) => inDomain(value))) {
              fail(`Case ${fixture.id} gives ${parameter.id} a value its domain accepts, so its refusal is not evidence for ${reference}`);
            } else if (shared !== undefined) {
              const proven = shared.invalid.filter(({ requirements: covered }) => covered.includes(id)).map(({ value }) => value);
              if (!values.some((value) => proven.some((candidate) => isDeepStrictEqual(value, candidate)))) {
                fail(`Case ${fixture.id} rejects ${parameter.id} with ${JSON.stringify(values)}, not a value ${parameter.domain_ref} proves refused for ${reference}`);
              }
            }
          }
        }
        secondCauses(parameter.id, parameter.input_path);
        const known = new Set(manifest.parameters.map(({ input_path: [head] }) => head));
        for (const key of extension ? [] : Object.keys(fixture.input)) {
          if (!known.has(key)) fail(`Case ${fixture.id} also carries the unknown key ${key}, so its refusal is not evidence for ${parameter.id}`);
        }
      }
      if (fixture.expect.kind === 'accepted' && fixture.expect.wire.method !== manifest.endpoint.http_method) {
        fail(`Case ${fixture.id} wire method disagrees with endpoint`);
      }
      if (fixture.expect.kind === 'accepted' && fixture.expect.wire.json !== undefined && fixture.expect.wire.multipart !== undefined) {
        fail(`Case ${fixture.id} declares both JSON and multipart request bodies`);
      }
    }
    for (const reference of requirements.keys()) if (!covered.has(reference)) fail(`Uncovered requirement: ${reference}`);
  }
  return errors;
}

export function parameterCoverageReport(
  manifests: readonly ParameterManifest[],
  inventory: readonly EndpointIdentity[],
): { reviewedEndpoints: string[]; completeEndpoints: string[]; partialEndpoints: string[]; pendingEndpoints: string[] } {
  const reviewed = new Set(manifests.map(({ endpoint }) => endpoint.tool));
  return {
    reviewedEndpoints: [...reviewed].sort(),
    completeEndpoints: manifests.filter(({ review }) => review.status === 'complete').map(({ endpoint }) => endpoint.tool).sort(),
    partialEndpoints: manifests.filter(({ review }) => review.status === 'partial').map(({ endpoint }) => endpoint.tool).sort(),
    pendingEndpoints: inventory.filter(({ tool }) => !reviewed.has(tool)).map(({ tool }) => tool).sort(),
  };
}
