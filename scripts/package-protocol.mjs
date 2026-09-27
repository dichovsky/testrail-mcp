import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { Client, parseJSONRPCMessage, ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

/*
 * MCP sessions against the installed package's executable, in both protocol eras.
 *
 * The in-memory protocol tests exercise the server module; these exercise what npm
 * actually installs, over real pipes, with a real TestRail stand-in on the loopback
 * interface. A transport of our own records every byte the server writes to stdout, so
 * anything that is not a protocol message fails the check rather than being skipped by
 * a lenient parser.
 */

const API_KEY = 'synthetic-package-protocol-key-must-not-appear';
const EMAIL = 'package-protocol@example.test';
const CREDENTIAL = Buffer.from(`${EMAIL}:${API_KEY}`).toString('base64');
/** The configured identity in every form a leak could take, the request header's included. */
const IDENTITY = [API_KEY, CREDENTIAL, EMAIL];
const PROJECT = { id: 7, name: 'Packaged project' };
/** How long a host waits for the server to leave on its own once stdin closes. */
const STDIN_EXIT_MS = 10_000;

/** A stdio client transport that keeps everything the server writes to stdout and stderr. */
class RecordingStdioTransport {
  constructor(command, args, env) {
    this.command = command;
    this.args = args;
    this.env = env;
    this.lines = [];
    this.stderr = '';
    /** Set when the server had to be killed because it did not exit after stdin closed. */
    this.forced = false;
  }

  start() {
    this.child = spawn(this.command, this.args, { env: this.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    // 'close' follows the end of every stdio stream, so all output has been recorded by then.
    this.closed = new Promise((resolve) => {
      this.child.on('close', (code, signal) => { resolve({ code, signal }); });
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
    // Output that ends without a newline still reaches the host's stream.
    this.child.stdout.on('end', () => {
      if (buffer === '') return;
      this.lines.push(buffer);
      buffer = '';
    });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => { this.stderr += chunk; });
    // A server that has already exited makes writes fail; the checks report why.
    this.child.stdin.on('error', () => undefined);
    this.child.on('error', (error) => { this.onerror?.(error); });
    this.child.on('close', () => { this.onclose?.(); });
    return Promise.resolve();
  }

  send(message) {
    return new Promise((resolve, reject) => {
      this.child.stdin.write(`${JSON.stringify(message)}\n`, (error) => { if (error) reject(error); else resolve(); });
    });
  }

  /**
   * Close stdin, as a host does, and wait for the server to exit on its own. A server
   * still running after the wait is killed outright, so the check neither hangs nor
   * mistakes a signal-driven shutdown for the exit it requires.
   */
  async close() {
    if (this.child === undefined) return;
    if (!this.stdinClosed) {
      this.stdinClosed = true;
      this.child.stdin.end();
    }
    const timer = setTimeout(() => {
      this.forced = true;
      this.child.kill('SIGKILL');
    }, STDIN_EXIT_MS);
    this.exit = await this.closed;
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
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => { resolve(); });
    }),
  };
}

/**
 * The server's environment. Node's process warnings are silenced, so every stderr line
 * must be one of the server's own diagnostic events: the driver warns that plain HTTP,
 * which this loopback stand-in needs, is enabled, and a server that wrote its diagnostics
 * as warnings would otherwise hide among such lines. NODE_OPTIONS is not passed on.
 */
function serverEnvironment(env, baseUrl, downloadDirectory) {
  const inherited = { ...env };
  delete inherited.NODE_OPTIONS;
  return {
    ...inherited,
    NODE_NO_WARNINGS: '1',
    TESTRAIL_BASE_URL: baseUrl,
    TESTRAIL_ALLOW_INSECURE: 'true',
    TESTRAIL_ALLOW_PRIVATE_HOSTS: 'true',
    TESTRAIL_EMAIL: EMAIL,
    TESTRAIL_API_KEY: API_KEY,
    TESTRAIL_MCP_UPLOAD_ROOTS: '[]',
    TESTRAIL_MCP_DOWNLOAD_DIR: downloadDirectory,
  };
}

/** Every page of the catalog, fetched from the server: the client's response cache is bypassed. */
async function listAll(client) {
  const tools = [];
  let cursor;
  do {
    const page = await client.listTools(cursor === undefined ? {} : { cursor }, { cacheMode: 'bypass' });
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
 * Diagnostics stay on stderr as one JSON event object per line, and they are there: the
 * server announces its start, and a server that shut down on its own announces that too.
 */
function checkStderr(label, stderr, required) {
  const events = [];
  for (const line of stderr.split(/\r?\n/u).filter((candidate) => candidate !== '')) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      assert.fail(`${label}: stderr line is not JSON: ${line.slice(0, 200)}`);
    }
    assert.ok(typeof event === 'object' && event !== null && !Array.isArray(event) && typeof event.event === 'string',
      `${label}: stderr line is not a diagnostic event: ${line.slice(0, 200)}`);
    events.push(event.event);
  }
  for (const name of required) assert.ok(events.includes(name), `${label}: no ${name} diagnostic on stderr.`);
}

/** Neither stream may carry the configured identity or the TestRail address. */
function checkNoSecrets(label, baseUrl, streams) {
  for (const [name, text] of Object.entries(streams)) {
    for (const secret of IDENTITY) assert.ok(!text.includes(secret), `${label}: ${name} carried the configured credential or email.`);
    assert.ok(!text.includes(baseUrl), `${label}: ${name} carried the configured TestRail address.`);
  }
}

/**
 * One session: discovery, a successful call, a refused argument and an unknown tool,
 * then the connection's close. `progress.step` names the step under way, for a failure.
 */
async function session({ label, negotiation, expectedEra, transport, testRail, tools, progress }) {
  const client = new Client({ name: `package-protocol-${label}`, version: '1.0.0' }, { versionNegotiation: { mode: negotiation } });
  const errors = [];
  client.onerror = (error) => { errors.push(error); };
  progress.step = 'connect';
  await client.connect(transport);
  // Read from the connection, not inferred from the negotiation mode asked for.
  progress.step = 'negotiation';
  assert.equal(client.getProtocolEra(), expectedEra, `${label}: negotiated the ${client.getProtocolEra()} era.`);

  progress.step = 'discovery';
  const first = await listAll(client);
  const second = await listAll(client);
  assert.equal(testRail.requests.length, 0, `${label}: discovery contacted TestRail.`);
  const names = first.map(({ name }) => name);
  assert.equal(names.length, tools.length, `${label}: expected ${tools.length} tools, listed ${names.length}.`);
  assert.deepEqual([...names].sort(), [...tools].sort(), `${label}: listed tools differ from the inventory.`);
  assert.equal(JSON.stringify(second), JSON.stringify(first), `${label}: repeated discovery differs.`);

  progress.step = 'testrail_get_project';
  const success = await client.callTool({ name: 'testrail_get_project', arguments: { project_id: 7 } });
  assert.notEqual(success.isError, true, `${label}: get_project failed: ${JSON.stringify(success.structuredContent)}`);
  assert.deepEqual(structured(success).data, PROJECT, `${label}: get_project returned other data.`);
  assert.equal(testRail.requests.length, 1, `${label}: expected one TestRail request.`);
  const [request] = testRail.requests;
  assert.equal(request.method, 'GET');
  assert.equal(request.url, '/index.php?/api/v2/get_project/7');
  assert.equal(request.authorization, `Basic ${CREDENTIAL}`);

  progress.step = 'refused argument';
  const refused = await client.callTool({ name: 'testrail_get_project', arguments: { project_id: '7' } });
  assert.equal(refused.isError, true, `${label}: a string ID was accepted.`);
  assert.equal(structured(refused).error.code, 'INVALID_ARGUMENT');
  assert.equal(testRail.requests.length, 1, `${label}: a refused argument reached TestRail.`);

  // The protocol's own answer to an unknown tool, not a timeout or a dropped connection.
  progress.step = 'unknown tool';
  await assert.rejects(client.callTool({ name: 'testrail_not_a_tool', arguments: {} }, { timeout: 15_000 }), (error) => {
    assert.ok(ProtocolError.isInstance(error) && error.code === ProtocolErrorCode.InvalidParams,
      `${label}: an unknown tool failed with ${error?.name}: ${error?.message}, not the protocol's invalid-params error.`);
    return true;
  });
  // And the server is still serving afterwards.
  assert.equal((await listAll(client)).length, tools.length, `${label}: the server stopped serving after an unknown tool.`);

  progress.step = 'close';
  await client.close();
  assert.deepEqual(errors, [], `${label}: the client reported errors: ${errors.map(String).join('; ')}`);
  return { tools: names.length };
}

/** Name the session, step and exit, and keep the server's last words, when a session fails. */
function failure(label, progress, error, exit, stderr) {
  const status = exit === undefined ? '' : `; the server exited with ${exit.code ?? exit.signal}`;
  const tail = stderr.trim() === '' ? '' : `; its stderr ended: ${stderr.trim().slice(-800)}`;
  return new Error(`${label} session failed at ${progress.step}: ${(error instanceof Error ? error.message : String(error)).trim()}${status}${tail}`, { cause: error });
}

/**
 * @param {{ command: string, args: string[], env: Record<string, string>, downloadDirectory: string, tools: string[] }} options
 */
export async function verifyProtocol({ command, args, env, downloadDirectory, tools }) {
  const verdicts = [];

  // Two sessions over the recording transport: every stdout byte and the exit are checked.
  for (const [label, negotiation, expectedEra] of [
    ['legacy', 'legacy', 'legacy'],
    ['2026-07-28', { pin: '2026-07-28' }, 'modern'],
  ]) {
    const testRail = await startTestRail();
    const transport = new RecordingStdioTransport(command, args, serverEnvironment(env, testRail.baseUrl, downloadDirectory));
    const progress = { step: 'start' };
    try {
      const verdict = await session({ label, negotiation, expectedEra, transport, testRail, tools, progress });
      progress.step = 'exit';
      await transport.close();
      assert.equal(transport.forced, false, `${label}: the server was still running ${STDIN_EXIT_MS / 1000} s after stdin closed.`);
      assert.deepEqual(transport.exit, { code: 0, signal: null }, `${label}: the server exited with ${JSON.stringify(transport.exit)} after stdin closed.`);
      // Every stdout line, the last one included, is a complete JSON-RPC message: a request,
      // a notification, or a response with a result or an error. The client validates only
      // the lines it received, and a final unterminated line never reaches it.
      progress.step = 'output';
      assert.ok(transport.lines.length > 0, `${label}: no protocol output.`);
      for (const line of transport.lines) {
        let message;
        try { message = JSON.parse(line); } catch { assert.fail(`${label}: stdout carried a line that is not JSON: ${line.slice(0, 200)}`); }
        assert.doesNotThrow(() => parseJSONRPCMessage(message), `${label}: stdout line is not a JSON-RPC message: ${line.slice(0, 200)}`);
      }
      checkStderr(label, transport.stderr, ['server_started', 'server_stopped']);
      checkNoSecrets(label, testRail.baseUrl, { stdout: transport.lines.join('\n'), stderr: transport.stderr });
      verdicts.push(`${label}: ${verdict.tools} tools`);
    } catch (error) {
      await transport.close().catch(() => undefined);
      throw failure(label, progress, error, transport.exit, transport.stderr);
    } finally {
      await transport.close().catch(() => undefined);
      await testRail.close();
    }
  }

  /*
   * A host that negotiates automatically, through the SDK's own stdio transport, which
   * probes a short-lived sibling process before starting the session. It runs the same
   * calls and must settle on the modern era. The SDK owns this session's pipes and ends
   * the process itself, so its raw stdout, exit and exit status are the recorded
   * sessions' to check and report; its stderr is checked here.
   */
  const testRail = await startTestRail();
  const transport = new StdioClientTransport({ command, args, stderr: 'pipe', env: serverEnvironment(env, testRail.baseUrl, downloadDirectory) });
  let stderr = '';
  transport.stderr?.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  const progress = { step: 'start' };
  try {
    const verdict = await session({ label: 'auto', negotiation: 'auto', expectedEra: 'modern', transport, testRail, tools, progress });
    checkStderr('auto', stderr, ['server_started']);
    checkNoSecrets('auto', testRail.baseUrl, { stderr });
    verdicts.push(`auto: ${verdict.tools} tools`);
  } catch (error) {
    throw failure('auto', progress, error, undefined, stderr);
  } finally {
    await transport.close().catch(() => undefined);
    await testRail.close();
  }
  return verdicts;
}
