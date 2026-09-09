#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseCommandLine } from './config/command-line.js';

const help = `TestRail MCP server

Usage: testrail-mcp [--help | --version]

Options:
  -h, --help     Show this help without loading TestRail configuration.
  -v, --version  Print the installed package version.

This development build does not yet serve MCP.
`;

switch (parseCommandLine(process.argv.slice(2))) {
  case 'help':
    process.stdout.write(help);
    break;
  case 'version': {
    try {
      const metadata: unknown = JSON.parse(
        readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
      );
      if (
        metadata === null ||
        typeof metadata !== 'object' ||
        !('version' in metadata) ||
        typeof metadata.version !== 'string'
      ) {
        throw new Error('Invalid package metadata');
      }
      process.stdout.write(`${metadata.version}\n`);
    } catch {
      process.stderr.write('Unable to read package version.\n');
      process.exitCode = 1;
    }
    break;
  }
  case 'serve':
    process.stderr.write('This development build does not yet serve MCP.\n');
    process.exitCode = 1;
    break;
  case 'invalid':
    process.stderr.write('Unknown arguments. Run testrail-mcp --help for usage.\n');
    process.exitCode = 2;
    break;
}
