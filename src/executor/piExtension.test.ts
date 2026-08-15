import assert from 'node:assert/strict';
import { createServer, type Server as HttpServer } from 'node:http';
import { test } from 'node:test';
import type {
  ExtensionAPI,
  ProviderConfig,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { startExtensionSubmitBridge } from './extensionSubmitBridge.js';
import {
  createWeaverPiExtension,
  WEAVER_HARNESS_SUBMIT_TOKEN_ENV,
  WEAVER_HARNESS_SUBMIT_URL_ENV,
  WEAVER_PI_MCP_RELAYS_ENV,
  WEAVER_PI_PROVIDER_CONFIG_ENV,
} from './piExtension.js';
import type { SubmitResultArgs } from './types.js';

interface FakePi {
  api: ExtensionAPI;
  providers: Array<{ name: string; config: ProviderConfig }>;
  tools: ToolDefinition[];
  handlers: Map<string, Array<(event: never) => unknown | Promise<unknown>>>;
}

function fakePi(): FakePi {
  const providers: FakePi['providers'] = [];
  const tools: ToolDefinition[] = [];
  const handlers: FakePi['handlers'] = new Map();
  const api = {
    registerProvider(name: string, config: ProviderConfig) {
      providers.push({ name, config });
    },
    registerTool(tool: ToolDefinition) {
      tools.push(tool);
    },
    on(event: string, handler: (event: never) => unknown | Promise<unknown>) {
      const registered = handlers.get(event) ?? [];
      registered.push(handler);
      handlers.set(event, registered);
    },
  } as unknown as ExtensionAPI;
  return { api, providers, tools, handlers };
}

function providerEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    [WEAVER_PI_PROVIDER_CONFIG_ENV]: JSON.stringify({
      provider: 'weaver-proxy',
      model: 'fixture-model',
      baseUrl: 'http://127.0.0.1:43123/v1',
      apiKey: 'disposable-provider-bearer',
    }),
    [WEAVER_PI_MCP_RELAYS_ENV]: '[]',
    [WEAVER_HARNESS_SUBMIT_URL_ENV]: 'http://127.0.0.1:43124',
    [WEAVER_HARNESS_SUBMIT_TOKEN_ENV]: 'disposable-submit-bearer',
    ...overrides,
  };
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

interface McpFixture {
  url: string;
  listCalls: number;
  calls: Array<{ name: string; arguments?: Record<string, unknown> }>;
  close(): Promise<void>;
}

async function startMcpFixture(options: {
  token: string;
  tools: Tool[];
  callResult?: CallToolResult;
  failCalls?: boolean;
}): Promise<McpFixture> {
  let listCalls = 0;
  const calls: McpFixture['calls'] = [];
  const active = new Set<{ server: Server; transport: StreamableHTTPServerTransport }>();
  const http = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${options.token}`) {
      res.writeHead(401).end();
      return;
    }
    const server = new Server(
      { name: 'weaver-pi-extension-fixture', version: '0.1.0' },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      listCalls += 1;
      return { tools: structuredClone(options.tools) };
    });
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (options.failCalls) throw new Error(`private upstream failure ${options.token}`);
      calls.push({
        name: request.params.name,
        ...(request.params.arguments ? { arguments: request.params.arguments } : {}),
      });
      return structuredClone(options.callResult ?? {
        content: [{ type: 'text' as const, text: 'fixture called' }],
      });
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const connection = { server, transport };
    active.add(connection);
    const dispose = () => {
      if (!active.delete(connection)) return;
      void Promise.allSettled([server.close(), transport.close()]);
    };
    res.once('close', dispose);
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch {
      if (!res.headersSent) res.writeHead(500).end();
      dispose();
    }
  });
  const port = await listen(http);
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    get listCalls() { return listCalls; },
    calls,
    async close() {
      const connections = [...active];
      active.clear();
      await Promise.allSettled(connections.flatMap(
        ({ server, transport }) => [server.close(), transport.close()],
      ));
      await closeServer(http);
    },
  };
}

async function executeTool(
  tool: ToolDefinition,
  args: Record<string, unknown>,
  context: { abort(): void } = { abort() {} },
) {
  return tool.execute('fixture-call', args as never, undefined, undefined, context as never);
}

async function emit(fake: FakePi, event: string, value: unknown): Promise<unknown[]> {
  const handlers = fake.handlers.get(event) ?? [];
  return Promise.all(handlers.map((handler) => handler(value as never)));
}

test('registers the explicit run provider and authenticated Weaver submission surface only', async () => {
  let appended: string | undefined;
  let submitted: SubmitResultArgs | undefined;
  const bridge = await startExtensionSubmitBridge({
    async appendSection(content) {
      appended = content;
      return { text: 'section accepted' };
    },
    async submitResult(args) {
      submitted = args;
      return { text: 'result accepted' };
    },
  });
  const env = providerEnv({
    [WEAVER_HARNESS_SUBMIT_URL_ENV]: bridge.url,
    [WEAVER_HARNESS_SUBMIT_TOKEN_ENV]: bridge.token,
  });
  const fake = fakePi();
  let aborts = 0;

  try {
    await createWeaverPiExtension(env)(fake.api);

    assert.deepEqual(fake.providers, [{
      name: 'weaver-proxy',
      config: {
        name: 'Weaver run-bound weaver-proxy',
        baseUrl: 'http://127.0.0.1:43123/v1',
        apiKey: 'disposable-provider-bearer',
        api: 'openai-completions',
        models: [{
          id: 'fixture-model',
          name: 'fixture-model',
          reasoning: false,
          input: ['text', 'image'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128_000,
          maxTokens: 16_384,
        }],
      },
    }]);
    assert.deepEqual(fake.tools.map(({ name }) => name), [
      'weaver_append_section',
      'weaver_submit_result',
    ]);
    assert.deepEqual(
      Object.keys(env).filter((name) => name.startsWith('WEAVER_')),
      [],
      'run bearer bundles must not remain in the shell environment',
    );

    assert.deepEqual(await executeTool(fake.tools[0]!, { content: 'first section' }), {
      content: [{ type: 'text', text: 'section accepted' }],
      details: {},
    });
    const resultArgs = {
      summary: 'done',
      artifact: { title: 'Title', kind: 'report', file_name: 'report.md', content: 'Body' },
    };
    assert.deepEqual(await executeTool(fake.tools[1]!, resultArgs, {
      abort() { aborts += 1; },
    }), {
      content: [{ type: 'text', text: 'result accepted' }],
      details: {},
    });
    assert.equal(appended, 'first section');
    assert.deepEqual(submitted, resultArgs);
    assert.equal(aborts, 1, 'accepted submit_result structurally ends the agent loop');
    assert.equal(fake.handlers.has('session_shutdown'), true);
    assert.equal(fake.handlers.has('tool_result'), true);
    await emit(fake, 'session_shutdown', { type: 'session_shutdown' });
  } finally {
    await bridge.close();
  }
});

test('snapshots multiple authenticated MCP relays and preserves schemas, results, errors, and collisions', async () => {
  const firstToken = 'first-disposable-relay-bearer';
  const secondToken = 'second-disposable-relay-bearer';
  const inputSchema = {
    type: 'object' as const,
    properties: {
      issue: { type: 'string', minLength: 3, pattern: '^WVR-' },
      mode: { oneOf: [{ const: 'read' }, { const: 'write' }] },
    },
    required: ['issue'],
    additionalProperties: false,
  };
  const upstreamResult: CallToolResult = {
    content: [
      { type: 'text', text: 'updated WVR-17' },
      { type: 'image', data: Buffer.from('image fixture').toString('base64'), mimeType: 'image/png' },
      { type: 'resource_link', uri: 'https://example.test/WVR-17', name: 'WVR-17' },
    ],
    structuredContent: { issue: 'WVR-17', state: 'updated' },
    isError: true,
  };
  const first = await startMcpFixture({
    token: firstToken,
    tools: [{
      name: 'sync-item',
      title: 'Sync item',
      description: 'Synchronize one fixture item.',
      inputSchema,
      annotations: { destructiveHint: true },
    }],
    callResult: upstreamResult,
  });
  const second = await startMcpFixture({
    token: secondToken,
    tools: [{ name: 'sync-item', inputSchema: { type: 'object', properties: {} } }],
  });
  const env = providerEnv({
    [WEAVER_PI_MCP_RELAYS_ENV]: JSON.stringify([
      { name: 'tracker.one', url: first.url, token: firstToken },
      { name: 'tracker_one', url: second.url, token: secondToken },
    ]),
  });
  const fake = fakePi();

  try {
    await createWeaverPiExtension(env)(fake.api);
    assert.equal(first.listCalls, 1);
    assert.equal(second.listCalls, 1);
    const relayed = fake.tools.slice(2);
    assert.deepEqual(relayed.map(({ name }) => name), [
      'mcp__tracker_one__sync-item',
      'mcp__tracker_one__sync-item__2',
    ]);
    assert.deepEqual(relayed[0]!.parameters, inputSchema);
    assert.equal(relayed[0]!.description, 'Synchronize one fixture item.');

    const result = await executeTool(relayed[0]!, { issue: 'WVR-17', mode: 'write' });
    assert.deepEqual(first.calls, [{
      name: 'sync-item',
      arguments: { issue: 'WVR-17', mode: 'write' },
    }]);
    assert.deepEqual(result.details, { kind: 'weaver-mcp-result', result: upstreamResult });
    const imageBlock = upstreamResult.content[1];
    assert.equal(imageBlock?.type, 'image');
    if (!imageBlock || imageBlock.type !== 'image') throw new Error('fixture image is missing');
    assert.deepEqual(result.content.slice(0, 2), [
      { type: 'text', text: 'updated WVR-17' },
      { type: 'image', data: imageBlock.data, mimeType: 'image/png' },
    ]);
    assert.deepEqual(JSON.parse((result.content[2] as { text: string }).text), {
      mcpContent: upstreamResult.content[2],
    });
    assert.deepEqual(JSON.parse((result.content[3] as { text: string }).text), {
      mcpStructuredContent: upstreamResult.structuredContent,
    });

    const eventResults = await emit(fake, 'tool_result', {
      type: 'tool_result',
      toolCallId: 'fixture-call',
      toolName: relayed[0]!.name,
      input: { issue: 'WVR-17' },
      content: result.content,
      details: result.details,
      isError: false,
    });
    assert.deepEqual(eventResults, [{ isError: true }]);
    assert.equal(JSON.stringify(result).includes(firstToken), false);
    assert.equal(JSON.stringify(result).includes(secondToken), false);
    await emit(fake, 'session_shutdown', { type: 'session_shutdown' });
  } finally {
    await Promise.allSettled([first.close(), second.close()]);
  }
});

test('fails closed with generic secret-free diagnostics for malformed setup and MCP failures', async () => {
  const malformedSecret = 'must-not-escape-malformed-provider';
  const malformed = providerEnv({
    [WEAVER_PI_PROVIDER_CONFIG_ENV]: `{"provider":"${malformedSecret}"}`,
  });
  await assert.rejects(
    async () => createWeaverPiExtension(malformed)(fakePi().api),
    (error: Error) => {
      assert.equal(error.message, 'WEAVER_PI_PROVIDER_CONFIG is missing or malformed');
      assert.equal(error.message.includes(malformedSecret), false);
      return true;
    },
  );

  const relayToken = 'must-not-escape-relay-token';
  const fixture = await startMcpFixture({
    token: relayToken,
    tools: [{ name: 'explode', inputSchema: { type: 'object', properties: {} } }],
    failCalls: true,
  });
  try {
    const unauthorizedEnv = providerEnv({
      [WEAVER_PI_MCP_RELAYS_ENV]: JSON.stringify([
        { name: 'private', url: fixture.url, token: `${relayToken}-wrong` },
      ]),
    });
    await assert.rejects(
      async () => createWeaverPiExtension(unauthorizedEnv)(fakePi().api),
      (error: Error) => {
        assert.equal(error.message, 'failed to discover configured MCP relay');
        assert.equal(error.message.includes(relayToken), false);
        return true;
      },
    );

    const fake = fakePi();
    await createWeaverPiExtension(providerEnv({
      [WEAVER_PI_MCP_RELAYS_ENV]: JSON.stringify([
        { name: 'private', url: fixture.url, token: relayToken },
      ]),
    }))(fake.api);
    await assert.rejects(
      executeTool(fake.tools[2]!, {}),
      (error: Error) => {
        assert.equal(error.message, 'configured MCP tool call failed');
        assert.equal(error.message.includes(relayToken), false);
        return true;
      },
    );
    await emit(fake, 'session_shutdown', { type: 'session_shutdown' });
  } finally {
    await fixture.close();
  }
});
