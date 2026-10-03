// Run the server under an MCP host and record its stdio, for R02 host checks.
//
// Usage: node scripts/record-stdio.mjs --log <file.jsonl> --server <path to dist/cli.js>
//
// The host launches this script in place of the server. It starts the server with the same
// Node, passes stdin, stdout and stderr through unchanged, and appends every line in each
// direction to the log as { at, direction, line }, with direction in, out, err or exit. That
// is how a host's negotiated protocol revision, its cancellations and the server's stderr are
// read afterwards, none of which the host itself shows. Signals are forwarded, and the script
// exits with the server's code. It refuses to start if it cannot write the log.
import { spawn } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { log: { type: 'string' }, server: { type: 'string' } } });
if (values.log === undefined || values.server === undefined) {
  process.stderr.write('Usage: node scripts/record-stdio.mjs --log <file.jsonl> --server <path to dist/cli.js>\n');
  process.exit(2);
}
const log = values.log;
try {
  writeFileSync(log, '', { flag: 'a' });
} catch (error) {
  process.stderr.write(`Cannot write the stdio log ${log}: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
}
const record = (direction, line) => {
  appendFileSync(log, `${JSON.stringify({ at: new Date().toISOString(), direction, line })}\n`);
};

const child = spawn(process.execPath, [values.server], { stdio: ['pipe', 'pipe', 'pipe'] });
function lines(stream, direction, forward) {
  let buffer = '';
  stream.on('data', (chunk) => {
    forward(chunk);
    buffer += chunk.toString('utf8');
    for (let index = buffer.indexOf('\n'); index !== -1; index = buffer.indexOf('\n')) {
      record(direction, buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
    }
  });
  stream.on('end', () => { if (buffer !== '') record(direction, buffer); });
}
lines(process.stdin, 'in', (chunk) => { child.stdin.write(chunk); });
process.stdin.on('end', () => { child.stdin.end(); });
lines(child.stdout, 'out', (chunk) => { process.stdout.write(chunk); });
lines(child.stderr, 'err', (chunk) => { process.stderr.write(chunk); });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { child.kill(signal); });
child.on('exit', (code, signal) => {
  record('exit', JSON.stringify({ code, signal }));
  process.exitCode = code ?? 1;
});
