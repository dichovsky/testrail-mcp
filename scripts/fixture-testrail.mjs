#!/usr/bin/env node
/*
 * A loopback stand-in for TestRail, for R02 host checks without a TestRail account.
 *
 * It answers every route in the operation inventory with that endpoint's reply from its
 * hand-authored parameter manifest, so a real MCP client can drive the real installed
 * server end to end. Reserved path IDs and flags add the cases the client scenarios need:
 * errors, drift, unusable replies, slow replies and pages, large results and multi-page
 * lists. docs/client-compatibility.md says which routes each reserved ID applies to.
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
  slowPages: 990045,
  rejected: 990400,
  unauthenticated: 990401,
  forbidden: 990403,
  notFound: 990404,
  failed: 990500,
  large: 990900,
  oversized: 990901,
});

/**
 * Twenty seconds outlasts the driver's 15-second request timeout. Fourteen stays just
 * under it, so a complete read of 14-second pages passes its 45-second budget on the
 * fourth page.
 */
const DELAYS_MS = Object.freeze({ [RESERVED.slow]: 20_000, [RESERVED.slowPages]: 14_000 });
/** How many pages a slow-pages list spans, whatever page size is asked for. */
const SLOW_PAGES = 10;
/** A list read with a page size holds 50 items a page: TestRail's default page. */
const CONTROLLED_PAGE = 50;
/** A list that chooses its own pages serves two items a page. */
const RESPONSE_DRIVEN_PAGE = 2;
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
  // A paged list whose fixture replies with a bare array, the legacy form, is served as a
  // page envelope under the collection key its resource's other lists use, so it can span
  // pages like the rest.
  const envelopeKeys = new Map();
  for (const { tool, resource } of inventory.operations) {
    const accepted = manifests.get(tool)?.cases.find(({ expect }) => expect.kind === 'accepted');
    const found = accepted?.expect.upstream_response.kind === 'json' ? envelopeOf(accepted.expect.upstream_response.body) : undefined;
    if (found !== undefined && !envelopeKeys.has(resource)) envelopeKeys.set(resource, collectionKey(found.envelope));
  }
  return inventory.operations.map(({ tool, http_method: method, route, pagination, resource }) => {
    const manifest = manifests.get(tool);
    const accepted = manifest?.cases.find(({ expect }) => expect.kind === 'accepted');
    if (accepted === undefined) throw new Error(`${tool}: no accepted fixture to answer with`);
    let reply = accepted.expect.upstream_response;
    if (pagination.kind !== 'none' && reply.kind === 'json' && Array.isArray(reply.body) && envelopeOf(reply.body) === undefined) {
      const key = envelopeKeys.get(resource);
      if (key === undefined) throw new Error(`${tool}: no page envelope to serve its list in`);
      reply = { kind: 'json', body: { offset: 0, limit: reply.body.length, size: reply.body.length, _links: { next: null, prev: null }, [key]: reply.body } };
    }
    // The inventory's route, and any other path the fixtures show the driver sending for the
    // tool, such as get_users/{project_id} when a project is given.
    const shapes = new Set([route.replace(/\{[a-z_]+\}/gu, '{}')]);
    for (const { expect } of manifest.cases) {
      if (expect.kind === 'accepted' && expect.wire !== undefined) shapes.add(expect.wire.endpoint.split('&')[0].replace(/\/\d+(?=\/|$)/gu, '/{}'));
    }
    const patterns = [...shapes].map((shape) => new RegExp(`^${shape.replaceAll('{}', '([^/&]+)')}$`, 'u'));
    return { tool, method, route, patterns, kind: pagination.kind, reply };
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

/**
 * The same entity with every top-level text turned into a number and every number into
 * text: still an object, so usable, but no longer the shape any checked field expects.
 */
function drifted(entity) {
  if (!isRecord(entity)) return entity;
  return Object.fromEntries(Object.entries(entity).map(([key, value]) => [key,
    typeof value === 'string' ? 42 : typeof value === 'number' ? String(value) : value]));
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

/** The entity with its first text, at any depth, padded so it serializes to about `bytes`. */
function padded(entity, bytes) {
  const room = Math.max(0, bytes - Buffer.byteLength(JSON.stringify(entity)));
  let done = false;
  const pad = (value, key) => {
    if (done) return value;
    if (typeof value === 'string' && key !== 'id') {
      done = true;
      return `${value}${'x'.repeat(room)}`;
    }
    if (Array.isArray(value)) return value.map((item) => pad(item));
    if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([inner, item]) => [inner, pad(item, inner)]));
    return value;
  };
  return pad(entity);
}

/**
 * One page of a generated list. The list has a fixed length whatever page size is asked
 * for, as a real one does: `pages` pages of 50 for a list read with a page size, and of 2
 * for one that chooses its own pages. A slow-pages list spans ten pages of any size.
 */
function page(reply, path, controls, { kind, pages, sized, slow }) {
  const found = envelopeOf(reply);
  if (found === undefined) return reply;
  const key = collectionKey(found.envelope);
  const template = found.envelope[key][0];
  const limit = kind === 'response_driven' ? RESPONSE_DRIVEN_PAGE : Number(controls.get('limit') ?? 250);
  const offset = Number(controls.get('offset') ?? 0);
  let items;
  let total;
  if (sized !== undefined) {
    // A single page of padded items whose total serialized size is about `sized`.
    total = Math.max(1, Math.min(limit, 50));
    items = Array.from({ length: total }, (_, index) => padded(renumbered(template, 800_000 + index), Math.floor(sized / total)));
  } else {
    total = slow ? limit * SLOW_PAGES : (kind === 'response_driven' ? RESPONSE_DRIVEN_PAGE : CONTROLLED_PAGE) * pages;
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
  // A log that cannot be written is refused now, not discovered on the first request.
  if (log !== undefined) {
    try {
      await appendFile(log, '');
    } catch (error) {
      throw new Error(`Cannot write the request log ${log}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }

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
            if (route.kind !== 'none') {
              const controls = controlsOf(query);
              const sized = reserved === RESERVED.large ? LARGE_BYTES : reserved === RESERVED.oversized ? OVERSIZED_BYTES : undefined;
              body = page(body, path, controls, { kind: route.kind, pages, sized, slow: reserved === RESERVED.slowPages });
            }
            if (reserved === RESERVED.drift) body = withDrift(body);
            reply = json(body);
          }
        }
        const entry = { method: request.method, endpoint: path + (query.length === 0 ? '' : `&${query.join('&')}`),
          tool: route?.tool ?? null, status, authorized: typeof request.headers.authorization === 'string', bytes: Buffer.concat(chunks).length };
        requests.push(entry);
        // A log write that fails later still leaves the reply as the route gives it.
        if (log !== undefined) await appendFile(log, `${JSON.stringify(entry)}\n`).catch(() => undefined);
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
