import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { connect, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const loopback = '127.0.0.1';
const guardedHost = 'guarded.testrail.invalid';
const guardedAddress = process.env.TESTRAIL_MCP_GUARDED_TEST_ADDRESS;
if (guardedAddress !== undefined && guardedAddress !== '203.0.113.10') {
  throw new Error('Guarded transport verification requires the isolated test address 203.0.113.10.');
}

const certificatePath = fileURLToPath(new URL('./fixtures/native-tls/certificate.pem', import.meta.url));
// This synthetic key is used only on loopback and in the isolated test namespace.
const keyPath = fileURLToPath(new URL('./fixtures/native-tls/key.pem', import.meta.url));
const root = fileURLToPath(new URL('../', import.meta.url));
const project = { id: 1, name: 'TLS project' };
const execute = promisify(execFile);

const runDriver = `
import { TestRailClient } from '@dichovsky/testrail-api-client';
import { loadConfiguration } from './dist/config/environment.js';
import { driverOptions } from './dist/driver/configuration.js';

const configuration = await loadConfiguration(process.env);
const options = { ...driverOptions(configuration), maxRetries: 0 };
const address = process.argv[1];
if (address !== undefined) {
  options.dnsLookup = async (host) => {
    if (host !== '${guardedHost}') throw new Error('Unexpected hostname in guarded test');
    return [{ address, family: 4 }];
  };
}
const client = new TestRailClient(options);
try {
  const project = await client.projects.getProject(1);
  process.stdout.write(JSON.stringify(project));
} finally {
  client.destroy();
}
`;

async function listen(server: Server, host: string): Promise<number> {
  server.listen(0, host);
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Expected a TCP listener');
  return address.port;
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => { server.close(() => { resolve(); }); });
}

async function fixture(host: string) {
  const directory = await mkdtemp(join(tmpdir(), 'testrail-mcp-native-proxy-'));
  const sockets = new Set<Duplex>();
  const authorities: (string | undefined)[] = [];
  const connections: (string | undefined)[] = [];
  const origin = createHttpsServer({ key: await readFile(keyPath), cert: await readFile(certificatePath) }, (request, response) => {
    authorities.push(request.headers.host);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(project));
  });
  const proxy = createHttpServer((_request, response) => { response.writeHead(403).end(); });
  const dispose = async () => {
    for (const socket of sockets) socket.destroy();
    origin.closeAllConnections();
    proxy.closeAllConnections();
    await Promise.all([close(origin), close(proxy)]);
    await rm(directory, { recursive: true, force: true });
  };
  try {
    const port = await listen(origin, host);
    const allowedAuthority = `${loopback}:${String(port)}`;
    proxy.on('connect', (request, client, prefix) => {
      connections.push(request.url);
      if (request.url !== allowedAuthority) {
        client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
        return;
      }
      // The fixture proxies only its own HTTPS listener.
      const upstream = connect(port, loopback);
      sockets.add(client);
      sockets.add(upstream);
      client.on('error', () => { upstream.destroy(); });
      upstream.on('error', () => { client.destroy(); });
      client.once('close', () => { sockets.delete(client); upstream.destroy(); });
      upstream.once('close', () => { sockets.delete(upstream); client.destroy(); });
      upstream.once('connect', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        upstream.write(prefix);
        upstream.pipe(client).pipe(upstream);
      });
    });
    const proxyPort = await listen(proxy, loopback);
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(http_proxy|https_proxy|all_proxy|no_proxy|node_use_env_proxy|node_extra_ca_certs|node_options|node_tls_reject_unauthorized|testrail_.*)$/iu.test(name)));
    return {
      authorities, connections, allowedAuthority, port, dispose,
      request({ noProxy = '', trust = true, guarded }: { noProxy?: string; trust?: boolean; guarded?: string } = {}) {
        const baseUrl = guarded === undefined ? `https://${allowedAuthority}` : `https://${guardedHost}:${String(port)}`;
        return execute(process.execPath, ['--input-type=module', '--eval', runDriver, ...(guarded === undefined ? [] : [guarded])], {
          cwd: root, timeout: 5000, encoding: 'utf8', env: {
            ...inherited, NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: `http://${loopback}:${String(proxyPort)}`, NO_PROXY: noProxy,
            ...(trust ? { NODE_EXTRA_CA_CERTS: certificatePath } : {}),
            TESTRAIL_BASE_URL: baseUrl, TESTRAIL_EMAIL: 'user@example.com', TESTRAIL_API_KEY: 'synthetic',
            TESTRAIL_ALLOW_PRIVATE_HOSTS: String(guarded === undefined),
            TESTRAIL_MCP_UPLOAD_ROOTS: '[]', TESTRAIL_MCP_DOWNLOAD_DIR: directory,
          },
        });
      },
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}

describe('native HTTPS and proxy routing', () => {
  it('uses the opt-in proxy, honors NO_PROXY and requires a trusted CA', async () => {
    const upstream = await fixture(loopback);
    try {
      const proxied = await upstream.request();
      expect(JSON.parse(proxied.stdout)).toEqual(project);
      expect(upstream.connections).toEqual([upstream.allowedAuthority]);
      expect(upstream.authorities).toEqual([upstream.allowedAuthority]);

      const direct = await upstream.request({ noProxy: loopback });
      expect(JSON.parse(direct.stdout)).toEqual(project);
      expect(upstream.connections).toEqual([upstream.allowedAuthority]);
      expect(upstream.authorities).toEqual([upstream.allowedAuthority, upstream.allowedAuthority]);

      await expect(upstream.request({ noProxy: loopback, trust: false })).rejects.toMatchObject({ code: 1 });
      expect(upstream.authorities).toHaveLength(2);
    } finally {
      await upstream.dispose();
    }
  });

  it.skipIf(guardedAddress === undefined)('dials a DNS-approved fixture directly despite the configured proxy', async () => {
    if (guardedAddress === undefined) throw new Error('Missing isolated guard address');
    const upstream = await fixture(guardedAddress);
    try {
      const reply = await upstream.request({ guarded: guardedAddress });
      expect(JSON.parse(reply.stdout)).toEqual(project);
      expect(upstream.connections).toEqual([]);
      expect(upstream.authorities).toEqual([`${guardedHost}:${String(upstream.port)}`]);
    } finally {
      await upstream.dispose();
    }
  });
});
