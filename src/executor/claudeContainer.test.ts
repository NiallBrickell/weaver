/**
 * The containerized Claude worker is a credential boundary: these tests pin
 * exactly what crosses it (the SDK binary read-only, the workspace, the
 * declared secrets by name, the Claude identity) and what never can (the
 * runner's ambient environment, the executor secret store, an action).
 */

import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import {
  CLAUDE_CONTAINER_LABEL,
  claudeContainerFromEnv,
  containerSpawner,
  planContainerRun,
  type ClaudeContainerConfig,
} from './claudeContainer.js';
import { OPENHANDS_AGENT_SERVER_IMAGE } from './openHands.js';
import { LocalSdkExecutor } from './localSdk.js';
import type { WorkerExecutionRequest } from './types.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const config: ClaudeContainerConfig = { image: 'example.test/worker:1', dockerCommand: 'docker', hostGatewayIp: '10.170.0.2' };

function spawnOptions(overrides: Partial<SpawnOptions> = {}): SpawnOptions {
  return {
    command: '/opt/weaver/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude',
    args: ['--output-format', 'stream-json', '--model', 'claude-opus-5'],
    cwd: '/home/weaver/workspaces/ws/work',
    env: {
      CLAUDE_CODE_OAUTH_TOKEN: 'setup-token-value',
      CLAUDE_CODE_ENTRYPOINT: 'sdk-ts',
      CLAUDE_AGENT_SDK_VERSION: '0.9.9',
      CLAUDE_CONFIG_DIR: '/home/weaver/.claude',
      WEAVER_STORE: 'postgres://weaver:secret@db/weaver',
      OPENROUTER_API_KEY: 'or-key',
      WEAVER_GITHUB_APP_PRIVATE_KEY_BASE64: 'app-key',
      DOCKER_HOST: 'unix:///run/user/1001/docker.sock',
      PATH: '/usr/bin',
    },
    signal: new AbortController().signal,
    ...overrides,
  };
}

test('the plan mounts only the SDK binary, the workspace and declared read dirs, at their host paths', () => {
  const plan = planContainerRun(spawnOptions(), {
    assignmentId: 'asg_Abc/123',
    cwd: '/home/weaver/workspaces/ws/work',
    additionalDirectories: ['/home/weaver/workspaces/ws/work/nested', '/srv/application', '/srv/application'],
    workerVisibleEnv: {},
  }, config);
  assert.equal(plan.command, 'docker');
  const volumes = plan.args.filter((_, i) => plan.args[i - 1] === '--volume');
  assert.deepEqual(volumes, [
    '/opt/weaver/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64:/opt/weaver/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64:ro',
    '/home/weaver/workspaces/ws/work:/home/weaver/workspaces/ws/work',
    '/srv/application:/srv/application:ro',
  ]);
  assert.ok(plan.args.includes('--workdir') && plan.args[plan.args.indexOf('--workdir') + 1] === '/home/weaver/workspaces/ws/work');
  assert.ok(plan.args.includes('--rm') && plan.args.includes('--interactive'));
  assert.deepEqual(plan.args.slice(plan.args.indexOf('--user'), plan.args.indexOf('--user') + 2), ['--user', '0']);
  // No limit configured: the container still runs under the default ceiling.
  assert.deepEqual(plan.args.slice(plan.args.indexOf('--memory'), plan.args.indexOf('--memory') + 4), [
    '--memory', '4g', '--memory-swap', '4g',
  ]);
  assert.ok(plan.args.includes(`host.docker.internal:10.170.0.2`));
  assert.ok(plan.args.includes(CLAUDE_CONTAINER_LABEL));
  assert.match(plan.containerName, /^weaver-claude-asg_abc-123-[0-9a-f]{12}$/);
  // The binary at its host path replaces the image's own entrypoint, and the
  // SDK's own args follow the image untouched.
  const image = plan.args.indexOf('example.test/worker:1');
  assert.deepEqual(plan.args.slice(image - 2, image), [
    '--entrypoint', '/opt/weaver/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude',
  ]);
  assert.deepEqual(plan.args.slice(image + 1), ['--output-format', 'stream-json', '--model', 'claude-opus-5']);
});

test('only the Claude identity, SDK protocol names and declared secrets cross, by name, never a value in argv', () => {
  const plan = planContainerRun(spawnOptions(), {
    assignmentId: 'asg_1',
    cwd: '/w',
    additionalDirectories: [],
    workerVisibleEnv: { SENTRY_AUTH_TOKEN: 'sntrys', READONLY_DB_URL: 'postgres://ro:pw@127.0.0.1:55432/erdo' },
  }, config);
  const forwarded = plan.args.filter((_, i) => plan.args[i - 1] === '--env');
  assert.deepEqual(forwarded, [
    'HOME=/root',
    'IS_SANDBOX=1',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_CODE_ENTRYPOINT',
    'CLAUDE_AGENT_SDK_VERSION',
    'SENTRY_AUTH_TOKEN',
    'READONLY_DB_URL',
  ]);
  // Values live in the docker CLI's environment, loopback rewritten to the host gateway alias.
  assert.equal(plan.env.CLAUDE_CODE_OAUTH_TOKEN, 'setup-token-value');
  assert.equal(plan.env.READONLY_DB_URL, 'postgres://ro:pw@host.docker.internal:55432/erdo');
  assert.equal(plan.env.SENTRY_AUTH_TOKEN, 'sntrys');
  for (const never of ['WEAVER_STORE', 'OPENROUTER_API_KEY', 'WEAVER_GITHUB_APP_PRIVATE_KEY_BASE64', 'CLAUDE_CONFIG_DIR']) {
    assert.equal(plan.env[never], undefined, `${never} must not reach the docker CLI environment`);
    assert.ok(!plan.args.includes(never), `${never} must not be forwarded`);
  }
  assert.ok(!plan.args.join(' ').includes('setup-token-value'), 'no secret value in argv');
  assert.ok(!plan.args.join(' ').includes('sntrys'), 'no secret value in argv');
});

test('a declared secret cannot impersonate the identity, and a non-native command or relative path is refused', () => {
  const run = { assignmentId: 'a', cwd: '/w', additionalDirectories: [], workerVisibleEnv: {} };
  assert.throws(
    () => planContainerRun(spawnOptions(), { ...run, workerVisibleEnv: { ANTHROPIC_API_KEY: 'x' } }, config),
    /collides with a reserved Claude\/Anthropic name/,
  );
  assert.throws(() => planContainerRun(spawnOptions({ command: 'node' }), run, config), /absolute Claude Code binary path/);
  assert.throws(() => planContainerRun(spawnOptions(), { ...run, cwd: 'relative' }, config), /cwd must be absolute/);
  assert.throws(() => planContainerRun(spawnOptions(), { ...run, additionalDirectories: ['rel'] }, config), /must be absolute/);
  assert.throws(
    () => planContainerRun(spawnOptions({ env: { 'BAD NAME': 'x' , CLAUDE_CODE_OAUTH_TOKEN: 't' } }), { ...run, workerVisibleEnv: { 'X\nY': 'v' } }, config),
    /invalid name/,
  );
});

test('container mode is an explicit host decision with the pinned worker image as default', () => {
  assert.equal(claudeContainerFromEnv({}), undefined);
  assert.equal(claudeContainerFromEnv({ WEAVER_LOCAL_SDK_CONTAINER: '0' }), undefined);
  assert.deepEqual(claudeContainerFromEnv({ WEAVER_LOCAL_SDK_CONTAINER: '1', WEAVER_OPENHANDS_HOST_GATEWAY_IP: '10.1.2.3' }), {
    image: OPENHANDS_AGENT_SERVER_IMAGE,
    dockerCommand: 'docker',
    hostGatewayIp: '10.1.2.3',
  });
  assert.equal(
    claudeContainerFromEnv({ WEAVER_LOCAL_SDK_CONTAINER: '1', WEAVER_LOCAL_SDK_CONTAINER_IMAGE: 'x/y:2' })!.image,
    'x/y:2',
  );
});

test('the memory ceiling follows WEAVER_WORKER_MEMORY_LIMIT, opts out only explicitly, and refuses garbage at plan time', () => {
  const run = { assignmentId: 'a', cwd: '/w', additionalDirectories: [], workerVisibleEnv: {} };
  const planWith = (limit: string | undefined) => {
    const hostConfig = claudeContainerFromEnv({
      WEAVER_LOCAL_SDK_CONTAINER: '1',
      ...(limit !== undefined ? { WEAVER_WORKER_MEMORY_LIMIT: limit } : {}),
    })!;
    return planContainerRun(spawnOptions(), run, hostConfig).args;
  };
  const memoryFlags = (args: string[]) => ({
    memory: args.filter((_, i) => args[i - 1] === '--memory'),
    swap: args.filter((_, i) => args[i - 1] === '--memory-swap'),
  });
  assert.deepEqual(memoryFlags(planWith(undefined)), { memory: ['4g'], swap: ['4g'] });
  assert.deepEqual(memoryFlags(planWith('3072m')), { memory: ['3072m'], swap: ['3072m'] });
  assert.deepEqual(memoryFlags(planWith('none')), { memory: [], swap: [] });
  // The ceiling rides flags before the image; nothing after the image is Docker's.
  const args = planWith('6g');
  assert.ok(args.indexOf('--memory') < args.indexOf(OPENHANDS_AGENT_SERVER_IMAGE));
  assert.throws(() => planWith('4 gigs'), /WEAVER_WORKER_MEMORY_LIMIT="4 gigs" is not a Docker memory size/);
  assert.throws(() => planWith('4096'), /needs at least 512m/);
});

test('the spawner runs the docker CLI with the plan, relays stdio, and reaps the container after exit', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-claude-container-'));
  roots.push(root);
  const fakeDocker = path.join(root, 'docker');
  const log = path.join(root, 'calls.log');
  fs.writeFileSync(
    fakeDocker,
    `#!/bin/bash
printf '%s\\n' "$*" >> "${log}"
if [ "$1" = run ]; then
  printf 'token=%s store=%s\\n' "\${CLAUDE_CODE_OAUTH_TOKEN:-unset}" "\${WEAVER_STORE:-unset}"
  read -r line; printf 'echo:%s\\n' "$line"
  exit 0
fi
exit 0
`,
    { mode: 0o755 },
  );
  const spawner = containerSpawner(
    { ...config, dockerCommand: fakeDocker },
    { assignmentId: 'asg_2', cwd: root, additionalDirectories: [], workerVisibleEnv: {} },
  );
  const child = spawner(spawnOptions({ cwd: root }));
  let out = '';
  child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString(); });
  child.stdin.write('hello\n');
  child.stdin.end();
  const exit = await new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  assert.equal(exit, 0);
  assert.equal(out, 'token=setup-token-value store=unset\necho:hello\n');
  // The reaper runs detached after exit; give it a moment to be recorded.
  for (let i = 0; i < 40 && !fs.readFileSync(log, 'utf8').includes('rm --force'); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const calls = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);
  assert.match(calls[0]!, /^run --rm --interactive --name weaver-claude-asg_2-/);
  assert.match(calls[1]!, /^rm --force weaver-claude-asg_2-/);
});

test('the local-sdk executor containerizes ordinary work only; a supervised action stays a host process', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const runQuery = (async function* (input: { options: Record<string, unknown> }) {
    seen.push(input.options);
    yield { type: 'result', subtype: 'success', session_id: 's', total_cost_usd: 0.1 };
  }) as never;
  const executor = new LocalSdkExecutor({ container: config, runQuery });
  const base: WorkerExecutionRequest = {
    workstreamSlug: 'ws',
    assignmentId: 'asg_3',
    prompt: 'p',
    systemPrompt: { type: 'preset', preset: 'claude_code', append: '' },
    model: 'claude-opus-5',
    tools: { type: 'preset', preset: 'claude_code' },
    allowedTools: ['mcp__weaver__*'],
    permissionMode: 'bypassPermissions',
    settingSources: ['user', 'project', 'local'],
    strictMcpConfig: false,
    maxTurns: 10,
    cwd: '/w',
    additionalDirectories: [],
    env: {},
    operatorMcpServers: {},
    submit: { appendSection: async () => ({ text: '' }), submitResult: async () => ({ text: '' }) },
    abort: new AbortController(),
  };
  await executor.execute(base);
  assert.equal(typeof seen[0]!.spawnClaudeCodeProcess, 'function', 'ordinary work gets the container spawner');

  await executor.execute({ ...base, permissionMode: 'default', supervise: async () => ({ behavior: 'deny', message: 'no' }) });
  assert.equal(seen[1]!.spawnClaudeCodeProcess, undefined, 'a Pilot-supervised action is never containerized');

  await assert.rejects(executor.execute({ ...base, cwd: undefined }), /needs a working directory to mount/);
  const hostOnly = new LocalSdkExecutor({ runQuery });
  await hostOnly.execute(base);
  assert.equal(seen[2]!.spawnClaudeCodeProcess, undefined, 'without container config the worker is a host process');
});

test('the plan refuses to mount Weaver state or a credential store, even through a symlink', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-claude-container-guard-')));
  roots.push(root);
  const previousHome = process.env.WEAVER_HOME;
  const state = path.join(root, 'state');
  const workspace = path.join(root, 'workspaces', 'erdo');
  fs.mkdirSync(state, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(state, 'executor-secrets.env'), 'WEAVER_GITHUB_APP_PRIVATE_KEY_BASE64=never-mounted\n');
  fs.symlinkSync(state, path.join(root, 'workspaces', 'looks-harmless'));
  process.env.WEAVER_HOME = state;
  try {
    const run = { assignmentId: 'asg_guard', cwd: workspace, additionalDirectories: [] as string[], workerVisibleEnv: {} };
    assert.throws(() => planContainerRun(spawnOptions(), { ...run, cwd: path.join(state, 'stream') }, config), /sits under Weaver's state directory/);
    assert.throws(() => planContainerRun(spawnOptions(), { ...run, cwd: root }, config), /contains Weaver's state directory/);
    assert.throws(
      () => planContainerRun(spawnOptions(), { ...run, additionalDirectories: [path.join(root, 'workspaces', 'looks-harmless')] }, config),
      /is Weaver's state directory.*resolves to/,
    );
    assert.throws(() => planContainerRun(spawnOptions(), { ...run, additionalDirectories: ['/etc/weaver'] }, config), /hosted runner's service configuration/);
    assert.throws(() => planContainerRun(spawnOptions(), { ...run, additionalDirectories: [path.join(os.homedir(), '.ssh')] }, config), /SSH keys/);
    const allowed = planContainerRun(spawnOptions(), run, config);
    assert.ok(allowed.args.includes(`${workspace}:${workspace}`));
  } finally {
    if (previousHome === undefined) delete process.env.WEAVER_HOME;
    else process.env.WEAVER_HOME = previousHome;
  }
});
