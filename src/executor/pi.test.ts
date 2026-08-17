import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { PiExecutor } from './pi.js';
import type { SubmitSurface, WorkerExecutionRequest } from './types.js';

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

  test('an accepted submission is the terminal fact even when the post-submit abort throws', async () => {
    // The production extension aborts the agent loop right after the harness
    // accepts submit_result; on some providers that surfaces as a rejected
    // RPC promise ("This operation was aborted") instead of run.error.
    // Mislabeling it failed re-dispatches already-submitted work — the exact
    // duplicate-egress hazard the existing run.error rule exists to prevent.
    let capturedSubmit: SubmitSurface | null = null;
    const executor = new PiExecutor({
      executorSecrets: { ZAI_API_KEY: 'zai-secret' },
      startProviderProxy: async () => ({
        url: 'http://127.0.0.1:43911/proxy',
        token: 'proxy-token',
        modelResolved: () => 'glm-5.3',
        async close() {},
      }),
      startMcpRelay: async () => {
        throw new Error('unreachable in this test');
      },
      startBridge: async (submit) => {
        capturedSubmit = submit;
        return { url: 'http://127.0.0.1:43912/mcp', token: 'bridge-token', async close() {} };
      },
      startRuntime: async () => ({
        harnessVersion: 'pi-test',
        sessionId: 'pi-session',
        async run() {
          const reply = await capturedSubmit!.submitResult({
            summary: 'Done.',
            artifact: {
              title: 'Evidence', kind: 'report', file_name: 'evidence.md',
              content: `# Evidence\n\n${'Verified. '.repeat(8)}`,
            },
          });
          assert.equal(reply.isError, undefined);
          throw new Error('This operation was aborted');
        },
        async abort() {},
        async close() {},
      }),
    });

    const outcome = await executor.execute(request({ cwd: workdir }));

    assert.equal(outcome.error, undefined);
    assert.equal(executor.lastTelemetry()?.terminalReason, 'completed');
    assert.notEqual(executor.lastTelemetry()?.timeToSubmissionMs, null);
  });

  test('cleanup races never flip an accepted submission into a failed attempt', async () => {
    // macOS ENOTEMPTY: the dying RPC child's last writes race rmSync. A
    // leftover temp dir is a leak worth surfacing on stderr — but joining it
    // into `failure` turned submitted work into a retriable failure, inviting
    // duplicate dispatch of already-published work.
    const stderrLines: string[] = [];
    const originalWrite = process.stderr.write;
    process.stderr.write = ((chunk: unknown) => {
      stderrLines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    let capturedSubmit: SubmitSurface | null = null;
    const executor = new PiExecutor({
      executorSecrets: { ZAI_API_KEY: 'zai-secret' },
      removeDirectory: () => {
        throw Object.assign(new Error('ENOTEMPTY, Directory not empty'), { code: 'ENOTEMPTY' });
      },
      startProviderProxy: async () => ({
        url: 'http://127.0.0.1:43913/proxy',
        token: 'proxy-token',
        modelResolved: () => 'glm-5.3',
        async close() {},
      }),
      startBridge: async (submit) => {
        capturedSubmit = submit;
        return { url: 'http://127.0.0.1:43914/mcp', token: 'bridge-token', async close() {} };
      },
      startRuntime: async () => ({
        harnessVersion: 'pi-test',
        sessionId: null,
        async run() {
          const reply = await capturedSubmit!.submitResult({
            summary: 'Done.',
            artifact: {
              title: 'Evidence', kind: 'report', file_name: 'evidence.md',
              content: `# Evidence\n\n${'Verified. '.repeat(8)}`,
            },
          });
          assert.equal(reply.isError, undefined);
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
      }),
    });

    let outcome: Awaited<ReturnType<typeof executor.execute>>;
    try {
      outcome = await executor.execute(request({ cwd: workdir }));
    } finally {
      process.stderr.write = originalWrite;
    }

    assert.equal(outcome!.error, undefined);
    assert.equal(executor.lastTelemetry()?.terminalReason, 'completed');
    assert.match(stderrLines.join(''), /cleanup incomplete after accepted submission/);
  });
});
