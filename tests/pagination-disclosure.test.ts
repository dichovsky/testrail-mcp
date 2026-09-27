import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { operationRegistry } from '../src/operations/catalog.js';
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
 * for them, and what happens if it pages anyway. That warning is the only paging wording
 * an unpaged tool may carry.
 */
const DISCLAIMS_PAGING: ReadonlySet<string> = new Set(['testrail_get_attachments_for_plan_entry', 'testrail_get_attachments_for_test']);

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
      if (!DISCLAIMS_PAGING.has(tool)) expect(text).not.toMatch(/\bpag(?:e|es|ed|ing|ination)\b|\boffset\b|continuation|cursor/iu);
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

  it('never claims a paged read, or an aggregate, is a consistent snapshot', () => {
    for (const { tool } of inventory) expect(description(tool), tool).not.toMatch(/snapshot|consistent|atomic|transactional/iu);
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
});
