import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { SubmitBridge } from '../../executor/submitBridge.js';
import type {
  SubmitResultArgs,
  SubmitSurface,
  WorkerExecutionRequest,
} from '../../executor/types.js';
import {
  OpenCodeEvalExecutor,
  splitOpenCodeModel,
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
    now: () => times.shift() ?? 1_100,
    async startBridge(submit) {
      calls.push('bridge.start');
      bridgedSubmit = submit;
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
  assert.deepEqual(promptInput!.model, {
    providerID: 'openrouter',
    modelID: 'moonshotai/kimi-k3',
  });
  assert.equal(promptInput!.prompt, req.prompt);
  assert.match(promptInput!.system, /weaver_submit_result/);
  assert.equal(promptInput!.signal, req.abort.signal);
  assert.equal(submitted.length, 1);
  assert.deepEqual(calls, [
    'bridge.start',
    'runtime.start',
    'session.create:eval-stream/asg_eval',
    'session.prompt:ses_fresh',
    'session.delete:ses_fresh',
    'runtime.close',
    'bridge.close',
  ]);
  assert.deepEqual(outcome, { costUsd: 0.125, sessionId: 'ses_fresh' });
  assert.deepEqual(executor.lastTelemetry(), {
    executor: 'opencode',
    modelRequested: 'openrouter/moonshotai/kimi-k3',
    providerResolved: 'openrouter',
    modelResolved: 'moonshotai/kimi-k3',
    harnessVersion: '1.18.15',
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

  const unsafeAmbient = new OpenCodeEvalExecutor({
    ...dependencies,
    ambientEnv: { ANTHROPIC_API_KEY: 'must-not-leak' },
  });
  const unsafeOutcome = await unsafeAmbient.execute(request({ env: {} }));
  assert.equal(launches, 0);
  assert.match(unsafeOutcome.error!, /bypass Weaver credential sanitization/);
  assert.equal(unsafeAmbient.lastTelemetry()!.terminalReason, 'unsupported');
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
    'bridge.start',
    'runtime.start',
    'create',
    'prompt',
    'abort:ses_abort',
    'delete:ses_abort',
    'runtime.close',
    'bridge.close',
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
