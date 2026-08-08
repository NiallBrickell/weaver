import { randomBytes } from 'node:crypto';
import { createServer, type Server as HttpServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { SubmitReply, SubmitSurface } from './types.js';

export interface SubmitBridge {
  url: string;
  token: string;
  close(): Promise<void>;
}

export interface SubmitBridgeOptions {
  /** Interface the host HTTP server listens on. */
  bindHost?: string;
  /** Hostname placed in the URL handed to a remote/container runtime. */
  advertiseHost?: string;
}

function toolResult(reply: SubmitReply) {
  return {
    content: [{ type: 'text' as const, text: reply.text }],
    ...(reply.isError ? { isError: true } : {}),
  };
}

function makeMcpServer(submit: SubmitSurface): McpServer {
  const server = new McpServer({ name: 'weaver-submit', version: '0.1.0' });

  server.registerTool(
    'append_section',
    {
      description: 'Append one ordered section to a long Weaver deliverable before submitting it.',
      inputSchema: z.object({ content: z.string().min(1) }),
    },
    async ({ content }) => toolResult(await submit.appendSection(content)),
  );

  server.registerTool(
    'submit_result',
    {
      description: 'Finalize the one proposed result for this Weaver assignment.',
      inputSchema: z.object({
        summary: z.string(),
        artifact: z.object({
          title: z.string(),
          kind: z.string(),
          file_name: z.string(),
          content: z.string(),
        }),
      }),
    },
    async (args) => toolResult(await submit.submitResult(args)),
  );

  return server;
}

function closeHttpServer(server: HttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function urlHost(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

function scrub(value: string, credential: string): string {
  return value.replaceAll(credential, '[REDACTED]');
}

/**
 * Expose Weaver's in-process submission closures to a disposable remote agent
 * loop. The bearer token is per-run and remains process-local; binding and
 * advertising are separate because a container may reach the host under a
 * different name than the interface on which Node listens.
 */
export async function startSubmitBridge(
  submit: SubmitSurface,
  options: SubmitBridgeOptions = {},
): Promise<SubmitBridge> {
  const bindHost = options.bindHost ?? '127.0.0.1';
  const advertiseHost = options.advertiseHost ?? bindHost;
  const token = randomBytes(32).toString('base64url');
  const active = new Set<{ mcp: McpServer; transport: StreamableHTTPServerTransport }>();
  let closed = false;
  const protectedSubmit: SubmitSurface = {
    appendSection: (content) => submit.appendSection(scrub(content, token)),
    submitResult: (args) => submit.submitResult({
      summary: scrub(args.summary, token),
      artifact: {
        title: scrub(args.artifact.title, token),
        kind: scrub(args.artifact.kind, token),
        file_name: scrub(args.artifact.file_name, token),
        content: scrub(args.artifact.content, token),
      },
    }),
  };

  const http = createServer(async (req, res) => {
    if (closed) {
      res.writeHead(503, { Connection: 'close' }).end();
      return;
    }
    if (req.url !== '/mcp') {
      res.writeHead(404).end();
      return;
    }
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' }).end();
      return;
    }

    const mcp = makeMcpServer(protectedSubmit);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const connection = { mcp, transport };
    active.add(connection);
    const dispose = () => {
      if (!active.delete(connection)) return;
      void transport.close().catch(() => undefined);
      void mcp.close().catch(() => undefined);
    };
    res.once('close', dispose);

    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
          id: null,
        }));
      }
      dispose();
    }
  });

  await new Promise<void>((resolve, reject) => {
    const fail = (error: Error) => reject(error);
    http.once('error', fail);
    http.listen(0, bindHost, () => {
      http.off('error', fail);
      resolve();
    });
  });

  const address = http.address();
  if (!address || typeof address === 'string') {
    await closeHttpServer(http);
    throw new Error('submit bridge did not receive a TCP address');
  }

  return {
    url: `http://${urlHost(advertiseHost)}:${address.port}/mcp`,
    token,
    async close() {
      if (closed) return;
      closed = true;
      const connections = [...active];
      active.clear();
      const results = await Promise.allSettled(connections.flatMap(({ mcp, transport }) => [
        transport.close(),
        mcp.close(),
      ]));
      let serverFailure: unknown;
      try { await closeHttpServer(http); }
      catch (error) { serverFailure = error; }
      const failures = results
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => result.reason);
      if (serverFailure !== undefined) failures.push(serverFailure);
      if (failures.length) throw new AggregateError(failures, 'failed to close submit bridge');
    },
  };
}
