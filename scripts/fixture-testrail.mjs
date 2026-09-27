#!/usr/bin/env node
/*
 * A loopback stand-in for TestRail, for R02 host checks without a TestRail account.
 *
 * It answers every route in the operation inventory with that endpoint's reply from its
 * hand-authored parameter manifest, so a real MCP client can drive the real installed
 * server end to end. Reserved IDs and flags add the cases the client scenarios need:
 * errors, drift, unusable replies, slow replies, large results and multi-page lists.
 *
 * It is a development harness. It is not part of the published package, and it adds no
 * option to the server: the server reaches it through its ordinary configuration with
 * TESTRAIL_ALLOW_INSECURE and TESTRAIL_ALLOW_PRIVATE_HOSTS set for the loopback address.
 * Its credentials are synthetic and it never logs the authorization header.
 */
import { appendFile, readdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = new URL('../', import.meta.url);

/** Synthetic credentials: the stand-in accepts any, and these are what it prints. */
export const SYNTHETIC = Object.freeze({ email: 'fixture@example.invalid', apiKey: 'fixture-api-key' });

/** Path IDs that turn an ordinary route into a scenario. None occurs in a manifest. */
export const RESERVED = Object.freeze({
  drift: 990001,
  unusable: 990002,
  slow: 990020,
  stalled: 990070,
  rejected: 990400,
  unauthenticated: 990401,
  forbidden: 990403,
  notFound: 990404,
  failed: 990500,
  large: 990900,
  oversized: 990901,
});

const DELAYS_MS = Object.freeze({ [RESERVED.slow]: 20_000, [RESERVED.stalled]: 70_000 });
const LARGE_BYTES = 700 * 1024;
const OVERSIZED_BYTES = 3 * 1024 * 1024;
const PREFIX = '/index.php?/api/v2/';

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The collection key of a page envelope: its one array other than the links. */
function collectionKey(envelope) {
  if (!isRecord(envelope) || !isRecord(envelope._links)) return undefined;
  const keys = Object.keys(envelope).filter((key) => key !== '_links' && Array.isArray(envelope[key]));
  return keys.length === 1 ? keys[0] : undefined;
}

/** Split a reply into its envelope, whether flat or nested in a one-element array. */
function envelopeOf(reply) {
  if (collectionKey(reply) !== undefined) return { envelope: reply, nested: false };
  if (Array.isArray(reply) && reply.length === 1 && collectionKey(reply[0]) !== undefined) return { envelope: reply[0], nested: true };
  return undefined;
}

async function loadRoutes() {
  const inventory = JSON.parse(await readFile(new URL('docs/operation-inventory.json', ROOT), 'utf8'));
  const directory = new URL('tests/fixtures/parameters/', ROOT);
  const manifests = new Map();
  for (const name of (await readdir(directory)).filter((file) => file.endsWith('.json'))) {
    const manifest = JSON.parse(await readFile(new URL(name, directory), 'utf8'));
    manifests.set(manifest.endpoint.tool, manifest);
  }
  return inventory.operations.map(({ tool, http_method: method, route, pagination }) => {
    const manifest = manifests.get(tool);
    const accepted = manifest?.cases.find(({ expect }) => expect.kind === 'accepted');
    if (accepted === undefined) throw new Error(`${tool}: no accepted fixture to answer with`);
    // The inventory's route, and any other path the fixtures show the driver sending for the
    // tool, such as get_users/{project_id} when a project is given.
    const shapes = new Set([route.replace(/\{[a-z_]+\}/gu, '{}')]);
    for (const { expect } of manifest.cases) {
      if (expect.kind === 'accepted' && expect.wire !== undefined) shapes.add(expect.wire.endpoint.split('&')[0].replace(/\/\d+(?=\/|$)/gu, '/{}'));
    }
    const patterns = [...shapes].map((shape) => new RegExp(`^${shape.replaceAll('{}', '([^/&]+)')}$`, 'u'));
    return { tool, method, route, patterns, paged: pagination.kind !== 'none', reply: accepted.expect.upstream_response };
  });
}

function controlsOf(query) {
  const controls = new Map();
  for (const part of query) {
    const [key, value] = part.split('=');
    if (key !== undefined && value !== undefined) controls.set(key, value);
  }
  return controls;
}

/** The same entity with one known text field turned into a number: usable drift. */
function drifted(entity) {
  if (!isRecord(entity)) return entity;
  const key = Object.keys(entity).find((name) => name !== 'id' && typeof entity[name] === 'string');
  return key === undefined ? { ...entity, id: String(entity.id ?? '') } : { ...entity, [key]: 42 };
}

function withDrift(reply) {
  const page = envelopeOf(reply);
  if (page !== undefined) {
    const key = collectionKey(page.envelope);
    const items = page.envelope[key];
    const envelope = { ...page.envelope, [key]: [drifted(items[0]), ...items.slice(1)] };
    return page.nested ? [envelope] : envelope;
  }
  if (Array.isArray(reply)) return reply.length === 0 ? reply : [drifted(reply[0]), ...reply.slice(1)];
  return drifted(reply);
}

/** One entity renumbered, so repeated items on generated pages are distinct. */
function renumbered(entity, id) {
  return isRecord(entity) && typeof entity.id === 'number' ? { ...entity, id } : entity;
}

/** The entity with its first text field padded so it serializes to about `bytes`. */
function padded(entity, bytes) {
  if (!isRecord(entity)) return entity;
  const key = Object.keys(entity).find((name) => name !== 'id' && typeof entity[name] === 'string');
  const size = Buffer.byteLength(JSON.stringify(entity));
  const room = Math.max(0, bytes - size);
  return key === undefined ? entity : { ...entity, [key]: `${entity[key]}${'x'.repeat(room)}` };
}

function page(reply, path, controls, pages, sized) {
  const found = envelopeOf(reply);
  if (found === undefined) return reply;
  const key = collectionKey(found.envelope);
  const template = found.envelope[key][0];
  const limit = Number(controls.get('limit') ?? 2);
  const offset = Number(controls.get('offset') ?? 0);
  let items;
  let total;
  if (sized !== undefined) {
    // A single page of padded items whose total serialized size is about `sized`.
    total = Math.max(1, Math.min(limit, 50));
    items = Array.from({ length: total }, (_, index) => padded(renumbered(template, 800_000 + index), Math.floor(sized / total)));
  } else {
    total = limit * pages;
    items = Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, index) =>
      renumbered(template, 700_000 + offset + index));
  }
  const nextOffset = offset + limit;
  const envelope = {
    offset,
    limit,
    size: items.length,
    _links: {
      next: sized === undefined && nextOffset < total ? `/api/v2/${path}&limit=${limit}&offset=${nextOffset}` : null,
      prev: offset > 0 ? `/api/v2/${path}&limit=${limit}&offset=${Math.max(0, offset - limit)}` : null,
    },
    [key]: items,
  };
  return found.nested ? [envelope] : envelope;
}

function send(response, status, reply) {
  if (reply.kind === 'binary') {
    response.writeHead(status, { 'content-type': 'application/octet-stream' });
    response.end(Buffer.from(reply.utf8, 'utf8'));
  } else if (reply.kind === 'text') {
    response.writeHead(status, { 'content-type': 'text/plain' });
    response.end(reply.text);
  } else {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(reply.body));
  }
}

const json = (body) => ({ kind: 'json', body });
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref(); });

/**
 * Start the stand-in. `pages` sets how many pages every paged list spans; `delayScale`
 * shortens the reserved delays for tests; `log`, when set, receives one JSON line per
 * request with its method, endpoint and status, never its credentials.
 */
export async function startFixtureTestRail({ port = 0, host = '127.0.0.1', pages = 1, delayScale = 1, log } = {}) {
  const routes = await loadRoutes();
  const requests = [];

  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => { chunks.push(chunk); });
    request.on('end', () => {
      void (async () => {
        const url = request.url ?? '';
        const at = url.indexOf(PREFIX);
        const [path = '', ...query] = at === -1 ? [''] : decodeURIComponent(url.slice(at + PREFIX.length)).split('&');
        const route = routes.find((candidate) => candidate.method === request.method && candidate.patterns.some((pattern) => pattern.test(path)));
        const ids = route === undefined ? [] : (route.patterns.map((pattern) => pattern.exec(path)).find((match) => match !== null) ?? []).slice(1).map(Number);
        const reserved = ids.find((id) => Object.values(RESERVED).includes(id));
        let status = 200;
        let reply;
        if (route === undefined) {
          status = 404;
          reply = json({ error: 'This stand-in does not serve that endpoint.' });
        } else if (reserved === RESERVED.notFound) {
          status = 404;
          reply = json({ error: 'The requested resource does not exist.' });
        } else if (reserved === RESERVED.rejected) {
          // TestRail's own reply to an ID it will not serve.
          status = 400;
          reply = json({ error: 'Field :id is not a valid or accessible ID.' });
        } else if (reserved === RESERVED.unauthenticated) {
          status = 401;
          reply = json({ error: 'Authentication failed: invalid or missing user/password or session cookie.' });
        } else if (reserved === RESERVED.forbidden) {
          status = 403;
          reply = json({ error: 'You are not allowed to perform this action (insufficient permissions).' });
        } else if (reserved === RESERVED.failed) {
          status = 500;
          reply = json({ error: 'An internal error occurred on the stand-in.' });
        } else if (reserved === RESERVED.unusable) {
          reply = json('not the shape this endpoint documents');
        } else {
          if (reserved !== undefined && DELAYS_MS[reserved] !== undefined) await sleep(DELAYS_MS[reserved] * delayScale);
          reply = route.reply;
          if (reply.kind === 'json') {
            let body = reply.body;
            if (route.paged) {
              const controls = controlsOf(query);
              const sized = reserved === RESERVED.large ? LARGE_BYTES : reserved === RESERVED.oversized ? OVERSIZED_BYTES : undefined;
              body = page(body, path, controls, pages, sized);
            }
            if (reserved === RESERVED.drift) body = withDrift(body);
            reply = json(body);
          }
        }
        const entry = { method: request.method, endpoint: path + (query.length === 0 ? '' : `&${query.join('&')}`),
          tool: route?.tool ?? null, status, authorized: typeof request.headers.authorization === 'string', bytes: Buffer.concat(chunks).length };
        requests.push(entry);
        if (log !== undefined) await appendFile(log, `${JSON.stringify(entry)}\n`);
        if (!response.destroyed) send(response, status, reply);
      })().catch(() => {
        if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'stand-in failure' }));
      });
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  const baseUrl = `http://${host}:${address.port}`;
  return {
    baseUrl,
    requests,
    environment: {
      TESTRAIL_BASE_URL: baseUrl,
      TESTRAIL_ALLOW_INSECURE: 'true',
      TESTRAIL_ALLOW_PRIVATE_HOSTS: 'true',
      TESTRAIL_EMAIL: SYNTHETIC.email,
      TESTRAIL_API_KEY: SYNTHETIC.apiKey,
    },
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => { resolve(); });
    }),
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      port: { type: 'string', default: '0' },
      host: { type: 'string', default: '127.0.0.1' },
      pages: { type: 'string', default: '1' },
      'delay-scale': { type: 'string', default: '1' },
      log: { type: 'string' },
      json: { type: 'boolean', default: false },
    },
  });
  const pages = Number(values.pages);
  const delayScale = Number(values['delay-scale']);
  if (!Number.isSafeInteger(pages) || pages < 1 || !(delayScale >= 0)) throw new Error('--pages must be a positive integer and --delay-scale a non-negative number');
  const standIn = await startFixtureTestRail({
    port: Number(values.port), host: values.host, pages, delayScale, ...(values.log === undefined ? {} : { log: values.log }),
  });
  if (values.json) {
    process.stdout.write(`${JSON.stringify({ baseUrl: standIn.baseUrl, environment: standIn.environment, reserved: RESERVED })}\n`);
  } else {
    process.stdout.write([
      `TestRail fixture stand-in listening on ${standIn.baseUrl} (${pages} page${pages === 1 ? '' : 's'} per list).`,
      'Launch the MCP client with these variables. The credentials are synthetic:',
      '',
      ...Object.entries(standIn.environment).map(([key, value]) => `${key}=${value}`),
      'TESTRAIL_MCP_UPLOAD_ROOTS=<a JSON array of directories you create>',
      'TESTRAIL_MCP_DOWNLOAD_DIR=<a directory you create>',
      '',
      `Reserved IDs: ${Object.entries(RESERVED).map(([name, id]) => `${id} ${name}`).join(', ')}.`,
      'Press Ctrl+C to stop.',
      '',
    ].join('\n'));
  }
  const stop = () => { void standIn.close().then(() => process.exit(0)); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
