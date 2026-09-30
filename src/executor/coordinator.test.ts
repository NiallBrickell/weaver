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
  ClaudeCoordinatorExecutor,
  CodexCoordinatorExecutor,
  PROJECTION_CACHE_MARKER_ENV,
  resetProjectionCacheMarkerRejection,
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
      OPENROUTER_API_KEY: 'must-not-cross-provider-boundary',
      OMIT_ME: undefined,
    },
    abort: new AbortController(),
    ...overrides,
  };
}

describe('ClaudeCoordinatorExecutor', () => {
  test('uses a registered Claude Code setup-token in a fresh config boundary', async () => {
    let captured: any;
    let cleaned = 0;
    const executor = new ClaudeCoordinatorExecutor({
      loadExecutorSecrets: () => ({
        CLAUDE_CODE_OAUTH_TOKEN: 'registered-setup-token',
        ANTHROPIC_API_KEY: 'shadowed-registered-api-key',
      }),
      prepareApiHome: () => ({
        path: '/tmp/fresh-setup-token-home',
        cleanup() { cleaned++; },
      }),
      runQuery: ((args: any) => {
        captured = args;
        return (async function* () {})();
      }) as any,
    });

    const outcome = await executor.execute(request({
      model: 'claude-fable-5',
      env: {
        PATH: '/usr/bin',
        CLAUDE_CODE_OAUTH_TOKEN: 'ambient-setup-token',
        ANTHROPIC_API_KEY: 'ambient-api-key',
        ANTHROPIC_BASE_URL: 'https://untrusted.example',
        OPENROUTER_API_KEY: 'ambient-router-key',
      },
    }));

    assert.deepEqual(outcome, { costUsd: 0 });
    assert.equal(cleaned, 1);
    assert.equal(captured.options.model, 'claude-fable-5');
    assert.deepEqual(captured.options.env, {
      PATH: '/usr/bin',
      CLAUDE_CONFIG_DIR: '/tmp/fresh-setup-token-home',
      CLAUDE_CODE_OAUTH_TOKEN: 'registered-setup-token',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    });
  });

  test('records the pass token anatomy from the SDK result, counting every tool call', async () => {
    const assistant = (content: unknown[]) => ({ type: 'assistant', message: { content } });
    const executor = new ClaudeCoordinatorExecutor({
      loadExecutorSecrets: () => ({}),
      runQuery: (() => (async function* () {
        yield assistant([{ type: 'thinking', thinking: '' }, { type: 'tool_use', id: 't1', name: 'mcp__weaver__read_artifact', input: {} }]);
        yield assistant([
          { type: 'tool_use', id: 't2', name: 'mcp__weaver__adopt_submission', input: {} },
          { type: 'tool_use', id: 't3', name: 'mcp__weaver__schedule_wake', input: {} },
        ]);
        yield assistant([{ type: 'text', text: 'done' }]);
        yield {
          type: 'result', subtype: 'success', is_error: false, num_turns: 3, session_id: 'sess-1',
          total_cost_usd: 1.25,
          usage: {
            input_tokens: 12, output_tokens: 4_000,
            cache_read_input_tokens: 90_000, cache_creation_input_tokens: 21_000,
            cache_creation: { ephemeral_1h_input_tokens: 20_000, ephemeral_5m_input_tokens: 1_000 },
          },
        };
      })()) as any,
    });

    const outcome = await executor.execute(request({ model: 'claude-opus-5', env: { PATH: '/usr/bin' } }));

    assert.deepEqual(outcome, {
      costUsd: 1.25,
      sessionId: 'sess-1',
      usage: {
        inputTokens: 12,
        cacheReadInputTokens: 90_000,
        cacheCreationInputTokens: 21_000,
        cacheCreation1hInputTokens: 20_000,
        cacheCreation5mInputTokens: 1_000,
        outputTokens: 4_000,
        modelTurns: 3,
        toolCalls: 3,
      },
    });
  });

  test('uses a registered direct Anthropic API key in a fresh config boundary', async () => {
    let captured: any;
    let cleaned = 0;
    const executor = new ClaudeCoordinatorExecutor({
      loadExecutorSecrets: () => ({ ANTHROPIC_API_KEY: 'registered-anthropic-key' }),
      prepareApiHome: () => ({
        path: '/tmp/fresh-direct-claude-home',
        cleanup() { cleaned++; },
      }),
      runQuery: ((args: any) => {
        captured = args;
        return (async function* () {})();
      }) as any,
    });

    const outcome = await executor.execute(request({
      model: 'claude-fable-5',
      env: {
        PATH: '/usr/bin',
        CLAUDE_CODE_OAUTH_TOKEN: 'ambient-device-login',
        ANTHROPIC_API_KEY: 'ambient-api-key',
        ANTHROPIC_BASE_URL: 'https://untrusted.example',
        OPENROUTER_API_KEY: 'ambient-router-key',
      },
    }));

    assert.deepEqual(outcome, { costUsd: 0 });
    assert.equal(cleaned, 1);
    assert.equal(captured.options.model, 'claude-fable-5');
    assert.deepEqual(captured.options.env, {
      PATH: '/usr/bin',
      CLAUDE_CONFIG_DIR: '/tmp/fresh-direct-claude-home',
      ANTHROPIC_API_KEY: 'registered-anthropic-key',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    });
  });

  test('uses a fresh non-Claude OpenRouter API identity without ambient Claude or device-login state', async () => {
    let captured: any;
    let cleaned = 0;
    const executor = new ClaudeCoordinatorExecutor({
      loadExecutorSecrets: () => ({ OPENROUTER_API_KEY: 'registered-router-key' }),
      prepareApiHome: () => ({
        path: '/tmp/fresh-claude-api-home',
        cleanup() { cleaned++; },
      }),
      runQuery: ((args: any) => {
        captured = args;
        return (async function* () {})();
      }) as any,
    });

    const outcome = await executor.execute(request({
      model: 'openrouter/z-ai/glm-5.2',
      env: {
        PATH: '/usr/bin',
        CLAUDE_CODE_OAUTH_TOKEN: 'personal-device-login',
        ANTHROPIC_API_KEY: 'ambient-api-key',
        OPENROUTER_API_KEY: 'ambient-router-key',
      },
    }));

    assert.deepEqual(outcome, { costUsd: 0 });
    assert.equal(cleaned, 1);
    assert.equal(captured.options.model, 'z-ai/glm-5.2');
    assert.deepEqual(captured.options.env, {
      PATH: '/usr/bin',
      CLAUDE_CONFIG_DIR: '/tmp/fresh-claude-api-home',
      ANTHROPIC_BASE_URL: 'https://openrouter.ai/api',
      ANTHROPIC_AUTH_TOKEN: 'registered-router-key',
      ANTHROPIC_API_KEY: '',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    });
    assert.deepEqual(captured.options.tools, []);
    assert.deepEqual(captured.options.allowedTools, ['mcp__weaver__*']);
    assert.equal(captured.options.persistSession, false);
  });

  test('fails closed without the registered OpenRouter key', async () => {
    let queried = false;
    const executor = new ClaudeCoordinatorExecutor({
      loadExecutorSecrets: () => ({}),
      runQuery: (() => {
        queried = true;
        return (async function* () {})();
      }) as any,
    });

    const outcome = await executor.execute(request({
      model: 'openrouter/~anthropic/claude-opus-latest',
    }));

    assert.equal(queried, false);
    assert.match(outcome.error ?? '', /requires OPENROUTER_API_KEY in executor-only secrets/);
  });
});

describe('the projection cache marker', () => {
  const STABLE = 'A wake fired for this workstream. Reconcile…\n\n# Policies and doctrine\nSTABLE PART\n';
  const VOLATILE = '\n## 3. Current operating state\nVOLATILE PART';
  const noUsage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

  /** Runs one Claude pass through a fake Claude Code boundary and returns
   * what it was handed: the prompt (a string, or the streamed user turns)
   * and the env. */
  async function launch(
    overrides: Partial<CoordinatorExecutionRequest>,
    result: Record<string, unknown> = { type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, session_id: 's', total_cost_usd: 0, usage: noUsage },
  ) {
    let prompt: unknown;
    let env: Record<string, string | undefined> = {};
    const turns: any[] = [];
    const executor = new ClaudeCoordinatorExecutor({
      loadExecutorSecrets: () => ({}),
      runQuery: ((args: any) => {
        prompt = args.prompt;
        env = args.options.env;
        return (async function* () {
          if (typeof args.prompt !== 'string') for await (const turn of args.prompt) turns.push(turn);
          yield result;
        })();
      }) as any,
    });
    const outcome = await executor.execute(request({
      model: 'claude-opus-5',
      prompt: STABLE + VOLATILE,
      stablePrefixLength: STABLE.length,
      env: { PATH: '/usr/bin', FORCE_PROMPT_CACHING_5M: '1' },
      ...overrides,
    }));
    return { prompt, env, turns, outcome };
  }

  const breakpoints = (value: unknown): number => JSON.stringify(value).split('"cache_control"').length - 1;

  test('sends the stable prefix and the volatile tail as two blocks with exactly one added breakpoint, pinned to 1h', async () => {
    const { prompt, env, turns } = await launch({});
    assert.notEqual(typeof prompt, 'string');
    assert.equal(turns.length, 1, 'one user turn');
    const [turn] = turns;
    assert.equal(turn.type, 'user');
    assert.equal(turn.parent_tool_use_id, null);
    assert.deepEqual(turn.message, {
      role: 'user',
      content: [
        { type: 'text', text: STABLE, cache_control: { type: 'ephemeral', ttl: '1h' } },
        { type: 'text', text: VOLATILE },
      ],
    });
    assert.equal(breakpoints(turn), 1, 'Weaver adds one breakpoint; Claude Code spends the other three');
    assert.equal(turn.message.content.map((block: { text: string }) => block.text).join(''), STABLE + VOLATILE, 'the model reads the same text');
    // Claude Code's own markers must be 1h too (a 1h breakpoint may not
    // follow a 5m one), and its remote flags off so it adds no fifth.
    assert.equal(env.ENABLE_PROMPT_CACHING_1H, '1');
    assert.equal(env.DISABLE_GROWTHBOOK, '1');
    assert.equal(env.FORCE_PROMPT_CACHING_5M, undefined);
    assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1');
  });

  test(`${PROJECTION_CACHE_MARKER_ENV}=0 restores the single string prompt and the untouched env`, async () => {
    process.env[PROJECTION_CACHE_MARKER_ENV] = '0';
    try {
      const { prompt, env, turns } = await launch({});
      assert.equal(prompt, STABLE + VOLATILE);
      assert.equal(turns.length, 0);
      assert.deepEqual(env, { PATH: '/usr/bin', FORCE_PROMPT_CACHING_5M: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' });
    } finally {
      delete process.env[PROJECTION_CACHE_MARKER_ENV];
    }
  });

  test('pins reasoning effort for Claude seats and leaves an OpenRouter seat at its route default', async () => {
    const seen: Array<{ model: string; effort: unknown }> = [];
    for (const model of ['claude-opus-5-5', 'openrouter/z-ai/glm-5.3']) {
      const executor = new ClaudeCoordinatorExecutor({
        loadExecutorSecrets: () => ({ OPENROUTER_API_KEY: 'router-key' }),
        prepareApiHome: () => ({ path: '/tmp/router-home', cleanup() {} }),
        runQuery: ((args: any) => {
          seen.push({ model, effort: args.options.effort });
          return (async function* () {})();
        }) as any,
      });
      await executor.execute(request({ model, prompt: STABLE + VOLATILE, env: { PATH: '/usr/bin' } }));
    }
    assert.deepEqual(seen, [
      { model: 'claude-opus-5-5', effort: 'xhigh' },
      { model: 'openrouter/z-ai/glm-5.3', effort: undefined },
    ]);
  });

  test('a per-request effort overrides the coordinator effort for that run only, and an OpenRouter seat still gets none', async () => {
    const seen: unknown[] = [];
    const executor = new ClaudeCoordinatorExecutor({
      loadExecutorSecrets: () => ({ OPENROUTER_API_KEY: 'router-key' }),
      prepareApiHome: () => ({ path: '/tmp/router-home', cleanup() {} }),
      runQuery: ((args: any) => {
        seen.push(args.options.effort);
        return (async function* () {})();
      }) as any,
    });
    const run = (model: string, effort?: CoordinatorExecutionRequest['effort']) =>
      executor.execute(request({ model, prompt: STABLE + VOLATILE, env: { PATH: '/usr/bin' }, ...(effort ? { effort } : {}) }));
    await run('claude-fable-5-1', 'medium');
    await run('claude-fable-5-1');
    await run('claude-fable-5-1', 'default');
    await run('openrouter/z-ai/glm-5.3', 'low');
    assert.deepEqual(seen, ['medium', 'xhigh', undefined, undefined]);
  });

  test('is not sent without a stable prefix, on an OpenRouter seat, or when the operator disabled prompt caching', async () => {
    const cases: Partial<CoordinatorExecutionRequest>[] = [
      { stablePrefixLength: undefined },
      { stablePrefixLength: 0 },
      { stablePrefixLength: (STABLE + VOLATILE).length },
      { model: 'openrouter/anthropic/claude-opus-5' },
      { env: { PATH: '/usr/bin', DISABLE_PROMPT_CACHING: '1' } },
      { env: { PATH: '/usr/bin', DISABLE_PROMPT_CACHING_OPUS: 'true' } },
    ];
    for (const overrides of cases) {
      const executor = new ClaudeCoordinatorExecutor({
        loadExecutorSecrets: () => ({ OPENROUTER_API_KEY: 'router-key' }),
        prepareApiHome: () => ({ path: '/tmp/router-home', cleanup() {} }),
        runQuery: ((args: any) => {
          assert.equal(args.prompt, STABLE + VOLATILE, JSON.stringify(overrides));
          assert.equal(args.options.env.DISABLE_GROWTHBOOK, undefined);
          assert.equal(args.options.env.ENABLE_PROMPT_CACHING_1H, undefined);
          // No session-title side call on any seat, marker or not.
          assert.equal(args.options.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1');
          return (async function* () {})();
        }) as any,
      });
      await executor.execute(request({
        model: 'claude-opus-5',
        prompt: STABLE + VOLATILE,
        stablePrefixLength: STABLE.length,
        env: { PATH: '/usr/bin' },
        ...overrides,
      }));
    }
  });

  test('a provider rejecting the marker fails that pass and sends later passes in the process as one block', async () => {
    resetProjectionCacheMarkerRejection();
    try {
      const rejected = await launch({}, {
        type: 'result', subtype: 'success', is_error: true, num_turns: 2, session_id: 's', total_cost_usd: 0,
        result: 'API Error: 400 A maximum of 4 blocks with cache_control may be provided. Found 5.',
        usage: noUsage,
      });
      assert.match(rejected.outcome.error ?? '', /rejected the projection cache marker .*Found 5/);
      const next = await launch({});
      assert.equal(next.prompt, STABLE + VOLATILE);
      assert.equal(next.env.DISABLE_GROWTHBOOK, undefined);
    } finally {
      resetProjectionCacheMarkerRejection();
    }
    // An unrelated failure trips nothing.
    const other = await launch({}, {
      type: 'result', subtype: 'success', is_error: true, num_turns: 1, session_id: 's', total_cost_usd: 0,
      result: 'API Error: 529 overloaded',
      usage: noUsage,
    });
    assert.equal(other.outcome.error, 'Claude coordinator result reported an error');
    assert.notEqual(typeof (await launch({})).prompt, 'string');
  });

  test('Codex receives the same stable-first text as one plain string, with no marker', async () => {
    let input: unknown;
    const executor = new CodexCoordinatorExecutor({
      startBridge: async () => ({ url: 'http://127.0.0.1:1/mcp', token: 't', async close() {} }),
      prepareHome: () => ({ path: '/tmp/codex-home', cleanup() {} }),
      createCodex: () => ({
        startThread: () => ({
          async runStreamed(value: string) {
            input = value;
            return streamed((async function* (): AsyncGenerator<ThreadEvent> {
              yield {
                type: 'turn.completed',
                usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 },
              };
            })());
          },
        }),
      }),
    });
    await executor.execute(request({ prompt: STABLE + VOLATILE, stablePrefixLength: STABLE.length }));
    assert.equal(input, STABLE + VOLATILE);
    assert.equal(breakpoints(input), 0);
  });
});

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

    assert.deepEqual(outcome, {
      costUsd: 0,
      sessionId: 'fresh-coordinator-thread',
      // OpenAI's input count is recorded as reported (it includes cached
      // tokens); reasoning is its own field; the one Weaver tool call counts.
      usage: {
        inputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
        outputTokens: 5, reasoningOutputTokens: 1, toolCalls: 1,
      },
    });
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

  test('keeps the turn.failed provider diagnosis when the stream exits non-zero', async () => {
    // Reproduces the 2026-08-15 outage: a usage-limited Codex subscription
    // reports `turn.failed` on stdout, then the SDK throws an exit-code error
    // whose message is stderr-only ("Reading prompt from stdin…"). The event
    // diagnosis must survive so capacity classification sees the usage limit
    // (infrastructure backoff, no strikes) instead of a logical pass error.
    async function* events(): AsyncGenerator<ThreadEvent> {
      yield { type: 'thread.started', thread_id: 'thread-usage-limited' };
      yield {
        type: 'turn.failed',
        error: {
          message: "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Aug 21st, 2026 1:27 AM.",
        },
      };
      throw new Error('Codex Exec exited with code 1: Reading prompt from stdin...');
    }
    const executor = new CodexCoordinatorExecutor({
      startBridge: async () => ({
        url: 'http://127.0.0.1:43125/mcp', token: 'token',
        async close() {},
      }),
      prepareHome: () => ({
        path: '/tmp/isolated-codex-home-3',
        cleanup() {},
      }),
      createCodex: () => ({
        startThread: () => ({ async runStreamed() { return streamed(events()); } }),
      }),
    });

    const outcome = await executor.execute(request());

    assert.match(outcome.error ?? '', /You've hit your usage limit/);
    assert.match(outcome.error ?? '', /stream exit: Codex Exec exited with code 1/);
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
