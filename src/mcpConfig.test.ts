import { test } from 'node:test';
import assert from 'node:assert/strict';
import { query, type SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import { secureMcpHeaderCredentials } from './mcpConfig.js';

test('literal MCP header credentials leave serialized config and move to child env', () => {
  const credential = 'Bearer synthetic-credential-never-use-live-values';
  const input = {
    magpie: {
      type: 'http',
      url: 'https://example.invalid/mcp',
      headers: {
        Authorization: credential,
        'X-Tenant': 'synthetic-tenant-secret',
      },
    },
  };

  const secured = secureMcpHeaderCredentials(input);
  const serialized = JSON.stringify(secured.servers);
  assert.doesNotMatch(serialized, /synthetic-credential|synthetic-tenant-secret/);
  assert.deepEqual(
    (secured.servers.magpie as { headers: Record<string, string> }).headers,
    {
      Authorization: '${WEAVER_INTERNAL_MCP_HEADER_1}',
      'X-Tenant': '${WEAVER_INTERNAL_MCP_HEADER_2}',
    },
  );
  assert.deepEqual(secured.env, {
    WEAVER_INTERNAL_MCP_HEADER_1: credential,
    WEAVER_INTERNAL_MCP_HEADER_2: 'synthetic-tenant-secret',
  });
  assert.equal(input.magpie.headers.Authorization, credential, 'pure transform must not mutate operator config');
});

test('existing supported environment placeholders remain placeholders', () => {
  const secured = secureMcpHeaderCredentials({
    existing: {
      type: 'sse',
      url: 'https://example.invalid/sse',
      headers: {
        Authorization: 'Bearer ${EXISTING_TOKEN}',
        'X-Key': '$EXISTING_KEY',
      },
    },
  });

  assert.deepEqual(secured.env, {});
  assert.match(JSON.stringify(secured.servers), /EXISTING_TOKEN/);
  assert.match(JSON.stringify(secured.servers), /EXISTING_KEY/);
});

test('non-header MCP configuration is preserved', () => {
  const stdio = { command: 'node', args: ['server.js'], env: { SAFE: 'value' } };
  const secured = secureMcpHeaderCredentials({ local: stdio, disabled: false });
  assert.deepEqual(secured.servers, { local: stdio, disabled: false });
  assert.deepEqual(secured.env, {});
});

test('the real Agent SDK spawn receives placeholders in argv and values only in env', async () => {
  const credential = 'Bearer synthetic-spawn-credential';
  const secured = secureMcpHeaderCredentials({
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
