import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type Server as HttpServer } from 'node:http';
import type {
  McpHttpServerConfig,
  McpSSEServerConfig,
  McpStdioServerConfig,
} from '@anthropic-ai/claude-agent-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import {
  StdioClientTransport,
  type StdioServerParameters,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  ListToolsRequestSchema,
  ToolSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';

/** The serializable Claude MCP server shapes Weaver can relay. SDK-instance
 * servers are deliberately excluded because they cannot cross a substrate. */
export type McpRelayServerConfig =
  | McpStdioServerConfig
  | McpHttpServerConfig
  | McpSSEServerConfig;

export interface McpRelayOptions {
  /** Environment used for placeholder expansion. Live process.env is never
   * consulted implicitly. */
  env: Readonly<Record<string, string | undefined>>;
  /** Interface the host-side HTTP server listens on. Defaults to loopback. */
  bindHost?: string;
  /** Hostname placed in the URL handed to a remote/container runtime. */
  advertiseHost?: string;
}

export interface McpRelay {
  url: string;
  token: string;
  close(): Promise<void>;
}

type ResolvedConfig =
  | {
      type: 'stdio';
      command: string;
      args?: string[];
      env: Record<string, string>;
      timeout?: number;
    }
  | {
      type: 'http' | 'sse';
      url: URL;
      headers: Record<string, string>;
      timeout?: number;
    };

const PLACEHOLDER = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)(?::-(?:([^}]*)))?\}|([A-Za-z_][A-Za-z0-9_]*))/g;
const SENSITIVE_ENV_NAME = /(?:key|secret|token|password|passwd|credential|auth|header|cookie|session)/i;

function plainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function ownString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function optionalTimeout(record: Record<string, unknown>): number | undefined {
  const timeout = record.timeout;
  return typeof timeout === 'number' && Number.isFinite(timeout) && timeout >= 1_000
    ? timeout
    : undefined;
}

function resolveString(
  value: string,
  env: Readonly<Record<string, string | undefined>>,
  sensitiveValues: Set<string>,
): string {
  return value.replace(PLACEHOLDER, (_match, bracedName: string | undefined,
    fallback: string | undefined, bareName: string | undefined) => {
    const name = bracedName ?? bareName;
    if (!name) throw new Error('invalid MCP environment placeholder');
    const supplied = env[name];
    const resolved = supplied !== undefined && supplied !== '' ? supplied : fallback;
    if (resolved === undefined) {
      throw new Error(`missing MCP environment variable ${name}`);
    }
    if (resolved && SENSITIVE_ENV_NAME.test(name)) sensitiveValues.add(resolved);
    return resolved;
  });
}

function stringRecord(
  value: unknown,
  field: string,
  env: Readonly<Record<string, string | undefined>>,
  sensitiveValues: Set<string>,
): Record<string, string> {
  if (value === undefined) return {};
  if (!plainRecord(value)) throw new Error(`invalid MCP ${field}`);
  const resolved: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') throw new Error(`invalid MCP ${field}`);
    resolved[key] = resolveString(item, env, sensitiveValues);
  }
  return resolved;
}

function rememberCredential(value: string, sensitiveValues: Set<string>): void {
  if (!value) return;
  sensitiveValues.add(value);
  const credential = /^(?:Bearer|Basic)\s+(.+)$/i.exec(value)?.[1];
  if (credential) sensitiveValues.add(credential);
}

function rememberUrlCredential(value: string, sensitiveValues: Set<string>): void {
  rememberCredential(value, sensitiveValues);
  try {
    rememberCredential(decodeURIComponent(value), sensitiveValues);
  } catch {
    // The URL was already accepted; retaining its encoded form is sufficient
    // for confinement when a component is not independently decodable.
  }
}

function resolveConfig(
  rawConfig: unknown,
  suppliedEnv: Readonly<Record<string, string | undefined>>,
  sensitiveValues: Set<string>,
): ResolvedConfig {
  if (!plainRecord(rawConfig)) throw new Error('invalid MCP server configuration');
  const type = ownString(rawConfig, 'type');
  const timeout = optionalTimeout(rawConfig);
  if (rawConfig.oauth !== undefined) {
    throw new Error('MCP OAuth configuration is unsupported by the host relay');
  }
  if (rawConfig.headersHelper !== undefined) {
    throw new Error('MCP headersHelper configuration is unsupported by the host relay');
  }

  if (type === undefined || type === 'stdio') {
    const command = ownString(rawConfig, 'command');
    if (!command) throw new Error('invalid MCP stdio command');
    const rawArgs = rawConfig.args;
    if (rawArgs !== undefined &&
      (!Array.isArray(rawArgs) || rawArgs.some((arg) => typeof arg !== 'string'))) {
      throw new Error('invalid MCP stdio arguments');
    }
    const configuredEnv = stringRecord(
      rawConfig.env,
      'stdio environment',
      suppliedEnv,
      sensitiveValues,
    );
    for (const [name, value] of Object.entries(configuredEnv)) {
      if (SENSITIVE_ENV_NAME.test(name)) sensitiveValues.add(value);
    }
    for (const [name, value] of Object.entries(suppliedEnv)) {
      if (value && SENSITIVE_ENV_NAME.test(name)) sensitiveValues.add(value);
    }
    return {
      type: 'stdio',
      command: resolveString(command, suppliedEnv, sensitiveValues),
      ...(rawArgs ? {
        args: rawArgs.map((arg) => resolveString(arg as string, suppliedEnv, sensitiveValues)),
      } : {}),
      env: configuredEnv,
      ...(timeout ? { timeout } : {}),
    };
  }

  if (type === 'http' || type === 'streamable-http' || type === 'sse') {
    const transportType = type === 'streamable-http' ? 'http' : type;
    const rawUrl = ownString(rawConfig, 'url');
    if (!rawUrl) throw new Error(`invalid MCP ${transportType} URL`);
    const headers = stringRecord(rawConfig.headers, `${transportType} headers`, suppliedEnv, sensitiveValues);
    for (const value of Object.values(headers)) rememberCredential(value, sensitiveValues);
    let url: URL;
    try {
      url = new URL(resolveString(rawUrl, suppliedEnv, sensitiveValues));
    } catch {
      throw new Error(`invalid MCP ${transportType} URL`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`invalid MCP ${transportType} URL protocol`);
    }
    if (url.username) rememberUrlCredential(url.username, sensitiveValues);
    if (url.password) rememberUrlCredential(url.password, sensitiveValues);
    // Query parameter names are not a security vocabulary. A provider may call
    // its credential `code`, `sig`, or anything else, so every non-empty value
    // is private even when the key does not contain "token" or "secret".
    for (const [, value] of url.searchParams) {
      if (value) rememberUrlCredential(value, sensitiveValues);
    }
    return { type: transportType, url, headers, ...(timeout ? { timeout } : {}) };
  }

  throw new Error('unsupported MCP server transport');
}

function suppliedProcessEnv(
  supplied: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(supplied).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

function makeUpstreamTransport(
  config: ResolvedConfig,
  suppliedEnv: Readonly<Record<string, string | undefined>>,
): Transport {
  if (config.type === 'stdio') {
    const parameters: StdioServerParameters = {
      command: config.command,
      ...(config.args ? { args: config.args } : {}),
      env: { ...suppliedProcessEnv(suppliedEnv), ...config.env },
      stderr: 'pipe',
    };
    const transport = new StdioClientTransport(parameters);
    // StdioClientTransport defaults to inherited stderr. Pipe and drain it so
    // an upstream process cannot print configured credentials through Weaver.
    transport.stderr?.on('data', () => undefined);
    return transport;
  }
  const requestInit: RequestInit = { headers: config.headers };
  if (config.type === 'http') {
    return new StreamableHTTPClientTransport(config.url, { requestInit });
  }
  return new SSEClientTransport(config.url, {
    requestInit,
    // Legacy SSE has two independent HTTP paths. Keep credentials on both the
    // EventSource GET and recurring POST even if an SDK version does not merge
    // requestInit into its EventSource implementation.
    eventSourceInit: {
      fetch: async (url, init) => {
        const headers = new Headers(init.headers);
        for (const [name, value] of Object.entries(config.headers)) headers.set(name, value);
        return fetch(url, { ...init, headers });
      },
    },
  });
}

function requestOptions(timeout: number | undefined): { timeout: number } | undefined {
  return timeout ? { timeout } : undefined;
}

function redact(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === 'string') {
    return secrets.reduce((text, secret) => text.replaceAll(secret, '[REDACTED]'), value);
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, secrets));
  if (plainRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      redact(key, secrets) as string,
      redact(item, secrets),
    ]));
  }
  return value;
}

function validBearer(header: string | undefined, token: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const actual = Buffer.from(header.slice('Bearer '.length));
  const expected = Buffer.from(token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function closeHttpServer(server: HttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function closeProtocolAndTransport(
  protocol: { close(): Promise<void> },
  transport: Transport,
): Promise<void> {
  let failed = false;
  try {
    await protocol.close();
  } catch {
    failed = true;
  }
  try {
    // Protocol.close owns this call, but an explicit second close covers a
    // protocol that failed before reaching its transport.
    await transport.close();
  } catch {
    failed = true;
  }
  if (failed) throw new Error('failed to close MCP connection');
}

function urlHost(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

function makeRelayServer(
  upstream: Client,
  tools: readonly Tool[],
  timeout: number | undefined,
  secrets: readonly string[],
): Server {
  const server = new Server(
    { name: 'weaver-mcp-relay', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );
  const names = new Set(tools.map((tool) => tool.name));

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...tools] }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (!names.has(request.params.name)) throw new Error('unknown relayed MCP tool');
    try {
      const result = await upstream.callTool(
        {
          name: request.params.name,
          ...(request.params.arguments ? {
            arguments: redact(request.params.arguments, secrets) as Record<string, unknown>,
          } : {}),
        },
        CallToolResultSchema,
        requestOptions(timeout),
      );
      return CallToolResultSchema.parse(redact(result, secrets)) as CallToolResult;
    } catch {
      // Upstream transport errors can contain URLs, headers, argv, or stderr.
      // Keep the model-visible failure deterministic and credential-free.
      throw new Error('upstream MCP tool call failed');
    }
  });
  return server;
}

/**
 * Connect to one configured operator MCP server, snapshot its complete
 * paginated tools/list catalog once, and expose those tools through a fresh
 * authenticated Streamable HTTP endpoint for one disposable run.
 */
export async function startMcpRelay(
  rawConfig: unknown,
  options: McpRelayOptions,
): Promise<McpRelay> {
  const sensitiveValues = new Set<string>();
  const config = resolveConfig(rawConfig, options.env, sensitiveValues);
  const upstreamTransport = makeUpstreamTransport(config, options.env);
  const upstream = new Client({ name: 'weaver-mcp-relay', version: '0.1.0' });
  const upstreamSecrets = [...sensitiveValues]
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  let tools: Tool[];

  try {
    await upstream.connect(upstreamTransport);
    tools = [];
    let cursor: string | undefined;
    do {
      const listed = await upstream.listTools(
        cursor ? { cursor } : undefined,
        requestOptions(config.timeout),
      );
      tools.push(...listed.tools.map(
        (tool) => ToolSchema.parse(redact(tool, upstreamSecrets)),
      ));
      cursor = listed.nextCursor;
    } while (cursor);
  } catch {
    await Promise.allSettled([closeProtocolAndTransport(upstream, upstreamTransport)]);
    throw new Error('failed to connect to configured MCP server');
  }

  const bindHost = options.bindHost ?? '127.0.0.1';
  const advertiseHost = options.advertiseHost ?? bindHost;
  const token = randomBytes(32).toString('base64url');
  sensitiveValues.add(token);
  const secrets = [...sensitiveValues].filter(Boolean).sort((left, right) => right.length - left.length);
  const active = new Set<{ mcp: Server; transport: StreamableHTTPServerTransport }>();
  let closed = false;
  let closePromise: Promise<void> | undefined;

  const http = createServer(async (req, res) => {
    if (closed) {
      res.writeHead(503, { Connection: 'close' }).end();
      return;
    }
    if (req.url !== '/mcp') {
      res.writeHead(404).end();
      return;
    }
    if (!validBearer(req.headers.authorization, token)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' }).end();
      return;
    }

    const mcp = makeRelayServer(upstream, tools, config.timeout, secrets);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const connection = { mcp, transport };
    active.add(connection);
    const dispose = () => {
      if (!active.delete(connection)) return;
      void closeProtocolAndTransport(mcp, transport).catch(() => undefined);
    };
    res.once('close', dispose);

    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    } catch {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'MCP relay request failed' },
          id: null,
        }));
      }
      dispose();
    }
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const fail = () => reject(new Error('failed to listen for MCP relay requests'));
      http.once('error', fail);
      http.listen(0, bindHost, () => {
        http.off('error', fail);
        resolve();
      });
    });
  } catch {
    await Promise.allSettled([closeProtocolAndTransport(upstream, upstreamTransport)]);
    throw new Error('failed to start MCP relay');
  }

  const address = http.address();
  if (!address || typeof address === 'string') {
    await Promise.allSettled([
      closeHttpServer(http),
      closeProtocolAndTransport(upstream, upstreamTransport),
    ]);
    throw new Error('failed to start MCP relay');
  }

  return {
    url: `http://${urlHost(advertiseHost)}:${address.port}/mcp`,
    token,
    close() {
      closePromise ??= (async () => {
        closed = true;
        const connections = [...active];
        active.clear();
        const results = await Promise.allSettled([
          ...connections.map(({ mcp, transport }) => closeProtocolAndTransport(mcp, transport)),
          closeHttpServer(http),
          closeProtocolAndTransport(upstream, upstreamTransport),
        ]);
        if (results.some((result) => result.status === 'rejected')) {
          throw new Error('failed to close MCP relay');
        }
      })();
      return closePromise;
    },
  };
}
