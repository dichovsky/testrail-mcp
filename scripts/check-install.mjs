import { readFileSync } from 'node:fs';

/**
 * Each direct dependency whose installed version is not the one package-lock.json
 * records, as a line naming both. A checkout that pulled new pins without reinstalling
 * would otherwise build against the old packages and fail with type errors that do not
 * say why.
 */
export function staleDependencies(root = new URL('../', import.meta.url)) {
  const read = (path) => JSON.parse(readFileSync(new URL(path, root), 'utf8'));
  const { dependencies = {}, devDependencies = {} } = read('package.json');
  const { packages } = read('package-lock.json');
  const stale = [];
  for (const name of Object.keys({ ...dependencies, ...devDependencies }).sort()) {
    const locked = packages[`node_modules/${name}`]?.version;
    let installed;
    try {
      installed = read(`node_modules/${name}/package.json`).version;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (locked === undefined) stale.push(`${name}: not in package-lock.json`);
    else if (installed === undefined) stale.push(`${name}: not installed, package-lock.json has ${locked}`);
    else if (installed !== locked) stale.push(`${name}: installed ${installed}, package-lock.json has ${locked}`);
  }
  return stale;
}

/** Stops the process with the stale dependencies named, or returns when there are none. */
export function requireLockedInstall(root) {
  const stale = staleDependencies(root);
  if (stale.length === 0) return;
  process.stderr.write(`The installed dependencies do not match package-lock.json:\n${stale.map((line) => `  ${line}\n`).join('')}Run npm ci, then try again.\n`);
  process.exit(1);
}
