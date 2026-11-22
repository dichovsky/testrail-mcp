import { once } from 'node:events';
import { mkdtemp, open, readdir, rm } from 'node:fs/promises';
import { createServer, type RequestListener, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfiguration } from '../src/config/environment.js';
import { createConfiguredDriver } from '../src/driver/configuration.js';
import { createStagingArea } from '../src/files/staging.js';
import { operationRegistry } from '../src/operations/catalog.js';
import type { Operation } from '../src/operations/registry.js';
import { createTestExecutor } from './support/executor.js';

const host = '127.0.0.1';
const project = { id: 1, name: 'Project' };

function registered(tool: string): Operation {
  const entry = operationRegistry.entries.find((operation) => operation.tool === tool);
  if (entry === undefined) throw new Error(`${tool} is not registered`);
  return entry;
}

function socketClose(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => { if (error !== undefined) reject(error); else resolve(); });
    server.closeAllConnections();
  });
}

async function fixture(listener: RequestListener) {
  const directory = await mkdtemp(join(tmpdir(), 'testrail-mcp-native-socket-'));
  const server = createServer(listener);
  try {
    server.listen(0, host);
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('Expected an HTTP listener');
    const staging = await createStagingArea(directory);
    const configuration = await loadConfiguration({
      TESTRAIL_BASE_URL: `http://${host}:${String(address.port)}`,
      TESTRAIL_EMAIL: 'user@example.com', TESTRAIL_API_KEY: 'synthetic',
      TESTRAIL_ALLOW_PRIVATE_HOSTS: 'true', TESTRAIL_ALLOW_INSECURE: 'true',
      TESTRAIL_MCP_UPLOAD_ROOTS: JSON.stringify([directory]), TESTRAIL_MCP_DOWNLOAD_DIR: directory,
    });
    const executor = createTestExecutor({ configuration, client: createConfiguredDriver(configuration), createStaging: () => Promise.resolve(staging) });
    return {
      directory, executor, staging,
      async close() {
        await socketClose(server);
        await executor.shutdown();
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (server.listening) await socketClose(server);
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

describe('the native HTTP connection to TestRail', () => {
  it('settles a staged upload after the peer disconnects during multipart streaming', async () => {
    const fileBytes = 16 * 1_048_576;
    const marker = 'opening of the staged upload';
    const started = new AbortController();
    const disconnect = new AbortController();
    let uploads = 0;
    let received = 0;
    let complete = false;
    const upstream = await fixture((request, response) => {
      if (request.url !== '/index.php?/api/v2/add_attachment_to_case/1') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(project));
        return;
      }
      uploads += 1;
      let prefix = '';
      request.on('end', () => { complete = true; });
      request.on('data', (chunk: Buffer) => {
        received += chunk.byteLength;
        prefix = (prefix + chunk.toString('latin1')).slice(0, 4096);
        if (!prefix.includes(marker)) return;
        request.pause();
        disconnect.signal.addEventListener('abort', () => { request.socket.destroy(); }, { once: true });
        started.abort();
      });
    });
    try {
      const source = join(upstream.directory, 'stream.bin');
      const file = await open(source, 'wx');
      try {
        await file.writeFile(marker);
        await file.truncate(fileBytes);
      } finally {
        await file.close();
      }

      const streaming = once(started.signal, 'abort', { signal: AbortSignal.timeout(5000) });
      const result = upstream.executor.execute(registered('testrail_add_attachment_to_case'), {
        case_id: 1, file_path: source, filename: 'stream.bin',
      });
      await Promise.race([streaming, result.then(({ structuredContent }) => {
        throw new Error(`Upload finished before streaming: ${JSON.stringify(structuredContent)}`);
      })]);
      expect(received).toBeLessThan(fileBytes);
      expect(complete).toBe(false);
      expect(upstream.executor.stats().active).toBe(1);
      expect(await readdir(upstream.staging.directory)).toHaveLength(2);

      disconnect.abort();
      expect((await result).structuredContent).toMatchObject({ error: { code: 'INVALID_RESPONSE', write_outcome: 'unknown' } });
      expect(uploads).toBe(1);
      await expect.poll(() => upstream.executor.stats().active).toBe(0);
      expect(await readdir(upstream.staging.directory)).toEqual(['owner.json']);
      expect((await upstream.executor.execute(registered('testrail_get_project'), { project_id: 1 })).structuredContent)
        .toMatchObject({ data: project });
    } finally {
      disconnect.abort();
      await upstream.close();
    }
  });

  it('reports a write with a truncated 200 response as unknown and sends it once', async () => {
    let writes = 0;
    const upstream = await fixture((request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.method !== 'POST') {
        response.end(JSON.stringify(project));
        return;
      }
      writes += 1;
      request.resume();
      request.on('end', () => {
        response.writeHead(200, { 'content-length': '100' });
        response.flushHeaders();
        response.write('{"id":', () => { response.socket?.end(); });
      });
    });
    try {
      const result = await upstream.executor.execute(registered('testrail_add_project'), { body: { name: 'Write' } });
      expect(result.structuredContent).toMatchObject({ error: { code: 'INVALID_RESPONSE', write_outcome: 'unknown' } });
      expect(result.structuredContent.error).not.toHaveProperty('http_status');
      expect(writes).toBe(1);
      await expect.poll(() => upstream.executor.stats().active).toBe(0);
      expect((await upstream.executor.execute(registered('testrail_get_project'), { project_id: 1 })).structuredContent)
        .toMatchObject({ data: project });
    } finally {
      await upstream.close();
    }
  });
});
