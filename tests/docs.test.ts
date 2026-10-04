import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigurationError, loadConfiguration } from '../src/config/environment.js';
import { DEFAULT_LIMITS, FIXED_BUDGETS, LIMIT_CEILINGS } from '../src/config/limits.js';
import { ERROR_CODES } from '../src/contracts/errors.js';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../src/contracts/pagination.js';
import { BODY_TIMEOUT_MS, REQUEST_TIMEOUT_MS } from '../src/driver/configuration.js';

/*
 * R02/R03: the README and the client setup guide must match what ships. They must name
 * exactly the variables the server reads, with the same requiredness as the configuration
 * contract; give the limits and budgets the code enforces; name only outcomes a client
 * can see; and hold client examples that parse, launch the packaged executable and
 * forward exactly those variables with the documented 120-second timeout.
 */

// Windows checkouts may carry CRLF line endings; the checks read documents as LF.
const read = async (path: string): Promise<string> => (await readFile(new URL(path, import.meta.url), 'utf8')).replace(/\r\n/gu, '\n');
const readme = await read('../README.md');
const clients = await read('../docs/client-compatibility.md');
const contracts = await read('../docs/implementation-contracts.md');
const packageJson = JSON.parse(await read('../package.json')) as { name: string; bin: Record<string, string> };
const inventory = JSON.parse(await read('../docs/operation-inventory.json')) as { operations: { tool: string; pagination: { kind: string } }[] };

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

  it('documents exactly the variables the server reads', async () => {
    const touched = new Set<string>();
    const environment = new Proxy(full(), {
      get: (target, key, receiver) => {
        if (typeof key === 'string') touched.add(key);
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    await loadConfiguration(environment);
    expect([...touched].sort()).toEqual([...documented.keys()].sort());
  });

  it('gives a Windows upload root that is valid JSON and an absolute Windows path', () => {
    const row = readme.split('\n').find((line) => line.startsWith('| `TESTRAIL_MCP_UPLOAD_ROOTS` |')) ?? '';
    const roots = JSON.parse(/On Windows[^`]*`(\[[^`]+\])`/u.exec(row)?.[1] ?? 'null') as unknown;
    // Drive-qualified or UNC, as src/config/environment.ts requires on Windows: a path rooted
    // on the current drive is absolute to Node but refused by the server.
    const usable = (root: unknown): boolean => typeof root === 'string' && win32.isAbsolute(root) && !/^[\\/]$/u.test(win32.parse(root).root);
    expect(Array.isArray(roots) && roots.length > 0 && roots.every(usable)).toBe(true);
  });

  it('installs the latest release from npm, or the tarball npm packs by its file name, and runs the executable', async () => {
    const section = /^## Install\n([\s\S]*?)^## /mu.exec(readme)?.[1] ?? '';
    const [released, packed] = [...section.matchAll(/```sh\n([\s\S]*?)```/gu)].map(([, block]) => block?.split('\n'));
    // The newest dated changelog section is the latest release.
    const latest = /^## \[(\d+\.\d+\.\d+)\] - \d{4}-\d{2}-\d{2}$/mu.exec(await readFile(new URL('../CHANGELOG.md', import.meta.url), 'utf8'))?.[1];
    expect(released).toEqual([`npm install --global ${packageJson.name}@${latest ?? 'no dated release'}`, `${BIN} --version`, '']);
    const tarball = `${packageJson.name.replace(/^@/u, '').replace('/', '-')}-<version>.tgz`;
    expect(packed).toEqual(['npm ci', 'npm pack', `npm install --global ./${tarball}`, `${BIN} --version`, '']);
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
    const cell = (text: string): number => {
      const [, bytes = '', mib] = /^(\d+)(?: \((\d+(?:\.\d+)?) MiB\))?$/u.exec(text) ?? [];
      // A MiB figure beside a byte count is that count in MiB.
      if (mib !== undefined) expect(Number(mib) * 1024 * 1024, text).toBe(Number(bytes));
      return bytes === '' ? Number.NaN : Number(bytes);
    };
    const rows = [...readme.matchAll(/^\| `(max_[a-z_]+)` \| ([^|]+) \| ([^|]+) \|$/gmu)]
      .map(([, key, value = '', ceiling = '']) => [key, cell(value), cell(ceiling)]);
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

  it('names the lists that choose their own pages: exactly the inventory\'s response-driven lists', () => {
    const driven = inventory.operations.filter(({ pagination }) => pagination.kind === 'response_driven').map(({ tool }) => tool).sort();
    const bullet = readme.split('\n').find((line) => line.includes('lists choose their own pages')) ?? '';
    expect(bullet).toContain(`${['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six'][driven.length] ?? driven.length} lists choose their own pages`);
    expect([...bullet.matchAll(/`(testrail_[a-z_]+)`/gu)].map(([, tool]) => tool).sort()).toEqual(driven);
  });

  it('counts the paged lists and those that take a page size, and gives only unpaged lists as ones that return the whole reply', () => {
    const kinds = new Map(inventory.operations.map(({ tool, pagination }) => [tool, pagination.kind]));
    const paged = [...kinds.values()].filter((kind) => kind !== 'none').length;
    const controlled = [...kinds.values()].filter((kind) => kind === 'controlled').length;
    const bullet = readme.split('\n').find((line) => line.startsWith('- **Lists.**')) ?? '';
    // Only the controlled lists take a page size; the response-driven ones choose their own.
    expect(bullet).toContain(`${String(paged)} lists are paged. ${String(controlled)} of them return one page of`);
    expect(bullet).toContain(`On any of the ${String(paged)}, set \`_mcp.pagination\``);
    const whole = [...(/Other lists, such as (.*?), return TestRail's whole reply/u.exec(bullet)?.[1] ?? '').matchAll(/`(testrail_[a-z_]+)`/gu)].map(([, tool]) => tool);
    expect(whole.length).toBeGreaterThan(0);
    expect(whole.filter((tool) => kinds.get(tool ?? '') !== 'none')).toEqual([]);
  });

  it('names only error codes a client can receive, and write outcomes the server returns', () => {
    // Every code-like name anywhere in the README, other than a variable: the server's own,
    // or one of the Node and proxy variables its network note names.
    const environment = ['HTTP_PROXY', 'HTTPS_PROXY', 'NODE_USE_ENV_PROXY', 'NODE_EXTRA_CA_CERTS'];
    const named = [...readme.matchAll(/`([A-Z][A-Z_]{3,})`/gu)].map(([, code = '']) => code)
      .filter((code) => !code.startsWith('TESTRAIL_') && !environment.includes(code));
    expect(named.length).toBeGreaterThan(0);
    expect(named.filter((code) => !(ERROR_CODES as readonly string[]).includes(code))).toEqual([]);
    // The SDK drops the response to a cancelled call (tests/transport/cancellation.test.ts),
    // so no client ever sees CANCELLED or the outcome that goes with it.
    expect(named).not.toContain('CANCELLED');
    expect(readme).toContain('the client gets no result for that call');
    // Every outcome a line about write_outcome names is one the server returns.
    const stated = readme.split('\n').filter((line) => line.includes('write_outcome'))
      .flatMap((line) => [...line.matchAll(/`([a-z_]+)`/gu)].map(([, word = '']) => word)).filter((word) => word !== 'write_outcome');
    expect(stated.length).toBeGreaterThan(0);
    expect(stated.filter((word) => !['acknowledged', 'not_started', 'unknown'].includes(word))).toEqual([]);
    const errors = readme.split('\n').find((line) => line.startsWith('- **Errors.**')) ?? '';
    // The three outcomes of src/contracts/errors.ts's WriteOutcome, each named at least once.
    expect([...new Set([...errors.matchAll(/`([a-z_]+)`/gu)].map(([, outcome]) => outcome))].filter((outcome) => outcome !== 'write_outcome').sort())
      .toEqual(['acknowledged', 'not_started', 'unknown']);
  });
});

/**
 * The TOML the Codex example is written in: tables, and keys whose values are JSON
 * literals, arrays of them spanning lines included. Anything else is refused, so a
 * malformed example fails rather than being read around.
 */
function parseToml(text: string): Record<string, Record<string, unknown>> {
  const tables: Record<string, Record<string, unknown>> = {};
  let table: Record<string, unknown> | undefined;
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? '';
    if (line === '' || line.startsWith('#')) continue;
    const header = /^\[([a-z_]+(?:\.[a-z_]+)*)\]$/u.exec(line)?.[1];
    if (header !== undefined) {
      if (header in tables) throw new Error(`table ${header} is defined twice`);
      table = tables[header] = {};
      continue;
    }
    const [, key, first] = /^([a-z_]+) = (.+)$/u.exec(line) ?? [];
    if (table === undefined || key === undefined || first === undefined) throw new Error(`not a key in a table: ${line}`);
    if (key in table) throw new Error(`key ${key} is defined twice`);
    let value = first;
    while (value.startsWith('[') && !value.endsWith(']')) {
      index += 1;
      if (index >= lines.length) throw new Error(`array ${key} is not closed`);
      value += lines[index]?.trim() ?? '';
    }
    // TOML allows a trailing comma in an array; JSON does not.
    table[key] = JSON.parse(value.replace(/,\s*\]$/u, ']')) as unknown;
  }
  return tables;
}

describe('the client setup guide', () => {
  const fenced = (text: string, language: string): string[] =>
    [...text.matchAll(new RegExp(`^\`\`\`${language}\\n([\\s\\S]*?)^\`\`\`$`, 'gmu'))].map(([, body = '']) => body);
  const blocks = (language: string): string[] => fenced(clients, language);
  /** The text of one `## ` section of the guide. */
  const section = (title: string): string => clients.split(/^## /mu).find((part) => part.startsWith(`${title}\n`)) ?? '';
  const required = keysWhere('Required');
  const known = [...documented.keys()];

  it('launches the packaged executable by its published name', () => {
    expect(packageJson.name).toBe('@dichovsky/testrail-mcp');
    expect(Object.keys(packageJson.bin)).toEqual([BIN]);
    expect(clients).toContain(`Package: \`${packageJson.name}\`. Executable: \`${BIN}\`.`);
  });

  it('gives Codex one table that parses and forwards the required variables with a 120-second call timeout', () => {
    const tables = blocks('toml');
    expect(tables).toHaveLength(1);
    expect(fenced(section('Codex desktop and CLI'), 'toml')).toEqual(tables);
    const parsed = parseToml(tables[0] ?? '');
    expect(Object.keys(parsed)).toEqual(['mcp_servers.testrail']);
    const { env_vars: forwarded, ...rest } = parsed['mcp_servers.testrail'] ?? {};
    expect([...(forwarded as string[])].sort()).toEqual(required);
    expect(rest).toEqual({ command: BIN, args: [], startup_timeout_sec: expect.any(Number) as unknown, tool_timeout_sec: CLIENT_TIMEOUT_MS / 1000, enabled: true });
  });

  it('refuses TOML the Codex check cannot read', () => {
    expect(() => parseToml('command = "x"')).toThrow(/not a key in a table/u);
    expect(() => parseToml('[a]\nargs = [\n  "x",\n')).toThrow(/not closed/u);
    expect(() => parseToml('[a]\ncommand = x')).toThrow(SyntaxError);
    expect(() => parseToml('[a]\nx = 1\nx = 2')).toThrow(/defined twice/u);
    expect(parseToml('# note\n[a]\nlist = [\n  "x",\n  "y",\n]\nn = 3')).toEqual({ a: { list: ['x', 'y'], n: 3 } });
  });

  it('gives Claude Code and Copilot CLI entries that parse, launch the executable and pass the variables through', () => {
    expect(blocks('json')).toHaveLength(2);
    const entry = (title: string): Record<string, unknown> => {
      const found = fenced(section(title), 'json');
      expect(found, title).toHaveLength(1);
      return (JSON.parse(found[0] ?? '') as { mcpServers: Record<string, Record<string, unknown>> }).mcpServers.testrail ?? {};
    };
    const claude = entry('Claude Code');
    const copilot = entry('GitHub Copilot CLI');
    for (const server of [claude, copilot]) {
      expect(server).toMatchObject({ type: 'stdio', command: BIN, args: [], timeout: CLIENT_TIMEOUT_MS });
      const env = server.env as Record<string, string>;
      expect(Object.keys(env).sort()).toEqual(required);
      expect(Object.entries(env).filter(([key, value]) => value !== `\${${key}}` || !known.includes(key))).toEqual([]);
    }
    // Copilot CLI keeps the whole catalog and its automatic deferral; Claude Code has neither setting.
    expect(copilot).toMatchObject({ tools: ['*'], deferTools: 'auto' });
    expect(Object.keys(claude).filter((key) => ['tools', 'deferTools'].includes(key))).toEqual([]);
  });

  it('lists the required variables in one table and the optional ones in another', () => {
    const tables = clients.split(/\n\n+/u).filter((part) => part.split('\n').every((line) => line.startsWith('|')))
      .map((table) => [...table.matchAll(/^\| `(TESTRAIL_[A-Z_]+)` \|/gmu)].map(([, key]) => key).sort())
      .filter((keys) => keys.length > 0);
    expect(tables).toEqual([required, keysWhere('Optional')]);
  });

  it('points to deterministic checks that exist', async () => {
    const stage = /^### 1\. Deterministic protocol and package checks\n([\s\S]*?)^### /mu.exec(clients)?.[1] ?? '';
    const paths = [...stage.matchAll(/`((?:tests|scripts)\/[^`]+)`/gu)].map(([, path = '']) => path);
    expect(paths.length).toBeGreaterThan(3);
    for (const path of paths) await expect(access(new URL(`../${path}`, import.meta.url)), path).resolves.toBeUndefined();
  });

  it('documents the budgets the code enforces', () => {
    expect(clients).toContain(`Set client tool-call timeouts to ${CLIENT_TIMEOUT_MS / 1000} seconds.`);
    expect(clients).toContain(`separate ${REQUEST_TIMEOUT_MS / 1000}-second driver request and body timeouts, a ${DEFAULT_LIMITS.max_all_duration_ms / 1000}-second aggregation budget and a ${FIXED_BUDGETS.response_wait_ms / 1000}-second response-wait watchdog`);
  });
});
