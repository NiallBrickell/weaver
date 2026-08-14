import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import type {
  CodexOptions,
  RunStreamedResult,
  ThreadEvent,
  ThreadOptions,
} from '@openai/codex-sdk';
import { z } from 'zod';
import {
  CodexCoordinatorExecutor,
  selectCoordinatorExecutor,
  type CoordinatorExecutionRequest,
} from './coordinator.js';
import type { ToolBridge, ToolBridgeOptions } from './toolBridge.js';

function streamed(events: AsyncGenerator<ThreadEvent>): RunStreamedResult {
  return { events };
}

function request(overrides: Partial<CoordinatorExecutionRequest> = {}): CoordinatorExecutionRequest {
  return {
    prompt: 'Wake and typed projection only.',
    systemPrompt: 'Durable controller doctrine.',
    model: 'gpt-5.6-sol',
    tools: [
      tool(
        'finish_pass',
        'Finish this disposable pass.',
        { summary: z.string() },
        async () => ({ content: [{ type: 'text' as const, text: 'finished' }] }),
      ),
    ],
    env: {
      PATH: '/usr/bin',
      OPENAI_API_KEY: 'must-not-switch-billing',
      CODEX_API_KEY: 'must-not-switch-principal',
      OMIT_ME: undefined,
    },
    abort: new AbortController(),
    ...overrides,
  };
}

describe('CodexCoordinatorExecutor', () => {
  test('runs one fresh, isolated, subscription-backed thread over only the authenticated Weaver tools', async () => {
    let codexOptions: CodexOptions | undefined;
    let threadOptions: ThreadOptions | undefined;
    let prompt: string | undefined;
    let signal: AbortSignal | undefined;
    let bridgeClosed = 0;
    let homeCleaned = 0;
    let bridgeOptions: ToolBridgeOptions | undefined;
    const bridge: ToolBridge = {
      url: 'http://127.0.0.1:43123/mcp',
      token: 'coordinator-bridge-token',
      async close() { bridgeClosed++; },
    };

    async function* events(): AsyncGenerator<ThreadEvent> {
      yield { type: 'thread.started', thread_id: 'fresh-coordinator-thread' };
      yield {
        type: 'item.completed',
        item: {
          id: 'tool-1', type: 'mcp_tool_call', server: 'weaver', tool: 'finish_pass',
          arguments: { summary: 'done' }, status: 'completed',
        },
      };
      yield {
        type: 'turn.completed',
        usage: {
          input_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 0,
          output_tokens: 5, reasoning_output_tokens: 1,
        },
      };
    }

    const executor = new CodexCoordinatorExecutor({
      startBridge: async (_tools, options) => {
        bridgeOptions = options;
        return bridge;
      },
      prepareHome: () => ({
        path: '/tmp/isolated-codex-home',
        cleanup() { homeCleaned++; },
      }),
      createCodex(options) {
        codexOptions = options;
        return {
          startThread(options_) {
            threadOptions = options_;
            return {
              async runStreamed(input, turnOptions) {
                prompt = input;
                signal = turnOptions?.signal;
                return streamed(events());
              },
            };
          },
        };
      },
    });
    const req = request();

    const outcome = await executor.execute(req);

    assert.deepEqual(outcome, { costUsd: 0, sessionId: 'fresh-coordinator-thread' });
    assert.equal(prompt, 'Wake and typed projection only.');
    assert.equal(signal, req.abort.signal);
    assert.equal(bridgeClosed, 1);
    assert.equal(homeCleaned, 1);
    assert.deepEqual(bridgeOptions, {
      rejectArgumentValues: ['/tmp/isolated-codex-home'],
      rejectArgumentMessage:
        'REFUSED: this path belongs to the disposable coordinator process and will be deleted; choose a durable workspace outside the coordinator runtime',
    });
    assert.deepEqual(threadOptions, {
      model: 'gpt-5.6-sol',
      sandboxMode: 'read-only',
      approvalPolicy: 'never',
      networkAccessEnabled: false,
      webSearchMode: 'disabled',
      workingDirectory: '/tmp/isolated-codex-home',
      skipGitRepoCheck: true,
    });
    assert.deepEqual(codexOptions, {
      env: {
        PATH: '/usr/bin',
        CODEX_HOME: '/tmp/isolated-codex-home',
        WEAVER_CODEX_COORDINATOR_TOKEN: 'coordinator-bridge-token',
      },
      config: {
        forced_login_method: 'chatgpt',
        developer_instructions: 'Durable controller doctrine.',
        include_environment_context: false,
        include_permissions_instructions: false,
        include_collaboration_mode_instructions: false,
        include_apps_instructions: false,
        history: { persistence: 'none' },
        agents: { enabled: false },
        features: {
          shell_tool: false,
          unified_exec: false,
          shell_snapshot: false,
          skill_mcp_dependency_install: false,
          apply_patch_freeform: false,
          apps: false,
          plugins: false,
          hooks: false,
          multi_agent: false,
          browser_use: false,
          computer_use: false,
          goals: false,
          image_generation: false,
          js_repl: false,
          exec_permission_approvals: false,
          request_permissions_tool: false,
          search_tool: false,
          standalone_web_search: false,
          tool_suggest: false,
        },
        web_search: 'disabled',
        mcp_servers: {
          weaver: {
            url: 'http://127.0.0.1:43123/mcp',
            bearer_token_env_var: 'WEAVER_CODEX_COORDINATOR_TOKEN',
            required: true,
            enabled: true,
            enabled_tools: ['finish_pass'],
            default_tools_approval_mode: 'approve',
          },
        },
      },
    });
  });

  test('fails closed and aborts if SDK drift exposes a non-Weaver capability', async () => {
    let bridgeClosed = 0;
    let homeCleaned = 0;
    async function* events(): AsyncGenerator<ThreadEvent> {
      yield { type: 'thread.started', thread_id: 'thread-forbidden' };
      yield {
        type: 'item.started',
        item: {
          id: 'command-1', type: 'command_execution', command: 'pwd',
          aggregated_output: '', status: 'in_progress',
        },
      };
    }
    const executor = new CodexCoordinatorExecutor({
      startBridge: async () => ({
        url: 'http://127.0.0.1:43124/mcp', token: 'token',
        async close() { bridgeClosed++; },
      }),
      prepareHome: () => ({
        path: '/tmp/isolated-codex-home-2',
        cleanup() { homeCleaned++; },
      }),
      createCodex: () => ({
        startThread: () => ({ async runStreamed() { return streamed(events()); } }),
      }),
    });
    const req = request();

    const outcome = await executor.execute(req);

    assert.match(outcome.error ?? '', /forbidden command_execution capability/);
    assert.equal(req.abort.signal.aborted, true);
    assert.equal(bridgeClosed, 1);
    assert.equal(homeCleaned, 1);
  });

  test('selects only explicit supported coordinator executors', () => {
    assert.equal(selectCoordinatorExecutor('local-sdk').id, 'local-sdk');
    assert.equal(selectCoordinatorExecutor('codex-sdk').id, 'codex-sdk');
    assert.throws(
      () => selectCoordinatorExecutor('openhands'),
      /unknown coordinator executor 'openhands'/,
    );
  });
});
