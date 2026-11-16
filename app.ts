// app.ts — the forge's HTTP server: one router over the four surfaces (git smart HTTP, REST v3,
// GraphQL v4, MCP), the bearer-token gate, and the headers every GitHub answer carries. The token is
// the process's own MAKEFUN_SHOP_TOKEN: the surfaces act as that token's user, and a request without
// it (or with a different one) is a 401 — except the health probe, the API root and meta, which
// GitHub serves publicly. Every answer, errors included, is JSON with an X-GitHub-Request-Id; no
// route ever answers HTML, and a handler failure is a 500 with a message, never a dropped request.
//
// app.ts is deliberately separate from main.ts: this is the server; main.ts is the entry <-> env
// lifecycle and stays as it is.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './store.ts';
import { HttpError, makeCtx, readBody, sendJson } from './http.ts';
import { handleGit } from './githttp.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

/** The token the forge acts for; empty (local runs) disables the gate. */
function expectedToken(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

function isAuthorized(req: IncomingMessage): boolean {
  const expected = expectedToken();
  if (expected === '') return true;
  return (req.headers.authorization ?? '') === `Bearer ${expected}`;
}

/** The decoded path segments of a request URL ('/' -> []), or null when the URL does not parse. */
function segmentsOf(req: IncomingMessage): { segments: string[]; query: URLSearchParams } | null {
  try {
    const url = new URL(req.url ?? '/', 'http://entry');
    const segments = url.pathname
      .split('/')
      .filter((part) => part !== '')
      .map((part) => {
        try {
          return decodeURIComponent(part);
        } catch {
          return part;
        }
      });
    return { segments, query: url.searchParams };
  } catch {
    return null;
  }
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const forge = new Forge();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async (): Promise<void> => {
      res.setHeader('x-github-request-id', forge.nextRequestId());
      try {
        const parsed = segmentsOf(req);
        if (parsed === null) throw new HttpError(400, 'Bad request URL');
        const { segments, query } = parsed;
        const method = req.method ?? 'GET';
        const body = await readBody(req);
        const host = req.headers.host ?? 'localhost';
        const ctx = makeCtx(forge, host, query, body, req.headers['git-protocol'] ?? '');

        // The env's boot check: 200 {"ok":true}, no token needed.
        if (method === 'GET' && segments.length === 1 && segments[0] === 'healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // REST v3.
        if (segments[0] === 'api' && segments[1] === 'v3') {
          const rest = segments.slice(2);
          const isPublic = method === 'GET' && (rest.length === 0 || (rest.length === 1 && rest[0] === 'meta'));
          if (!isPublic && !isAuthorized(req)) throw new HttpError(401, 'Bad credentials');
          res.setHeader('x-oauth-scopes', 'repo, read:org');
          handleRest(ctx, res, method, rest);
          return;
        }

        // GraphQL v4.
        if (segments[0] === 'api' && segments[1] === 'graphql' && segments.length === 2) {
          if (method !== 'POST') throw new HttpError(404, 'Not Found');
          if (!isAuthorized(req)) throw new HttpError(401, 'Bad credentials');
          handleGraphQL(ctx, res);
          return;
        }

        // MCP.
        if (segments[0] === 'mcp' && segments.length === 1) {
          if (method !== 'POST') {
            res.writeHead(405, { 'content-type': JSON_TYPE, allow: 'POST' });
            res.end(`${JSON.stringify({ message: 'Method Not Allowed' })}\n`);
            return;
          }
          if (!isAuthorized(req)) {
            sendJson(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized: a bearer token is required' } });
            return;
          }
          handleMcp(ctx, res);
          return;
        }

        // Git smart HTTP: /{owner}/{repo}[.git]/{info/refs,git-upload-pack,git-receive-pack}.
        if (segments.length >= 3) {
          const last = segments[segments.length - 1] ?? '';
          const lastTwo = segments.slice(-2).join('/');
          if (lastTwo === 'info/refs' || last === 'git-upload-pack' || last === 'git-receive-pack') {
            if (!isAuthorized(req)) throw new HttpError(401, 'Bad credentials');
            handleGit(ctx, res, segments);
            return;
          }
        }

        throw new HttpError(404, 'Not Found');
      } catch (err) {
        if (res.headersSent) {
          res.end();
          return;
        }
        if (err instanceof HttpError) {
          sendJson(res, err.status, { message: err.message });
          return;
        }
        sendJson(res, 500, { message: `Internal error: ${err instanceof Error ? err.message : String(err)}` });
      }
    })();
  });
}
