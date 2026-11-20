// coreforge: a GitHub-compatible git forge in one Node process.
//
// Surfaces, all over one shared in-memory store:
//   - git smart HTTP (protocol v0 and v2): clone, fetch, push, shallow
//   - REST v3 under /api/v3: repos, contents, refs, issues, pulls, labels
//   - GraphQL at /api/graphql
//   - MCP (JSON-RPC) at /mcp
//
// Lifecycle (the make.fun environment contract): listen on an ephemeral
// port, POST {"port"} to $MAKEFUN_ENV_URL/register, poll
// $MAKEFUN_ENV_URL/done until it answers {"done": true}, then exit 0.

import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { handleRest } from './rest.ts';
import type { Reply } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMCP } from './mcp.ts';
import { getRepo } from './store.ts';
import {
  uploadPackAdvertisement,
  receivePackAdvertisement,
  lsRefs,
  fetchV2,
  fetchV0,
  receivePack,
} from './gitproto.ts';
import { decodeSections } from './util.ts';

const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const presented = header.slice('Bearer '.length);
  if (presented === '') return false;
  return SHOP_TOKEN === '' || presented === SHOP_TOKEN;
}

function send(res: ServerResponse, reply: Reply): void {
  const headers: Record<string, string> = { ...(reply.headers ?? {}) };
  let body: Buffer;
  if (reply.raw !== undefined) {
    body = reply.raw;
    headers['content-type'] = reply.contentType ?? 'application/octet-stream';
  } else {
    body = Buffer.from(JSON.stringify(reply.json ?? {}), 'utf8');
    headers['content-type'] = reply.contentType ?? 'application/json';
  }
  headers['content-length'] = String(body.length);
  res.writeHead(reply.status, headers);
  res.end(body);
}

function notFound(): Reply {
  return { status: 404, json: { message: 'Not Found' } };
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function gitRoute(
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  name: string,
  sub: string,
  query: URLSearchParams,
  body: Buffer,
): void {
  const repo = getRepo(owner, name);
  if (!repo) {
    send(res, notFound());
    return;
  }
  if (sub === '/info/refs' && req.method === 'GET') {
    const service = query.get('service');
    if (service === 'git-upload-pack') {
      const protocol = req.headers['git-protocol'];
      const v2 = typeof protocol === 'string' && protocol.includes('version=2');
      send(res, {
        status: 200,
        raw: uploadPackAdvertisement(repo, v2),
        contentType: 'application/x-git-upload-pack-advertisement',
      });
      return;
    }
    if (service === 'git-receive-pack') {
      send(res, {
        status: 200,
        raw: receivePackAdvertisement(repo),
        contentType: 'application/x-git-receive-pack-advertisement',
      });
      return;
    }
    send(res, { status: 400, json: { message: 'unknown service' } });
    return;
  }
  if (sub === '/git-upload-pack' && req.method === 'POST') {
    const protocol = req.headers['git-protocol'];
    const v2 = typeof protocol === 'string' && protocol.includes('version=2');
    if (!v2) {
      send(res, { status: 200, raw: fetchV0(repo, body), contentType: 'application/x-git-upload-pack-result' });
      return;
    }
    const sections = decodeSections(body);
    const firstPacket = sections[0]?.find((p) => p.kind === 'data');
    const firstLine = firstPacket?.kind === 'data' ? firstPacket.payload.toString('utf8') : '';
    if (firstLine.startsWith('command=ls-refs')) {
      send(res, { status: 200, raw: lsRefs(repo, sections), contentType: 'application/x-git-upload-pack-result' });
      return;
    }
    if (firstLine.startsWith('command=fetch')) {
      send(res, { status: 200, raw: fetchV2(repo, sections), contentType: 'application/x-git-upload-pack-result' });
      return;
    }
    send(res, { status: 400, json: { message: 'unknown command' } });
    return;
  }
  if (sub === '/git-receive-pack' && req.method === 'POST') {
    send(res, { status: 200, raw: receivePack(repo, body), contentType: 'application/x-git-receive-pack-result' });
    return;
  }
  send(res, notFound());
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    if (path === '/healthz') {
      send(res, { status: 200, json: { ok: true } });
      return;
    }
    const body = await readBody(req);
    if (!authorized(req)) {
      send(res, { status: 401, json: { message: 'Requires authentication' } });
      return;
    }
    if (path === '/api/graphql') {
      if (req.method !== 'POST') {
        send(res, notFound());
        return;
      }
      send(res, handleGraphQL(body.toString('utf8')));
      return;
    }
    if (path === '/mcp') {
      if (req.method !== 'POST') {
        send(res, { status: 405, json: { message: 'Method Not Allowed' } });
        return;
      }
      send(res, handleMCP(body.toString('utf8')));
      return;
    }
    if (path === '/api/v3' || path === '/api/v3/' || path.startsWith('/api/v3/')) {
      const segments =
        path === '/api/v3' || path === '/api/v3/'
          ? []
          : path.slice('/api/v3/'.length).split('/').filter((s) => s !== '');
      const base = `http://${req.headers.host ?? 'localhost'}`;
      send(res, handleRest(req.method ?? 'GET', segments, url.searchParams, body.toString('utf8'), base));
      return;
    }
    const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
    if (gitMatch) {
      gitRoute(req, res, gitMatch[1], gitMatch[2], gitMatch[3] ?? '', url.searchParams, body);
      return;
    }
    send(res, notFound());
  } catch (err) {
    // A malformed request must never take the server down.
    if (!res.headersSent) {
      send(res, { status: 500, json: { message: `internal error: ${err instanceof Error ? err.message : 'unknown'}` } });
    } else {
      res.end();
    }
  }
}

const server = createServer((req, res) => {
  void handle(req, res);
});

let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
}

async function registerAndPoll(port: number): Promise<void> {
  if (ENV_URL === '') {
    console.log(`coreforge listening on port ${port} (no MAKEFUN_ENV_URL; not registering)`);
    return;
  }
  try {
    await fetch(`${ENV_URL}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port }),
    });
  } catch {
    // Registration is retried by the poll loop's liveness; keep serving.
  }
  const poll = async (): Promise<void> => {
    if (shuttingDown) return;
    try {
      const answer = await fetch(`${ENV_URL}/done`);
      const data = (await answer.json()) as { done?: boolean };
      if (data.done === true) {
        shutdown();
        return;
      }
    } catch {
      // The env may not be up yet; keep polling.
    }
    setTimeout(() => void poll(), 200);
  };
  void poll();
}

server.listen(0, () => {
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  void registerAndPoll(port);
});

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
