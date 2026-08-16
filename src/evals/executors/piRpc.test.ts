import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import type {
  SubmitResultArgs,
  SubmitSurface,
  WorkerExecutionRequest,
} from '../../executor/types.js';
import type { ProviderProxy, ProviderProxyOptions } from '../../executor/providerProxy.js';
import { PiEvalExecutor } from './pi.js';
import {
  buildPiRpcArgs,
  summarizePiRpcUsage,
  splitPiModel,
  validatePiRpcState,
  type PiRpcRuntime,
  type StartPiRpcRuntimeInput,
} from '../../executor/pi.js';
import { PrimeAgentEvalExecutor } from './primeAgent.js';
import {
  scrubSubmitResultArgs,
  type ExtensionSubmitBridge,
} from '../../executor/extensionSubmitBridge.js';

function request(overrides: Partial<WorkerExecutionRequest> = {}): WorkerExecutionRequest {
  const submit: SubmitSurface = {
    async appendSection() { return { text: 'appended' }; },
    async submitResult() { return { text: 'submitted' }; },
  };
  return {
    workstreamSlug: 'eval-stream',
    assignmentId: 'asg_eval',
    prompt: 'Produce the bounded evaluation artifact.',
    systemPrompt: { type: 'preset', preset: 'claude_code', append: 'Follow the worker contract.' },
    model: 'openrouter/moonshotai/kimi-k3',
    tools: { type: 'preset', preset: 'claude_code' },
    allowedTools: ['mcp__weaver__*'],
    permissionMode: 'bypassPermissions',
    settingSources: [],
    strictMcpConfig: true,
    maxTurns: 20,
    cwd: process.cwd(),
    additionalDirectories: [],
    env: {
      PATH: process.env.PATH,
      OPENROUTER_API_KEY: 'ambient-openrouter',
      PRIME_API_KEY: 'ambient-prime',
      ZAI_API_KEY: 'ambient-zai',
    },
    operatorMcpServers: {},
    submit,
    abort: new AbortController(),
    ...overrides,
  };
}

function runtimeInput(command: 'pi' | 'prime-agent'): StartPiRpcRuntimeInput {
  return {
    command,
    cwd: '/tmp/eval-cwd',
    provider: 'openrouter',
    model: 'moonshotai/kimi-k3',
    systemPrompt: 'system',
    maxTurns: 20,
    env: { PATH: '/bin' },
    extensionPath: '/weaver/submit.ts',
  };
}

function fakeProviderProxy(
  model = 'moonshotai/kimi-k3',
  overrides: Partial<ProviderProxy> = {},
): ProviderProxy {
  return {
    url: 'http://127.0.0.1:4455/v1',
    token: 'disposable-provider-token',
    modelResolved: () => model,
    async close() {},
    ...overrides,
  };
}

test('Pi-family models require and preserve an explicit provider qualification', () => {
  assert.deepEqual(splitPiModel('openrouter/moonshotai/kimi-k3'), {
    provider: 'openrouter',
    model: 'moonshotai/kimi-k3',
  });
  assert.throws(() => splitPiModel('kimi-k3'), /provider-qualified/);
  assert.throws(() => splitPiModel('/kimi-k3'), /provider-qualified/);
});

test('Pi RPC usage sums each assistant message exactly once and keeps missing cost unknown', () => {
  assert.deepEqual(summarizePiRpcUsage([
    { usage: { input: 10, output: 4, cacheRead: 2, cost: { total: 0.01 } } },
    { usage: { input: 20, output: 6, cacheRead: 3, cost: { total: 0.02 } } },
  ]), {
    usage: { inputTokens: 30, outputTokens: 10, cachedInputTokens: 5, reasoningOutputTokens: null },
    costUsd: 0.03,
  });
  assert.deepEqual(summarizePiRpcUsage([]), {
    usage: { inputTokens: null, outputTokens: null, cachedInputTokens: null, reasoningOutputTokens: null },
    costUsd: null,
  });
});

test('RPC startup fails closed on model substitution or inherited Prime goal state', () => {
  const input = runtimeInput('prime-agent');
  assert.throws(() => validatePiRpcState(input, {
    sessionId: 'fresh',
    model: { provider: 'openrouter', id: 'different-model' },
    goal: { active: false },
  }), /instead of requested/);
  assert.throws(() => validatePiRpcState(input, {
    sessionId: 'fresh',
    model: { provider: 'openrouter', id: 'moonshotai/kimi-k3' },
    goal: { active: true },
  }), /active goal/);
  assert.deepEqual(validatePiRpcState(input, {
    sessionId: 'fresh',
    model: { provider: 'openrouter', id: 'moonshotai/kimi-k3' },
    goal: { active: false },
  }), { sessionId: 'fresh', provider: 'openrouter', model: 'moonshotai/kimi-k3' });
});

test('Pi and Prime RPC launches are ephemeral and expose only their bounded tool surfaces', () => {
  const pi = buildPiRpcArgs(runtimeInput('pi'));
  const prime = buildPiRpcArgs(runtimeInput('prime-agent'));
  assert.deepEqual(pi.slice(0, 3), ['--no-session', '--provider', 'openrouter']);
  assert.deepEqual(prime.slice(0, 4), ['--mode', 'rpc', '--no-session', '--provider']);
  for (const args of [pi, prime]) {
    assert.ok(args.includes('--no-extensions'));
    assert.ok(args.includes('--no-skills'));
    assert.equal(args.filter((arg) => arg === '--extension').length, 1);
    assert.ok(!args.some((arg) => [
      '--continue', '--resume', '--session', '--session-id', '--fork',
      '--goal', '--goal-token-budget', '--autonomous', '--daemon-socket',
    ].includes(arg)));
  }
  assert.ok(!pi.includes('--no-context-files'));
  assert.ok(!pi.includes('--tools'));
  assert.ok(prime.includes('--no-context-files'));
  assert.equal(prime[prime.indexOf('--tools') + 1], 'ipython,weaver_append_section,weaver_submit_result');
  assert.deepEqual(prime.slice(-2), ['--cwd', '/tmp/eval-cwd']);
});

test('Pi eval uses one authenticated fresh runtime, scopes credentials, redacts submission fields, and tears down', async () => {
  const calls: string[] = [];
  const inputs: StartPiRpcRuntimeInput[] = [];
  let submitted: SubmitResultArgs | null = null;
  let replySeen = '';
  let bridgedSubmit: SubmitSurface | null = null;
  let bridgeRedaction: Record<string, string> = {};
  let providerOptions: ProviderProxyOptions | undefined;
  let isolatedHome = '';
  const providerSecret = 'openrouter-secret-value';
  const otherSecret = 'zai-secret-value';
  let time = 1_000;
  const executor = new PiEvalExecutor({
    now: () => time += 10,
    executorSecrets: {
      OPENROUTER_API_KEY: providerSecret,
      PRIME_API_KEY: 'prime-secret-value',
      ZAI_API_KEY: otherSecret,
    },
    async startProviderProxy(options) {
      providerOptions = options;
      calls.push('provider.start');
      return fakeProviderProxy('moonshotai/kimi-k3', {
        async close() { calls.push('provider.close'); },
      });
    },
    async startMcpRelay() {
      calls.push('relay.start');
      return {
        url: 'http://127.0.0.1:4456/mcp', token: 'disposable-mcp-token',
        async close() { calls.push('relay.close'); },
      };
    },
    async startBridge(submit, options) {
      calls.push('bridge.start');
      bridgedSubmit = submit;
      bridgeRedaction = options.redactionSecrets;
      return {
        url: 'http://127.0.0.1:4321',
        token: 'fresh-bridge-token',
        async close() { calls.push('bridge.close'); },
      };
    },
    async startRuntime(start) {
      inputs.push(start);
      calls.push('runtime.start');
      const runtime: PiRpcRuntime = {
        harnessVersion: 'pi@0.84.2-weaver.4',
        sessionId: 'fresh-pi-session',
        async run(prompt, signal) {
          calls.push(`runtime.run:${prompt}`);
          assert.equal(signal.aborted, false);
          assert.equal(start.env.OPENROUTER_API_KEY, undefined);
          assert.equal(start.env.PRIME_API_KEY, undefined);
          assert.equal(start.env.ZAI_API_KEY, undefined);
          isolatedHome = start.env.HOME!;
          assert.notEqual(isolatedHome, process.env.HOME);
          assert.match(start.env.PI_CODING_AGENT_DIR!, /weaver-pi-run-/);
          assert.match(start.env.PRIME_AGENT_CODING_AGENT_DIR!, /weaver-pi-run-/);
          assert.equal(start.env.PI_OFFLINE, '1');
          assert.equal(start.env.PI_TELEMETRY, '0');
          assert.match(start.extensionPath, /src\/executor\/piExtension\.ts$/);
          assert.equal(start.env.WEAVER_HARNESS_SUBMIT_URL, 'http://127.0.0.1:4321');
          assert.equal(start.env.WEAVER_HARNESS_SUBMIT_TOKEN, 'fresh-bridge-token');
          assert.deepEqual(JSON.parse(start.env.WEAVER_PI_PROVIDER_CONFIG!), {
            provider: 'openrouter',
            model: 'moonshotai/kimi-k3',
            baseUrl: 'http://127.0.0.1:4455/v1',
            apiKey: 'disposable-provider-token',
          });
          assert.deepEqual(JSON.parse(start.env.WEAVER_PI_MCP_RELAYS!), [{
            name: 'tracker',
            url: 'http://127.0.0.1:4456/mcp',
            token: 'disposable-mcp-token',
          }]);
          const dirty: SubmitResultArgs = {
              summary: `summary ${providerSecret}`,
              artifact: {
                title: `title ${providerSecret}`,
                kind: `kind ${otherSecret}`,
                file_name: `file-${providerSecret}.md`,
                content: (`artifact ${providerSecret} ${otherSecret} `).repeat(12),
              },
          };
          const reply = await bridgedSubmit!.submitResult(
            scrubSubmitResultArgs(dirty, bridgeRedaction),
          );
          replySeen = reply.text.replaceAll(providerSecret, '[REDACTED]');
          return {
            providerResolved: 'openrouter',
            modelResolved: 'moonshotai/kimi-k3',
            usage: { inputTokens: 100, outputTokens: 25, cachedInputTokens: 10, reasoningOutputTokens: null },
            costUsd: 0.125,
            aborted: true,
            error: 'agent stopped: aborted',
          };
        },
        async abort() { calls.push('runtime.abort'); },
        async close() { calls.push('runtime.close'); },
      };
      return runtime;
    },
  });
  const outcome = await executor.execute(request({
    operatorMcpServers: { tracker: { type: 'http', url: 'https://example.invalid/mcp' } },
    submit: {
      async appendSection() { return { text: 'appended' }; },
      async submitResult(args) {
        submitted = args;
        return { text: `submitted without ${providerSecret}` };
      },
    },
  }));

  assert.equal(outcome.error, undefined);
  const input = inputs[0]!;
  assert.equal(input.command, 'pi');
  assert.equal(input.provider, 'openrouter');
  assert.equal(input.model, 'moonshotai/kimi-k3');
  assert.equal(providerOptions?.upstreamApiKey, providerSecret);
  assert.equal(providerOptions?.upstreamBaseUrl, 'https://openrouter.ai/api/v1');
  assert.equal(JSON.stringify(submitted).includes(providerSecret), false);
  assert.equal(JSON.stringify(submitted).includes(otherSecret), false);
  assert.equal(replySeen.includes(providerSecret), false);
  assert.equal(existsSync(isolatedHome), false);
  assert.deepEqual(calls, [
    'provider.start',
    'relay.start',
    'bridge.start',
    'runtime.start',
    'runtime.run:Produce the bounded evaluation artifact.',
    'runtime.close',
    'bridge.close',
    'relay.close',
    'provider.close',
  ]);
  assert.deepEqual(outcome, { costUsd: null, sessionId: 'fresh-pi-session' });
  assert.deepEqual(executor.lastTelemetry(), {
    executor: 'pi',
    providerRequested: 'openrouter',
    modelRequested: 'openrouter/moonshotai/kimi-k3',
    providerResolved: 'openrouter',
    modelResolved: 'moonshotai/kimi-k3',
    harnessVersion: 'pi@0.84.2-weaver.4',
    isolation: 'host-process',
    startedAt: new Date(1_010).toISOString(),
    endedAt: new Date(1_040).toISOString(),
    durationMs: 30,
    startupMs: 10,
    timeToSubmissionMs: 20,
    usage: { inputTokens: 100, outputTokens: 25, cachedInputTokens: 10, reasoningOutputTokens: null },
    costUsd: null,
    sessionId: 'fresh-pi-session',
    terminalReason: 'completed',
    error: null,
  });
});

test('Prime Agent starts a new invocation-local runtime per assignment and never carries goal/session state', async () => {
  const inputs: StartPiRpcRuntimeInput[] = [];
  const closed: string[] = [];
  const executor = new PrimeAgentEvalExecutor({
    executorSecrets: { OPENROUTER_API_KEY: 'durable-openrouter-key' },
    async startProviderProxy() { return fakeProviderProxy('z-ai/glm-5'); },
    async startBridge() {
      const index = inputs.length + 1;
      const bridge: ExtensionSubmitBridge = {
        url: `http://127.0.0.1:${4300 + index}`,
        token: `bridge-${index}`,
        async close() {},
      };
      return bridge;
    },
    async startRuntime(input) {
      inputs.push(input);
      const sessionId = `prime-fresh-${inputs.length}`;
      return {
        harnessVersion: 'prime-agent@0.7.2-weaver.1',
        sessionId,
        async run() {
          return {
            providerResolved: 'openrouter', modelResolved: 'z-ai/glm-5',
            usage: { inputTokens: null, outputTokens: null, cachedInputTokens: null, reasoningOutputTokens: null },
            costUsd: null, error: null,
          };
        },
        async abort() {},
        async close() { closed.push(sessionId); },
      };
    },
  });

  const first = await executor.execute(request({ model: 'openrouter/z-ai/glm-5' }));
  const second = await executor.execute(request({ model: 'openrouter/z-ai/glm-5' }));

  assert.equal(first.error, undefined);
  assert.equal(second.error, undefined);
  assert.equal(first.costUsd, null);
  assert.equal(second.costUsd, null);
  assert.equal(first.sessionId, undefined);
  assert.equal(second.sessionId, undefined);
  assert.equal(inputs.length, 2);
  assert.equal(executor.lastTelemetry()?.sessionId, null);
  assert.deepEqual(closed, ['prime-fresh-1', 'prime-fresh-2']);
  assert.ok(inputs.every((input) => input.command === 'prime-agent'));
});

test('Prime Inference receives its own key and not another provider credential', async () => {
  const executor = new PrimeAgentEvalExecutor({
    executorSecrets: {
      OPENROUTER_API_KEY: 'openrouter-secret',
      PRIME_API_KEY: 'prime-secret',
    },
    async startProviderProxy(options) {
      assert.equal(options.upstreamApiKey, 'prime-secret');
      return fakeProviderProxy('fixture-model');
    },
    async startBridge() {
      return { url: 'http://127.0.0.1:4300', token: 'bridge', async close() {} };
    },
    async startRuntime(input) {
      assert.equal(input.env.PRIME_API_KEY, undefined);
      assert.equal(input.env.OPENROUTER_API_KEY, undefined);
      assert.equal(
        (JSON.parse(input.env.WEAVER_PI_PROVIDER_CONFIG!) as { apiKey: string }).apiKey,
        'disposable-provider-token',
      );
      return {
        harnessVersion: 'prime-agent@0.7.2-weaver.1', sessionId: null,
        async run() {
          return {
            providerResolved: 'prime-inference', modelResolved: 'fixture-model',
            usage: {
              inputTokens: null,
              outputTokens: null,
              cachedInputTokens: null,
              reasoningOutputTokens: null,
            },
            costUsd: null,
            error: null,
          };
        },
        async abort() {},
        async close() {},
      };
    },
  });

  const outcome = await executor.execute(request({ model: 'prime-inference/fixture-model' }));

  assert.equal(outcome.error, undefined);
  assert.equal(executor.lastTelemetry()?.providerResolved, 'prime-inference');
});

test('Pi relays every operator MCP server with disposable bearers and closes partial startup', async () => {
  const calls: string[] = [];
  const durableMcpCredential = 'durable-mcp-credential';
  const stderrLines: string[] = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = ((chunk: unknown) => {
    stderrLines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  let runtimeSystemPrompt: string | null = null;
  const executor = new PiEvalExecutor({
    executorSecrets: { OPENROUTER_API_KEY: 'durable-provider-key' },
    async startProviderProxy() {
      calls.push('provider.start');
      return fakeProviderProxy('moonshotai/kimi-k3', {
        async close() { calls.push('provider.close'); },
      });
    },
    async startMcpRelay(config, options) {
      const name = (config as { name: string }).name;
      calls.push(`relay.${name}.start`);
      assert.equal(options.env.WEAVER_INTERNAL_MCP_HEADER_1, durableMcpCredential);
      if (name === 'second') throw new Error(`relay failed with ${durableMcpCredential}`);
      return {
        url: 'http://127.0.0.1:4555/mcp', token: 'disposable-mcp-token',
        async close() { calls.push(`relay.${name}.close`); },
      };
    },
    async startBridge() {
      calls.push('bridge.start');
      return { url: 'http://127.0.0.1:4556/mcp', token: 'submit-token', async close() {} };
    },
    async startRuntime(input) {
      calls.push('runtime.start');
      runtimeSystemPrompt = input.systemPrompt;
      return {
        harnessVersion: 'pi-eval',
        sessionId: null,
        async run() {
          return {
            error: null,
            usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, reasoningOutputTokens: 0 },
            providerResolved: 'openrouter',
            modelResolved: 'moonshotai/kimi-k3',
            costUsd: null,
          };
        },
        async abort() {},
        async close() { calls.push('runtime.close'); },
      };
    },
  });

  let outcome: Awaited<ReturnType<typeof executor.execute>>;
  try {
    outcome = await executor.execute(request({
      env: {
        PATH: process.env.PATH,
        WEAVER_INTERNAL_MCP_HEADER_1: durableMcpCredential,
      },
      operatorMcpServers: {
        first: { name: 'first' },
        second: { name: 'second' },
      },
    }));
  } finally {
    process.stderr.write = originalWrite;
  }

  // A dead operator MCP server degrades: the run proceeds without it, the
  // confined worker is told which server is absent, and neither the stderr
  // note nor the outcome may carry the durable credential.
  assert.equal(outcome!.error, undefined);
  const note = stderrLines.join('');
  assert.match(note, /operator MCP server 'second' unavailable/);
  assert.doesNotMatch(note, new RegExp(durableMcpCredential));
  assert.match(note, /«secret:WEAVER_INTERNAL_MCP_HEADER_1»/);
  assert.match(runtimeSystemPrompt ?? '', /unavailable during this run: second/);
  assert.doesNotMatch(runtimeSystemPrompt ?? '', new RegExp(durableMcpCredential));
  assert.deepEqual(calls, [
    'provider.start',
    'relay.first.start',
    'relay.second.start',
    'bridge.start',
    'runtime.start',
    'runtime.close',
    'relay.first.close',
    'provider.close',
  ]);
});

test('Pi and Prime fail action-shaped work closed before creating a bridge or process', async () => {
  let starts = 0;
  for (const executor of [
    new PiEvalExecutor({
      startBridge: async () => { starts += 1; throw new Error('must not start'); },
      startRuntime: async () => { starts += 1; throw new Error('must not start'); },
    }),
    new PrimeAgentEvalExecutor({
      startBridge: async () => { starts += 1; throw new Error('must not start'); },
      startRuntime: async () => { starts += 1; throw new Error('must not start'); },
    }),
  ]) {
    for (const actionShape of [
      { supervise: async (_toolName: string, input: Record<string, unknown>) => ({ behavior: 'allow' as const, updatedInput: input }) },
      { permissionMode: 'default' as const },
    ]) {
      const outcome = await executor.execute(request(actionShape));
      assert.match(outcome.error ?? '', /does not support action-worker supervision/);
      assert.equal(executor.lastTelemetry()?.terminalReason, 'unsupported');
    }
  }
  assert.equal(starts, 0);
});

test('Pi never falls back to an ambient provider credential', async () => {
  let starts = 0;
  const executor = new PiEvalExecutor({
    executorSecrets: {},
    startProviderProxy: async () => { starts += 1; throw new Error('must not start'); },
    startBridge: async () => { starts += 1; throw new Error('must not start'); },
    startRuntime: async () => { starts += 1; throw new Error('must not start'); },
  });
  const outcome = await executor.execute(request({
    env: { PATH: process.env.PATH, OPENROUTER_API_KEY: 'ambient-provider-key' },
  }));
  assert.match(outcome.error ?? '', /requires OPENROUTER_API_KEY in executor-only secrets/);
  assert.equal(executor.lastTelemetry()?.terminalReason, 'unsupported');
  assert.equal(starts, 0);
});

test('Pi accepts both Weaver and Pi-native Z.ai secret names behind exact billing pools', async () => {
  const fixtures: Array<{
    model: string;
    secrets: Record<string, string>;
    upstream: string;
    key: string;
    provider: string;
  }> = [
    {
      model: 'zai/glm-5.3',
      secrets: { ZAI_API_KEY: 'pi-native-zai-key' },
      upstream: 'https://api.z.ai/api/paas/v4',
      key: 'pi-native-zai-key',
      provider: 'zai',
    },
    {
      model: 'zai-coding-plan/glm-5.3',
      secrets: { ZHIPU_API_KEY: 'weaver-zai-key' },
      upstream: 'https://api.z.ai/api/coding/paas/v4',
      key: 'weaver-zai-key',
      provider: 'zai-coding-plan',
    },
  ];
  for (const fixture of fixtures) {
    const executor = new PiEvalExecutor({
      executorSecrets: fixture.secrets,
      async startProviderProxy(options) {
        assert.equal(options.upstreamBaseUrl, fixture.upstream);
        assert.equal(options.upstreamApiKey, fixture.key);
        return fakeProviderProxy('glm-5.3');
      },
      async startBridge() {
        return { url: 'http://127.0.0.1:4300', token: 'bridge', async close() {} };
      },
      async startRuntime(input) {
        assert.equal(input.provider, fixture.provider);
        assert.equal(input.env.ZAI_API_KEY, undefined);
        assert.equal(input.env.ZHIPU_API_KEY, undefined);
        return {
          harnessVersion: 'pi@0.84.2-weaver.4', sessionId: 'fresh',
          async run() {
            return {
              providerResolved: fixture.provider, modelResolved: 'glm-5.3',
              usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, reasoningOutputTokens: null },
              costUsd: null, error: null,
            };
          },
          async abort() {}, async close() {},
        };
      },
    });

    const outcome = await executor.execute(request({ model: fixture.model }));
    assert.equal(outcome.error, undefined);
    assert.equal(executor.lastTelemetry()?.providerRequested, fixture.provider);
  }
});

test('Pi rejects unknown providers, reserved MCP names, and missing directories before side effects', async () => {
  let starts = 0;
  const executor = new PiEvalExecutor({
    executorSecrets: { OPENROUTER_API_KEY: 'durable-key' },
    startProviderProxy: async () => { starts += 1; throw new Error('must not start'); },
    startMcpRelay: async () => { starts += 1; throw new Error('must not start'); },
    startBridge: async () => { starts += 1; throw new Error('must not start'); },
    startRuntime: async () => { starts += 1; throw new Error('must not start'); },
  });

  for (const overrides of [
    { model: 'unknown/model' },
    { operatorMcpServers: { Weaver: { type: 'http', url: 'https://example.invalid/mcp' } } },
    { additionalDirectories: ['/definitely-missing-weaver-pi-source'] },
  ]) {
    const outcome = await executor.execute(request(overrides));
    assert.ok(outcome.error);
    assert.equal(executor.lastTelemetry()?.terminalReason, 'unsupported');
  }
  assert.equal(starts, 0);
});

test('Pi reloads executor-only credentials for every fresh attempt', async () => {
  let load = 0;
  const seenKeys: string[] = [];
  const executor = new PiEvalExecutor({
    loadExecutorSecrets: () => ({ OPENROUTER_API_KEY: `rotated-key-${++load}` }),
    async startProviderProxy(options) {
      seenKeys.push(options.upstreamApiKey);
      return fakeProviderProxy();
    },
    async startBridge() {
      return { url: 'http://127.0.0.1:4300', token: 'bridge', async close() {} };
    },
    async startRuntime() {
      return {
        harnessVersion: 'pi@0.84.2-weaver.4', sessionId: 'fresh',
        async run() {
          return {
            providerResolved: 'openrouter', modelResolved: 'moonshotai/kimi-k3',
            usage: { inputTokens: null, outputTokens: null, cachedInputTokens: null, reasoningOutputTokens: null },
            costUsd: null, error: null,
          };
        },
        async abort() {}, async close() {},
      };
    },
  });

  await executor.execute(request());
  await executor.execute(request());
  assert.deepEqual(seenKeys, ['rotated-key-1', 'rotated-key-2']);
});

test('Pi refuses requested/catalog identity when the upstream response reports no model', async () => {
  const executor = new PiEvalExecutor({
    executorSecrets: { OPENROUTER_API_KEY: 'durable-key' },
    async startProviderProxy() { return fakeProviderProxy('', { modelResolved: () => null }); },
    async startBridge() {
      return { url: 'http://127.0.0.1:4300', token: 'bridge', async close() {} };
    },
    async startRuntime() {
      return {
        harnessVersion: 'pi@0.84.2-weaver.4', sessionId: 'fresh',
        async run() {
          return {
            providerResolved: 'openrouter', modelResolved: 'moonshotai/kimi-k3',
            usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, reasoningOutputTokens: null },
            costUsd: 0.01, error: null,
          };
        },
        async abort() {}, async close() {},
      };
    },
  });
  const outcome = await executor.execute(request());
  assert.match(outcome.error ?? '', /did not report a model identity/);
  assert.equal(executor.lastTelemetry()?.modelResolved, null);
  assert.equal(executor.lastTelemetry()?.terminalReason, 'error');
});

test('runtime failures are redacted and every allocated resource is still closed', async () => {
  const calls: string[] = [];
  const secret = 'failure-secret-value';
  const executor = new PiEvalExecutor({
    executorSecrets: { OPENROUTER_API_KEY: secret },
    async startProviderProxy() {
      calls.push('provider.start');
      return fakeProviderProxy('moonshotai/kimi-k3', {
        async close() { calls.push('provider.close'); },
      });
    },
    async startBridge() {
      calls.push('bridge.start');
      return {
        url: 'http://127.0.0.1:1', token: 'bridge-token',
        async close() { calls.push('bridge.close'); },
      };
    },
    async startRuntime() {
      calls.push('runtime.start');
      return {
        harnessVersion: 'fixture', sessionId: 'fresh',
        async run() { throw new Error(`provider failed with ${secret}`); },
        async abort() { calls.push('runtime.abort'); },
        async close() { calls.push('runtime.close'); },
      };
    },
  });

  const outcome = await executor.execute(request());

  assert.equal(outcome.error?.includes(secret), false);
  assert.match(outcome.error ?? '', /«secret:OPENROUTER_API_KEY»/);
  assert.deepEqual(calls, [
    'provider.start', 'bridge.start', 'runtime.start', 'runtime.abort', 'runtime.close',
    'bridge.close', 'provider.close',
  ]);
});
