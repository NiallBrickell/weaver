/**
 * Ephemeral provider proxy for container executors.
 *
 * A long-lived model-provider credential must never enter the agent container:
 * its normal terminal can inspect its own environment and runtime files. The
 * container receives only this proxy's random per-run bearer. The real key is
 * held in the host process closure, applied only to inference requests, and
 * disappears when the executor closes the proxy.
 */

import { randomBytes } from 'node:crypto';
import * as http from 'node:http';

const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const ALLOWED_PATHS = new Set([
  '/v1/chat/completions',
  '/v1/responses',
]);
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'content-length',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
const REWRITTEN_RESPONSE_HEADERS = new Set([
  ...HOP_BY_HOP_HEADERS,
  'content-encoding',
  'content-md5',
  'etag',
]);

export interface ProviderProxy {
  /** OpenAI-compatible base URL advertised to the container. */
  url: string;
  /** Per-run credential safe to place inside the disposable container. */
  token: string;
  /** Model id stated by the upstream provider response, not local config. */
  modelResolved(): string | null;
  close(): Promise<void>;
}

export interface ProviderProxyOptions {
  upstreamBaseUrl: string;
  upstreamApiKey: string;
  /** Exact model spellings the adapter may send to this run-bound proxy. */
  allowedModels: readonly string[];
  /** Hard upper bound for all inference calls made with this run bearer. */
  maxRequests: number;
  bindHost?: string;
  advertiseHost?: string;
  fetch?: typeof globalThis.fetch;
  token?: string;
}

export async function startProviderProxy(options: ProviderProxyOptions): Promise<ProviderProxy> {
  const allowedModels = new Set(options.allowedModels.filter(Boolean));
  if (allowedModels.size === 0) throw new Error('provider proxy requires at least one allowed model');
  if (!Number.isSafeInteger(options.maxRequests) || options.maxRequests <= 0) {
    throw new Error('provider proxy maxRequests must be a positive integer');
  }
  const bindHost = options.bindHost ?? '127.0.0.1';
  const advertiseHost = options.advertiseHost ?? bindHost;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const token = options.token ?? randomBytes(32).toString('hex');
  const upstreamBaseUrl = options.upstreamBaseUrl.replace(/\/+$/, '');
  let modelResolved: string | null = null;
  let requestCount = 0;
  const inFlight = new Set<AbortController>();

  const server = http.createServer(async (request, response) => {
    try {
      if (request.headers.authorization !== `Bearer ${token}`) {
        respondJson(response, 401, { error: 'unauthorized' });
        return;
      }
      const incoming = new URL(request.url ?? '/', 'http://provider.invalid');
      if (request.method !== 'POST' || !ALLOWED_PATHS.has(incoming.pathname)) {
        respondJson(response, 404, { error: 'unsupported provider path' });
        return;
      }

      const body = await readBody(request);
      const requestedModel = requestModel(body);
      if (!requestedModel || !allowedModels.has(requestedModel)) {
        respondJson(response, 403, { error: 'model is not authorized for this run' });
        return;
      }
      if (requestCount >= options.maxRequests) {
        respondJson(response, 429, { error: 'run inference request limit reached' });
        return;
      }
      requestCount += 1;
      const suffix = incoming.pathname.slice('/v1'.length) + incoming.search;
      const headers = forwardedRequestHeaders(request.headers);
      headers.set('Authorization', `Bearer ${options.upstreamApiKey}`);
      const upstreamAbort = new AbortController();
      inFlight.add(upstreamAbort);
      request.once('aborted', () => upstreamAbort.abort());
      try {
        const upstream = await fetchImpl(`${upstreamBaseUrl}${suffix}`, {
          method: 'POST',
          headers,
          body,
          signal: upstreamAbort.signal,
        });

        response.statusCode = upstream.status;
        for (const [name, value] of upstream.headers) {
          if (!REWRITTEN_RESPONSE_HEADERS.has(name.toLowerCase())) response.setHeader(name, value);
        }
        const raw = Buffer.from(await upstream.arrayBuffer()).toString('utf8');
        modelResolved = responseModel(raw, upstream.headers.get('content-type')) ?? modelResolved;
        const bytes = Buffer.from(raw.replaceAll(options.upstreamApiKey, '[REDACTED]'));
        response.setHeader('Content-Length', bytes.byteLength);
        response.end(bytes);
      } finally {
        inFlight.delete(upstreamAbort);
      }
    } catch (caught) {
      const detail = caught instanceof Error ? caught.message : String(caught);
      // Provider errors can contain request metadata. The durable key is
      // scrubbed before even this ephemeral response reaches the container.
      respondJson(response, 502, {
        error: detail.replaceAll(options.upstreamApiKey, '[REDACTED]'),
      });
    }
  });

  await new Promise<void>((resolvePromise, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(0, bindHost, () => {
      server.off('error', onError);
      resolvePromise();
    });
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    await closeServer(server);
    throw new Error('provider proxy did not bind a TCP port');
  }
  let closed = false;
  return {
    url: `http://${advertiseHost}:${address.port}/v1`,
    token,
    modelResolved: () => modelResolved,
    async close() {
      if (closed) return;
      closed = true;
      for (const controller of inFlight) controller.abort();
      await closeServer(server);
    },
  };
}

function requestModel(body: Buffer): string | null {
  try {
    const parsed = JSON.parse(body.toString('utf8')) as unknown;
    return isRecord(parsed) && typeof parsed.model === 'string' ? parsed.model : null;
  } catch {
    return null;
  }
}

function responseModel(body: string, contentType: string | null): string | null {
  if (contentType?.includes('text/event-stream') || body.startsWith('data:')) {
    for (const line of body.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice('data:'.length).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const parsed = JSON.parse(data) as unknown;
        if (isRecord(parsed) && typeof parsed.model === 'string') return parsed.model;
      } catch {
        // A malformed provider event remains the provider client's concern.
      }
    }
    return null;
  }
  try {
    const parsed = JSON.parse(body) as unknown;
    return isRecord(parsed) && typeof parsed.model === 'string' ? parsed.model : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function forwardedRequestHeaders(source: http.IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [name, raw] of Object.entries(source)) {
    if (raw === undefined || HOP_BY_HOP_HEADERS.has(name.toLowerCase())) continue;
    for (const value of Array.isArray(raw) ? raw : [raw]) headers.append(name, value);
  }
  return headers;
}

function readBody(request: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > MAX_REQUEST_BYTES) {
        reject(new Error('provider request exceeded 32 MiB'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.once('end', () => resolvePromise(Buffer.concat(chunks)));
    request.once('error', reject);
  });
}

function respondJson(response: http.ServerResponse, status: number, value: unknown): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': body.byteLength,
  });
  response.end(body);
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    server.close((error) => (error ? reject(error) : resolvePromise()));
  });
}
