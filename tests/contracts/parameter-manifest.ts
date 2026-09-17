import { readFile, readdir } from 'node:fs/promises';
import { z } from 'zod';
import { loadDomainLibrary, type DomainLibrary } from './domains.js';

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
    // Inspect multipart fields independently of the generated boundary string.
    multipart: z.array(z.strictObject({
      name: identifier,
      filename: identifier,
      content_type: identifier,
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
    reviewed_on: z.iso.date(),
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

function replaceAt(input: JsonObject, path: readonly string[], value: JsonObject[string]): JsonObject {
  const [head, ...rest] = path;
  if (head === undefined) throw new Error('Empty input path');
  const nested = input[head];
  return {
    ...input,
    [head]: rest.length === 0
      ? value
      : replaceAt(typeof nested === 'object' && nested !== null && !Array.isArray(nested) ? nested : {}, rest, value),
  };
}

function removeAt(input: JsonObject, path: readonly string[]): JsonObject {
  const [head, ...rest] = path;
  if (head === undefined) throw new Error('Empty input path');
  if (rest.length === 0) {
    return Object.fromEntries(Object.entries(input).filter(([key]) => key !== head));
  }
  const nested = input[head];
  if (typeof nested !== 'object' || nested === null || Array.isArray(nested)) return input;
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
function resolveDomains(manifest: ParameterManifest, library: DomainLibrary): ParameterManifest {
  const referencing = manifest.parameters.filter(({ domain_ref: reference }) => reference !== undefined);
  if (referencing.length === 0) return manifest;

  const baseline = manifest.cases.find(({ id }) => id === manifest.baseline);
  if (baseline === undefined || baseline.expect.kind !== 'accepted') {
    throw new Error(`${manifest.endpoint.tool}: a domain reference requires an accepted baseline case`);
  }

  const derived: ParameterManifest['cases'] = [];
  const parameters = manifest.parameters.map((parameter) => {
    const reference = parameter.domain_ref;
    if (reference === undefined) return parameter;
    const domain = library.domains[reference];
    if (domain === undefined) throw new Error(`${manifest.endpoint.tool}: unknown domain ${reference}`);

    for (const invalid of domain.invalid) {
      derived.push({
        id: `${parameter.id}:${invalid.id}`,
        input: replaceAt(baseline.input, parameter.input_path, invalid.value),
        covers: [{ parameter: parameter.id, requirements: invalid.requirements }],
        expect: { kind: 'rejected', code: 'INVALID_ARGUMENT' },
      });
    }
    if (domain.omitted !== undefined && parameter.requiredness === 'required') {
      derived.push({
        id: `${parameter.id}:${domain.omitted.id}`,
        input: removeAt(baseline.input, parameter.input_path),
        covers: [{ parameter: parameter.id, requirements: domain.omitted.requirements }],
        expect: { kind: 'rejected', code: 'INVALID_ARGUMENT' },
      });
    }
    // An optional control has no required-omission case, so drop that requirement
    // rather than leaving one nothing covers.
    const requirements = domain.requirements.filter(({ kind }) =>
      parameter.requiredness === 'required' || (kind !== 'required' && kind !== 'omitted'));
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
    return resolveDomains(ParameterManifestSchema.parse(raw), library);
  }));
}

function duplicates(values: readonly string[]): string[] {
  return [...new Set(values.filter((value, index) => values.indexOf(value) !== index))];
}

/** Audit authored coverage; this does not certify an adapter or infer missing API fields. */
export function auditParameterManifests(
  manifests: readonly ParameterManifest[],
  inventory?: readonly EndpointIdentity[],
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
    const driverSourcePrefix = 'https://github.com/dichovsky/testrail-api-client/blob/';
    if (!manifest.sources.some(({ url }) => url.startsWith(`${driverSourcePrefix}${manifest.review.driver_commit}/`))) {
      fail('Missing pinned driver source evidence');
    }
    for (const source of manifest.sources) {
      if (source.url.startsWith(driverSourcePrefix) && !source.url.startsWith(`${driverSourcePrefix}${manifest.review.driver_commit}/`)) {
        fail(`Source ${source.id} uses a different driver revision`);
      }
    }
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
          covered.add(reference);
        }
      }
      for (const duplicate of duplicates(caseReferences)) fail(`Case ${fixture.id} repeats coverage ${duplicate}`);
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
