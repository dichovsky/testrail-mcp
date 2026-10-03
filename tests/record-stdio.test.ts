import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const recorder = fileURLToPath(new URL('../scripts/record-stdio.mjs', import.meta.url));
const directories: string[] = [];

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'record-stdio-'));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function run(args: string[], input: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [recorder, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => { resolve({ code, stdout, stderr }); });
    child.stdin.end(input);
  });
}

/*
 * The R02 runbook launches the server through this recorder, and the host records are
 * written from its log: the revision a host negotiated and the cancellations it sent are
 * read there. So it must pass every byte through unchanged and log each line as it went.
 */
describe('the stdio recorder', () => {
  it('passes stdio through unchanged, logs every line by direction, and exits with the server\'s code', async () => {
    const directory = await scratch();
    const server = join(directory, 'server.mjs');
    await writeFile(server, [
      "process.stderr.write('ready\\n');",
      "let input = '';",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => { process.stdout.write(input.toUpperCase()); process.exitCode = 3; });",
    ].join('\n'));
    const log = join(directory, 'stdio.jsonl');
    const result = await run(['--log', log, '--server', server], '{"a":1}\n{"b":2}\n');
    expect(result).toEqual({ code: 3, stdout: '{"A":1}\n{"B":2}\n', stderr: 'ready\n' });
    const entries = (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { direction: string; line: string; at: string });
    expect(entries.map(({ direction, line }) => [direction, line])).toEqual(expect.arrayContaining([
      ['in', '{"a":1}'], ['in', '{"b":2}'], ['out', '{"A":1}'], ['out', '{"B":2}'], ['err', 'ready'],
    ]));
    expect(entries.at(-1)).toMatchObject({ direction: 'exit', line: JSON.stringify({ code: 3, signal: null }) });
    expect(entries.every(({ at }) => !Number.isNaN(Date.parse(at)))).toBe(true);
  });

  it('refuses to start without its arguments, or when it cannot write the log', async () => {
    const directory = await scratch();
    const usage = await run(['--log', join(directory, 'stdio.jsonl')], '');
    expect(usage.code).toBe(2);
    expect(usage.stderr).toMatch(/^Usage: /u);
    const unwritable = await run(['--log', directory, '--server', join(directory, 'absent.mjs')], '');
    expect(unwritable.code).toBe(2);
    expect(unwritable.stderr).toMatch(/^Cannot write the stdio log /u);
  });
});
