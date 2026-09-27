#!/usr/bin/env node
/*
 * Print the catalog an installed server lists, for the C01 evidence record: the tool
 * count and the SHA-256 of the sorted tool names joined by newlines, over both the legacy
 * and the 2026-07-28 protocol. It launches the executable you name against the fixture
 * stand-in, so it needs no TestRail account and makes no TestRail request.
 *
 *   node scripts/catalog-hash.mjs [--command testrail-mcp] [--arg ...]
 */
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { startFixtureTestRail } from './fixture-testrail.mjs';

export function catalogHash(names) {
  return createHash('sha256').update([...names].sort().join('\n')).digest('hex');
}

async function listAll(client) {
  const names = [];
  let cursor;
  do {
    const page = await client.listTools(cursor === undefined ? {} : { cursor }, { cacheMode: 'bypass' });
    names.push(...page.tools.map(({ name }) => name));
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return names;
}

export async function listCatalog({ command, args = [] }) {
  const standIn = await startFixtureTestRail();
  const directory = await mkdtemp(join(tmpdir(), 'testrail-mcp-catalog-'));
  const env = { ...process.env, ...standIn.environment, TESTRAIL_MCP_UPLOAD_ROOTS: '[]', TESTRAIL_MCP_DOWNLOAD_DIR: directory };
  try {
    const eras = {};
    for (const [label, versionNegotiation] of [['legacy', { mode: 'legacy' }], ['2026-07-28', { mode: { pin: '2026-07-28' } }]]) {
      const client = new Client({ name: 'catalog-hash', version: '1.0.0' }, { versionNegotiation });
      await client.connect(new StdioClientTransport({ command, args, env, stderr: 'ignore' }));
      try {
        const names = await listAll(client);
        eras[label] = { count: names.length, sorted_names_sha256: catalogHash(names), duplicates: names.length - new Set(names).size };
      } finally {
        await client.close();
      }
    }
    return { eras, testrail_requests: standIn.requests.length };
  } finally {
    await standIn.close();
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { values } = parseArgs({ options: { command: { type: 'string', default: 'testrail-mcp' }, arg: { type: 'string', multiple: true, default: [] } } });
  listCatalog({ command: values.command, args: values.arg }).then(
    (result) => { process.stdout.write(`${JSON.stringify(result, null, 2)}\n`); },
    (error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exit(1); },
  );
}
