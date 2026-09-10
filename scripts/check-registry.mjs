import { readFile, writeFile } from 'node:fs/promises';
import { operationRegistry } from '../dist/operations/catalog.js';
import { assertRegistryParity, compareRegistry, parseInventory, renderRegistryReference } from '../dist/operations/parity.js';

const args = process.argv.slice(2);
if (args.some((arg) => arg !== '--write' && arg !== '--complete')) throw new Error('Unsupported registry check argument');
const inventory = parseInventory(JSON.parse(await readFile(new URL('../docs/operation-inventory.json', import.meta.url), 'utf8')));
const report = compareRegistry(operationRegistry, inventory);
assertRegistryParity(report, args.includes('--complete'));
const referenceUrl = new URL('../docs/operation-reference.md', import.meta.url);
const expected = renderRegistryReference(operationRegistry, inventory);
if (args.includes('--write')) {
  await writeFile(referenceUrl, expected);
} else if (await readFile(referenceUrl, 'utf8') !== expected) {
  throw new Error('Operation reference is stale; run npm run registry:generate.');
}
console.log(`Registry parity passed: ${operationRegistry.entries.length}/${inventory.length} implemented; ${report.missing.length} pending; no extra or mismatched bindings.`);
