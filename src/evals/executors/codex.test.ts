import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import type {
  CodexOptions,
  RunStreamedResult,
  ThreadEvent,
  ThreadOptions,
} from '@openai/codex-sdk';
import type { SubmitBridge } from '../../executor/submitBridge.js';
import type { SubmitSurface, WorkerExecutionRequest } from '../../executor/types.js';
import { CodexEvalExecutor } from './codex.js';

function request(overrides: Partial<WorkerExecutionRequest> = {}): WorkerExecutionRequest {
  return {
    workstreamSlug: 'eval-codex',
    assignmentId: 'asg_codex',
    prompt: 'Worker prompt',
    systemPrompt: { type: 'preset', preset: 'claude_code', append: 'System rules' },
    model: 'gpt-5.6-codex',
    tools: { type: 'preset', preset: 'claude_code' },
    allowedTools: ['mcp__weaver__*'],
    permissionMode: 'bypassPermissions',
    settingSources: [],
    strictMcpConfig: true,
    maxTurns: 80,
    cwd: '/fixture/workspace',
    additionalDirectories: ['/fixture/additional'],
    env: {
      PATH: '/usr/bin',
      OPENAI_API_KEY: 'must-not-switch-billing',
      CODEX_API_KEY: 'must-not-switch-principal',
      OMIT_ME: undefined,
    },
    operatorMcpServers: {},
    submit: {
      async appendSection() { return { text: 'appended' }; },
      async submitResult() { return { text: 'submitted' }; },
    },
    abort: new AbortController(),
    ...overrides,
  };
}

function streamed(events: AsyncGenerator<ThreadEvent>): RunStreamedResult {
  return { events };
}

describe('CodexEvalExecutor', () => {
  test('starts one workspace-write thread with a required authenticated submit MCP and records stream telemetry', async () => {
    const base = Date.parse('2026-08-08T10:00:00.000Z');
    let elapsed = 0;
    let codexOptions: CodexOptions | undefined;
    let threadOptions: ThreadOptions | undefined;
    let prompt: string | undefined;
    let signal: AbortSignal | undefined;
    let bridgeSubmit: SubmitSurface | undefined;
    let bridgeClosed = 0;
    const bridge: SubmitBridge = {
      url: 'http://127.0.0.1:43210/mcp',
      token: 'bridge-secret',
      async close() { bridgeClosed++; },
    };

    async function* eventStream(): AsyncGenerator<ThreadEvent> {
      elapsed = 12;
      yield { type: 'thread.started', thread_id: 'thread-fresh-1' };
      elapsed = 35;
      await bridgeSubmit!.submitResult({
        summary: 'Deterministic submission.',
        artifact: {
          title: 'Fixture',
          kind: 'report',
          file_name: 'fixture.md',
          content: 'fixture',
        },
      });
      yield {
        type: 'item.completed',
        item: {
          id: 'mcp-1',
          type: 'mcp_tool_call',
          server: 'weaver',
          tool: 'submit_result',
          arguments: {},
          status: 'completed',
        },
      };
      elapsed = 50;
      yield {
        type: 'turn.completed',
        usage: {
          input_tokens: 101,
          cached_input_tokens: 31,
          cache_write_input_tokens: 7,
          output_tokens: 42,
          reasoning_output_tokens: 11,
        },
      };
    }

    const executor = new CodexEvalExecutor({
      startBridge: async (submit) => {
        bridgeSubmit = submit;
        return bridge;
      },
      createCodex(options) {
        codexOptions = options;
        return {
          startThread(options_) {
            threadOptions = options_;
            return {
              async runStreamed(input, turnOptions) {
                prompt = input;
                signal = turnOptions?.signal;
                return streamed(eventStream());
              },
            };
          },
        };
      },
      monotonicNow: () => elapsed,
      now: () => new Date(base + elapsed),
      harnessVersion: 'test-harness',
    });
    const req = request();

    const outcome = await executor.execute(req);

    assert.deepEqual(outcome, { costUsd: 0, sessionId: 'thread-fresh-1' });
    assert.equal(bridgeClosed, 1);
    assert.equal(prompt, 'System rules\n\nWorker prompt');
    assert.equal(signal, req.abort.signal);
    assert.deepEqual(threadOptions, {
      model: 'gpt-5.6-codex',
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
      workingDirectory: '/fixture/workspace',
      additionalDirectories: ['/fixture/additional'],
      skipGitRepoCheck: true,
    });
    assert.deepEqual(codexOptions, {
      env: {
        PATH: '/usr/bin',
        WEAVER_CODEX_SUBMIT_TOKEN: 'bridge-secret',
      },
      config: {
        forced_login_method: 'chatgpt',
        history: { persistence: 'none' },
        mcp_servers: {
          weaver: {
            url: 'http://127.0.0.1:43210/mcp',
            bearer_token_env_var: 'WEAVER_CODEX_SUBMIT_TOKEN',
            required: true,
            enabled: true,
            enabled_tools: ['append_section', 'submit_result'],
            default_tools_approval_mode: 'approve',
          },
        },
      },
    });
    assert.deepEqual(executor.lastTelemetry(), {
      executor: 'codex-sdk',
      modelRequested: 'gpt-5.6-codex',
      providerResolved: 'openai',
      modelResolved: 'gpt-5.6-codex',
      harnessVersion: 'test-harness',
      isolation: 'host-process',
      startedAt: '2026-08-08T10:00:00.000Z',
      endedAt: '2026-08-08T10:00:00.050Z',
      durationMs: 50,
      startupMs: 12,
      timeToSubmissionMs: 35,
      usage: {
        inputTokens: 101,
        outputTokens: 42,
        cachedInputTokens: 31,
        reasoningOutputTokens: 11,
      },
      costUsd: null,
      sessionId: 'thread-fresh-1',
      terminalReason: 'completed',
      error: null,
    });
  });

  test('creates a fresh thread for every execute and never resumes one', async () => {
    let clientCount = 0;
    let threadCount = 0;
    let bridgeCount = 0;
    const closed: number[] = [];
    const executor = new CodexEvalExecutor({
      async startBridge() {
        const id = ++bridgeCount;
        return {
          url: `http://127.0.0.1:${44000 + id}/mcp`,
          token: `token-${id}`,
          async close() { closed.push(id); },
        };
      },
      createCodex() {
        clientCount++;
        return {
          startThread() {
            const id = ++threadCount;
            return {
              async runStreamed() {
                async function* events(): AsyncGenerator<ThreadEvent> {
                  yield { type: 'thread.started', thread_id: `thread-${id}` };
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
        };
      },
    });

    const first = await executor.execute(request());
    const second = await executor.execute(request({ assignmentId: 'asg_codex_2' }));

    assert.equal(clientCount, 2);
    assert.equal(threadCount, 2);
    assert.deepEqual(closed, [1, 2]);
    assert.equal(first.sessionId, 'thread-1');
    assert.equal(second.sessionId, 'thread-2');
  });

  test('fails supervised actions closed before starting a bridge or SDK client', async () => {
    let bridgeStarts = 0;
    let clientStarts = 0;
    const executor = new CodexEvalExecutor({
      startBridge: async () => {
        bridgeStarts++;
        throw new Error('must not start');
      },
      createCodex() {
        clientStarts++;
        throw new Error('must not start');
      },
      monotonicNow: () => 10,
      now: () => new Date('2026-08-08T11:00:00.000Z'),
      harnessVersion: 'test-harness',
    });

    const outcome = await executor.execute(request({
      supervise: async (_toolName, input) => ({ behavior: 'allow', updatedInput: input }),
    }));

    assert.equal(bridgeStarts, 0);
    assert.equal(clientStarts, 0);
    assert.match(outcome.error ?? '', /per-tool authority callback/);
    assert.deepEqual(executor.lastTelemetry(), {
      executor: 'codex-sdk',
      modelRequested: 'gpt-5.6-codex',
      providerResolved: null,
      modelResolved: null,
      harnessVersion: 'test-harness',
      isolation: 'host-process',
      startedAt: '2026-08-08T11:00:00.000Z',
      endedAt: '2026-08-08T11:00:00.000Z',
      durationMs: 0,
      startupMs: null,
      timeToSubmissionMs: null,
      usage: {
        inputTokens: null,
        outputTokens: null,
        cachedInputTokens: null,
        reasoningOutputTokens: null,
      },
      costUsd: null,
      sessionId: null,
      terminalReason: 'unsupported',
      error: outcome.error,
    });
  });
});
