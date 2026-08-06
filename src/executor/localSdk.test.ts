import { test } from 'node:test';
import assert from 'node:assert/strict';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { LocalSdkExecutor } from './localSdk.js';
import type { WorkerExecutionRequest } from './types.js';

test('local executor provisions every inherited MCP with its capability environment', async () => {
  let captured: Parameters<typeof query>[0] | undefined;
  const fakeQuery = ((args: Parameters<typeof query>[0]) => {
    captured = args;
    return (async function* () {})();
  }) as typeof query;

  const req: WorkerExecutionRequest = {
    workstreamSlug: 'remote-mcp-contract',
    assignmentId: 'asg_test',
    prompt: 'test prompt',
    systemPrompt: 'test system prompt',
    model: 'sonnet',
    tools: [],
    allowedTools: ['mcp__weaver__*'],
    maxTurns: 3,
    additionalDirectories: [],
    sandbox: false,
    env: {
      WORKSTREAM_SECRET: 'synthetic-workstream-secret',
      CLAUDE_CODE_OAUTH_TOKEN: 'synthetic-account-token',
    },
    operatorMcp: {
      servers: {
        langfuse: { type: 'http', url: 'https://example.invalid/langfuse' },
        magpie: {
          type: 'http',
          url: 'https://example.invalid/magpie',
          headers: { Authorization: '${WEAVER_INTERNAL_MCP_HEADER_1}' },
        },
      },
      env: { WEAVER_INTERNAL_MCP_HEADER_1: 'synthetic-mcp-secret' },
    },
    supervise: async (_toolName, input) => ({ behavior: 'allow', updatedInput: input }),
    submit: {
      appendSection: async () => ({ text: 'unused' }),
      submitResult: async () => ({ text: 'unused' }),
    },
    abort: new AbortController(),
  };

  await new LocalSdkExecutor(fakeQuery).execute(req);

  assert.ok(captured);
  const options = captured.options;
  assert.ok(options);
  assert.equal(options.env?.WORKSTREAM_SECRET, 'synthetic-workstream-secret');
  assert.equal(
    options.env?.WEAVER_INTERNAL_MCP_HEADER_1,
    'synthetic-mcp-secret',
  );
  assert.equal(options.env?.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  const servers = options.mcpServers as Record<string, unknown>;
  assert.deepEqual(servers.langfuse, req.operatorMcp.servers.langfuse);
  assert.deepEqual(servers.magpie, req.operatorMcp.servers.magpie);
  assert.ok(servers.weaver, 'harness submit server must remain present');
});
