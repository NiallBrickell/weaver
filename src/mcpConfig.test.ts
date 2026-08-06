import { test } from 'node:test';
import assert from 'node:assert/strict';
import { query, type SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import { secureMcpConfiguration } from './mcpConfig.js';

test('literal MCP header credentials leave serialized config and move with the capability env', () => {
  const credential = 'Bearer synthetic-credential-never-use-live-values';
  const input = {
    remote: {
      type: 'http',
      url: 'https://example.invalid/mcp',
      headers: {
        Authorization: credential,
        'X-Tenant': 'synthetic-tenant-secret',
      },
    },
  };

  const secured = secureMcpConfiguration(input);
  const serialized = JSON.stringify(secured.servers);
  assert.doesNotMatch(serialized, /synthetic-credential|synthetic-tenant-secret/);
  assert.deepEqual(
    (secured.servers.remote as { headers: Record<string, string> }).headers,
    {
      Authorization: '${WEAVER_INTERNAL_MCP_HEADER_1}',
      'X-Tenant': '${WEAVER_INTERNAL_MCP_HEADER_2}',
    },
  );
  assert.deepEqual(secured.env, {
    WEAVER_INTERNAL_MCP_HEADER_1: credential,
    WEAVER_INTERNAL_MCP_HEADER_2: 'synthetic-tenant-secret',
  });
  assert.equal(
    input.remote.headers.Authorization,
    credential,
    'pure transform must not mutate operator config',
  );
});

test('all inherited servers and only their referenced environment cross the boundary', () => {
  const secured = secureMcpConfiguration(
    {
      langfuse: {
        type: 'sse',
        url: '${MCP_ORIGIN:-https://example.invalid}/langfuse',
        headers: { Authorization: 'Bearer ${LANGFUSE_TOKEN}' },
      },
      magpie: {
        type: 'http',
        url: 'https://example.invalid/magpie',
        headers: { 'X-Key': '$MAGPIE_KEY' },
      },
      local: {
        command: '${MCP_NODE}',
        args: ['server.js', '--tenant=${MCP_TENANT}'],
        env: { DATABASE_URL: '${DATABASE_URL}', LITERAL_SECRET: 'synthetic-local-secret' },
      },
    },
    {
      LANGFUSE_TOKEN: 'synthetic-langfuse-value',
      MAGPIE_KEY: 'synthetic-magpie-value',
      MCP_NODE: '/synthetic/node',
      MCP_TENANT: 'synthetic-tenant',
      DATABASE_URL: 'postgres://synthetic.invalid/db',
      UNRELATED_HOST_SECRET: 'must-not-cross',
    },
  );

  assert.deepEqual(Object.keys(secured.servers).sort(), ['langfuse', 'local', 'magpie']);
  assert.deepEqual(secured.env, {
    LANGFUSE_TOKEN: 'synthetic-langfuse-value',
    MAGPIE_KEY: 'synthetic-magpie-value',
    MCP_NODE: '/synthetic/node',
    MCP_TENANT: 'synthetic-tenant',
    DATABASE_URL: 'postgres://synthetic.invalid/db',
    WEAVER_INTERNAL_MCP_ENV_1: 'synthetic-local-secret',
  });
  assert.doesNotMatch(JSON.stringify(secured), /must-not-cross/);
  assert.doesNotMatch(JSON.stringify(secured.servers), /synthetic-local-secret/);
  assert.match(JSON.stringify(secured.servers), /LANGFUSE_TOKEN/);
  assert.match(JSON.stringify(secured.servers), /MAGPIE_KEY/);
  assert.deepEqual(
    (secured.servers.local as { env: Record<string, string> }).env,
    {
      DATABASE_URL: '${DATABASE_URL}',
      LITERAL_SECRET: '${WEAVER_INTERNAL_MCP_ENV_1}',
    },
  );
});

test('generated names cannot collide with inherited or referenced environment', () => {
  const secured = secureMcpConfiguration(
    {
      remote: {
        type: 'http',
        url: 'https://example.invalid/mcp',
        headers: {
          Authorization: 'synthetic-secret',
          Existing: '${WEAVER_INTERNAL_MCP_HEADER_1}',
        },
      },
    },
    { WEAVER_INTERNAL_MCP_HEADER_1: 'synthetic-existing-value' },
  );

  assert.deepEqual(secured.env, {
    WEAVER_INTERNAL_MCP_HEADER_1: 'synthetic-existing-value',
    WEAVER_INTERNAL_MCP_HEADER_2: 'synthetic-secret',
  });
});

test('reserved executor credentials cannot be smuggled through MCP placeholders', () => {
  assert.throws(
    () =>
      secureMcpConfiguration(
        {
          remote: {
            type: 'http',
            url: 'https://example.invalid/mcp',
            headers: { Authorization: 'Bearer ${CLAUDE_CODE_OAUTH_TOKEN}' },
          },
        },
        { CLAUDE_CODE_OAUTH_TOKEN: 'synthetic-account-token' },
        ['CLAUDE_CODE_OAUTH_TOKEN'],
      ),
    /reserved executor credential CLAUDE_CODE_OAUTH_TOKEN/,
  );
});

test('the real local Agent SDK spawn receives placeholders in argv and values only in env', async () => {
  const credential = 'Bearer synthetic-spawn-credential';
  const secured = secureMcpConfiguration({
    remote: {
      type: 'http',
      url: 'https://example.invalid/mcp',
      headers: { Authorization: credential },
    },
  });
  let captured: SpawnOptions | undefined;

  await assert.rejects(async () => {
    for await (const _message of query({
      prompt: 'never reaches a model',
      options: {
        mcpServers: secured.servers as never,
        env: secured.env,
        spawnClaudeCodeProcess: (options) => {
          captured = options;
          throw new Error('synthetic spawn stop');
        },
      },
    })) {
      // The synthetic spawner throws before a message can exist.
    }
  }, /synthetic spawn stop/);

  assert.ok(captured);
  assert.doesNotMatch(captured.args.join('\0'), /synthetic-spawn-credential/);
  assert.match(captured.args.join('\0'), /\$\{WEAVER_INTERNAL_MCP_HEADER_1\}/);
  assert.equal(captured.env.WEAVER_INTERNAL_MCP_HEADER_1, credential);
});
