import { strict as assert } from 'node:assert';
import { createServer, type Server as HttpServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { startMcpRelay } from './mcpRelay.js';

interface FixtureState {
  tools: Tool[];
  listCalls: number;
  calls: Array<{ name: string; arguments: Record<string, unknown> | undefined }>;
  failureSecret?: string;
}

const fixtureTools: Tool[] = [
  {
    name: 'read_fixture',
    title: 'Read fixture',
    description: 'Reads a deterministic fixture.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'write_fixture',
    description: 'Writes a deterministic fixture.',
    inputSchema: {
      type: 'object',
      properties: { message: { type: 'string' } },
      required: ['message'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        message: { type: 'string' },
      },
      required: ['name', 'message'],
    },
    annotations: { destructiveHint: true, idempotentHint: false },
  },
  {
    name: 'explode_fixture',
    description: 'Fails with an upstream-only diagnostic.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'image_fixture',
    description: 'Returns a deterministic MCP image block.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
];

function makeFixtureServer(state: FixtureState): Server {
  const server = new Server(
    { name: 'weaver-mcp-relay-fixture', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    state.listCalls += 1;
    return { tools: structuredClone(state.tools) };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (!state.tools.some((tool) => tool.name === request.params.name)) {
      throw new Error('unknown fixture tool');
    }
    if (request.params.name === 'explode_fixture') {
      throw new Error(`upstream diagnostic ${state.failureSecret ?? ''}`);
    }
    state.calls.push({
      name: request.params.name,
      arguments: request.params.arguments,
    });
    const message = typeof request.params.arguments?.message === 'string'
      ? request.params.arguments.message
      : '';
    if (request.params.name === 'image_fixture') {
      return {
        content: [{
          type: 'image' as const,
          data: Buffer.from('weaver-image-fixture').toString('base64'),
          mimeType: 'image/png',
        }],
      };
    }
    return {
      content: [{ type: 'text' as const, text: `called ${request.params.name}` }],
      ...(request.params.name === 'write_fixture' ? {
        isError: true,
        structuredContent: { name: request.params.name, message },
      } : {}),
    };
  });
  return server;
}

function listen(server: HttpServer): Promise<number> {
  return new Promise((resolve, reject) => {
    const fail = (error: Error) => reject(error);
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', fail);
      const address = server.address();
      if (!address || typeof address === 'string') reject(new Error('fixture did not bind TCP'));
      else resolve(address.port);
    });
  });
}

function closeServer(server: HttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function startHttpFixture(secret: string): Promise<{
  url: string;
  state: FixtureState;
  close(): Promise<void>;
}> {
  const state: FixtureState = {
    tools: structuredClone(fixtureTools),
    listCalls: 0,
    calls: [],
    failureSecret: secret,
  };
  const active = new Set<{ mcp: Server; transport: StreamableHTTPServerTransport }>();
  const http = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${secret}`) {
      res.writeHead(401).end();
      return;
    }
    const mcp = makeFixtureServer(state);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const connection = { mcp, transport };
    active.add(connection);
    const dispose = () => {
      if (!active.delete(connection)) return;
      void Promise.allSettled([mcp.close(), transport.close()]);
    };
    res.once('close', dispose);
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    } catch {
      if (!res.headersSent) res.writeHead(500).end();
      dispose();
    }
  });
  const port = await listen(http);
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    state,
    async close() {
      await Promise.allSettled(
        [...active].flatMap(({ mcp, transport }) => [mcp.close(), transport.close()]),
      );
      await closeServer(http);
    },
  };
}

async function startSseFixture(secret: string): Promise<{
  url: string;
  state: FixtureState;
  close(): Promise<void>;
}> {
  const state: FixtureState = {
    tools: [structuredClone(fixtureTools[0]!)],
    listCalls: 0,
    calls: [],
  };
  const sessions = new Map<string, { mcp: Server; transport: SSEServerTransport }>();
  const http = createServer(async (req, res) => {
    if (req.headers['x-fixture-key'] !== secret) {
      res.writeHead(401).end();
      return;
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/sse') {
      const transport = new SSEServerTransport('/message', res);
      const mcp = makeFixtureServer(state);
      const session = { mcp, transport };
      sessions.set(transport.sessionId, session);
      res.once('close', () => sessions.delete(transport.sessionId));
      try {
        await mcp.connect(transport);
      } catch {
        sessions.delete(transport.sessionId);
        await Promise.allSettled([mcp.close(), transport.close()]);
      }
      return;
    }
    if (req.method === 'POST' && url.pathname === '/message') {
      const session = sessions.get(url.searchParams.get('sessionId') ?? '');
      if (!session) {
        res.writeHead(404).end();
        return;
      }
      await session.transport.handlePostMessage(req, res);
      return;
    }
    res.writeHead(404).end();
  });
  const port = await listen(http);
  return {
    url: `http://127.0.0.1:${port}/sse`,
    state,
    async close() {
      const active = [...sessions.values()];
      sessions.clear();
      await Promise.allSettled(active.flatMap(({ mcp, transport }) => [mcp.close(), transport.close()]));
      await closeServer(http);
    },
  };
}

async function connectRelayClient(url: string, token: string): Promise<Client> {
  const client = new Client({ name: 'weaver-mcp-relay-test', version: '0.1.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }));
  return client;
}

async function runStdioFixture(): Promise<void> {
  const state: FixtureState = {
    tools: [{
      name: 'stdio_fixture',
      description: 'Proves stdio transport and configured environment expansion.',
      inputSchema: { type: 'object', properties: {} },
    }],
    listCalls: 0,
    calls: [],
  };
  const server = makeFixtureServer(state);
  server.setRequestHandler(CallToolRequestSchema, async () => ({
    content: [{
      type: 'text' as const,
      text: process.env.FIXTURE_EXPECTED === process.env.STDIO_SECRET
        ? `${process.env.FIXTURE_LABEL} ${process.env.STDIO_SECRET}`
        : 'stdio bad',
    }],
  }));
  await server.connect(new StdioServerTransport());
}

if (process.env.WEAVER_MCP_RELAY_STDIO_FIXTURE === '1') {
  await runStdioFixture();
} else {
  test('relays every snapshotted HTTP tool with auth, schemas, results, and secret confinement', async () => {
    const upstreamSecret = 'upstream-http-secret-98413';
    const urlSecret = 'upstream-url-secret-30391';
    const fixture = await startHttpFixture(upstreamSecret);
    fixture.state.tools[0]!.description = `credential in catalog ${urlSecret}`;
    const relay = await startMcpRelay({
      type: 'http',
      url: `${fixture.url}?opaque=\${UPSTREAM_URL_SECRET}`,
      headers: { Authorization: 'Bearer ${UPSTREAM_SECRET}' },
      // Claude-side tool policies are permission prompts, not Weaver authority.
      // A substrate relay must not turn one into a capability allow-list.
      tools: [{ name: 'read_fixture', permission_policy: 'always_allow' }],
    }, { env: { UPSTREAM_SECRET: upstreamSecret, UPSTREAM_URL_SECRET: urlSecret } });
    const client = await connectRelayClient(relay.url, relay.token);

    try {
      const unauthorized = await fetch(relay.url, {
        method: 'POST',
        headers: { Authorization: `Bearer wrong-${relay.token}` },
      });
      assert.equal(unauthorized.status, 401);
      const unauthorizedBody = await unauthorized.text();
      assert.doesNotMatch(unauthorizedBody, new RegExp(upstreamSecret));
      assert.doesNotMatch(unauthorizedBody, new RegExp(relay.token));

      const firstList = await client.listTools();
      assert.deepEqual(
        firstList.tools.map((tool) => tool.name),
        ['read_fixture', 'write_fixture', 'explode_fixture', 'image_fixture'],
      );
      assert.equal(firstList.tools[0]!.description, 'credential in catalog [REDACTED]');
      assert.deepEqual(firstList.tools[1], fixtureTools[1]);
      assert.equal(fixture.state.listCalls, 1);

      fixture.state.tools.push({
        name: 'late_fixture',
        inputSchema: { type: 'object', properties: {} },
      });
      const secondList = await client.listTools();
      assert.deepEqual(
        secondList.tools.map((tool) => tool.name),
        ['read_fixture', 'write_fixture', 'explode_fixture', 'image_fixture'],
      );
      assert.equal(fixture.state.listCalls, 1);

      const called = CallToolResultSchema.parse(await client.callTool({
        name: 'write_fixture',
        arguments: { message: `${relay.token} ${upstreamSecret}` },
      }));
      assert.equal(called.isError, true);
      assert.deepEqual(called.content, [{ type: 'text', text: 'called write_fixture' }]);
      assert.deepEqual(called.structuredContent, {
        name: 'write_fixture',
        message: '[REDACTED] [REDACTED]',
      });
      assert.deepEqual(fixture.state.calls, [{
        name: 'write_fixture',
        arguments: { message: '[REDACTED] [REDACTED]' },
      }]);

      const image = CallToolResultSchema.parse(await client.callTool({
        name: 'image_fixture',
        arguments: {},
      }));
      assert.deepEqual(image.content, [{
        type: 'image',
        data: Buffer.from('weaver-image-fixture').toString('base64'),
        mimeType: 'image/png',
      }]);

      await assert.rejects(
        client.callTool({ name: 'explode_fixture', arguments: {} }),
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          assert.match(message, /upstream MCP tool call failed/);
          assert.doesNotMatch(message, new RegExp(upstreamSecret));
          return true;
        },
      );
    } finally {
      await client.close();
      await relay.close();
      await relay.close();
      await fixture.close();
    }
  });

  test('connects to a legacy SSE operator server with expanded headers', async () => {
    const secret = 'sse-header-secret-7125';
    const fixture = await startSseFixture(secret);
    const relay = await startMcpRelay({
      type: 'sse',
      url: fixture.url,
      headers: { 'X-Fixture-Key': '$SSE_SECRET' },
    }, { env: { SSE_SECRET: secret } });
    const client = await connectRelayClient(relay.url, relay.token);
    try {
      assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), ['read_fixture']);
      const result = CallToolResultSchema.parse(await client.callTool({
        name: 'read_fixture',
        arguments: {},
      }));
      assert.deepEqual(result.content, [{ type: 'text', text: 'called read_fixture' }]);
      assert.equal(fixture.state.listCalls, 1);
      assert.deepEqual(fixture.state.calls, [{ name: 'read_fixture', arguments: {} }]);
    } finally {
      await client.close();
      await relay.close();
      await fixture.close();
    }
  });

  test('connects to a stdio operator server and expands its configured environment', async () => {
    const secret = 'stdio-env-secret-4628';
    const relay = await startMcpRelay({
      command: process.execPath,
      args: ['--import', 'tsx', fileURLToPath(import.meta.url)],
      env: {
        WEAVER_MCP_RELAY_STDIO_FIXTURE: '1',
        FIXTURE_EXPECTED: '${STDIO_SECRET}',
        FIXTURE_LABEL: '${DISPLAY_LABEL}',
      },
    }, { env: { STDIO_SECRET: secret, DISPLAY_LABEL: 'stdio ok' } });
    const client = await connectRelayClient(relay.url, relay.token);
    try {
      assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), ['stdio_fixture']);
      const result = CallToolResultSchema.parse(await client.callTool({
        name: 'stdio_fixture',
        arguments: {},
      }));
      assert.deepEqual(result.content, [{ type: 'text', text: 'stdio ok [REDACTED]' }]);
    } finally {
      await client.close();
      await relay.close();
      await relay.close();
    }
  });

  test('fails closed without exposing substituted credentials', async () => {
    const secret = 'startup-secret-55317';
    const fixture = await startHttpFixture('different-secret');
    try {
      await assert.rejects(
        startMcpRelay({
          type: 'http',
          url: fixture.url,
          headers: { Authorization: 'Bearer ${UPSTREAM_SECRET}' },
        }, { env: { UPSTREAM_SECRET: secret } }),
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          assert.equal(message, 'failed to connect to configured MCP server');
          assert.doesNotMatch(message, new RegExp(secret));
          return true;
        },
      );
      await assert.rejects(
        startMcpRelay({
          type: 'http',
          url: fixture.url,
          headers: { Authorization: 'Bearer ${MISSING_SECRET}' },
        }, { env: {} }),
        /missing MCP environment variable MISSING_SECRET/,
      );
      await assert.rejects(
        startMcpRelay({
          type: 'http', url: fixture.url, oauth: { clientId: 'synthetic' },
        }, { env: {} }),
        /OAuth configuration is unsupported/,
      );
      await assert.rejects(
        startMcpRelay({
          type: 'http', url: fixture.url, headersHelper: 'synthetic-helper',
        }, { env: {} }),
        /headersHelper configuration is unsupported/,
      );
    } finally {
      await fixture.close();
    }
  });
}
