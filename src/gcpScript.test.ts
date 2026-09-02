/**
 * The GCP helper is an authority-bearing deployment boundary. These tests run
 * it against inert PATH stubs so URL transport, restart defaults, and rendered
 * env forwarding stay deterministic without touching GCP or model identities.
 */

import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../bin/weaver-gcp.sh', import.meta.url));
const installer = fileURLToPath(new URL('../bin/weaver-install-env.sh', import.meta.url));
const gcpPreflight = fileURLToPath(new URL('../bin/weaver-gcp-preflight.sh', import.meta.url));
const roots: string[] = [];

const SAFE_GCP_EXECUTION_ENV = [
  'WEAVER_EXECUTOR=openhands',
  'WEAVER_OPENHANDS_HOST_GATEWAY_IP=10.170.0.2',
  'WEAVER_WORKER_MODEL=openrouter/z-ai/glm-5.3',
  'WEAVER_WORKER_FALLBACKS=',
  'WEAVER_COORDINATOR_MODEL=claude-fable-5',
  'WEAVER_COORDINATOR_EXECUTOR=local-sdk',
  'WEAVER_COORDINATOR_FALLBACKS=local-sdk:openrouter/z-ai/glm-5.3',
  'WEAVER_ACTION_EXECUTOR=local-sdk',
  'WEAVER_DETERMINISTIC_ACTIONS_ONLY=1',
  'WEAVER_PILOT_URL=http://127.0.0.1:9721',
  'WEAVER_RUNNER_EXECUTORS=openhands,local-sdk',
  '',
].join('\n');

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(
  remoteEnv = '',
  staleRemoteInstaller = false,
  preflightEnv = SAFE_GCP_EXECUTION_ENV,
  dockerOk = true,
  pilotListenerOk = true,
  pilotClientOk = true,
  pilotTokenPresent = true,
  pilotAuthEnabled = true,
  githubClientOk = true,
  githubCredentialsPresent = true,
  personalGithubAuth = false,
  staticGithubToken = false,
): { root: string; env: NodeJS.ProcessEnv } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-gcp-script-'));
  roots.push(root);
  const bin = path.join(root, 'bin');
  const calls = path.join(root, 'calls');
  const codex = path.join(root, 'codex-none');
  const serviceHome = path.join(root, 'service-home');
  fs.mkdirSync(bin);
  fs.mkdirSync(calls);
  fs.mkdirSync(serviceHome);
  fs.writeFileSync(
    path.join(bin, 'gcloud'),
    `#!/bin/bash
set -euo pipefail
counter="$WEAVER_GCP_TEST_CALLS/count"
n=0
[ ! -f "$counter" ] || n="$(cat "$counter")"
n=$((n + 1))
printf '%s\n' "$n" > "$counter"
printf '%s\n' "$@" > "$WEAVER_GCP_TEST_CALLS/$n.args"
cat > "$WEAVER_GCP_TEST_CALLS/$n.stdin"
if printf '%s\n' "$@" | grep -q 'weaver-gcp-preflight'; then
  WEAVER_GCP_PREFLIGHT_ENV_FILE="$WEAVER_GCP_TEST_PREFLIGHT_ENV" \
  WEAVER_GCP_PREFLIGHT_SERVICE_USER="$WEAVER_GCP_TEST_SERVICE_USER" \
  WEAVER_GCP_PREFLIGHT_SERVICE_HOME="$WEAVER_GCP_TEST_SERVICE_HOME" \
  WEAVER_GCP_PREFLIGHT_EXECUTOR_SECRETS_FILE="$WEAVER_GCP_TEST_EXECUTOR_SECRETS" \
  WEAVER_GCP_PREFLIGHT_WEAVER_BIN="$WEAVER_GCP_TEST_WEAVER_BIN" \
    bash "$WEAVER_GCP_TEST_CALLS/$n.stdin"
  : > "$WEAVER_GCP_TEST_CALLS/$n.systemctl-executed"
fi
if [ "\${WEAVER_GCP_TEST_STALE_INSTALLER:-0}" = 1 ]; then
  if printf '%s\n' "$@" | grep -q '/tmp/weaver-install-env.local'; then
    cp "$WEAVER_GCP_TEST_CALLS/$n.stdin" "$WEAVER_GCP_TEST_REMOTE_INSTALLER"
  fi
  if printf '%s\n' "$@" | grep -q 'weaver-install-env executor-secrets'; then
    grep -q '^  executor-secrets)' "$WEAVER_GCP_TEST_REMOTE_INSTALLER" || {
      echo 'remote installer does not support executor-secrets' >&2
      exit 91
    }
  fi
  if printf '%s\n' "$@" | grep -q 'weaver-install-env worker-secrets'; then
    grep -q '^  worker-secrets)' "$WEAVER_GCP_TEST_REMOTE_INSTALLER" || {
      echo 'remote installer does not support worker-secrets' >&2
      exit 92
    }
  fi
fi
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(bin, 'sudo'),
    `#!/bin/bash
set -euo pipefail
if [ "\${1:-}" = -u ]; then shift 2; fi
exec "$@"
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(bin, 'gh'),
    `#!/bin/bash
set -euo pipefail
[ "\${1:-}" = auth ] && [ "\${2:-}" = status ]
[ "\${WEAVER_GCP_TEST_PERSONAL_GITHUB_AUTH:-0}" = 1 ]
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(bin, 'git'),
    `#!/bin/bash
set -euo pipefail
case "$*" in
  *'config --get-all credential.helper'*)
    [ "\${WEAVER_GCP_TEST_GIT_HELPER:-0}" = 1 ] || exit 1
    printf '%s\n' store
    ;;
  *) exit 1 ;;
esac
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(bin, 'docker'),
    `#!/bin/bash
set -euo pipefail
[ "\${WEAVER_GCP_TEST_DOCKER_OK:-0}" = 1 ]
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(bin, 'ip'),
    `#!/bin/bash
set -euo pipefail
printf '%s\n' '2: eth0    inet 10.170.0.2/32 brd 10.170.0.2 scope global dynamic eth0'
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(bin, 'systemctl'),
    `#!/bin/bash
set -euo pipefail
case "\${1:-}" in
  is-active) exit 0 ;;
  show)
    case "$*" in
      *--property=User*) printf '%s\n' weaver-pilot ;;
      *--property=MainPID*) printf '%s\n' 4242 ;;
      *) exit 1 ;;
    esac
    ;;
  *) exit 1 ;;
esac
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(bin, 'ss'),
    `#!/bin/bash
set -euo pipefail
[ "\${WEAVER_GCP_TEST_PILOT_LISTENER_OK:-0}" = 1 ] || {
  printf '%s\n' 'LISTEN 0 128 0.0.0.0:9721 0.0.0.0:* users:(("pilot",pid=4242,fd=3))'
  exit 0
}
printf '%s\n' 'LISTEN 0 128 127.0.0.1:9721 0.0.0.0:* users:(("pilot",pid=4242,fd=3))'
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(bin, 'curl'),
    `#!/bin/bash
set -euo pipefail
header=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --header) header="\${2:-}"; shift 2 ;;
    *) shift ;;
  esac
done
if [ "\${WEAVER_GCP_TEST_PILOT_AUTH_ENABLED:-0}" != 1 ]; then
  printf '%s' 204
elif [ "$header" = 'Authorization: Bearer weaver-preflight-deliberately-invalid' ]; then
  printf '%s' 401
elif [ "\${header#@}" != "$header" ] && grep -q "Authorization: Bearer $WEAVER_GCP_TEST_PILOT_TOKEN" "\${header#@}"; then
  printf '%s' 204
else
  printf '%s' 401
fi
`,
    { mode: 0o755 },
  );
  const weaverProbe = path.join(bin, 'weaver-probe');
  fs.writeFileSync(
    weaverProbe,
    `#!/bin/bash
set -euo pipefail
[ "$#" -eq 1 ]
case "$1" in
  pilot-auth-check)
    : > "$WEAVER_GCP_TEST_CALLS/pilot-client-probe"
    [ "\${WEAVER_GCP_TEST_PILOT_CLIENT_OK:-0}" = 1 ]
    ;;
  github-auth-check)
    : > "$WEAVER_GCP_TEST_CALLS/github-client-probe"
    [ "\${WEAVER_GCP_TEST_GITHUB_CLIENT_OK:-0}" = 1 ]
    ;;
  *) exit 2 ;;
esac
`,
    { mode: 0o755 },
  );
  const preflightEnvFile = path.join(root, 'remote-host-env');
  fs.writeFileSync(preflightEnvFile, preflightEnv);
  const executorSecretsFile = path.join(root, 'executor-secrets.env');
  const executorSecrets = [
    'CLAUDE_CODE_OAUTH_TOKEN=test-setup-token',
    'OPENROUTER_API_KEY=test-provider-key',
    ...(pilotTokenPresent ? ['WEAVER_PILOT_TOKEN=test-pilot-token'] : []),
    ...(githubCredentialsPresent ? [
      'WEAVER_GITHUB_APP_ID=12345',
      'WEAVER_GITHUB_APP_INSTALLATION_ID=67890',
      'WEAVER_GITHUB_APP_PRIVATE_KEY_BASE64=test-base64-key',
    ] : []),
    ...(staticGithubToken ? ['GH_TOKEN=forbidden-static-token'] : []),
    '',
  ].join('\n');
  fs.writeFileSync(
    executorSecretsFile,
    executorSecrets,
    { mode: 0o600 },
  );
  if (personalGithubAuth) {
    fs.mkdirSync(path.join(serviceHome, '.config', 'gh'), { recursive: true });
    fs.writeFileSync(path.join(serviceHome, '.config', 'gh', 'hosts.yml'), 'github.com:\n  user: personal\n');
  }
  const remoteInstaller = path.join(root, 'remote-installer');
  if (staleRemoteInstaller) {
    fs.writeFileSync(remoteInstaller, '#!/bin/bash\ncase "$1" in merge|store) exit 0;; esac\n');
  }
  fs.writeFileSync(
    path.join(bin, 'node'),
    `#!/bin/bash
set -euo pipefail
if [ -n "\${WEAVER_EXECUTOR:-}" ]; then
printf '%s\n' \
  "WEAVER_EXECUTOR=$WEAVER_EXECUTOR" \
  "WEAVER_WORKER_MODEL=$WEAVER_WORKER_MODEL" \
  "WEAVER_WORKER_FALLBACKS=$WEAVER_WORKER_FALLBACKS" \
  "WEAVER_COORDINATOR_EXECUTOR=$WEAVER_COORDINATOR_EXECUTOR" \
  "WEAVER_COORDINATOR_MODEL=$WEAVER_COORDINATOR_MODEL" \
  "WEAVER_COORDINATOR_FALLBACKS=$WEAVER_COORDINATOR_FALLBACKS" \
  "WEAVER_ACTION_EXECUTOR=$WEAVER_ACTION_EXECUTOR" \
  "WEAVER_DETERMINISTIC_ACTIONS_ONLY=$WEAVER_DETERMINISTIC_ACTIONS_ONLY" \
  "WEAVER_RUNNER_EXECUTORS=$WEAVER_RUNNER_EXECUTORS" \
  > "$WEAVER_GCP_TEST_CALLS/render-profile"
fi
printf '%s' "$WEAVER_GCP_TEST_REMOTE_ENV"
`,
    { mode: 0o755 },
  );
  return {
    root,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      CODEX_HOME: codex,
      WEAVER_GCP_PROJECT: 'test-project',
      WEAVER_GCP_VM: 'test-runner',
      WEAVER_GCP_TEST_CALLS: calls,
      WEAVER_GCP_TEST_REMOTE_ENV: remoteEnv,
      WEAVER_GCP_TEST_STALE_INSTALLER: staleRemoteInstaller ? '1' : '0',
      WEAVER_GCP_TEST_REMOTE_INSTALLER: remoteInstaller,
      WEAVER_GCP_TEST_PREFLIGHT_ENV: preflightEnvFile,
      WEAVER_GCP_TEST_SERVICE_USER: os.userInfo().username,
      WEAVER_GCP_TEST_SERVICE_HOME: serviceHome,
      WEAVER_GCP_TEST_DOCKER_OK: dockerOk ? '1' : '0',
      WEAVER_GCP_TEST_PILOT_LISTENER_OK: pilotListenerOk ? '1' : '0',
      WEAVER_GCP_TEST_PILOT_CLIENT_OK: pilotClientOk ? '1' : '0',
      WEAVER_GCP_TEST_PILOT_AUTH_ENABLED: pilotAuthEnabled ? '1' : '0',
      WEAVER_GCP_TEST_PILOT_TOKEN: 'test-pilot-token',
      WEAVER_GCP_TEST_GITHUB_CLIENT_OK: githubClientOk ? '1' : '0',
      WEAVER_GCP_TEST_PERSONAL_GITHUB_AUTH: personalGithubAuth ? '1' : '0',
      WEAVER_GCP_TEST_EXECUTOR_SECRETS: executorSecretsFile,
      WEAVER_GCP_TEST_WEAVER_BIN: weaverProbe,
    },
  };
}

function run(
  args: string[],
  input: string | undefined,
  remoteEnv = '',
  staleRemoteInstaller = false,
  preflightEnv = SAFE_GCP_EXECUTION_ENV,
  dockerOk = true,
  pilotListenerOk = true,
  pilotClientOk = true,
  pilotTokenPresent = true,
  pilotAuthEnabled = true,
  githubClientOk = true,
  githubCredentialsPresent = true,
  personalGithubAuth = false,
  staticGithubToken = false,
): { result: SpawnSyncReturns<string>; root: string } {
  const f = fixture(
    remoteEnv,
    staleRemoteInstaller,
    preflightEnv,
    dockerOk,
    pilotListenerOk,
    pilotClientOk,
    pilotTokenPresent,
    pilotAuthEnabled,
    githubClientOk,
    githubCredentialsPresent,
    personalGithubAuth,
    staticGithubToken,
  );
  const result = spawnSync('bash', [script, ...args], {
    env: f.env,
    ...(input === undefined ? {} : { input }),
    encoding: 'utf8',
  }) as SpawnSyncReturns<string>;
  return { result, root: f.root };
}

function startExistingFixture(f: { root: string; env: NodeJS.ProcessEnv }): SpawnSyncReturns<string> {
  return spawnSync('bash', [script, 'start'], {
    env: f.env,
    encoding: 'utf8',
  }) as SpawnSyncReturns<string>;
}

function call(root: string, n: number, kind: 'args' | 'stdin'): string {
  return fs.readFileSync(path.join(root, 'calls', `${n}.${kind}`), 'utf8');
}

function allCallArgs(root: string): string {
  const count = Number(fs.readFileSync(path.join(root, 'calls', 'count'), 'utf8'));
  return Array.from({ length: count }, (_, index) => call(root, index + 1, 'args')).join('\n');
}

function installEnv(
  envFile: string,
  mode: 'merge' | 'store' | 'executor-secrets' | 'worker-secrets',
  input: string,
  executorSecretsFile?: string,
  workerSecretsFile?: string,
): SpawnSyncReturns<string> {
  return spawnSync('bash', [installer, mode], {
    input,
    encoding: 'utf8',
    env: {
      ...process.env,
      WEAVER_INSTALL_ENV_FILE: envFile,
      WEAVER_INSTALL_ENV_OWNER: ':',
      ...(executorSecretsFile === undefined ? {} : {
        WEAVER_INSTALL_EXECUTOR_SECRETS_FILE: executorSecretsFile,
        WEAVER_INSTALL_EXECUTOR_SECRETS_OWNER: ':',
      }),
      ...(workerSecretsFile === undefined ? {} : {
        WEAVER_INSTALL_WORKER_SECRETS_FILE: workerSecretsFile,
        WEAVER_INSTALL_WORKER_SECRETS_OWNER: ':',
      }),
    },
  }) as SpawnSyncReturns<string>;
}

test('host env merge preserves local state and replaces the complete portable render', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-gcp-env-'));
  roots.push(root);
  const envFile = path.join(root, 'env');
  fs.writeFileSync(envFile, [
    '# host-local values survive portable renders',
    'WEAVER_STORE=postgresql://old-secret@db.example/weaver',
    'WEAVER_HOME=/home/weaver/state',
    'WEAVER_WORKSPACE_ROOT=/old/workspaces',
    'WEAVER_HOUSE_JSON={"repoMap":"Old path: /old"}',
    'WEAVER_EXECUTOR=local-sdk',
    'OPENROUTER_API_KEY=revoked-secret',
    'WEAVER_ACTION_MODEL=removed-action-model',
    'CUSTOM_HOST_SETTING=keep-me',
    '',
  ].join('\n'));
  const rendered = [
    'WEAVER_EXECUTOR=pi',
    'WEAVER_COORDINATOR_FALLBACKS=codex-sdk:gpt-5.6-sol,local-sdk:claude-opus-5',
    'WEAVER_WORKER_MODEL_COMPLEX=zai-coding-plan/glm-5.3',
    'WEAVER_WORKER_FALLBACKS=pi:zai/glm-5.3',
    'WEAVER_WORKSPACE_ROOT=/home/weaver/workspaces',
    'WEAVER_HOUSE_JSON={"repoMap":"Primary application: /srv/application","tags":["application"]}',
    '',
  ].join('\n');
  const result = installEnv(envFile, 'merge', rendered);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.deepEqual(fs.readFileSync(envFile, 'utf8').trimEnd().split('\n'), [
    '# host-local values survive portable renders',
    'WEAVER_STORE=postgresql://old-secret@db.example/weaver',
    'WEAVER_HOME=/home/weaver/state',
    'WEAVER_WORKSPACE_ROOT=/home/weaver/workspaces',
    'WEAVER_HOUSE_JSON={"repoMap":"Primary application: /srv/application","tags":["application"]}',
    'WEAVER_EXECUTOR=pi',
    'CUSTOM_HOST_SETTING=keep-me',
    'WEAVER_COORDINATOR_FALLBACKS=codex-sdk:gpt-5.6-sol,local-sdk:claude-opus-5',
    'WEAVER_WORKER_MODEL_COMPLEX=zai-coding-plan/glm-5.3',
    'WEAVER_WORKER_FALLBACKS=pi:zai/glm-5.3',
  ]);
  assert.equal(fs.statSync(envFile).mode & 0o777, 0o600);
});

test('host env installer atomically replaces only WEAVER_STORE and refuses store injection via merge', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-gcp-store-'));
  roots.push(root);
  const envFile = path.join(root, 'env');
  fs.writeFileSync(envFile, 'WEAVER_STORE=postgres://old/db\nWEAVER_HOME=/home/weaver/state\n');
  const url = 'postgresql://weaver:new-secret@railway.example:5432/weaver?sslmode=require';
  const installed = installEnv(envFile, 'store', `${url}\n`);
  assert.equal(installed.status, 0, installed.stderr);
  assert.equal(`${installed.stdout}${installed.stderr}`, '');
  assert.equal(
    fs.readFileSync(envFile, 'utf8'),
    `WEAVER_HOME=/home/weaver/state\nWEAVER_STORE=${url}\n`,
  );

  const before = fs.readFileSync(envFile, 'utf8');
  const refused = installEnv(envFile, 'merge', 'WEAVER_STORE=postgres://injected/db\n');
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /attempted to replace host-local WEAVER_STORE/);
  assert.equal(fs.readFileSync(envFile, 'utf8'), before);
});

test('executor-secret installer exactly replaces the adapter store at mode 0600', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-gcp-executor-secrets-'));
  roots.push(root);
  const envFile = path.join(root, 'env');
  const secretsFile = path.join(root, 'state', 'executor-secrets.env');
  fs.writeFileSync(envFile, 'WEAVER_EXECUTOR=pi\n');
  fs.mkdirSync(path.dirname(secretsFile));
  fs.writeFileSync(secretsFile, 'REVOKED_API_KEY=old-value\n');

  const rendered = 'CUSTOM_PROVIDER_TOKEN=custom=credential\nOPENROUTER_API_KEY=new-value\n';
  const result = installEnv(envFile, 'executor-secrets', rendered, secretsFile);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(`${result.stdout}${result.stderr}`, '');
  assert.equal(fs.readFileSync(secretsFile, 'utf8'), rendered);
  assert.equal(fs.statSync(secretsFile).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(envFile, 'utf8'), 'WEAVER_EXECUTOR=pi\n');

  const refused = installEnv(
    envFile,
    'executor-secrets',
    'OPENROUTER_API_KEY=one\nOPENROUTER_API_KEY=two\n',
    secretsFile,
  );
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /duplicate key/);
  assert.equal(fs.readFileSync(secretsFile, 'utf8'), rendered);
});

test('worker-secret installer exactly replaces the global store at mode 0600', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-gcp-worker-secrets-'));
  roots.push(root);
  const envFile = path.join(root, 'env');
  const executorSecretsFile = path.join(root, 'state', 'executor-secrets.env');
  const workerSecretsFile = path.join(root, 'state', 'secrets.env');
  fs.writeFileSync(envFile, 'WEAVER_EXECUTOR=openhands\n');
  fs.mkdirSync(path.dirname(workerSecretsFile));
  fs.writeFileSync(executorSecretsFile, 'OPENROUTER_API_KEY=provider-value\n');
  fs.writeFileSync(workerSecretsFile, 'REVOKED_TOKEN=old-value\n');

  const rendered = 'READONLY_DB_URL=postgres://reader:secret@db/app\nSENTRY_AUTH_TOKEN=selected=value\n';
  const result = installEnv(
    envFile,
    'worker-secrets',
    rendered,
    executorSecretsFile,
    workerSecretsFile,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(`${result.stdout}${result.stderr}`, '');
  assert.equal(fs.readFileSync(workerSecretsFile, 'utf8'), rendered);
  assert.equal(fs.statSync(workerSecretsFile).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(executorSecretsFile, 'utf8'), 'OPENROUTER_API_KEY=provider-value\n');
  assert.equal(fs.readFileSync(envFile, 'utf8'), 'WEAVER_EXECUTOR=openhands\n');
});

test('worker-secret installer refuses malformed, duplicate, and empty records atomically', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-gcp-worker-secrets-invalid-'));
  roots.push(root);
  const envFile = path.join(root, 'env');
  const workerSecretsFile = path.join(root, 'state', 'secrets.env');
  fs.writeFileSync(envFile, 'WEAVER_EXECUTOR=openhands\n');
  fs.mkdirSync(path.dirname(workerSecretsFile));
  fs.writeFileSync(workerSecretsFile, 'KEPT_TOKEN=kept-value\n', { mode: 0o600 });

  for (const [input, error] of [
    ['', /render is empty/],
    ['MISSING_EQUALS\n', /malformed line/],
    ['lower=value\n', /malformed key/],
    ['EMPTY=\n', /empty value/],
    ['TOKEN=one\nTOKEN=two\n', /duplicate key/],
    ['TOKEN=value\r\n', /malformed value/],
  ] as const) {
    const result = installEnv(envFile, 'worker-secrets', input, undefined, workerSecretsFile);
    assert.notEqual(result.status, 0, `input ${JSON.stringify(input)} was accepted`);
    assert.match(result.stderr, error);
    assert.equal(fs.readFileSync(workerSecretsFile, 'utf8'), 'KEPT_TOKEN=kept-value\n');
  }
});

test('set-store carries the Postgres URL only on SSH stdin', () => {
  const url = 'postgresql://weaver:p4ss@db.example:5432/weaver?sslmode=require';
  const { result, root } = run(['set-store'], `${url}\n`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(call(root, 1, 'stdin'), `${url}\n`);
  assert.match(call(root, 1, 'args'), /weaver-install-env store/);
  assert.ok(!call(root, 1, 'args').includes(url), 'URL must not enter gcloud argv');
  assert.ok(!`${result.stdout}${result.stderr}`.includes(url), 'URL must not enter output');
  assert.match(result.stdout, /services were not restarted/);
});

test('set-store refuses a non-Postgres value before invoking gcloud', () => {
  const { result, root } = run(['set-store'], 'https://db.example/not-postgres\n');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must be a postgres:\/\/ or postgresql:\/\/ URL/);
  assert.equal(fs.existsSync(path.join(root, 'calls', 'count')), false);
});

test('push-env upgrades a stale remote installer before securely forwarding identities and config', () => {
  const rendered = [
    'OPENROUTER_API_KEY=registered-provider-secret',
    'ANTHROPIC_API_KEY=forbidden-api-secret',
    'CLAUDE_CODE_OAUTH_TOKEN=registered-setup-token',
    'ZHIPU_API_KEY=unused-provider-secret',
    'WEAVER_EXECUTOR=pi',
    'WEAVER_COORDINATOR_FALLBACKS=codex-sdk:gpt-5.6-sol,local-sdk:claude-opus-5',
    'WEAVER_WORKER_MODEL_COMPLEX=zai-coding-plan/glm-5.3',
    'WEAVER_WORKER_FALLBACKS=pi:zai/glm-5.3',
    'WEAVER_HOUSE_JSON={"repoMap":"Primary application: /srv/application","tags":["application"]}',
    'WEAVER_WORKSPACE_ROOT=/home/weaver/workspaces',
    '',
  ].join('\n');
  const { result, root } = run(['push-env'], undefined, rendered, true);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(call(root, 1, 'stdin'), fs.readFileSync(installer, 'utf8'));
  assert.match(call(root, 1, 'args'), /\/tmp\/weaver-install-env\.local/);
  assert.ok(!call(root, 1, 'stdin').includes('Primary application'));
  assert.ok(!call(root, 2, 'stdin').includes('OPENROUTER_API_KEY'));
  assert.ok(call(root, 2, 'stdin').includes('WEAVER_EXECUTOR=pi'));
  assert.match(call(root, 2, 'args'), /weaver-install-env merge/);
  assert.equal(call(root, 3, 'stdin'), [
    'OPENROUTER_API_KEY=registered-provider-secret',
    'CLAUDE_CODE_OAUTH_TOKEN=registered-setup-token',
    '',
  ].join('\n'));
  assert.match(call(root, 3, 'args'), /weaver-install-env executor-secrets/);
  assert.ok(!call(root, 3, 'stdin').includes('forbidden-api-secret'));
  assert.ok(!call(root, 3, 'stdin').includes('unused-provider-secret'));
  assert.ok(!allCallArgs(root).includes('systemctl'));
  assert.equal(fs.readFileSync(path.join(root, 'calls', 'count'), 'utf8').trim(), '3');
  assert.match(fs.readFileSync(path.join(root, 'remote-installer'), 'utf8'), /^  executor-secrets\)/m);
  assert.match(result.stdout, /services were not restarted/);
  assert.ok(!`${result.stdout}${result.stderr}`.includes('Primary application'));
  assert.equal(fs.readFileSync(path.join(root, 'calls', 'render-profile'), 'utf8'), [
    'WEAVER_EXECUTOR=openhands',
    'WEAVER_WORKER_MODEL=openrouter/z-ai/glm-5.3',
    'WEAVER_WORKER_FALLBACKS=',
    'WEAVER_COORDINATOR_EXECUTOR=local-sdk',
    'WEAVER_COORDINATOR_MODEL=claude-fable-5',
    'WEAVER_COORDINATOR_FALLBACKS=local-sdk:openrouter/z-ai/glm-5.3',
    'WEAVER_ACTION_EXECUTOR=local-sdk',
    'WEAVER_DETERMINISTIC_ACTIONS_ONLY=1',
    'WEAVER_RUNNER_EXECUTORS=openhands,local-sdk',
    '',
  ].join('\n'));
});

test('push-env never copies personal Codex device authentication to the host', () => {
  const f = fixture('WEAVER_EXECUTOR=pi\n');
  const codexHome = String(f.env.CODEX_HOME);
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'auth.json'), '{"personal":"device-login"}\n', { mode: 0o600 });

  const result = spawnSync('bash', [script, 'push-env'], {
    env: f.env,
    encoding: 'utf8',
  }) as SpawnSyncReturns<string>;

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(f.root, 'calls', 'count'), 'utf8').trim(), '3');
  assert.ok(!allCallArgs(f.root).includes('.codex'));
  assert.ok(!Array.from({ length: 3 }, (_, index) => call(f.root, index + 1, 'stdin')).join('\n').includes('device-login'));
  assert.ok(!`${result.stdout}${result.stderr}`.includes('auth.json'));
});

test('push-worker-secrets sends the exact selected global set only over SSH stdin', () => {
  const rendered = [
    'READONLY_DB_URL=postgres://reader:database-secret@db/app',
    'SENTRY_AUTH_TOKEN=monitoring-secret',
    '',
  ].join('\n');
  const { result, root } = run(
    ['push-worker-secrets', 'SENTRY_AUTH_TOKEN', 'READONLY_DB_URL'],
    undefined,
    rendered,
    true,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(call(root, 1, 'stdin'), fs.readFileSync(installer, 'utf8'));
  assert.match(call(root, 1, 'args'), /\/tmp\/weaver-install-env\.local/);
  assert.equal(call(root, 2, 'stdin'), rendered);
  assert.match(call(root, 2, 'args'), /weaver-install-env worker-secrets/);
  assert.ok(!allCallArgs(root).includes('database-secret'));
  assert.ok(!allCallArgs(root).includes('monitoring-secret'));
  assert.ok(!`${result.stdout}${result.stderr}`.includes('database-secret'));
  assert.ok(!`${result.stdout}${result.stderr}`.includes('monitoring-secret'));
  assert.ok(!allCallArgs(root).includes('systemctl'));
  assert.equal(fs.readFileSync(path.join(root, 'calls', 'count'), 'utf8').trim(), '2');
  assert.match(fs.readFileSync(path.join(root, 'remote-installer'), 'utf8'), /^  worker-secrets\)/m);
  assert.match(result.stdout, /2 selected worker secret\(s\) installed exactly/);
  assert.match(result.stdout, /services were not restarted/);
});

test('push-worker-secrets rejects an empty, malformed, or duplicate selection before GCP', () => {
  for (const [args, error] of [
    [[], /usage: weaver-gcp push-worker-secrets NAME/],
    [['lower_case'], /invalid worker secret name/],
    [['TOKEN', 'TOKEN'], /duplicate worker secret name/],
  ] as const) {
    const { result, root } = run(['push-worker-secrets', ...args], undefined, 'TOKEN=value\n');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, error);
    assert.equal(fs.existsSync(path.join(root, 'calls', 'count')), false);
  }
});

test('restart remains an explicit push-env and update option', () => {
  const pushed = run(['push-env', '--restart'], undefined, 'WEAVER_EXECUTOR=pi\n');
  assert.equal(pushed.result.status, 0, pushed.result.stderr);
  assert.match(call(pushed.root, 4, 'args'), /systemctl restart weaver-run weaver-serve/);

  const updated = run(['update'], undefined);
  assert.equal(updated.result.status, 0, updated.result.stderr);
  assert.equal(fs.readFileSync(path.join(updated.root, 'calls', 'count'), 'utf8').trim(), '1');
  assert.ok(!call(updated.root, 1, 'args').includes('systemctl restart'));
  assert.match(updated.result.stdout, /services were not restarted/);

  const updatedAndRestarted = run(['update', '--restart'], undefined);
  assert.equal(updatedAndRestarted.result.status, 0, updatedAndRestarted.result.stderr);
  assert.match(call(updatedAndRestarted.root, 2, 'args'), /systemctl restart weaver-run weaver-serve/);
});

test('GCP start runs the containment preflight before systemctl', () => {
  const { result, root } = run(['start'], undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(call(root, 1, 'stdin'), fs.readFileSync(gcpPreflight, 'utf8'));
  assert.match(call(root, 1, 'stdin'), /WEAVER_GCP_PREFLIGHT_WEAVER_BIN:-\/usr\/local\/bin\/weaver/);
  assert.match(call(root, 1, 'stdin'), /sudo -u "\$service_user" "\$weaver_binary" pilot-auth-check/);
  assert.match(call(root, 1, 'stdin'), /ss -H -ltnp 'sport = :9721'/);
  assert.doesNotMatch(call(root, 1, 'stdin'), /sudo ss/);
  assert.match(call(root, 1, 'stdin'), /"\$weaver_binary" github-auth-check/);
  assert.match(call(root, 1, 'args'), /weaver-gcp-preflight/);
  assert.match(call(root, 1, 'args'), /install -o root -g root -m 755/);
  assert.match(call(root, 1, 'args'), /systemctl enable --now weaver-run/);
  assert.equal(fs.existsSync(path.join(root, 'calls', '1.systemctl-executed')), true);
  assert.equal(fs.existsSync(path.join(root, 'calls', 'pilot-client-probe')), true);
  assert.equal(fs.existsSync(path.join(root, 'calls', 'github-client-probe')), true);
  assert.match(result.stdout, /GitHub machine identity authenticated/);
});

test('GCP start refuses host-process normal workers before systemctl', () => {
  const unsafe = SAFE_GCP_EXECUTION_ENV.replace('WEAVER_EXECUTOR=openhands', 'WEAVER_EXECUTOR=pi');
  const { result, root } = run(['start'], undefined, '', false, unsafe);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /WEAVER_EXECUTOR must be openhands/);
  assert.equal(fs.existsSync(path.join(root, 'calls', '1.systemctl-executed')), false);
});

test('GCP start refuses a non-local OpenHands bridge address before systemctl', () => {
  const unsafe = SAFE_GCP_EXECUTION_ENV.replace(
    'WEAVER_OPENHANDS_HOST_GATEWAY_IP=10.170.0.2',
    'WEAVER_OPENHANDS_HOST_GATEWAY_IP=10.170.0.99',
  );
  const { result, root } = run(['start'], undefined, '', false, unsafe);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must be owned by this execution host/);
  assert.equal(fs.existsSync(path.join(root, 'calls', '1.systemctl-executed')), false);
});

test('GCP restart refuses a host-process worker fallback before systemctl', () => {
  const unsafe = SAFE_GCP_EXECUTION_ENV.replace(
    'WEAVER_WORKER_FALLBACKS=',
    'WEAVER_WORKER_FALLBACKS=codex-sdk:gpt-5.6-sol',
  );
  const { result, root } = run(['restart'], undefined, '', false, unsafe);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /every WEAVER_WORKER_FALLBACKS target must use openhands/);
  assert.equal(fs.existsSync(path.join(root, 'calls', '1.systemctl-executed')), false);
});

test('GCP start refuses an OpenRouter primary or device-login coordinator', () => {
  const routedPrimary = SAFE_GCP_EXECUTION_ENV.replace(
    'WEAVER_COORDINATOR_MODEL=claude-fable-5',
    'WEAVER_COORDINATOR_MODEL=openrouter/~anthropic/claude-opus-5',
  );
  const first = run(['start'], undefined, '', false, routedPrimary);
  assert.notEqual(first.result.status, 0);
  assert.match(first.result.stderr, /registered Claude Code setup-token; OpenRouter coordination is forbidden/);
  assert.equal(fs.existsSync(path.join(first.root, 'calls', '1.systemctl-executed')), false);

  const deviceLogin = SAFE_GCP_EXECUTION_ENV.replace(
    'WEAVER_COORDINATOR_EXECUTOR=local-sdk',
    'WEAVER_COORDINATOR_EXECUTOR=codex-sdk',
  );
  const second = run(['start'], undefined, '', false, deviceLogin);
  assert.notEqual(second.result.status, 0);
  assert.match(second.result.stderr, /must be local-sdk on this host/);
  assert.equal(fs.existsSync(path.join(second.root, 'calls', '1.systemctl-executed')), false);
});

test('GCP start permits a non-Claude OpenRouter fallback and refuses Claude API billing there', () => {
  const chain = SAFE_GCP_EXECUTION_ENV.replace(
    'WEAVER_COORDINATOR_FALLBACKS=local-sdk:openrouter/z-ai/glm-5.3',
    'WEAVER_COORDINATOR_FALLBACKS=local-sdk:openrouter/~anthropic/claude-haiku-4.5',
  );
  const first = run(['start'], undefined, '', false, chain);
  assert.notEqual(first.result.status, 0);
  assert.match(first.result.stderr, /Claude coordinator fallbacks must use the registered setup-token, never OpenRouter/);
  assert.equal(fs.existsSync(path.join(first.root, 'calls', '1.systemctl-executed')), false);

  const legacy = SAFE_GCP_EXECUTION_ENV.replace(
    'WEAVER_COORDINATOR_FALLBACKS=local-sdk:openrouter/z-ai/glm-5.3\n',
    'WEAVER_COORDINATOR_FALLBACK_MODEL=openrouter/~anthropic/claude-haiku-4.5\n',
  );
  const second = run(['start'], undefined, '', false, legacy);
  assert.notEqual(second.result.status, 0);
  assert.match(second.result.stderr, /Claude coordinator fallback must use the registered setup-token, never OpenRouter/);
  assert.equal(fs.existsSync(path.join(second.root, 'calls', '1.systemctl-executed')), false);
});

test('GCP start refuses moving OpenRouter coordinator aliases and ambient provider identity', () => {
  const moving = SAFE_GCP_EXECUTION_ENV.replace(
    'local-sdk:openrouter/z-ai/glm-5.3',
    'local-sdk:openrouter/auto',
  );
  const first = run(['start'], undefined, '', false, moving);
  assert.notEqual(first.result.status, 0);
  assert.match(first.result.stderr, /must use the reviewed fixed model openrouter\/z-ai\/glm-5\.3/);

  const ambient = `${SAFE_GCP_EXECUTION_ENV}OPENROUTER_API_KEY=ambient-provider-key\n`;
  const second = run(['start'], undefined, '', false, ambient);
  assert.notEqual(second.result.status, 0);
  assert.match(second.result.stderr, /belongs only in the executor secret store/);
});

test('GCP start requires a setup-token identity and refuses Anthropic API billing', () => {
  const missing = fixture();
  const secretsPath = String(missing.env.WEAVER_GCP_TEST_EXECUTOR_SECRETS);
  fs.writeFileSync(
    secretsPath,
    fs.readFileSync(secretsPath, 'utf8').replace('CLAUDE_CODE_OAUTH_TOKEN=test-setup-token\n', ''),
  );
  const first = startExistingFixture(missing);
  assert.notEqual(first.status, 0);
  assert.match(first.stderr, /requires exactly one CLAUDE_CODE_OAUTH_TOKEN/);

  const api = fixture();
  const apiPath = String(api.env.WEAVER_GCP_TEST_EXECUTOR_SECRETS);
  fs.appendFileSync(apiPath, 'ANTHROPIC_API_KEY=forbidden-api-key\n');
  const second = startExistingFixture(api);
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /ANTHROPIC_API_KEY is forbidden on this host/);

  const tokenList = fixture();
  const tokenListPath = String(tokenList.env.WEAVER_GCP_TEST_EXECUTOR_SECRETS);
  fs.writeFileSync(
    tokenListPath,
    fs.readFileSync(tokenListPath, 'utf8').replace(
      'CLAUDE_CODE_OAUTH_TOKEN=test-setup-token',
      'CLAUDE_CODE_OAUTH_TOKEN=first-setup-token,second-setup-token',
    ),
  );
  const third = startExistingFixture(tokenList);
  assert.notEqual(third.status, 0);
  assert.match(third.stderr, /requires one setup-token, not a comma-separated token list/);
});

test('GCP start refuses Claude credentials in the ambient service env', () => {
  const withToken = SAFE_GCP_EXECUTION_ENV + 'CLAUDE_CODE_OAUTH_TOKEN=ambient-token\n';
  const first = run(['start'], undefined, '', false, withToken);
  assert.notEqual(first.result.status, 0);
  assert.match(first.result.stderr, /CLAUDE_CODE_OAUTH_TOKEN belongs only in the executor secret store/);

  const withApiKey = SAFE_GCP_EXECUTION_ENV + 'ANTHROPIC_API_KEY=ambient-key\n';
  const second = run(['start'], undefined, '', false, withApiKey);
  assert.notEqual(second.result.status, 0);
  assert.match(second.result.stderr, /ANTHROPIC_API_KEY is forbidden in the ambient host env/);
});

test('GCP start refuses copied Claude device credentials even with a setup-token', () => {
  const f = fixture();
  const serviceHome = String(f.env.WEAVER_GCP_TEST_SERVICE_HOME);
  fs.mkdirSync(path.join(serviceHome, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(serviceHome, '.claude', '.credentials.json'), '{"copied":true}\n');
  const result = startExistingFixture(f);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /personal Claude device authentication is forbidden/);
});

test('GCP start refuses a failing installed shared-client probe before systemctl', () => {
  const { result, root } = run(
    ['start'],
    undefined,
    '',
    false,
    SAFE_GCP_EXECUTION_ENV,
    true,
    true,
    false,
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /installed Weaver Pilot authentication probe failed/);
  assert.equal(fs.existsSync(path.join(root, 'calls', 'pilot-client-probe')), true);
  assert.equal(fs.existsSync(path.join(root, 'calls', '1.systemctl-executed')), false);
});

test('GCP start rejects a container-reachable Pilot listener before the client probe', () => {
  const { result, root } = run(['start'], undefined, '', false, SAFE_GCP_EXECUTION_ENV, true, false);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /exactly one TCP listener at 127\.0\.0\.1:9721/);
  assert.equal(fs.existsSync(path.join(root, 'calls', 'pilot-client-probe')), false);
  assert.equal(fs.existsSync(path.join(root, 'calls', '1.systemctl-executed')), false);
});

test('GCP start refuses a missing Pilot bearer before the client probe', () => {
  const { result, root } = run(
    ['start'],
    undefined,
    '',
    false,
    SAFE_GCP_EXECUTION_ENV,
    true,
    true,
    true,
    false,
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must contain exactly one WEAVER_PILOT_TOKEN/);
  assert.equal(fs.existsSync(path.join(root, 'calls', 'pilot-client-probe')), false);
  assert.equal(fs.existsSync(path.join(root, 'calls', '1.systemctl-executed')), false);
});

test('GCP start refuses a missing hosted OpenRouter worker identity', () => {
  const f = fixture();
  const secretsFile = path.join(f.root, 'executor-secrets.env');
  fs.writeFileSync(
    secretsFile,
    fs.readFileSync(secretsFile, 'utf8').replace(/^OPENROUTER_API_KEY=.*\n/m, ''),
    { mode: 0o600 },
  );
  const result = startExistingFixture(f);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must contain exactly one OPENROUTER_API_KEY/);
  assert.equal(fs.existsSync(path.join(f.root, 'calls', '1.systemctl-executed')), false);
});

test('GCP start refuses Pilot with authentication disabled before the client probe', () => {
  const { result, root } = run(
    ['start'],
    undefined,
    '',
    false,
    SAFE_GCP_EXECUTION_ENV,
    true,
    true,
    true,
    true,
    false,
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /did not reject an invalid bearer/);
  assert.equal(fs.existsSync(path.join(root, 'calls', 'pilot-client-probe')), false);
  assert.equal(fs.existsSync(path.join(root, 'calls', '1.systemctl-executed')), false);
});

test('GCP start refuses missing GitHub App credentials before systemctl', () => {
  const { result, root } = run(
    ['start'], undefined, '', false, SAFE_GCP_EXECUTION_ENV,
    true, true, true, true, true, true, false,
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /exactly one WEAVER_GITHUB_APP_ID/);
  assert.equal(fs.existsSync(path.join(root, 'calls', 'github-client-probe')), false);
  assert.equal(fs.existsSync(path.join(root, 'calls', '1.systemctl-executed')), false);
});

test('GCP start refuses personal GitHub CLI authentication before systemctl', () => {
  const { result, root } = run(
    ['start'], undefined, '', false, SAFE_GCP_EXECUTION_ENV,
    true, true, true, true, true, true, true, true,
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /personal GitHub CLI authentication is forbidden/);
  assert.equal(fs.existsSync(path.join(root, 'calls', 'github-client-probe')), false);
  assert.equal(fs.existsSync(path.join(root, 'calls', '1.systemctl-executed')), false);
});

test('GCP start refuses a persisted Codex device login before systemctl', () => {
  const f = fixture();
  const codex = path.join(f.root, 'service-home', '.codex');
  fs.mkdirSync(codex);
  fs.writeFileSync(path.join(codex, 'auth.json'), '{"tokens":"personal"}\n');
  const result = startExistingFixture(f);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /personal Codex device authentication is forbidden/);
  assert.equal(fs.existsSync(path.join(f.root, 'calls', '1.systemctl-executed')), false);
});

test('GCP start refuses static GitHub tokens before systemctl', () => {
  const { result, root } = run(
    ['start'], undefined, '', false, SAFE_GCP_EXECUTION_ENV,
    true, true, true, true, true, true, true, false, true,
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /static GitHub tokens are forbidden/);
  assert.equal(fs.existsSync(path.join(root, 'calls', 'github-client-probe')), false);
  assert.equal(fs.existsSync(path.join(root, 'calls', '1.systemctl-executed')), false);
});

test('GCP start refuses a failing GitHub App shared-client probe before systemctl', () => {
  const { result, root } = run(
    ['start'], undefined, '', false, SAFE_GCP_EXECUTION_ENV,
    true, true, true, true, true, false,
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /installed Weaver GitHub App authentication probe failed/);
  assert.equal(fs.existsSync(path.join(root, 'calls', 'github-client-probe')), true);
  assert.equal(fs.existsSync(path.join(root, 'calls', '1.systemctl-executed')), false);
});

test('GCP start refuses an SSH private key before GitHub authentication', () => {
  const f = fixture();
  const ssh = path.join(f.root, 'service-home', '.ssh');
  fs.mkdirSync(ssh);
  fs.writeFileSync(path.join(ssh, 'id_ed25519'), '-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n');
  const result = startExistingFixture(f);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /personal SSH private keys are forbidden/);
  assert.equal(fs.existsSync(path.join(f.root, 'calls', 'github-client-probe')), false);
});

test('GCP start refuses a persistent Git credential helper before GitHub authentication', () => {
  const f = fixture();
  f.env.WEAVER_GCP_TEST_GIT_HELPER = '1';
  const result = startExistingFixture(f);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /persistent Git credential helpers are forbidden/);
  assert.equal(fs.existsSync(path.join(f.root, 'calls', 'github-client-probe')), false);
});

test('GCP start refuses a credential-bearing workspace remote', () => {
  const f = fixture();
  const gitDir = path.join(f.root, 'service-home', 'workspaces', 'repo', '.git');
  fs.mkdirSync(gitDir, { recursive: true });
  fs.writeFileSync(path.join(gitDir, 'config'), '[remote "origin"]\n\turl = https://x-access-token:secret@github.com/octo/repo.git\n');
  const result = startExistingFixture(f);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /workspace remotes must not persist GitHub or SSH credentials/);
  assert.equal(fs.existsSync(path.join(f.root, 'calls', 'github-client-probe')), false);
});

test('GCP start refuses a hosted GitHub MCP configuration', () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.root, 'service-home', '.mcp.json'), '{"servers":{"github":{"env":{"GITHUB_TOKEN":"static"}}}}\n');
  const result = startExistingFixture(f);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /hosted GitHub MCP credentials are forbidden/);
  assert.equal(fs.existsSync(path.join(f.root, 'calls', 'github-client-probe')), false);
});

test('GCP start requires every configured coordinator capability without treating it as work', () => {
  const unsafe = SAFE_GCP_EXECUTION_ENV.replace(
    'WEAVER_RUNNER_EXECUTORS=openhands,local-sdk',
    'WEAVER_RUNNER_EXECUTORS=openhands',
  );
  const { result, root } = run(['start'], undefined, '', false, unsafe);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing a configured coordinator capability/);
  assert.equal(fs.existsSync(path.join(root, 'calls', '1.systemctl-executed')), false);
});

test('GCP start refuses when rootless Docker is unavailable to the service user', () => {
  const { result, root } = run(['start'], undefined, '', false, SAFE_GCP_EXECUTION_ENV, false);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /rootless Docker is not accessible/);
  assert.equal(fs.existsSync(path.join(root, 'calls', '1.systemctl-executed')), false);
});

test('external-store provisioning selects execution-only mode and never starts services', () => {
  const { result, root } = run(['create', '--external-store'], undefined);
  assert.equal(result.status, 0, result.stderr);
  const count = Number(fs.readFileSync(path.join(root, 'calls', 'count'), 'utf8'));
  const provisionArgs = call(root, count, 'args');
  assert.match(allCallArgs(root), /compute\ninstances\nstart\ntest-runner/);
  assert.match(provisionArgs, /WEAVER_GCP_STORE_MODE=external/);
  assert.match(provisionArgs, /WEAVER_GCP_CONCURRENCY=4/);
  assert.match(call(root, count, 'stdin'), /systemctl disable --now weaver-run weaver-serve/);
  assert.match(call(root, count, 'stdin'), /run --interval 5 --concurrency \$WEAVER_GCP_CONCURRENCY/);
  assert.match(call(root, count, 'stdin'), /WEAVER_RUNNER_ID=.*hostname/);
  assert.match(call(root, count, 'stdin'), /dockerd-rootless-setuptool\.sh install --force/);
  assert.match(call(root, count, 'stdin'), /DOCKER_HOST=unix:\/\/\/run\/user\/\$weaver_uid\/docker\.sock/);
  assert.match(call(root, count, 'stdin'), /WEAVER_OPENHANDS_HOST_GATEWAY_IP=\$openhands_host_gateway/);
  assert.match(call(root, count, 'stdin'), /ExecStartPre=\+\/usr\/local\/sbin\/weaver-gcp-preflight/);
  assert.match(call(root, count, 'stdin'), /install -o root -g root -m 755 \/opt\/weaver\/bin\/weaver-gcp-preflight\.sh/);
  assert.doesNotMatch(call(root, count, 'stdin'), /usermod -aG docker/);
  assert.doesNotMatch(call(root, count, 'stdin'), /SupplementaryGroups=docker/);
  assert.ok(!provisionArgs.includes('systemctl start'));
  assert.ok(!provisionArgs.includes('systemctl restart'));
  assert.match(result.stdout, /provisioned without starting/);
});
