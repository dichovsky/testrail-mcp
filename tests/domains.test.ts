import { TestRailClient, TestRailValidationError } from '@dichovsky/testrail-api-client';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  aggregateLimitDefaults, caseIdsSchema, idFilterSchema, nonnegativeIntegerSchema, positiveIdSchema,
} from '../src/contracts/inputs.js';
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
    case 'projects.getAllProjects':
      await client.projects.getAllProjects(value as { pageSize?: number; maxItems?: number });
      return;
    case 'cases.getCasesPage':
      await client.cases.getCasesPage(7, value as { typeId?: number; createdAfter?: number });
      return;
    case 'cases.getCaseTitles':
      await client.cases.getCaseTitles(value as number[]);
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
