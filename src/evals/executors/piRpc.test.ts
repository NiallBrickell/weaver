import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import type {
  SubmitResultArgs,
  SubmitSurface,
  WorkerExecutionRequest,
} from '../../executor/types.js';
import { PiEvalExecutor } from './pi.js';
import {
  buildPiRpcArgs,
  summarizePiRpcUsage,
  splitPiModel,
  validatePiRpcState,
  type PiRpcRuntime,
  type StartPiRpcRuntimeInput,
} from './piRpc.js';
import { PrimeAgentEvalExecutor } from './primeAgent.js';
import {
  scrubSubmitResultArgs,
  type ExtensionSubmitBridge,
} from './extensionSubmitBridge.js';

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
    cwd: '/tmp/eval-cwd',
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
  for (const args of [pi, prime]) {
    assert.deepEqual(args.slice(0, 4), ['--mode', 'rpc', '--no-session', '--provider']);
    assert.ok(args.includes('--no-extensions'));
    assert.ok(args.includes('--no-skills'));
    assert.ok(args.includes('--no-context-files'));
    assert.equal(args.filter((arg) => arg === '--extension').length, 1);
    assert.ok(!args.some((arg) => [
      '--continue', '--resume', '--session', '--session-id', '--fork',
      '--goal', '--goal-token-budget', '--autonomous', '--daemon-socket',
    ].includes(arg)));
  }
  assert.match(pi[pi.indexOf('--tools') + 1]!, /read,bash,edit,write/);
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
        harnessVersion: 'pi@0.84.2-weaver.1',
        sessionId: 'fresh-pi-session',
        async run(prompt, signal) {
          calls.push(`runtime.run:${prompt}`);
          assert.equal(signal.aborted, false);
          assert.equal(start.env.OPENROUTER_API_KEY, providerSecret);
          assert.equal(start.env.PRIME_API_KEY, undefined);
          assert.equal(start.env.ZAI_API_KEY, undefined);
          isolatedHome = start.env.HOME!;
          assert.notEqual(isolatedHome, process.env.HOME);
          assert.match(start.env.PI_CODING_AGENT_DIR!, /weaver-pi-eval-/);
          assert.match(start.env.PRIME_AGENT_CODING_AGENT_DIR!, /weaver-pi-eval-/);
          assert.equal(start.env.WEAVER_HARNESS_SUBMIT_URL, 'http://127.0.0.1:4321');
          assert.equal(start.env.WEAVER_HARNESS_SUBMIT_TOKEN, 'fresh-bridge-token');
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
            error: null,
          };
        },
        async abort() { calls.push('runtime.abort'); },
        async close() { calls.push('runtime.close'); },
      };
      return runtime;
    },
  });
  const outcome = await executor.execute(request({
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
  assert.match(input.extensionPath, /weaverSubmit\.ts$/);
  assert.equal(JSON.stringify(submitted).includes(providerSecret), false);
  assert.equal(JSON.stringify(submitted).includes(otherSecret), false);
  assert.equal(replySeen.includes(providerSecret), false);
  assert.equal(existsSync(isolatedHome), false);
  assert.deepEqual(calls, [
    'bridge.start',
    'runtime.start',
    'runtime.run:Produce the bounded evaluation artifact.',
    'runtime.close',
    'bridge.close',
  ]);
  assert.deepEqual(outcome, { costUsd: 0.125, sessionId: 'fresh-pi-session' });
  assert.deepEqual(executor.lastTelemetry(), {
    executor: 'pi',
    providerRequested: 'openrouter',
    modelRequested: 'openrouter/moonshotai/kimi-k3',
    providerResolved: 'openrouter',
    modelResolved: 'moonshotai/kimi-k3',
    harnessVersion: 'pi@0.84.2-weaver.1',
    isolation: 'host-process',
    startedAt: new Date(1_010).toISOString(),
    endedAt: new Date(1_040).toISOString(),
    durationMs: 30,
    startupMs: 10,
    timeToSubmissionMs: 20,
    usage: { inputTokens: 100, outputTokens: 25, cachedInputTokens: 10, reasoningOutputTokens: null },
    costUsd: 0.125,
    sessionId: 'fresh-pi-session',
    terminalReason: 'completed',
    error: null,
  });
});

test('Prime Agent starts a new invocation-local runtime per assignment and never carries goal/session state', async () => {
  const inputs: StartPiRpcRuntimeInput[] = [];
  const closed: string[] = [];
  const executor = new PrimeAgentEvalExecutor({
    executorSecrets: {},
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
    async startBridge() {
      return { url: 'http://127.0.0.1:4300', token: 'bridge', async close() {} };
    },
    async startRuntime(input) {
      assert.equal(input.env.PRIME_API_KEY, 'prime-secret');
      assert.equal(input.env.OPENROUTER_API_KEY, undefined);
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

test('Pi and Prime fail supervised action work closed before creating a bridge or process', async () => {
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
    const outcome = await executor.execute(request({
      supervise: async (_toolName, input) => ({ behavior: 'allow', updatedInput: input }),
    }));
    assert.match(outcome.error ?? '', /does not support action-worker supervision/);
    assert.equal(executor.lastTelemetry()?.terminalReason, 'unsupported');
  }
  assert.equal(starts, 0);
});

test('runtime failures are redacted and every allocated resource is still closed', async () => {
  const calls: string[] = [];
  const secret = 'failure-secret-value';
  const executor = new PiEvalExecutor({
    executorSecrets: { OPENROUTER_API_KEY: secret },
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
    'bridge.start', 'runtime.start', 'runtime.abort', 'runtime.close', 'bridge.close',
  ]);
});
