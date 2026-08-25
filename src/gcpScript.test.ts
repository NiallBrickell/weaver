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
  'WEAVER_WORKER_MODEL=openrouter/moonshotai/kimi-k3',
  'WEAVER_WORKER_FALLBACKS=openhands:openrouter/moonshotai/kimi-k3',
  'WEAVER_COORDINATOR_EXECUTOR=codex-sdk',
  'WEAVER_COORDINATOR_FALLBACKS=codex-sdk:gpt-5.6-sol',
  'WEAVER_ACTION_EXECUTOR=local-sdk',
  'WEAVER_RUNNER_EXECUTORS=openhands,codex-sdk',
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
): { root: string; env: NodeJS.ProcessEnv } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-gcp-script-'));
  roots.push(root);
  const bin = path.join(root, 'bin');
  const calls = path.join(root, 'calls');
  const codex = path.join(root, 'codex-none');
  fs.mkdirSync(bin);
  fs.mkdirSync(calls);
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
  WEAVER_GCP_PREFLIGHT_EXECUTOR_SECRETS_FILE="$WEAVER_GCP_TEST_EXECUTOR_SECRETS" \
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
    path.join(bin, 'docker'),
    `#!/bin/bash
set -euo pipefail
[ "\${WEAVER_GCP_TEST_DOCKER_OK:-0}" = 1 ]
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
if [ "$header" = 'Authorization: Bearer weaver-preflight-deliberately-invalid' ]; then
  printf '%s' 401
elif [ "\${header#@}" != "$header" ] && grep -q "Authorization: Bearer $WEAVER_GCP_TEST_PILOT_TOKEN" "\${header#@}"; then
  printf '%s' 204
else
  printf '%s' 401
fi
`,
    { mode: 0o755 },
  );
  const preflightEnvFile = path.join(root, 'remote-host-env');
  fs.writeFileSync(preflightEnvFile, preflightEnv);
  const executorSecretsFile = path.join(root, 'executor-secrets.env');
  fs.writeFileSync(executorSecretsFile, 'WEAVER_PILOT_TOKEN=test-pilot-token\n', { mode: 0o600 });
  const remoteInstaller = path.join(root, 'remote-installer');
  if (staleRemoteInstaller) {
    fs.writeFileSync(remoteInstaller, '#!/bin/bash\ncase "$1" in merge|store) exit 0;; esac\n');
  }
  fs.writeFileSync(
    path.join(bin, 'node'),
    `#!/bin/bash
set -euo pipefail
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
      WEAVER_GCP_TEST_DOCKER_OK: dockerOk ? '1' : '0',
      WEAVER_GCP_TEST_PILOT_LISTENER_OK: pilotListenerOk ? '1' : '0',
      WEAVER_GCP_TEST_PILOT_TOKEN: 'test-pilot-token',
      WEAVER_GCP_TEST_EXECUTOR_SECRETS: executorSecretsFile,
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
): { result: SpawnSyncReturns<string>; root: string } {
  const f = fixture(remoteEnv, staleRemoteInstaller, preflightEnv, dockerOk, pilotListenerOk);
  const result = spawnSync('bash', [script, ...args], {
    env: f.env,
    ...(input === undefined ? {} : { input }),
    encoding: 'utf8',
  }) as SpawnSyncReturns<string>;
  return { result, root: f.root };
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
  mode: 'merge' | 'store' | 'executor-secrets',
  input: string,
  executorSecretsFile?: string,
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
  assert.equal(call(root, 2, 'stdin'), rendered);
  assert.match(call(root, 2, 'args'), /weaver-install-env merge/);
  assert.equal(call(root, 3, 'stdin'), rendered);
  assert.match(call(root, 3, 'args'), /weaver-install-env executor-secrets/);
  assert.ok(!allCallArgs(root).includes('systemctl'));
  assert.equal(fs.readFileSync(path.join(root, 'calls', 'count'), 'utf8').trim(), '3');
  assert.match(fs.readFileSync(path.join(root, 'remote-installer'), 'utf8'), /^  executor-secrets\)/m);
  assert.match(result.stdout, /services were not restarted/);
  assert.ok(!`${result.stdout}${result.stderr}`.includes('Primary application'));
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
  assert.match(call(root, 1, 'args'), /weaver-gcp-preflight/);
  assert.match(call(root, 1, 'args'), /install -o root -g root -m 755/);
  assert.match(call(root, 1, 'args'), /systemctl enable --now weaver-run/);
  assert.equal(fs.existsSync(path.join(root, 'calls', '1.systemctl-executed')), true);
  assert.match(result.stdout, /ordinary workers containerized; action lane not claimed/);
});

test('GCP start refuses host-process normal workers before systemctl', () => {
  const unsafe = SAFE_GCP_EXECUTION_ENV.replace('WEAVER_EXECUTOR=openhands', 'WEAVER_EXECUTOR=pi');
  const { result, root } = run(['start'], undefined, '', false, unsafe);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /WEAVER_EXECUTOR must be openhands/);
  assert.equal(fs.existsSync(path.join(root, 'calls', '1.systemctl-executed')), false);
});

test('GCP restart refuses a host-process worker fallback before systemctl', () => {
  const unsafe = SAFE_GCP_EXECUTION_ENV.replace(
    'WEAVER_WORKER_FALLBACKS=openhands:openrouter/moonshotai/kimi-k3',
    'WEAVER_WORKER_FALLBACKS=codex-sdk:gpt-5.6-sol',
  );
  const { result, root } = run(['restart'], undefined, '', false, unsafe);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /every WEAVER_WORKER_FALLBACKS target must use openhands/);
  assert.equal(fs.existsSync(path.join(root, 'calls', '1.systemctl-executed')), false);
});

test('GCP start validates secure Pilot but keeps local actions disabled until bearer clients exist', () => {
  const unsafe = SAFE_GCP_EXECUTION_ENV.replace(
    'WEAVER_RUNNER_EXECUTORS=openhands,codex-sdk',
    'WEAVER_RUNNER_EXECUTORS=openhands,codex-sdk,local-sdk',
  );
  const { result, root } = run(['start'], undefined, '', false, unsafe);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /local-sdk action capability remains disabled until Weaver Pilot bearer clients are installed/);
  assert.equal(fs.existsSync(path.join(root, 'calls', '1.systemctl-executed')), false);
});

test('GCP start rejects a container-reachable Pilot listener before its bearer-client hold', () => {
  const unsafe = SAFE_GCP_EXECUTION_ENV.replace(
    'WEAVER_RUNNER_EXECUTORS=openhands,codex-sdk',
    'WEAVER_RUNNER_EXECUTORS=openhands,codex-sdk,local-sdk',
  );
  const { result, root } = run(['start'], undefined, '', false, unsafe, true, false);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /exactly one TCP listener at 127\.0\.0\.1:9721/);
  assert.equal(fs.existsSync(path.join(root, 'calls', '1.systemctl-executed')), false);
});

test('GCP start requires every configured coordinator capability without treating it as work', () => {
  const unsafe = SAFE_GCP_EXECUTION_ENV.replace(
    'WEAVER_RUNNER_EXECUTORS=openhands,codex-sdk',
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
  assert.match(call(root, count, 'stdin'), /dockerd-rootless-setuptool\.sh install --force/);
  assert.match(call(root, count, 'stdin'), /DOCKER_HOST=unix:\/\/\/run\/user\/\$weaver_uid\/docker\.sock/);
  assert.match(call(root, count, 'stdin'), /ExecStartPre=\/usr\/local\/sbin\/weaver-gcp-preflight/);
  assert.match(call(root, count, 'stdin'), /install -o root -g root -m 755 \/opt\/weaver\/bin\/weaver-gcp-preflight\.sh/);
  assert.doesNotMatch(call(root, count, 'stdin'), /usermod -aG docker/);
  assert.doesNotMatch(call(root, count, 'stdin'), /SupplementaryGroups=docker/);
  assert.ok(!provisionArgs.includes('systemctl start'));
  assert.ok(!provisionArgs.includes('systemctl restart'));
  assert.match(result.stdout, /provisioned without starting/);
});
