import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type {
  RunStreamedResult,
  ThreadEvent,
  ThreadOptions,
} from '@openai/codex-sdk';
import { CodexExecutor } from './codex.js';
import type { SubmitBridge } from './submitBridge.js';
import type { WorkerExecutionRequest } from './types.js';

function streamed(events: AsyncGenerator<ThreadEvent>): RunStreamedResult {
  return { events };
}

test('Codex worker keeps the turn.failed provider diagnosis when the stream exits non-zero', async () => {
  // The exit-code exception carries only stderr ("Reading prompt from
  // stdin…"), which has no capacity signal; the turn.failed message is what
  // routes a usage limit to infrastructure backoff instead of worker strikes.
  const bridge: SubmitBridge = {
    url: 'http://127.0.0.1:43211/mcp',
    token: 'bridge-secret',
    async close() {},
  };
  const executor = new CodexExecutor({
    startBridge: async () => bridge,
    createCodex: () => ({
      startThread() {
        return {
          async runStreamed() {
            async function* events(): AsyncGenerator<ThreadEvent> {
              yield { type: 'thread.started', thread_id: 'thread-usage-limited' };
              yield {
                type: 'turn.failed',
                error: {
                  message: "You've hit your usage limit for credential selected-token-secret. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Aug 21st, 2026 1:27 AM.",
                },
              };
              throw new Error('Codex Exec exited with code 1: Reading prompt from stdin...');
            }
            return streamed(events());
          },
        };
      },
    }),
  });
  const req: WorkerExecutionRequest = {
    workstreamSlug: 'codex-usage-limit',
    assignmentId: 'asg_codex_usage_limit',
    prompt: 'Complete the ordinary coding assignment.',
    systemPrompt: { type: 'preset', preset: 'claude_code', append: 'System rules' },
    model: 'gpt-5.6-sol',
    tools: { type: 'preset', preset: 'claude_code' },
    allowedTools: ['mcp__weaver__*'],
    permissionMode: 'bypassPermissions',
    settingSources: ['user', 'project', 'local'],
    strictMcpConfig: false,
    maxTurns: 80,
    cwd: '/fixture/worktree',
    additionalDirectories: [],
    env: { PATH: '/usr/bin' },
    redactionSecrets: { READONLY_API_TOKEN: 'selected-token-secret' },
    operatorMcpServers: {},
    submit: {
      async appendSection() { return { text: 'appended' }; },
      async submitResult() { return { text: 'submitted' }; },
    },
    abort: new AbortController(),
  };

  const outcome = await executor.execute(req);

  assert.match(outcome.error ?? '', /You've hit your usage limit/);
  assert.match(outcome.error ?? '', /stream exit: Codex Exec exited with code 1/);
  assert.doesNotMatch(outcome.error ?? '', /selected-token-secret/);
  assert.match(outcome.error ?? '', /«secret:READONLY_API_TOKEN»/);
  assert.doesNotMatch(JSON.stringify(executor.lastTelemetry()), /selected-token-secret/);
});

test('Codex ordinary workers use the exact host-process thread boundary without dropping workspace paths', async () => {
  let threadOptions: ThreadOptions | undefined;
  const bridge: SubmitBridge = {
    url: 'http://127.0.0.1:43210/mcp',
    token: 'bridge-secret',
    async close() {},
  };
  const executor = new CodexExecutor({
    startBridge: async () => bridge,
    createCodex: () => ({
      startThread(options) {
        threadOptions = options;
        return {
          async runStreamed() {
            async function* events(): AsyncGenerator<ThreadEvent> {
              yield { type: 'thread.started', thread_id: 'thread-host-boundary' };
              yield {
                type: 'turn.completed',
                usage: {
                  input_tokens: 1,
                  cached_input_tokens: 0,
                  cache_write_input_tokens: 0,
                  output_tokens: 1,
                  reasoning_output_tokens: 0,
                },
              };
            }
            return streamed(events());
          },
        };
      },
    }),
  });
  const req: WorkerExecutionRequest = {
    workstreamSlug: 'codex-host-boundary',
    assignmentId: 'asg_codex_host_boundary',
    prompt: 'Complete the ordinary coding assignment.',
    systemPrompt: { type: 'preset', preset: 'claude_code', append: 'System rules' },
    model: 'gpt-5.6-sol',
    tools: { type: 'preset', preset: 'claude_code' },
    allowedTools: ['mcp__weaver__*'],
    permissionMode: 'bypassPermissions',
    settingSources: ['user', 'project', 'local'],
    strictMcpConfig: false,
    maxTurns: 80,
    cwd: '/fixture/worktree',
    additionalDirectories: ['/fixture/knowledge', '/fixture/host-cache'],
    env: { PATH: '/usr/bin' },
    operatorMcpServers: {},
    submit: {
      async appendSection() { return { text: 'appended' }; },
      async submitResult() { return { text: 'submitted' }; },
    },
    abort: new AbortController(),
  };

  const outcome = await executor.execute(req);

  assert.equal(outcome.error, undefined);
  assert.deepEqual(threadOptions, {
    model: 'gpt-5.6-sol',
    sandboxMode: 'danger-full-access',
    approvalPolicy: 'never',
    workingDirectory: '/fixture/worktree',
    additionalDirectories: ['/fixture/knowledge', '/fixture/host-cache'],
    skipGitRepoCheck: true,
  });
  assert.equal(executor.lastTelemetry()?.isolation, 'host-process');
  assert.equal(executor.lastTelemetry()?.harnessVersion, 'codex-sdk-0.147.0-weaver.3');
});
