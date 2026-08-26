/**
 * `weaver login` rails: the remote-env render carries exactly one Claude
 * principal, never the store/home location, and never a multiline value; the
 * `.env` updater is surgical. No model calls anywhere.
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  ensureServeToken,
  renderRemoteEnvLines,
  renderRemoteExecutorSecretLines,
  updateEnvContent,
} from './login.js';
import { loadExecutorSecrets, setExecutorSecret } from './secrets.js';

beforeEach(() => {
  process.env.WEAVER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-login-'));
});

test('render emits exactly one Claude principal — the subscription token wins', () => {
  const { lines } = renderRemoteEnvLines(
    {
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token-123',
      ANTHROPIC_API_KEY: 'api-key-456',
      WEAVER_SERVE_TOKEN: 'serve-token-789',
    },
    {},
  );
  assert.ok(lines.includes('CLAUDE_CODE_OAUTH_TOKEN=oauth-token-123'));
  assert.ok(
    !lines.some((l) => l.startsWith('ANTHROPIC_API_KEY=')),
    'two live principals would make the remote billing identity ambiguous',
  );
});

test('render falls back to the registered API key and warns when no identity exists', () => {
  const withKey = renderRemoteEnvLines(
    { ANTHROPIC_API_KEY: 'api-key-456', WEAVER_SERVE_TOKEN: 't' },
    {},
  );
  assert.ok(withKey.lines.includes('ANTHROPIC_API_KEY=api-key-456'));

  const withNone = renderRemoteEnvLines({ WEAVER_SERVE_TOKEN: 't' }, {});
  assert.ok(!withNone.lines.some((l) => /^(ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN)=/.test(l)));
  assert.ok(withNone.warnings.some((w) => w.includes('no Claude identity registered')));
});

test('render forwards registered provider keys and mirrors config, and flags codex-sdk auth', () => {
  const { lines, warnings } = renderRemoteEnvLines(
    {
      OPENROUTER_API_KEY: 'or-key',
      ZHIPU_API_KEY: 'zhipu-key',
      WEAVER_SERVE_TOKEN: 'serve-token',
    },
    {
      WEAVER_EXECUTOR: 'pi',
      WEAVER_WORKER_MODEL: 'openrouter/moonshotai/kimi-k3',
      WEAVER_WORKER_MODEL_COMPLEX: 'zai-coding-plan/glm-5.3',
      WEAVER_WORKER_FALLBACKS: 'codex-sdk:gpt-5.6-sol,pi:zai/glm-5.3',
      WEAVER_COORDINATOR_FALLBACKS: 'codex-sdk:gpt-5.6-sol,local-sdk:claude-opus-5',
      WEAVER_COORDINATOR_FALLBACK_EXECUTOR: 'codex-sdk',
      WEAVER_HOUSE_JSON: '{"repoMap":"Primary application: /srv/application","tags":["application"]}',
      WEAVER_WORKSPACE_ROOT: '/var/lib/weaver/workspaces',
      WEAVER_PILOT_URL: 'http://127.0.0.1:9721',
      WEAVER_RUNNER_EXECUTORS: undefined, // unset locally → not mirrored
    },
  );
  assert.ok(lines.includes('OPENROUTER_API_KEY=or-key'));
  assert.ok(lines.includes('ZHIPU_API_KEY=zhipu-key'));
  assert.ok(lines.includes('WEAVER_SERVE_TOKEN=serve-token'));
  assert.ok(lines.includes('WEAVER_EXECUTOR=pi'));
  assert.ok(lines.includes('WEAVER_WORKER_MODEL=openrouter/moonshotai/kimi-k3'));
  assert.ok(lines.includes('WEAVER_WORKER_MODEL_COMPLEX=zai-coding-plan/glm-5.3'));
  assert.ok(lines.includes('WEAVER_WORKER_FALLBACKS=codex-sdk:gpt-5.6-sol,pi:zai/glm-5.3'));
  assert.ok(lines.includes('WEAVER_COORDINATOR_FALLBACKS=codex-sdk:gpt-5.6-sol,local-sdk:claude-opus-5'));
  assert.ok(lines.includes('WEAVER_HOUSE_JSON={"repoMap":"Primary application: /srv/application","tags":["application"]}'));
  assert.ok(lines.includes('WEAVER_WORKSPACE_ROOT=/var/lib/weaver/workspaces'));
  assert.ok(lines.includes('WEAVER_PILOT_URL=http://127.0.0.1:9721'));
  assert.ok(!lines.some((l) => l.startsWith('WEAVER_RUNNER_EXECUTORS=')));
  assert.ok(warnings.some((w) => w.includes('codex-sdk auth is a login file')));
});

test('executor-secret render carries every registered secret exactly and no config', () => {
  assert.deepEqual(
    renderRemoteExecutorSecretLines({
      CUSTOM_PROVIDER_TOKEN: 'custom=credential',
      OPENROUTER_API_KEY: 'provider-key',
      ANTHROPIC_API_KEY: 'api-key',
      WEAVER_PILOT_TOKEN: 'pilot-bearer',
    }),
    [
      'ANTHROPIC_API_KEY=api-key',
      'CUSTOM_PROVIDER_TOKEN=custom=credential',
      'OPENROUTER_API_KEY=provider-key',
      'WEAVER_PILOT_TOKEN=pilot-bearer',
    ],
  );
  assert.throws(
    () => renderRemoteExecutorSecretLines({ BAD: 'line-one\nWEAVER_HOME=/injected' }),
    /newline/,
  );
});

test('Pilot bearer travels only in the executor-secret render, never general remote env', () => {
  const secret = 'pilot-bearer-value-5804';
  assert.deepEqual(
    renderRemoteExecutorSecretLines({ WEAVER_PILOT_TOKEN: secret }),
    [`WEAVER_PILOT_TOKEN=${secret}`],
  );
  const general = renderRemoteEnvLines(
    { WEAVER_SERVE_TOKEN: 'serve-token', WEAVER_PILOT_TOKEN: secret },
    { WEAVER_PILOT_URL: 'https://pilot.example.test' },
  );
  assert.ok(!general.lines.some((line) => line.includes(secret)));
  assert.ok(!general.lines.some((line) => line.startsWith('WEAVER_PILOT_TOKEN=')));
});

test('GitHub App identity travels only in the executor-secret render', () => {
  const appSecrets = {
    WEAVER_GITHUB_APP_ID: '12345',
    WEAVER_GITHUB_APP_INSTALLATION_ID: '67890',
    WEAVER_GITHUB_APP_PRIVATE_KEY_BASE64: 'private-key-material',
  };
  assert.deepEqual(renderRemoteExecutorSecretLines(appSecrets), [
    'WEAVER_GITHUB_APP_ID=12345',
    'WEAVER_GITHUB_APP_INSTALLATION_ID=67890',
    'WEAVER_GITHUB_APP_PRIVATE_KEY_BASE64=private-key-material',
  ]);
  const general = renderRemoteEnvLines(
    { ...appSecrets, WEAVER_SERVE_TOKEN: 'serve-token' },
    {},
  );
  for (const value of Object.values(appSecrets)) {
    assert.ok(!general.lines.some((line) => line.includes(value)));
  }
  assert.ok(!general.lines.some((line) => line.startsWith('WEAVER_GITHUB_APP_')));
});

test('WEAVER_STORE and WEAVER_HOME are never emitted — provisioning owns them', () => {
  const { lines } = renderRemoteEnvLines(
    { WEAVER_SERVE_TOKEN: 't' },
    {
      WEAVER_STORE: 'postgres://user:pass@host/db',
      WEAVER_HOME: '/var/lib/weaver',
      WEAVER_EXECUTOR: 'local-sdk',
    },
  );
  assert.ok(!lines.some((l) => l.startsWith('WEAVER_STORE=')));
  assert.ok(!lines.some((l) => l.startsWith('WEAVER_HOME=')));
  assert.ok(lines.includes('WEAVER_EXECUTOR=local-sdk'));
});

test('a value containing a newline is refused, not truncated into a bogus env line', () => {
  assert.throws(
    () =>
      renderRemoteEnvLines(
        { WEAVER_SERVE_TOKEN: 't', OPENROUTER_API_KEY: 'line-one\nWEAVER_HOME=/injected' },
        {},
      ),
    /newline/,
  );
});

test('ensureServeToken mints once, persists to the executor store, and stays stable', () => {
  assert.equal(loadExecutorSecrets().WEAVER_SERVE_TOKEN, undefined);
  const minted = ensureServeToken();
  assert.match(minted, /^[0-9a-f]{64}$/);
  assert.equal(loadExecutorSecrets().WEAVER_SERVE_TOKEN, minted);
  assert.equal(ensureServeToken(), minted, 'a re-render must ship the SAME bearer token');
  const rendered = renderRemoteEnvLines(loadExecutorSecrets(), {});
  assert.ok(rendered.lines.includes(`WEAVER_SERVE_TOKEN=${minted}`));
});

test('ensureServeToken keeps a token the operator already registered', () => {
  setExecutorSecret('WEAVER_SERVE_TOKEN', 'operator-chosen-token');
  assert.equal(ensureServeToken(), 'operator-chosen-token');
});

test('.env update rewrites keys in place and preserves unrelated lines and comments', () => {
  const before = [
    '# machine-local config — see docs-public/configuration.md',
    'WEAVER_COORDINATOR_MODEL=claude-fable-5',
    '',
    'export WEAVER_WORKER_MODEL=sonnet',
    '# WEAVER_STORE=postgres://commented-out',
    'UNRELATED=stays',
  ].join('\n') + '\n';
  const after = updateEnvContent(before, {
    WEAVER_COORDINATOR_MODEL: 'claude-opus-5',
    WEAVER_WORKER_MODEL: 'gpt-5.6-sol',
    WEAVER_EXECUTOR: 'codex-sdk',
  });
  assert.equal(
    after,
    [
      '# machine-local config — see docs-public/configuration.md',
      'WEAVER_COORDINATOR_MODEL=claude-opus-5',
      '',
      'export WEAVER_WORKER_MODEL=gpt-5.6-sol',
      '# WEAVER_STORE=postgres://commented-out',
      'UNRELATED=stays',
      'WEAVER_EXECUTOR=codex-sdk',
    ].join('\n') + '\n',
  );
});

test('.env update handles an empty or missing file and duplicate keys deterministically', () => {
  assert.equal(updateEnvContent('', { A_KEY: 'one' }), 'A_KEY=one\n');
  assert.equal(updateEnvContent('', {}), '');
  // Every assignment of the key is rewritten — env parsers let the LAST one
  // win, so leaving a later duplicate would make the update ineffective.
  const dup = updateEnvContent('A_KEY=old\nA_KEY=older\n', { A_KEY: 'new' });
  assert.equal(dup, 'A_KEY=new\nA_KEY=new\n');
});
