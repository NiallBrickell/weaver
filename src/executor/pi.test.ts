import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { PiExecutor } from './pi.js';
import type { WorkerExecutionRequest } from './types.js';

function request(overrides: Partial<WorkerExecutionRequest> = {}): WorkerExecutionRequest {
  return {
    workstreamSlug: 'pi-degrade',
    assignmentId: 'asg_pi_degrade',
    prompt: 'Complete the assignment.',
    systemPrompt: { type: 'preset', preset: 'claude_code', append: 'System rules' },
    model: 'zai-coding-plan/glm-5.3',
    tools: { type: 'preset', preset: 'claude_code' },
    allowedTools: ['mcp__weaver__*'],
    permissionMode: 'bypassPermissions',
    settingSources: ['user', 'project', 'local'],
    strictMcpConfig: false,
    maxTurns: 10,
    cwd: '/fixture/worktree',
    additionalDirectories: [],
    env: { PATH: '/usr/bin' },
    operatorMcpServers: {},
    submit: {
      async appendSection() { return { text: 'appended' }; },
      async submitResult() { return { text: 'submitted' }; },
    },
    abort: new AbortController(),
    ...overrides,
  };
}

describe('PiExecutor operator MCP degradation', () => {
  const workdir = mkdtempSync(join(tmpdir(), 'weaver-pi-degrade-'));

  test('proceeds without an unreachable operator MCP server and tells the worker', async () => {
    const relayNames: string[] = [];
    let systemPrompt: string | null = null;
    const executor = new PiExecutor({
      executorSecrets: { ZAI_API_KEY: 'zai-secret' },
      startProviderProxy: async () => ({
        url: 'http://127.0.0.1:43901/proxy',
        token: 'proxy-token',
        modelResolved: () => 'glm-5.3',
        async close() {},
      }),
      startMcpRelay: async (rawConfig: unknown) => {
        const url = (rawConfig as { url?: string }).url ?? '';
        const name = url.includes('sentry') ? 'sentry' : 'healthy';
        relayNames.push(name);
        if (name === 'sentry') throw new Error('failed to connect to configured MCP server');
        return {
          url: `http://127.0.0.1:43902/${name}/mcp`,
          token: `${name}-relay-token`,
          async close() {},
        };
      },
      startBridge: async () => ({
        url: 'http://127.0.0.1:43903/mcp',
        token: 'bridge-token',
        async close() {},
      }),
      startRuntime: async (input) => {
        systemPrompt = input.systemPrompt;
        return {
          harnessVersion: 'pi-test',
          sessionId: 'pi-session',
          async run() {
            return {
              error: null,
              usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, reasoningOutputTokens: 0 },
              providerResolved: 'zai-coding-plan',
              modelResolved: 'glm-5.3',
              costUsd: null,
            };
          },
          async abort() {},
          async close() {},
        };
      },
    });

    const outcome = await executor.execute(request({
      cwd: workdir,
      operatorMcpServers: {
        healthy: { type: 'http', url: 'https://healthy.example/mcp' } as never,
        sentry: { type: 'http', url: 'https://mcp.sentry.dev/mcp' } as never,
      },
    }));

    assert.equal(outcome.error, undefined);
    assert.deepEqual(relayNames.sort(), ['healthy', 'sentry']);
    assert.match(systemPrompt ?? '', /unavailable during this run: sentry/);
    assert.doesNotMatch(systemPrompt ?? '', /healthy/);
    assert.equal(executor.lastTelemetry()?.terminalReason, 'completed');
  });
});
