import { TestRailClient } from '@dichovsky/testrail-api-client';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { nonnegativeIntegerSchema, positiveIdSchema } from '../src/contracts/inputs.js';
import { auditDomainLibrary, loadDomainLibrary, type ParameterDomain } from './contracts/domains.js';

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
    default:
      throw new Error(`No probe harness for binding ${binding}`);
  }
}

/** Page controls are carried in an options object; an identifier is positional. */
function positioned(name: string, value: unknown): unknown {
  if (name === 'pagination_limit') return { limit: value };
  if (name === 'pagination_offset') return { offset: value };
  return value;
}

/** The adapter schema each domain claims to describe. */
const adapterSchema: Readonly<Record<string, z.ZodType>> = {
  positive_id: positiveIdSchema,
  pagination_limit: positiveIdSchema.max(250),
  pagination_offset: nonnegativeIntegerSchema,
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
        if (invalid.rejected_by === 'driver') {
          await expect(attempt, `${name}/${invalid.id}`).rejects.toThrow();
          // Refused before dispatch, not merely surfaced as an upstream failure.
          expect(requests(), `${name}/${invalid.id} issued a request`).toBe(0);
        } else {
          // The driver accepts it; only the MCP boundary refuses. Asserting this keeps
          // the library from overstating where the guarantee comes from.
          await attempt;
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
