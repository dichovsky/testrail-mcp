#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseCommandLine } from './config/command-line.js';
import { ConfigurationError } from './config/errors.js';
import { startServer } from './transport/server.js';

const help = `TestRail MCP server

Usage: testrail-mcp [--help | --version]

Options:
  -h, --help     Show this help without loading TestRail configuration.
  -v, --version  Print the installed package version.

With no arguments the server speaks MCP over stdio. Standard output carries
protocol messages only; diagnostics go to standard error.
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
    try {
      await startServer(process.env);
    } catch (error) {
      // A configuration failure names its key and never its value. Any other startup
      // failure is reported without its message, which may embed the configured host.
      process.stderr.write(`${error instanceof ConfigurationError ? error.message : 'Unable to start the server.'}\n`);
      process.exitCode = 1;
    }
    break;
  case 'invalid':
    process.stderr.write('Unknown arguments. Run testrail-mcp --help for usage.\n');
    process.exitCode = 2;
    break;
}
