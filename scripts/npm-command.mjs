import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/**
 * How to run npm without a shell: this Node with npm's own entry point. Going through a
 * shell, cmd.exe on Windows, would split any argument holding a space. npm names its entry
 * point in npm_execpath for the scripts it runs; otherwise npm is found where Node's
 * installers put it, beside node.exe on Windows and under lib/ elsewhere.
 */
export function npmCommand(env = process.env) {
  const home = dirname(process.execPath);
  const candidates = [
    env.npm_execpath,
    join(home, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(home, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  const entry = candidates.find((candidate) => candidate !== undefined && basename(candidate) === 'npm-cli.js' && existsSync(candidate));
  if (entry === undefined) throw new Error('Cannot find npm beside this Node. Run the script through npm, or install npm with Node.');
  return [process.execPath, [entry]];
}
