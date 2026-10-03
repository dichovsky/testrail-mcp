import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { operationRegistry } from '../src/operations/catalog.js';
import { SERVER_INSTRUCTIONS } from '../src/transport/server.js';
import { loadParameterManifests } from './contracts/parameter-manifest.js';

/*
 * F06: what each tool tells a caller about paging, and how the adapter reaches the
 * driver's paging. The paging kind of each tool comes from the inventory, never from the
 * registry under test, and the two sentences are the ones docs/pagination.md quotes.
 */

const inventory = (JSON.parse(await readFile(new URL('../docs/operation-inventory.json', import.meta.url), 'utf8')) as {
  operations: { tool: string; pagination: { kind: 'none' | 'controlled' | 'response_driven' } }[];
}).operations;

/*
 * Two unpaged endpoints whose summaries warn that TestRail documents no limit or offset
 * for them, and what happens if it pages anyway. These exact sentences are the only
 * paging wording an unpaged tool may carry; the rest of each description is held to the
 * same rule as every other unpaged tool.
 */
const PAGING_WARNINGS: Readonly<Record<string, readonly string[]>> = {
  testrail_get_attachments_for_plan_entry: [
    'TestRail documents no limit or offset here and a bare array as the reply; if it sends a paged envelope instead, only the attachments in that one reply are returned, with no sign that more exist, because the driver method returns the list alone.',
  ],
  testrail_get_attachments_for_test: [
    'TestRail documents no limit or offset for this endpoint, yet gives its reply the format of get_attachments_for_case, which is paged.',
    'If TestRail pages it, only the attachments in that one reply are returned, with no sign that more exist, because the driver method returns the list alone.',
  ],
};

/*
 * The paged lists TestRail documents with a bare-array reply. A bare array carries no
 * continuation, so the driver reads one as the end of the list, on any list, and all mode
 * reports it complete; the server cannot see which kind of reply ended an aggregate,
 * because the driver's aggregate returns the items alone. Each of these descriptions says
 * so, and no other paged list does. The set is checked against the hand-authored
 * manifests below, so a bare-array fixture added to another list demands a disclosure
 * there too.
 */
const BARE_ARRAY_LISTS: ReadonlySet<string> = new Set([
  'testrail_get_attachments_for_plan',
  'testrail_get_attachments_for_run',
  'testrail_get_case_statuses',
]);

/*
 * The one list whose driver decoder unwraps an envelope sent inside an array, with the
 * collection key that marks the envelope: the only page descriptor declaring
 * `response: 'nested-envelope'` (the case history, in the driver's src/modules/cases.ts).
 * That decoder reads an array as bare only when no element carries the key; every other
 * list's decoder reads any array as bare.
 */
const NESTED: ReadonlyMap<string, string> = new Map([['testrail_get_history_for_case', 'history']]);

/**
 * Whether the driver would accept this reply to this list as a bare array. The case
 * history's decoder refuses, as invalid_page, an array in which no element carries the
 * key but one carries at least two of offset, limit, size and _links; such a reply fails
 * the fixture runner, so no accepted fixture holds one, and this check does not tell it
 * apart.
 */
function isBareArray(tool: string, body: unknown): boolean {
  if (!Array.isArray(body)) return false;
  const key = NESTED.get(tool);
  return key === undefined || !(body as unknown[]).some((value) =>
    typeof value === 'object' && value !== null && !Array.isArray(value) && Object.hasOwn(value, key));
}

const CONTROLLED = 'Returns one page by default. Use _mcp.pagination="all" for bounded remaining matches.';
const RESPONSE_DRIVEN = 'Returns the server-selected first page by default; manual continuation is unavailable. Use _mcp.pagination="all" for bounded complete retrieval.';

function description(tool: string): string {
  const operation = operationRegistry.get(tool);
  if (operation === undefined) throw new Error(`${tool} is not registered`);
  return operation.description;
}

describe('paging disclosure in tool descriptions', () => {
  it('covers 18 controlled, 6 response-driven and 109 unpaged tools', () => {
    const count = (kind: string) => inventory.filter(({ pagination }) => pagination.kind === kind).length;
    expect([count('controlled'), count('response_driven'), count('none')]).toEqual([18, 6, 109]);
  });

  it.each(inventory.map(({ tool, pagination }) => [tool, pagination.kind] as const))('%s (%s) says exactly what its paging offers', (tool, kind) => {
    const text = description(tool);
    expect(text.includes(CONTROLLED)).toBe(kind === 'controlled');
    expect(text.includes(RESPONSE_DRIVEN)).toBe(kind === 'response_driven');
    // An unpaged tool offers no paging control at all, and apart from the two warnings
    // above says nothing about pages, offsets, continuations or cursors.
    if (kind === 'none') {
      expect(text).not.toMatch(/_mcp|pagination=|page by default/u);
      let rest = text;
      for (const warning of PAGING_WARNINGS[tool] ?? []) {
        expect(rest).toContain(warning);
        rest = rest.replace(warning, '');
      }
      expect(rest).not.toMatch(/\bpag(?:e|in)|\boffset\b|continuation|cursor/iu);
    }
  });

  it('refuses every paging control on an unpaged tool', async () => {
    const manifests = await loadParameterManifests();
    const unpaged = inventory.filter(({ pagination }) => pagination.kind === 'none');
    expect(unpaged).toHaveLength(109);
    for (const { tool } of unpaged) {
      const operation = operationRegistry.get(tool);
      const fixture = manifests.find(({ endpoint }) => endpoint.tool === tool)?.cases.find(({ expect: outcome }) => outcome.kind === 'accepted');
      if (operation === undefined || fixture === undefined) throw new Error(`${tool}: no registration or accepted fixture`);
      const input = fixture.input as Record<string, unknown>;
      const query = typeof input.query === 'object' && input.query !== null ? input.query : {};
      // The accepted fixture itself passes, so each refusal below is the control's doing.
      expect(operation.inputSchema.safeParse(input).success, tool).toBe(true);
      for (const extra of [
        { _mcp: { pagination: 'all' } }, { _mcp: { pagination: 'page' } },
        { query: { ...query, limit: 1 } }, { query: { ...query, offset: 0 } },
      ]) expect(operation.inputSchema.safeParse({ ...input, ...extra }).success, `${tool} ${JSON.stringify(extra)}`).toBe(false);
    }
  });

  it('never claims a paged read, or an aggregate, is a consistent snapshot, in any description or the server instructions', () => {
    for (const { tool } of inventory) expect(description(tool), tool).not.toMatch(/snapshot|consistent|atomic|transactional/iu);
    // Every client receives the instructions, and they describe all mode too.
    expect(SERVER_INSTRUCTIONS).not.toMatch(/snapshot|consistent|atomic|transactional/iu);
  });

  it('names the bare-array lists exactly as their manifests document them', async () => {
    const manifests = await loadParameterManifests();
    const paged = new Set(inventory.filter(({ pagination }) => pagination.kind !== 'none').map(({ tool }) => tool));
    const documented = manifests
      .filter(({ endpoint, cases }) => paged.has(endpoint.tool) && cases.some(({ expect: outcome }) =>
        outcome.kind === 'accepted' && outcome.upstream_response.kind === 'json' && isBareArray(endpoint.tool, outcome.upstream_response.body)))
      .map(({ endpoint }) => endpoint.tool);
    expect(documented.sort()).toEqual([...BARE_ARRAY_LISTS].sort());
  });

  it.each(inventory.filter(({ pagination }) => pagination.kind !== 'none').map(({ tool }) => tool))(
    '%s says a bare-array reply reads as the whole list exactly when TestRail documents one', (tool) => {
      const text = description(tool);
      const documented = BARE_ARRAY_LISTS.has(tool);
      expect(/\bbare array\b/u.test(text)).toBe(documented);
      expect(/has_more false/u.test(text)).toBe(documented);
      expect(/all mode stops after [^.]*while reporting complete/u.test(text)).toBe(documented);
    });
});

describe('how the adapter reaches the driver', () => {
  it('imports the driver only through its public entry point, never a private file', async () => {
    // fileURLToPath, not URL.pathname, which reads as /D:/... on Windows.
    const root = fileURLToPath(new URL('../src/', import.meta.url));
    const files = (await readdir(root, { recursive: true })).filter((file) => file.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(0);
    const offending: string[] = [];
    for (const file of files) {
      const source = await readFile(join(root, file), 'utf8');
      for (const [, specifier] of source.matchAll(/(?:from\s+|import\s*\(?\s*|require\(\s*)['"]([^'"]+)['"]/gu)) {
        if (specifier !== undefined && (/testrail-api-client\//u.test(specifier) || specifier.includes('node_modules'))) offending.push(`${file}: ${specifier}`);
      }
    }
    expect(offending).toEqual([]);
  });

  /*
   * Within this server only the page describer reads a page's links or parses a
   * continuation, and it reports the numbers it validates without fetching anything. This
   * is not by itself a proof that there is no fetch loop: a loop over computed offsets
   * reads no link. The exact request counts on every paged list in
   * tests/paging-through-tools.test.ts hold that.
   */
  it('reads page links only in the page describer', async () => {
    const root = fileURLToPath(new URL('../src/', import.meta.url));
    const files = (await readdir(root, { recursive: true })).filter((file) => file.endsWith('.ts'));
    const readers: string[] = [];
    for (const file of files) {
      // Comments may name _links freely; a // after a colon is a URL, not a comment.
      const source = (await readFile(join(root, file), 'utf8'))
        .replace(/\/\*[\s\S]*?\*\//gu, '')
        .replace(/(^|[^:])\/\/.*$/gmu, '$1');
      // Member access, an index or a destructuring all name _links as a whole word.
      if (/(?<![\w$])_links(?![\w$])|\bparseContinuation\b/u.test(source)) readers.push(file.replaceAll('\\', '/'));
    }
    expect(readers).toEqual(['contracts/pagination.ts']);
  });
});
