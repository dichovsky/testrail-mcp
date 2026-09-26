import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

/*
 * MCP sessions against the installed package's executable, in both protocol eras.
 *
 * The in-memory protocol tests exercise the server module; these exercise what npm
 * actually installs, over real pipes, with a real TestRail stand-in on the loopback
 * interface. A transport of our own records every stdout line, so any line that is not
 * a protocol message fails the check rather than being skipped by a lenient parser.
 */

const API_KEY = 'synthetic-package-protocol-key-must-not-appear';
const EMAIL = 'package-protocol@example.test';
const PROJECT = { id: 7, name: 'Packaged project' };

/** A stdio client transport that keeps every raw stdout line and all of stderr. */
class RecordingStdioTransport {
  constructor(command, args, env) {
    this.command = command;
    this.args = args;
    this.env = env;
    this.lines = [];
    this.stderr = '';
  }

  start() {
    this.child = spawn(this.command, this.args, { env: this.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.exited = new Promise((resolve) => {
      this.child.on('exit', (code, signal) => { resolve({ code, signal }); });
    });
    let buffer = '';
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => {
      buffer += chunk;
      for (let end = buffer.indexOf('\n'); end !== -1; end = buffer.indexOf('\n')) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        this.lines.push(line);
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          this.onerror?.(new Error(`stdout carried a line that is not JSON: ${line.slice(0, 200)}`));
          continue;
        }
        this.onmessage?.(message);
      }
    });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => { this.stderr += chunk; });
    this.child.on('error', (error) => { this.onerror?.(error); });
    this.child.on('close', () => { this.onclose?.(); });
    return Promise.resolve();
  }

  send(message) {
    return new Promise((resolve, reject) => {
      this.child.stdin.write(`${JSON.stringify(message)}\n`, (error) => { if (error) reject(error); else resolve(); });
    });
  }

  /** Close stdin, as a host does, and wait for the server to exit on its own. */
  async close() {
    if (this.child === undefined || this.child.exitCode !== null) return;
    this.child.stdin.end();
    const timer = setTimeout(() => { this.child.kill(); }, 10_000);
    await this.exited;
    clearTimeout(timer);
  }
}

/** A TestRail stand-in: answers get_project and records every request it receives. */
async function startTestRail() {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization });
    request.resume();
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(PROJECT));
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => { server.close(() => { resolve(); }); }),
  };
}

async function listAll(client) {
  const tools = [];
  let cursor;
  do {
    const page = await client.listTools(cursor === undefined ? {} : { cursor });
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return tools;
}

function structured(result) {
  assert.equal(result.content.length, 1, 'A result carries exactly one text block.');
  assert.equal(result.content[0].type, 'text');
  // Text and structured content carry the same wrapper.
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent, 'Text and structured content differ.');
  return result.structuredContent;
}

/**
 * One session: discovery, a successful call, a refused argument and an unknown tool,
 * then stdin closure. Returns what the checks need from it.
 */
async function session({ label, negotiation, transport, testRail, tools }) {
  const client = new Client({ name: `package-protocol-${label}`, version: '1.0.0' }, { versionNegotiation: { mode: negotiation } });
  const errors = [];
  client.onerror = (error) => { errors.push(error); };
  await client.connect(transport);
  const era = client.getProtocolEra();
  const first = await listAll(client);
  const second = await listAll(client);
  assert.equal(testRail.requests.length, 0, `${label}: discovery contacted TestRail.`);
  const names = first.map(({ name }) => name);
  assert.equal(names.length, tools.length, `${label}: expected ${tools.length} tools, listed ${names.length}.`);
  assert.deepEqual([...names].sort(), [...tools].sort(), `${label}: listed tools differ from the inventory.`);
  assert.equal(JSON.stringify(second), JSON.stringify(first), `${label}: repeated discovery differs.`);

  const success = await client.callTool({ name: 'testrail_get_project', arguments: { project_id: 7 } });
  assert.notEqual(success.isError, true, `${label}: get_project failed: ${JSON.stringify(success.structuredContent)}`);
  assert.deepEqual(structured(success).data, PROJECT, `${label}: get_project returned other data.`);
  assert.equal(testRail.requests.length, 1, `${label}: expected one TestRail request.`);
  const [request] = testRail.requests;
  assert.equal(request.method, 'GET');
  assert.equal(request.url, '/index.php?/api/v2/get_project/7');
  assert.equal(request.authorization, `Basic ${Buffer.from(`${EMAIL}:${API_KEY}`).toString('base64')}`);

  const refused = await client.callTool({ name: 'testrail_get_project', arguments: { project_id: '7' } });
  assert.equal(refused.isError, true, `${label}: a string ID was accepted.`);
  assert.equal(structured(refused).error.code, 'INVALID_ARGUMENT');
  assert.equal(testRail.requests.length, 1, `${label}: a refused argument reached TestRail.`);

  await assert.rejects(client.callTool({ name: 'testrail_not_a_tool', arguments: {} }), `${label}: an unknown tool did not fail as a protocol error.`);

  await client.close();
  assert.deepEqual(errors, [], `${label}: the client reported errors: ${errors.map(String).join('; ')}`);
  return { era, tools: names.length };
}

/**
 * @param {{ command: string, args: string[], env: Record<string, string>, downloadDirectory: string, tools: string[] }} options
 */
export async function verifyProtocol({ command, args, env, downloadDirectory, tools }) {
  const verdicts = [];
  for (const [label, negotiation, expectedEra] of [
    ['legacy', 'legacy', 'legacy'],
    ['2026-07-28', { pin: '2026-07-28' }, 'modern'],
  ]) {
    const testRail = await startTestRail();
    const serverEnv = {
      ...env,
      TESTRAIL_BASE_URL: testRail.baseUrl,
      TESTRAIL_ALLOW_INSECURE: 'true',
      TESTRAIL_ALLOW_PRIVATE_HOSTS: 'true',
      TESTRAIL_EMAIL: EMAIL,
      TESTRAIL_API_KEY: API_KEY,
      TESTRAIL_MCP_UPLOAD_ROOTS: '[]',
      TESTRAIL_MCP_DOWNLOAD_DIR: downloadDirectory,
    };
    const transport = new RecordingStdioTransport(command, args, serverEnv);
    try {
      const verdict = await session({ label, negotiation, transport, testRail, tools });
      assert.equal(verdict.era, expectedEra, `${label}: negotiated the ${verdict.era} era.`);
      const { code, signal } = await transport.exited;
      assert.equal(code, 0, `${label}: the server exited with ${code ?? signal} after stdin closed.`);
      // Every stdout line is a JSON-RPC message; nothing else ever reaches the host's stream.
      assert.ok(transport.lines.length > 0, `${label}: no protocol output.`);
      for (const line of transport.lines) assert.equal(JSON.parse(line).jsonrpc, '2.0', `${label}: stdout line is not JSON-RPC.`);
      // Diagnostics stay on stderr, one JSON object per line, and never carry the credential.
      // Node's own process warnings share the stream: the driver warns that plain HTTP,
      // which this loopback stand-in needs, is enabled. Those lines are the runtime's.
      const nodeWarning = /^\(node:\d+\) \w*Warning: |^\(Use `node --trace-warnings/u;
      for (const line of transport.stderr.split(/\r?\n/u).filter((candidate) => candidate !== '' && !nodeWarning.test(candidate))) {
        assert.doesNotThrow(() => JSON.parse(line), `${label}: stderr line is not a JSON diagnostic: ${line.slice(0, 200)}`);
      }
      assert.ok(!transport.stderr.includes(API_KEY) && !transport.lines.some((line) => line.includes(API_KEY)), `${label}: the API key was echoed.`);
      verdicts.push(`${label}: ${verdict.tools} tools`);
    } finally {
      await transport.close();
      await testRail.close();
    }
  }

  /*
   * A host that negotiates automatically, through the SDK's own stdio transport, which
   * probes a short-lived sibling process before starting the session. It must settle on
   * the modern era and see the same catalog.
   */
  const testRail = await startTestRail();
  const client = new Client({ name: 'package-protocol-auto', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  try {
    await client.connect(new StdioClientTransport({
      command, args, stderr: 'ignore',
      env: {
        ...env,
        TESTRAIL_BASE_URL: testRail.baseUrl, TESTRAIL_ALLOW_INSECURE: 'true', TESTRAIL_ALLOW_PRIVATE_HOSTS: 'true',
        TESTRAIL_EMAIL: EMAIL, TESTRAIL_API_KEY: API_KEY, TESTRAIL_MCP_UPLOAD_ROOTS: '[]', TESTRAIL_MCP_DOWNLOAD_DIR: downloadDirectory,
      },
    }));
    assert.equal(client.getProtocolEra(), 'modern', 'auto: did not settle on the modern era.');
    assert.equal((await listAll(client)).length, tools.length, 'auto: listed a different number of tools.');
    assert.equal(testRail.requests.length, 0, 'auto: discovery contacted TestRail.');
    verdicts.push(`auto: ${tools.length} tools`);
  } finally {
    await client.close().catch(() => undefined);
    await testRail.close();
  }
  return verdicts;
}
