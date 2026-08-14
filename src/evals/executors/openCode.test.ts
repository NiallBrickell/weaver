import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import type { SubmitBridge, SubmitBridgeOptions } from '../../executor/submitBridge.js';
import type { ProviderProxy, ProviderProxyOptions } from '../../executor/providerProxy.js';
import type {
  SubmitResultArgs,
  SubmitSurface,
  WorkerExecutionRequest,
} from '../../executor/types.js';
import {
  isolatedOpenCodeEnv,
  OpenCodeEvalExecutor,
  splitOpenCodeModel,
  startIsolatedOpenCodeServer,
  type OpenCodeRuntime,
  type OpenCodeRuntimeStart,
} from './openCode.js';

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
    env: {},
    operatorMcpServers: {},
    submit,
    abort: new AbortController(),
    ...overrides,
  };
}

function proxy(overrides: Partial<ProviderProxy> = {}): ProviderProxy {
  return {
    url: 'http://127.0.0.1:4242/v1',
    token: 'ephemeral-provider-token',
    modelResolved: () => 'moonshotai/kimi-k3',
    async close() {},
    ...overrides,
  };
}

test('provider-qualified model splitting preserves slashes inside the model id', () => {
  assert.deepEqual(splitOpenCodeModel('openrouter/moonshotai/kimi-k3'), {
    providerID: 'openrouter',
    modelID: 'moonshotai/kimi-k3',
  });
  assert.throws(() => splitOpenCodeModel('sonnet'), /provider-qualified/);
  assert.throws(() => splitOpenCodeModel('/model'), /provider-qualified/);
  assert.throws(() => splitOpenCodeModel('openrouter/model#high'), /variants are not supported/);
});

test('OpenCode eval uses one fresh session, relays submission, records telemetry, and deletes it', async () => {
  const calls: string[] = [];
  let bridgedSubmit: SubmitSurface | undefined;
  let bridgeOptions: SubmitBridgeOptions | undefined;
  let providerOptions: ProviderProxyOptions | undefined;
  let runtimeStart: OpenCodeRuntimeStart | undefined;
  let promptInput: Parameters<OpenCodeRuntime['prompt']>[1] | undefined;
  const submitted: SubmitResultArgs[] = [];
  const req = request({
    submit: {
      async appendSection() { return { text: 'ok' }; },
      async submitResult(args) {
        submitted.push(args);
        return { text: 'accepted by fixture' };
      },
    },
  });
  const bridge: SubmitBridge = {
    url: 'http://127.0.0.1:4321/mcp',
    token: 'fixture-token',
    async close() { calls.push('bridge.close'); },
  };
  const runtime: OpenCodeRuntime = {
    harnessVersion: '1.18.15',
    async createSession(title) {
      calls.push(`session.create:${title}`);
      return 'ses_fresh';
    },
    async prompt(sessionId, input) {
      calls.push(`session.prompt:${sessionId}`);
      promptInput = input;
      await bridgedSubmit!.submitResult({
        summary: 'Fixture summary.',
        artifact: { title: 'Fixture', kind: 'report', file_name: 'fixture.md', content: '# Fixture' },
      });
      return {
        info: {
          cost: 0.125,
          providerID: 'openrouter',
          modelID: 'moonshotai/kimi-k3',
          tokens: { input: 100, output: 25, cache: { read: 40 } },
        },
      };
    },
    async abortSession(id) { calls.push(`session.abort:${id}`); },
    async deleteSession(id) { calls.push(`session.delete:${id}`); },
    async close() { calls.push('runtime.close'); },
  };
  const times = [1_000, 1_020, 1_075, 1_100];
  const executor = new OpenCodeEvalExecutor({
    executorSecrets: { OPENROUTER_API_KEY: 'durable-provider-key' },
    now: () => times.shift() ?? 1_100,
    async startProviderProxy(options) {
      calls.push('provider.start');
      providerOptions = options;
      return proxy({
        async close() { calls.push('provider.close'); },
      });
    },
    async startBridge(submit, options) {
      calls.push('bridge.start');
      bridgedSubmit = submit;
      bridgeOptions = options;
      return bridge;
    },
    async startRuntime(input) {
      calls.push('runtime.start');
      runtimeStart = input;
      return runtime;
    },
  });

  const outcome = await executor.execute(req);

  assert.equal(runtimeStart!.cwd, '/tmp/eval-cwd');
  assert.equal(runtimeStart!.bridge, bridge);
  assert.equal(runtimeStart!.maxTurns, 20);
  assert.deepEqual(runtimeStart!.model, {
    providerID: 'openrouter',
    modelID: 'moonshotai/kimi-k3',
  });
  assert.equal(runtimeStart!.providerProxy.token, 'ephemeral-provider-token');
  assert.equal(providerOptions!.upstreamBaseUrl, 'https://openrouter.ai/api/v1');
  assert.equal(providerOptions!.upstreamApiKey, 'durable-provider-key');
  assert.deepEqual(providerOptions!.allowedModels, ['moonshotai/kimi-k3']);
  assert.equal(providerOptions!.maxRequests, 20);
  assert.ok(bridgeOptions!.rejectArgumentValues!.includes('durable-provider-key'));
  assert.ok(bridgeOptions!.rejectArgumentValues!.includes('ephemeral-provider-token'));
  assert.deepEqual(promptInput!.model, {
    providerID: 'openrouter',
    modelID: 'moonshotai/kimi-k3',
  });
  assert.equal(promptInput!.prompt, req.prompt);
  assert.match(promptInput!.system, /weaver_submit_result/);
  assert.equal(promptInput!.signal, req.abort.signal);
  assert.equal(submitted.length, 1);
  assert.deepEqual(calls, [
    'provider.start',
    'bridge.start',
    'runtime.start',
    'session.create:eval-stream/asg_eval',
    'session.prompt:ses_fresh',
    'session.delete:ses_fresh',
    'runtime.close',
    'bridge.close',
    'provider.close',
  ]);
  assert.deepEqual(outcome, { costUsd: 0.125, sessionId: 'ses_fresh' });
  assert.deepEqual(executor.lastTelemetry(), {
    executor: 'opencode',
    modelRequested: 'openrouter/moonshotai/kimi-k3',
    providerResolved: 'openrouter',
    modelResolved: 'moonshotai/kimi-k3',
    harnessVersion: '1.18.15-weaver.3',
    isolation: 'host-process',
    startedAt: new Date(1_000).toISOString(),
    endedAt: new Date(1_100).toISOString(),
    durationMs: 100,
    startupMs: 20,
    timeToSubmissionMs: 75,
    usage: {
      inputTokens: 100,
      outputTokens: 25,
      cachedInputTokens: 40,
      reasoningOutputTokens: null,
    },
    costUsd: 0.125,
    sessionId: 'ses_fresh',
    terminalReason: 'completed',
    error: null,
  });
});

test('OpenCode eval rejects supervised and malformed requests before launching anything', async () => {
  let launches = 0;
  const dependencies = {
    executorSecrets: { OPENROUTER_API_KEY: 'durable-provider-key' },
    async startProviderProxy(): Promise<ProviderProxy> {
      launches++;
      throw new Error('must not launch');
    },
    async startBridge(): Promise<SubmitBridge> {
      launches++;
      throw new Error('must not launch');
    },
    async startRuntime(): Promise<OpenCodeRuntime> {
      launches++;
      throw new Error('must not launch');
    },
  };

  const supervised = new OpenCodeEvalExecutor(dependencies);
  const supervisedOutcome = await supervised.execute(request({
    supervise: async (_toolName, input) => ({ behavior: 'allow', updatedInput: input }),
  }));
  assert.equal(launches, 0);
  assert.match(supervisedOutcome.error!, /does not support supervised/);
  assert.equal(supervised.lastTelemetry()!.terminalReason, 'unsupported');
  assert.deepEqual(supervised.lastTelemetry()!.usage, {
    inputTokens: null,
    outputTokens: null,
    cachedInputTokens: null,
    reasoningOutputTokens: null,
  });

  const malformed = new OpenCodeEvalExecutor(dependencies);
  const malformedOutcome = await malformed.execute(request({ model: 'sonnet' }));
  assert.equal(launches, 0);
  assert.match(malformedOutcome.error!, /provider-qualified/);
  assert.equal(malformed.lastTelemetry()!.terminalReason, 'error');
  assert.equal(malformed.lastTelemetry()!.costUsd, null);

  const missingCredential = new OpenCodeEvalExecutor({
    ...dependencies,
    executorSecrets: {},
  });
  const missingOutcome = await missingCredential.execute(request());
  assert.match(missingOutcome.error!, /requires OPENROUTER_API_KEY in executor-only secrets/);
  assert.equal(launches, 0);
});

test('OpenCode eval aborts, deletes, and closes every allocated resource after a failed prompt', async () => {
  const calls: string[] = [];
  const controller = new AbortController();
  const runtime: OpenCodeRuntime = {
    harnessVersion: 'fixture',
    async createSession() { calls.push('create'); return 'ses_abort'; },
    async prompt() {
      calls.push('prompt');
      controller.abort();
      throw new Error('provider stream interrupted');
    },
    async abortSession(id) { calls.push(`abort:${id}`); },
    async deleteSession(id) { calls.push(`delete:${id}`); },
    async close() { calls.push('runtime.close'); },
  };
  const executor = new OpenCodeEvalExecutor({
    executorSecrets: { OPENROUTER_API_KEY: 'durable-provider-key' },
    async startProviderProxy() {
      calls.push('provider.start');
      return proxy({
        async close() { calls.push('provider.close'); },
      });
    },
    async startBridge() {
      calls.push('bridge.start');
      return {
        url: 'http://127.0.0.1:1/mcp',
        token: 'fixture',
        async close() { calls.push('bridge.close'); },
      };
    },
    async startRuntime() { calls.push('runtime.start'); return runtime; },
  });

  const outcome = await executor.execute(request({ abort: controller }));

  assert.deepEqual(calls, [
    'provider.start',
    'bridge.start',
    'runtime.start',
    'create',
    'prompt',
    'abort:ses_abort',
    'delete:ses_abort',
    'runtime.close',
    'bridge.close',
    'provider.close',
  ]);
  assert.deepEqual(outcome, {
    costUsd: 0,
    sessionId: 'ses_abort',
    error: 'provider stream interrupted',
  });
  assert.equal(executor.lastTelemetry()!.terminalReason, 'aborted');
  assert.deepEqual(executor.lastTelemetry()!.usage, {
    inputTokens: null,
    outputTokens: null,
    cachedInputTokens: null,
    reasoningOutputTokens: null,
  });
});

test('OpenCode closes the provider proxy and redacts credentials when bridge launch fails', async () => {
  const calls: string[] = [];
  const executor = new OpenCodeEvalExecutor({
    executorSecrets: { ZHIPU_API_KEY: 'durable-zai-key' },
    async startProviderProxy() {
      calls.push('provider.start');
      return proxy({
        token: 'disposable-proxy-token',
        async close() { calls.push('provider.close'); },
      });
    },
    async startBridge() {
      calls.push('bridge.start');
      throw new Error('bridge refused durable-zai-key and disposable-proxy-token');
    },
    async startRuntime() {
      calls.push('runtime.start');
      throw new Error('must not launch');
    },
  });

  const outcome = await executor.execute(request({ model: 'zai-coding-plan/glm-5.3' }));

  assert.deepEqual(calls, ['provider.start', 'bridge.start', 'provider.close']);
  assert.match(outcome.error!, /bridge refused/);
  assert.doesNotMatch(outcome.error!, /durable-zai-key|disposable-proxy-token/);
  assert.doesNotMatch(
    JSON.stringify(executor.lastTelemetry()),
    /durable-zai-key|disposable-proxy-token/,
  );
});

test('Z.AI Coding Plan stays behind the run proxy and reports subscription cost as unknown', async () => {
  let proxyOptions: ProviderProxyOptions | undefined;
  let runtimeStart: OpenCodeRuntimeStart | undefined;
  const executor = new OpenCodeEvalExecutor({
    executorSecrets: { ZHIPU_API_KEY: 'durable-zai-key' },
    async startProviderProxy(options) {
      proxyOptions = options;
      return proxy({ modelResolved: () => 'glm-5.3' });
    },
    async startBridge() {
      return { url: 'http://127.0.0.1:1/mcp', token: 'submit', async close() {} };
    },
    async startRuntime(input) {
      runtimeStart = input;
      return {
        harnessVersion: '1.18.15',
        async createSession() { return 'ses_zai'; },
        async prompt() {
          return {
            info: {
              cost: 0,
              providerID: 'zai-coding-plan',
              modelID: 'glm-5.3',
              tokens: { input: 1, output: 1 },
            },
          };
        },
        async abortSession() {},
        async deleteSession() {},
        async close() {},
      };
    },
  });

  const outcome = await executor.execute(request({ model: 'zai-coding-plan/glm-5.3' }));

  assert.equal(proxyOptions!.upstreamBaseUrl, 'https://api.z.ai/api/coding/paas/v4');
  assert.equal(proxyOptions!.upstreamApiKey, 'durable-zai-key');
  assert.deepEqual(proxyOptions!.allowedModels, ['glm-5.3']);
  assert.deepEqual(runtimeStart!.model, {
    providerID: 'zai-coding-plan',
    modelID: 'glm-5.3',
  });
  assert.equal(outcome.costUsd, 0);
  assert.equal(executor.lastTelemetry()!.costUsd, null);
  assert.equal(executor.lastTelemetry()!.providerResolved, 'zai-coding-plan');
  assert.equal(executor.lastTelemetry()!.modelResolved, 'glm-5.3');
  assert.equal(executor.lastTelemetry()!.harnessVersion, '1.18.15-weaver.3');
});

test('OpenCode child environment exposes only disposable config and operating-system basics', () => {
  const env = isolatedOpenCodeEnv('/tmp/disposable-opencode-home', {
    provider: { token: 'disposable-run-token' },
  }, {
    PATH: '/usr/bin:/bin',
    SHELL: '/bin/zsh',
    LANG: 'en_GB.UTF-8',
    TMPDIR: '/tmp/operator-tmp',
    WEAVER_HOME: '/operator/weaver/state',
    ZHIPU_API_KEY: 'durable-zai-key',
    OPENROUTER_API_KEY: 'durable-openrouter-key',
    SSH_AUTH_SOCK: '/operator/keychain.sock',
    GH_TOKEN: 'durable-github-key',
  });

  assert.deepEqual(Object.keys(env).sort(), [
    'HOME',
    'LANG',
    'OPENCODE_CONFIG_CONTENT',
    'PATH',
    'SHELL',
    'TMPDIR',
    'XDG_CACHE_HOME',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_STATE_HOME',
  ]);
  assert.equal(env.HOME, '/tmp/disposable-opencode-home');
  assert.match(env.OPENCODE_CONFIG_CONTENT!, /disposable-run-token/);
  assert.doesNotMatch(JSON.stringify(env), /operator\/weaver|durable-|keychain/);
});

test('isolated OpenCode server close awaits process exit and removes its temporary home', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-opencode-server-test-'));
  const receipt = path.join(cwd, 'exit-receipt.txt');
  const program = [
    "const fs = require('node:fs')",
    "process.on('SIGTERM', () => { fs.writeFileSync(process.argv[1], process.env.HOME); process.exit(0) })",
    "console.log('opencode server listening on http://127.0.0.1:43210')",
    'setInterval(() => {}, 1000)',
  ].join(';');
  try {
    const server = await startIsolatedOpenCodeServer({
      cwd,
      config: { share: 'disabled' },
      executable: process.execPath,
      args: ['-e', program, receipt],
      ambientEnv: { PATH: process.env.PATH },
      startTimeoutMs: 2_000,
      stopTimeoutMs: 2_000,
    });
    assert.equal(server.url, 'http://127.0.0.1:43210');

    await server.close();

    const disposableHome = fs.readFileSync(receipt, 'utf8');
    assert.match(disposableHome, /weaver-opencode-/);
    assert.equal(fs.existsSync(disposableHome), false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
