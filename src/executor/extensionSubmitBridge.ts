import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http';
import type { SubmitReply, SubmitResultArgs, SubmitSurface } from './types.js';
import { redactSecrets } from '../secrets.js';

export interface ExtensionSubmitBridge {
  /** Base URL; the extension appends one of the two fixed submission paths. */
  url: string;
  token: string;
  close(): Promise<void>;
}

export interface ExtensionSubmitBridgeOptions {
  redactionSecrets?: Record<string, string>;
}

function closeHttpServer(server: HttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 10 * 1024 * 1024) {
        reject(new Error('submission payload exceeds 10 MiB'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('submission payload is not valid JSON')); }
    });
    req.on('error', reject);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSubmitResultArgs(value: unknown): value is SubmitResultArgs {
  if (!isRecord(value) || typeof value.summary !== 'string' || !isRecord(value.artifact)) return false;
  const artifact = value.artifact;
  return ['title', 'kind', 'file_name', 'content']
    .every((field) => typeof artifact[field] === 'string');
}

function scrubReply(reply: SubmitReply, secrets: Record<string, string>): SubmitReply {
  return { ...reply, text: redactSecrets(reply.text, secrets) };
}

export function scrubSubmitResultArgs(
  body: SubmitResultArgs,
  secrets: Record<string, string>,
): SubmitResultArgs {
  return {
    summary: redactSecrets(body.summary, secrets),
    artifact: {
      title: redactSecrets(body.artifact.title, secrets),
      kind: redactSecrets(body.artifact.kind, secrets),
      file_name: redactSecrets(body.artifact.file_name, secrets),
      content: redactSecrets(body.artifact.content, secrets),
    },
  };
}

/**
 * Authenticated localhost relay used by Pi-family extension tools. The model
 * never receives an in-process closure or any other Weaver state API; each
 * run gets a random bearer and exactly append/finalize routes.
 */
export async function startExtensionSubmitBridge(
  submit: SubmitSurface,
  options: ExtensionSubmitBridgeOptions = {},
): Promise<ExtensionSubmitBridge> {
  const token = randomBytes(32).toString('base64url');
  const secrets: Record<string, string> = {
    ...(options.redactionSecrets ?? {}),
    WEAVER_HARNESS_SUBMIT_TOKEN: token,
  };
  let closed = false;

  const http = createServer(async (req, res) => {
    const respond = (status: number, reply: SubmitReply) => {
      res.writeHead(status, { 'Content-Type': 'application/json', Connection: 'close' });
      res.end(JSON.stringify(scrubReply(reply, secrets)));
    };
    if (closed) return respond(503, { text: 'submission bridge is closed', isError: true });
    if (req.headers.authorization !== `Bearer ${token}`) {
      return respond(401, { text: 'unauthorized', isError: true });
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST', Connection: 'close' }).end();
      return;
    }
    try {
      const body = await readJson(req);
      if (req.url === '/append-section') {
        if (!isRecord(body) || typeof body.content !== 'string') {
          return respond(400, { text: 'invalid append_section payload', isError: true });
        }
        const content = redactSecrets(body.content, secrets);
        return respond(200, await submit.appendSection(content));
      }
      if (req.url === '/submit-result') {
        if (!isSubmitResultArgs(body)) {
          return respond(400, { text: 'invalid submit_result payload', isError: true });
        }
        const clean = scrubSubmitResultArgs(body, secrets);
        return respond(200, await submit.submitResult(clean));
      }
      return respond(404, { text: 'unknown Weaver submission route', isError: true });
    } catch (error) {
      return respond(400, {
        text: redactSecrets(error instanceof Error ? error.message : String(error), secrets),
        isError: true,
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    const fail = (error: Error) => reject(error);
    http.once('error', fail);
    http.listen(0, '127.0.0.1', () => {
      http.off('error', fail);
      resolve();
    });
  });
  const address = http.address();
  if (!address || typeof address === 'string') {
    await closeHttpServer(http);
    throw new Error('extension submission bridge did not receive a TCP address');
  }
  const url = `http://127.0.0.1:${address.port}`;
  secrets.WEAVER_HARNESS_SUBMIT_URL = url;

  return {
    url,
    token,
    async close() {
      if (closed) return;
      closed = true;
      await closeHttpServer(http);
    },
  };
}
