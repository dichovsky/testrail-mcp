import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { npmCommand } from './npm-command.mjs';

// Acquire the same registry metadata npm needs when it resolves the packaged app.
const { name, version, dependencies } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const directory = mkdtempSync(join(tmpdir(), 'testrail-mcp-cache-'));
const [command, prefix] = npmCommand();
try {
  const source = join(directory, 'source');
  const install = join(directory, 'install');
  mkdirSync(source);
  mkdirSync(install);
  writeFileSync(join(source, 'package.json'), JSON.stringify({ name, version, dependencies }));
  const report = JSON.parse(execFileSync(command, [...prefix, 'pack', '--json', '--ignore-scripts', '--pack-destination', directory],
    { cwd: source, encoding: 'utf8' }));
  const [{ filename }] = Array.isArray(report) ? report : Object.values(report);
  execFileSync(command, [...prefix, 'install', '--ignore-scripts', '--no-audit', '--no-fund', '--engine-strict', join(directory, filename)],
    { cwd: install, stdio: 'inherit' });
} finally {
  rmSync(directory, { recursive: true, force: true });
}
