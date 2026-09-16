/**
 * The Claude SDK worker's identity boundary: a bare Claude model keeps the
 * registered subscription identity the harness placed in its environment; a
 * provider-qualified model on an Anthropic-compatible endpoint (the z.ai
 * coding plan) swaps that identity for the provider bearer and nothing else,
 * and anything the binary cannot reach is refused, never mis-billed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LocalSdkExecutor } from './localSdk.js';
import type { WorkerExecutionRequest } from './types.js';

function request(model: string, env: Record<string, string | undefined> = {}): WorkerExecutionRequest {
  return {
    workstreamSlug: 'ws',
    assignmentId: 'asg_1',
    prompt: 'p',
    systemPrompt: { type: 'preset', preset: 'claude_code', append: '' },
    model,
    tools: { type: 'preset', preset: 'claude_code' },
    allowedTools: ['mcp__weaver__*'],
    permissionMode: 'bypassPermissions',
    settingSources: ['user', 'project', 'local'],
    strictMcpConfig: false,
    maxTurns: 10,
    cwd: '/w',
    additionalDirectories: [],
    env: { CLAUDE_CODE_OAUTH_TOKEN: 'setup-token-value', CLAUDE_CONFIG_DIR: '/home/weaver/.claude', PATH: '/usr/bin', ...env },
    operatorMcpServers: {},
    submit: { appendSection: async () => ({ text: '' }), submitResult: async () => ({ text: '' }) },
    abort: new AbortController(),
  };
}

function capture() {
  const seen: Array<{ model: string; env: Record<string, string | undefined> }> = [];
  const runQuery = (async function* (input: { options: { model: string; env: Record<string, string | undefined> } }) {
    seen.push({ model: input.options.model, env: input.options.env });
    yield { type: 'result', subtype: 'success', session_id: 's', total_cost_usd: 0.1 };
  }) as never;
  return { seen, runQuery };
}

test('a bare Claude model runs on the registered identity untouched', async () => {
  const { seen, runQuery } = capture();
  const executor = new LocalSdkExecutor({ runQuery, loadExecutorSecrets: () => ({ ZAI_API_KEY: 'zai-bearer-value' }) });
  const outcome = await executor.execute(request('claude-opus-5'));
  assert.equal(outcome.error, undefined);
  assert.equal(seen[0]!.model, 'claude-opus-5');
  assert.equal(seen[0]!.env.CLAUDE_CODE_OAUTH_TOKEN, 'setup-token-value');
  assert.equal(seen[0]!.env.ANTHROPIC_BASE_URL, undefined);
});

test('a z.ai coding-plan model swaps the subscription identity for the provider bearer on its Anthropic endpoint', async () => {
  const { seen, runQuery } = capture();
  const homes: string[] = [];
  const executor = new LocalSdkExecutor({
    runQuery,
    loadExecutorSecrets: () => ({ ZAI_API_KEY: 'zai-bearer-value', CLAUDE_CODE_OAUTH_TOKEN: 'setup-token-value' }),
    prepareApiHome: () => ({ path: '/tmp/api-home', cleanup: () => { homes.push('cleaned'); } }),
  });
  const outcome = await executor.execute(request('zai-coding-plan/glm-5.3', { ZAI_API_KEY: 'ambient-copy' }));
  assert.equal(outcome.error, undefined);
  const [run] = seen;
  assert.equal(run!.model, 'glm-5.3', 'the binary is asked for the bare model name');
  assert.equal(run!.env.ANTHROPIC_BASE_URL, 'https://api.z.ai/api/anthropic');
  assert.equal(run!.env.ANTHROPIC_AUTH_TOKEN, 'zai-bearer-value');
  assert.equal(run!.env.ANTHROPIC_API_KEY, '', 'an explicitly empty key beside the bearer');
  assert.equal(run!.env.CLAUDE_CODE_OAUTH_TOKEN, undefined, 'the subscription can never be billed for a z.ai run');
  assert.equal(run!.env.ZAI_API_KEY, undefined, 'only the protocol variables carry the bearer');
  assert.equal(run!.env.CLAUDE_CONFIG_DIR, '/tmp/api-home', 'a host process gets a fresh config dir');
  assert.deepEqual(homes, ['cleaned']);
});

test('inside the container the host config dir is dropped and no API home is prepared', async () => {
  const { seen, runQuery } = capture();
  let prepared = 0;
  const executor = new LocalSdkExecutor({
    runQuery,
    container: { image: 'example.test/worker:1', dockerCommand: 'docker' },
    loadExecutorSecrets: () => ({ ZHIPU_API_KEY: 'zhipu-bearer-value' }),
    prepareApiHome: () => { prepared += 1; return { path: '/never', cleanup: () => {} }; },
  });
  await executor.execute(request('zai-coding-plan/glm-5.3'));
  assert.equal(prepared, 0);
  assert.equal(seen[0]!.env.CLAUDE_CONFIG_DIR, undefined);
  assert.equal(seen[0]!.env.ANTHROPIC_AUTH_TOKEN, 'zhipu-bearer-value', 'the ZHIPU_API_KEY alias is honoured');
});

test('a provider the binary cannot reach, an empty model, or a missing bearer is refused before any run', async () => {
  const { seen, runQuery } = capture();
  const executor = new LocalSdkExecutor({ runQuery, loadExecutorSecrets: () => ({}) });
  assert.match((await executor.execute(request('openrouter/z-ai/glm-5.3'))).error!, /cannot run provider 'openrouter'/);
  assert.match((await executor.execute(request('zai-coding-plan/'))).error!, /must name a model after zai-coding-plan\//);
  assert.match((await executor.execute(request('zai-coding-plan/glm-5.3'))).error!, /requires ZAI_API_KEY or ZHIPU_API_KEY in executor-only secrets/);
  assert.equal(seen.length, 0);
});

test('a failure that quotes the bearer is redacted before it becomes an outcome', async () => {
  const runQuery = (async function* () {
    throw new Error('401 from https://api.z.ai/api/anthropic with token zai-bearer-value');
    // eslint-disable-next-line no-unreachable
    yield undefined;
  }) as never;
  const executor = new LocalSdkExecutor({
    runQuery,
    loadExecutorSecrets: () => ({ ZAI_API_KEY: 'zai-bearer-value' }),
    prepareApiHome: () => ({ path: '/tmp/api-home', cleanup: () => {} }),
  });
  const outcome = await executor.execute(request('zai-coding-plan/glm-5.3'));
  assert.equal(outcome.error, '401 from https://api.z.ai/api/anthropic with token «secret:ZAI_API_KEY»');
});
