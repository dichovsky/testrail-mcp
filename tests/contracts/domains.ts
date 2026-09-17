import { readFile } from 'node:fs/promises';
import { z } from 'zod';

const identifier = z.string().min(1);

const requirementSchema = z.strictObject({
  id: identifier,
  kind: z.enum(['mapping', 'valid', 'invalid', 'required', 'omitted']),
  description: identifier,
});

const valueSchema = z.strictObject({
  id: identifier,
  value: z.json(),
  requirements: z.array(identifier).min(1),
});

const invalidValueSchema = z.strictObject({
  id: identifier,
  value: z.json(),
  requirements: z.array(identifier).min(1),
  /**
   * Which layer refuses the value. `driver` means the pinned client rejects it before
   * issuing a request; `adapter` means the driver accepts it and only the MCP boundary
   * refuses. Recording this keeps the library honest about where a guarantee comes from.
   */
  rejected_by: z.enum(['driver', 'adapter']),
});

/**
 * A reusable parameter domain.
 *
 * `validateId` is one implementation applied at 129 call sites, and its name argument
 * only shapes the error message, so every TestRail identifier shares a single domain.
 * Describing it once removes duplication that carries no signal: the hundredth copy of
 * "reject -1" proves nothing the first did not, while making a real error easier to
 * miss in the noise and a driver change a hundred-file edit.
 *
 * Independence is preserved because this is authored from the driver's validation
 * source, never from the operation registry, and because `probe` names a public method
 * that proves each value against the driver itself.
 */
const domainSchema = z.strictObject({
  source: z.strictObject({ id: identifier, url: z.url(), supports: identifier }),
  probe: z.strictObject({ binding: identifier, note: identifier }),
  domain: z.record(z.string(), z.json()),
  semantics: identifier,
  requirements: z.array(requirementSchema).min(1),
  valid: z.array(valueSchema).min(1),
  invalid: z.array(invalidValueSchema).min(1),
  omitted: z.strictObject({ id: identifier, requirements: z.array(identifier).min(1) }).optional(),
});

export const DomainLibrarySchema = z.strictObject({
  schema_version: z.literal(1),
  review: z.strictObject({
    driver_version: identifier,
    driver_commit: z.string().regex(/^[0-9a-f]{40}$/),
    reviewed_on: z.iso.date(),
  }),
  domains: z.record(z.string(), domainSchema),
});

export type DomainLibrary = z.infer<typeof DomainLibrarySchema>;
export type ParameterDomain = z.infer<typeof domainSchema>;

export async function loadDomainLibrary(): Promise<DomainLibrary> {
  const raw: unknown = JSON.parse(await readFile(new URL('../fixtures/domains.json', import.meta.url), 'utf8'));
  return DomainLibrarySchema.parse(raw);
}

/**
 * Internal consistency only. This does not certify a domain against the driver; the
 * probe test does that, and a domain that merely agrees with itself is an assertion.
 */
export function auditDomainLibrary(library: DomainLibrary): string[] {
  const errors: string[] = [];
  for (const [name, domain] of Object.entries(library.domains)) {
    const fail = (message: string): void => { errors.push(`${name}: ${message}`); };
    const declared = new Set(domain.requirements.map(({ id }) => id));
    if (declared.size !== domain.requirements.length) fail('Duplicate requirement id');

    const referenced = new Set<string>();
    const entries = [
      ...domain.valid.map((value) => ({ id: value.id, requirements: value.requirements, polarity: 'valid' as const })),
      ...domain.invalid.map((value) => ({ id: value.id, requirements: value.requirements, polarity: 'invalid' as const })),
      ...(domain.omitted === undefined
        ? []
        : [{ id: domain.omitted.id, requirements: domain.omitted.requirements, polarity: 'omitted' as const }]),
    ];
    const ids = entries.map(({ id }) => id);
    if (new Set(ids).size !== ids.length) fail('Duplicate value id');

    for (const entry of entries) {
      for (const requirement of entry.requirements) {
        if (!declared.has(requirement)) {
          fail(`Value ${entry.id} references unknown requirement ${requirement}`);
          continue;
        }
        referenced.add(requirement);
        const kind = domain.requirements.find(({ id }) => id === requirement)?.kind;
        // A value must satisfy a requirement of matching polarity, so an acceptance
        // can never stand in as evidence for a rejection or the reverse.
        const expected = entry.polarity === 'valid'
          ? ['mapping', 'valid']
          : entry.polarity === 'invalid' ? ['invalid'] : ['required', 'omitted'];
        if (kind !== undefined && !expected.includes(kind)) {
          fail(`Value ${entry.id} has wrong polarity for ${requirement}`);
        }
      }
    }
    for (const { id } of domain.requirements) {
      if (!referenced.has(id)) fail(`Requirement ${id} has no value covering it`);
    }
  }
  return errors;
}
