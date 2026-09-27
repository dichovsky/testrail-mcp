import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigurationError, loadConfiguration } from '../src/config/environment.js';
import { DEFAULT_LIMITS, FIXED_BUDGETS, LIMIT_CEILINGS } from '../src/config/limits.js';
import { ERROR_CODES } from '../src/contracts/errors.js';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../src/contracts/pagination.js';
import { BODY_TIMEOUT_MS, REQUEST_TIMEOUT_MS } from '../src/driver/configuration.js';

/*
 * R02/R03: the README and the client setup guide must match what ships. They must name
 * the variables the server reads, with the same requiredness as the configuration
 * contract; give the limits and budgets the code enforces; and hold client examples that
 * parse, launch the packaged executable and forward exactly those variables with the
 * documented 120-second timeout.
 */

// Windows checkouts may carry CRLF line endings; the checks read documents as LF.
const read = async (path: string): Promise<string> => (await readFile(new URL(path, import.meta.url), 'utf8')).replace(/\r\n/gu, '\n');
const readme = await read('../README.md');
const clients = await read('../docs/client-compatibility.md');
const contracts = await read('../docs/implementation-contracts.md');
const packageJson = JSON.parse(await read('../package.json')) as { name: string; bin: Record<string, string> };

type Requiredness = 'Required' | 'Optional';
const variables = (markdown: string): Map<string, Requiredness> => new Map(
  [...markdown.matchAll(/^\| `(TESTRAIL_[A-Z_]+)` \| (Required|Optional)\b/gmu)].map(([, key = '', level]) => [key, level as Requiredness]),
);
const documented = variables(readme);
const contracted = variables(contracts);
const keysWhere = (level: Requiredness): string[] => [...documented].filter(([, value]) => value === level).map(([key]) => key).sort();

const CLIENT_TIMEOUT_MS = 120_000;
const BIN = 'testrail-mcp';

describe('the README\'s configuration', () => {
  let base: string;
  beforeAll(async () => { base = await mkdtemp(join(tmpdir(), 'testrail-mcp-docs-')); });
  afterAll(async () => { await rm(base, { recursive: true, force: true }); });

  const full = (): Record<string, string> => ({
    TESTRAIL_BASE_URL: 'https://example.testrail.io',
    TESTRAIL_EMAIL: 'user@example.com',
    TESTRAIL_API_KEY: 'synthetic-key',
    TESTRAIL_MCP_UPLOAD_ROOTS: JSON.stringify([base]),
    TESTRAIL_MCP_DOWNLOAD_DIR: base,
    TESTRAIL_MCP_LIMITS: '{}',
    TESTRAIL_ALLOW_PRIVATE_HOSTS: 'false',
    TESTRAIL_ALLOW_INSECURE: 'false',
  });

  it('names the variables of the configuration contract, each with the contract\'s requiredness', () => {
    expect(documented.size).toBe(8);
    expect([...documented].sort()).toEqual([...contracted].sort());
    // Every variable a valid environment sets is documented, and nothing else is.
    expect([...documented.keys()].sort()).toEqual(Object.keys(full()).sort());
  });

  it('marks as required exactly the variables whose absence stops startup', async () => {
    await expect(loadConfiguration(full())).resolves.toBeDefined();
    for (const key of keysWhere('Required')) {
      const environment = full();
      delete environment[key];
      await expect(loadConfiguration(environment), key).rejects.toEqual(new ConfigurationError(key as ConfigurationError['key']));
    }
    for (const key of keysWhere('Optional')) {
      const environment = full();
      delete environment[key];
      await expect(loadConfiguration(environment), key).resolves.toBeDefined();
      // The server does read it: an unusable value stops startup and names the variable.
      await expect(loadConfiguration({ ...full(), [key]: 'maybe' }), key).rejects.toEqual(new ConfigurationError(key as ConfigurationError['key']));
    }
  });

  it('lists every limit with the default and ceiling the code enforces', () => {
    const rows = [...readme.matchAll(/^\| `(max_[a-z_]+)` \| (\d+)\b[^|]*\| (\d+)\b[^|]*\|$/gmu)]
      .map(([, key, value, ceiling]) => [key, Number(value), Number(ceiling)]);
    expect(rows).toEqual(Object.keys(DEFAULT_LIMITS).map((key) =>
      [key, DEFAULT_LIMITS[key as keyof typeof DEFAULT_LIMITS], LIMIT_CEILINGS[key as keyof typeof LIMIT_CEILINGS]]));
  });

  it('states the request, response-wait and page budgets the code enforces', () => {
    expect(REQUEST_TIMEOUT_MS).toBe(BODY_TIMEOUT_MS);
    expect(readme).toContain(`own ${REQUEST_TIMEOUT_MS / 1000}-second request and body timeouts`);
    expect(readme).toContain(`no answer within ${FIXED_BUDGETS.response_wait_ms / 1000} seconds is reported as \`TIMEOUT\``);
    expect(readme).toContain(`one page of ${DEFAULT_PAGE_SIZE} by default, and up to ${MAX_PAGE_SIZE} on request`);
    expect(readme).toContain(`${CLIENT_TIMEOUT_MS / 1000}-second tool-call timeout`);
  });

  it('names the lists that choose their own pages: exactly the inventory\'s response-driven lists', async () => {
    const inventory = JSON.parse(await read('../docs/operation-inventory.json')) as { operations: { tool: string; pagination: { kind: string } }[] };
    const driven = inventory.operations.filter(({ pagination }) => pagination.kind === 'response_driven').map(({ tool }) => tool).sort();
    const bullet = readme.split('\n').find((line) => line.includes('lists choose their own pages')) ?? '';
    expect(bullet).toContain(`${['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six'][driven.length] ?? driven.length} lists choose their own pages`);
    expect([...bullet.matchAll(/`(testrail_[a-z_]+)`/gu)].map(([, tool]) => tool).sort()).toEqual(driven);
  });

  it('names only error codes and write outcomes the server can return', () => {
    const errors = readme.split('\n').find((line) => line.startsWith('- **Errors.**')) ?? '';
    const named = [...errors.matchAll(/`([A-Z_]{4,})`/gu)].map(([, code]) => code);
    expect(named.length).toBeGreaterThan(0);
    expect(named.filter((code) => !(ERROR_CODES as readonly (string | undefined)[]).includes(code))).toEqual([]);
    // The three outcomes of src/contracts/errors.ts's WriteOutcome, each named at least once.
    expect([...new Set([...errors.matchAll(/`([a-z_]+)`/gu)].map(([, outcome]) => outcome))].filter((outcome) => outcome !== 'write_outcome').sort())
      .toEqual(['acknowledged', 'not_started', 'unknown']);
  });
});

describe('the client setup guide', () => {
  const blocks = (language: string): string[] =>
    [...clients.matchAll(new RegExp(`^\`\`\`${language}\\n([\\s\\S]*?)^\`\`\`$`, 'gmu'))].map(([, body = '']) => body);
  const required = keysWhere('Required');
  const known = [...documented.keys()];

  it('launches the packaged executable by its published name', () => {
    expect(packageJson.name).toBe('@dichovsky/testrail-mcp');
    expect(Object.keys(packageJson.bin)).toEqual([BIN]);
    expect(clients).toContain(`Package: \`${packageJson.name}\`. Executable: \`${BIN}\`.`);
  });

  it('gives Codex a table that forwards the required variables with a 120-second call timeout', () => {
    const tables = blocks('toml');
    expect(tables).toHaveLength(1);
    const [table = ''] = tables;
    expect(table).toMatch(/^\[mcp_servers\.testrail\]$/mu);
    expect(/^command = "([^"]+)"$/mu.exec(table)?.[1]).toBe(BIN);
    expect(table).toMatch(/^args = \[\]$/mu);
    const forwarded = [...(/^env_vars = \[([\s\S]*?)\]$/mu.exec(table)?.[1] ?? '').matchAll(/"([A-Z_]+)"/gu)].map(([, key]) => key);
    expect(forwarded.sort()).toEqual(required);
    expect(Number(/^tool_timeout_sec = (\d+)$/mu.exec(table)?.[1])).toBe(CLIENT_TIMEOUT_MS / 1000);
    expect(table).toMatch(/^enabled = true$/mu);
  });

  it('gives Claude Code and Copilot CLI entries that parse, launch the executable and pass the variables through', () => {
    const entries = blocks('json').map((block) => (JSON.parse(block) as { mcpServers: Record<string, Record<string, unknown>> }).mcpServers.testrail);
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(entry).toMatchObject({ type: 'stdio', command: BIN, args: [], timeout: CLIENT_TIMEOUT_MS });
      const env = entry?.env as Record<string, string>;
      expect(Object.keys(env).sort()).toEqual(required);
      expect(Object.entries(env).filter(([key, value]) => value !== `\${${key}}` || !known.includes(key))).toEqual([]);
    }
    // Copilot CLI keeps the whole catalog and its automatic deferral.
    expect(entries.filter((entry) => entry && 'tools' in entry)).toEqual([expect.objectContaining({ tools: ['*'], deferTools: 'auto' })]);
  });

  it('documents every optional variable and the budgets the code enforces', () => {
    for (const key of keysWhere('Optional')) expect(clients).toContain(`| \`${key}\` |`);
    expect(clients).toContain(`Set client tool-call timeouts to ${CLIENT_TIMEOUT_MS / 1000} seconds.`);
    expect(clients).toContain(`separate ${REQUEST_TIMEOUT_MS / 1000}-second driver request and body timeouts, a ${DEFAULT_LIMITS.max_all_duration_ms / 1000}-second aggregation budget and a ${FIXED_BUDGETS.response_wait_ms / 1000}-second response-wait watchdog`);
  });
});
