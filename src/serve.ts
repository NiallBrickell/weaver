/**
 * `weaver serve` — the network ingress adapter for a fleet of external bots.
 *
 * Weaver's durable layer is a library over a StateStore (fs, or a shared
 * Postgres for a fleet across machines). This is the thinnest possible seam
 * that lets a bot in ANY language reach that shared brain over HTTP, in the
 * same spirit as the Postgres store adapter and the Pilot daemon: it exposes
 * ONLY the typed ingress/read operations, runs no model, and holds no state of
 * its own. Execution stays with the resident runner (`weaver run`); this
 * process only writes durable state (create-or-get a workstream, record an
 * observation) and reads it back.
 *
 * What it deliberately does NOT expose: steering, approvals, adoption — the
 * authority channels. A bot supplies evidence (observations) and registers
 * work (workstreams); it can never be handed the human's hand. Auth is a single
 * shared bearer token (machine-to-machine); it is not a tenancy/orgs surface —
 * Weaver does not grow those.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

import { listManagedBy, load, SourceKeyConflictError } from './store.js';
import { renderStatus } from './status.js';
import {
  createOrGetWorkstream,
  recordObservation,
  type CreateWorkstreamRequest,
  type ObservationRequest,
} from './ingress.js';

export interface ServeOptions {
  token: string;
  host?: string;
  port?: number;
}

export interface RunningServer {
  server: Server;
  port: number;
  close(): Promise<void>;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

/** Constant-time bearer check so a wrong token cannot be probed by timing. */
function authorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers['authorization'];
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const presented = Buffer.from(header.slice('Bearer '.length));
  const expected = Buffer.from(token);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 1_000_000) throw new Error('request body too large');
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length ? v : undefined;
}
function strArr(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined;
}

async function handle(req: IncomingMessage, res: ServerResponse, token: string): Promise<void> {
  if (!authorized(req, token)) return send(res, 401, { error: 'unauthorized — send Authorization: Bearer <WEAVER_SERVE_TOKEN>' });
  const url = new URL(req.url ?? '/', 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean);
  const method = req.method ?? 'GET';

  // POST /workstreams  — create-or-get by source_key (idempotent)
  if (method === 'POST' && parts.length === 1 && parts[0] === 'workstreams') {
    const body = await readJson(req);
    const sourceKey = str(body.source_key);
    const title = str(body.title);
    const objective = str(body.objective);
    if (!sourceKey || !title || !objective) {
      return send(res, 400, { error: 'source_key, title and objective are required' });
    }
    const reqObj: CreateWorkstreamRequest = {
      sourceKey,
      title,
      objective,
      slug: str(body.slug),
      tags: strArr(body.tags),
      successCriteria: strArr(body.success_criteria),
      constraints: strArr(body.constraints),
      maxPasses: typeof body.max_passes === 'number' ? body.max_passes : undefined,
      maxCostUsd: typeof body.max_cost_usd === 'number' ? body.max_cost_usd : undefined,
    };
    const result = await createOrGetWorkstream(reqObj);
    return send(res, result.created ? 201 : 200, result);
  }

  // GET /workstreams/:slug — the five-questions position, for a bot to read
  if (method === 'GET' && parts.length === 2 && parts[0] === 'workstreams') {
    const slug = parts[1]!;
    let doc;
    try {
      doc = await load(slug);
    } catch {
      return send(res, 404, { error: `no workstream '${slug}'` });
    }
    const managed = await listManagedBy(slug);
    return send(res, 200, {
      slug,
      status: doc.workstream.status,
      title: doc.workstream.title,
      objective: doc.workstream.objective,
      revision: doc.revision,
      concluded: doc.workstream.conclusion ? doc.workstream.conclusion.summary : null,
      status_text: renderStatus(doc, managed),
    });
  }

  // POST /workstreams/:slug/observations — a bot reports what it saw (untrusted)
  if (method === 'POST' && parts.length === 3 && parts[0] === 'workstreams' && parts[2] === 'observations') {
    const slug = parts[1]!;
    try {
      await load(slug);
    } catch {
      return send(res, 404, { error: `no workstream '${slug}'` });
    }
    const body = await readJson(req);
    const source = str(body.source);
    const summary = str(body.summary);
    if (!source || !summary) return send(res, 400, { error: 'source and summary are required' });
    const obs: ObservationRequest = { source, summary, ingressKey: str(body.key) };
    const result = await recordObservation(slug, obs);
    return send(res, result.duplicate ? 200 : 201, result);
  }

  send(res, 404, { error: `no route for ${method} ${url.pathname}` });
}

/** Start the adapter. Returns the bound port and a close(); used by tests and
 * by the `serve` CLI command. */
export function startServer(opts: ServeOptions): Promise<RunningServer> {
  const server = createServer((req, res) => {
    handle(req, res, opts.token).catch((e) => {
      const msg = e instanceof SourceKeyConflictError ? e.message : e instanceof Error ? e.message : String(e);
      const status = e instanceof SyntaxError ? 400 : e instanceof SourceKeyConflictError ? 409 : 500;
      if (!res.headersSent) send(res, status, { error: msg });
    });
  });
  return new Promise((resolve) => {
    server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        server,
        port,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}
