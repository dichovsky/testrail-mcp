import { spawnSync } from 'node:child_process';
import { chmodSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = new URL('../dist/', import.meta.url);
rmSync(output, { recursive: true, force: true });

const compiler = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url));
const result = spawnSync(process.execPath, [compiler, '--project', 'tsconfig.build.json'], {
  cwd: root,
  stdio: 'inherit',
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

chmodSync(new URL('cli.js', output), 0o755);
