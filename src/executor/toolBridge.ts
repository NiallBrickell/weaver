import { randomBytes } from 'node:crypto';
import { createServer, type Server as HttpServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

/** Structural twin of the Agent SDK tool definition, deliberately erasing
 * each tool's distinct inferred argument type so heterogeneous tool arrays can
 * cross the substrate bridge without rebuilding schemas or handlers. */
export interface BridgeToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, z.ZodType>;
  annotations?: ToolAnnotations;
  handler(args: any, extra: unknown): Promise<CallToolResult>;
}

export interface ToolBridge {
  url: string;
  token: string;
  close(): Promise<void>;
}

export interface ToolBridgeOptions {
  /** Interface the host HTTP server listens on. */
  bindHost?: string;
  /** Hostname placed in the URL handed to a remote/container runtime. */
  advertiseHost?: string;
  /** Values that are valid process plumbing but can never become durable
   * model-authored tool arguments (for example a per-pass temporary cwd). */
  rejectArgumentValues?: string[];
  rejectArgumentMessage?: string;
}

function closeHttpServer(server: HttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function urlHost(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

/** The bridge credential is process plumbing, never model-authored state. */
function scrubCredential(value: unknown, credential: string): unknown {
  if (typeof value === 'string') return value.replaceAll(credential, '[REDACTED]');
  if (Array.isArray(value)) return value.map((item) => scrubCredential(item, credential));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, scrubCredential(item, credential)]),
    );
  }
  return value;
}

function containsString(value: unknown, needles: string[]): boolean {
  if (typeof value === 'string') return needles.some((needle) => needle && value.includes(needle));
  if (Array.isArray(value)) return value.some((item) => containsString(item, needles));
  if (value !== null && typeof value === 'object') {
    return Object.values(value).some((item) => containsString(item, needles));
  }
  return false;
}

function makeMcpServer(
  tools: BridgeToolDefinition[],
  credential: string,
  options: ToolBridgeOptions,
): McpServer {
  const server = new McpServer({ name: 'weaver', version: '0.1.0' });
  for (const definition of tools) {
    server.registerTool(
      definition.name,
      {
        description: definition.description,
        inputSchema: z.object(definition.inputSchema),
        ...(definition.annotations ? { annotations: definition.annotations } : {}),
      },
      async (args, extra) => {
        const scrubbed = scrubCredential(args, credential);
        if (containsString(scrubbed, options.rejectArgumentValues ?? [])) {
          return {
            content: [{
              type: 'text' as const,
              text: options.rejectArgumentMessage ??
                'REFUSED: tool arguments contain executor-private process plumbing',
            }],
            isError: true,
          };
        }
        return definition.handler(scrubbed as never, extra);
      },
    );
  }
  return server;
}

/**
 * Expose in-process harness tools to one disposable model loop over an
 * authenticated localhost MCP endpoint. A new stateless MCP server is built
 * per HTTP request; the bearer credential is random per bridge and scrubbed
 * recursively before any tool handler can persist model-authored arguments.
 */
export async function startToolBridge(
  tools: BridgeToolDefinition[],
  options: ToolBridgeOptions = {},
): Promise<ToolBridge> {
  const bindHost = options.bindHost ?? '127.0.0.1';
  const advertiseHost = options.advertiseHost ?? bindHost;
  const token = randomBytes(32).toString('base64url');
  const active = new Set<{ mcp: McpServer; transport: StreamableHTTPServerTransport }>();
  let closed = false;

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

    const mcp = makeMcpServer(tools, token, options);
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
    throw new Error('tool bridge did not receive a TCP address');
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
      if (failures.length) throw new AggregateError(failures, 'failed to close tool bridge');
    },
  };
}
