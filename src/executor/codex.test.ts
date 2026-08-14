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
