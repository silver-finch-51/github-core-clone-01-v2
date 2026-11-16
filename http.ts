// http.ts — the small plumbing every surface shares: JSON answers, raw answers, request bodies and
// the one error type handlers throw. A thrown HttpError becomes GitHub's error shape (a JSON body
// with a `message`) wherever it lands, so no surface ever answers HTML or drops a request.

import type { ServerResponse } from 'node:http';
import type { Forge } from './store.ts';

export const JSON_TYPE = 'application/json; charset=utf-8';

/** An error a handler can throw to answer with a status and a message. */
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Everything a handler needs about one request. */
export interface ReqCtx {
  forge: Forge;
  /** The request's Host header: the origin the suite dialed, used for pagination Link URLs. */
  host: string;
  query: URLSearchParams;
  /** The whole request body (git packs are binary; JSON surfaces parse it themselves). */
  body: Buffer;
  /** The Git-Protocol header's value ('version=2' when the client asks for protocol v2). */
  gitProtocol: string;
  /** Parse the body as JSON: an empty body is {}, malformed JSON is a 400. */
  json(): Record<string, unknown>;
}

export function makeCtx(forge: Forge, host: string, query: URLSearchParams, body: Buffer, gitProtocol = ''): ReqCtx {
  let parsed: Record<string, unknown> | undefined;
  return {
    forge,
    host,
    query,
    body,
    gitProtocol,
    json(): Record<string, unknown> {
      if (parsed !== undefined) return parsed;
      const text = body.toString('utf8').trim();
      if (text === '') {
        parsed = {};
        return parsed;
      }
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        throw new HttpError(400, 'Malformed JSON in request body');
      }
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new HttpError(400, 'Request body must be a JSON object');
      }
      parsed = value as Record<string, unknown>;
      return parsed;
    },
  };
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

export function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer, headers: Readonly<Record<string, string>> = {}): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, ...headers });
  res.end(body);
}

/** Read a request body to completion (the surfaces are small; packs included). */
export function readBody(req: NodeJS.ReadableStream & { headers?: Record<string, string | string[] | undefined> }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** A JSON field read: the string at `key`, or null when absent/not a string. */
export function strField(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  return typeof value === 'string' ? value : null;
}

/** A JSON field read: the boolean at `key`, or null when absent/not a boolean. */
export function boolField(body: Record<string, unknown>, key: string): boolean | null {
  const value = body[key];
  return typeof value === 'boolean' ? value : null;
}
