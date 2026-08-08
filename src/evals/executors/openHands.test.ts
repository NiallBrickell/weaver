import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { SubmitBridge } from '../../executor/submitBridge.js';
import type { WorkerExecutionRequest } from '../../executor/types.js';
import {
  OPENHANDS_AGENT_SERVER_IMAGE,
  OpenHandsEvalExecutor,
  type CommandRunner,
} from './openHands.js';

interface SeenFetch {
  url: string;
  init: RequestInit;
}

describe('OpenHands eval executor', () => {
  it('runs one fresh pinned Agent Server conversation and always tears it down', async () => {
    const commands: Array<{ command: string; args: string[] }> = [];
    const seenFetch: SeenFetch[] = [];
    let bridgeClosed = 0;
    let statusReads = 0;
    const runCommand: CommandRunner = async (command, args) => {
      commands.push({ command, args: [...args] });
      if (args[0] === 'port') {
        return { exitCode: 0, stdout: '127.0.0.1:49152\n', stderr: '' };
      }
      return { exitCode: 0, stdout: 'container-id\n', stderr: '' };
    };
    const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input);
      seenFetch.push({ url, init });
      if (url.endsWith('/health')) return response({ status: 'ok' });
      if (url.endsWith('/api/conversations') && init.method === 'POST') {
        return response({ id: 'conversation-1', execution_status: 'idle' });
      }
      if (url.endsWith('/run')) return response({ success: true });
      if (url.endsWith('/api/conversations/conversation-1')) {
        statusReads += 1;
        if (statusReads === 1) {
          return response({ id: 'conversation-1', execution_status: 'running' });
        }
        return response({
          id: 'conversation-1',
          execution_status: 'finished',
          stats: {
            usage_to_metrics: {
              agent: {
                accumulated_cost: 0.75,
                accumulated_token_usage: {
                  input_tokens: 120,
                  output_tokens: 45,
                  cache_read_tokens: 20,
                  reasoning_tokens: 5,
                },
              },
              condenser: {
                accumulated_cost: 0.25,
                accumulated_token_usage: { input_tokens: 30, output_tokens: 10 },
              },
            },
          },
        });
      }
      throw new Error(`unexpected fetch ${init.method ?? 'GET'} ${url}`);
    }) as typeof globalThis.fetch;
    const bridge: SubmitBridge = {
      url: 'http://host.docker.internal:41873/mcp',
      token: 'bridge-secret',
      async close() {
        bridgeClosed += 1;
      },
    };
    const executor = new OpenHandsEvalExecutor({
      apiKey: 'provider-secret',
      baseUrl: 'https://provider.example/v1',
      runCommand,
      fetch: fetchImpl,
      startSubmitBridge: async () => bridge,
      sleep: async () => undefined,
      now: increasingClock(),
    });

    const outcome = await executor.execute(request());

    assert.deepEqual(outcome, { costUsd: 1, sessionId: 'conversation-1' });
    assert.equal(bridgeClosed, 1);
    assert.equal(statusReads, 2);

    const dockerRun = commands.find(({ args }) => args[0] === 'run');
    assert.ok(dockerRun);
    assert.equal(dockerRun.command, 'docker');
    assert.ok(dockerRun.args.includes('--rm'));
    assert.ok(dockerRun.args.includes('--detach'));
    assert.ok(dockerRun.args.includes(OPENHANDS_AGENT_SERVER_IMAGE));
    assert.deepEqual(valuesAfter(dockerRun.args, '--volume'), ['/work/repo:/workspace']);
    assert.deepEqual(valuesAfter(dockerRun.args, '--add-host'), [
      'host.docker.internal:host-gateway',
    ]);
    assert.ok(valuesAfter(dockerRun.args, '--env').includes('OH_CONVERSATIONS_PATH=/tmp/weaver-conversations'));
    assert.ok(valuesAfter(dockerRun.args, '--env').includes('OH_BASH_EVENTS_DIR=/tmp/weaver-bash-events'));
    assert.ok(valuesAfter(dockerRun.args, '--env').includes('OH_WORKSPACE_PATH=/tmp/weaver-agent-server-workspace'));
    assert.equal(dockerRun.args.filter((arg) => arg.includes('provider-secret')).length, 0);

    const dockerStop = commands.find(({ args }) => args[0] === 'stop');
    assert.ok(dockerStop);
    assert.equal(dockerStop.args.at(-1), valueAfter(dockerRun.args, '--name'));

    const create = seenFetch.find(
      ({ url, init }) => url.endsWith('/api/conversations') && init.method === 'POST',
    );
    assert.ok(create);
    assert.equal(header(create.init, 'X-Session-API-Key').length, 64);
    const body = JSON.parse(String(create.init.body)) as Record<string, any>;
    assert.equal(body.agent.kind, 'Agent');
    assert.equal(body.agent.llm.model, 'anthropic/claude-sonnet-4-5-20250929');
    assert.equal(body.agent.llm.api_key, 'provider-secret');
    assert.equal(body.agent.llm.base_url, 'https://provider.example/v1');
    assert.deepEqual(body.agent.tools, [
      { name: 'TerminalTool' },
      { name: 'FileEditorTool' },
      { name: 'TaskTrackerTool' },
    ]);
    assert.deepEqual(body.agent.mcp_config, {
      weaver: {
        url: bridge.url,
        transport: 'streamable-http',
        auth: { strategy: 'bearer', value: bridge.token },
      },
    });
    assert.match(body.agent.agent_context.system_message_suffix, /mounted at \/workspace/);
    assert.equal(body.agent.agent_context.load_project_skills, false);
    assert.deepEqual(body.workspace, { type: 'local', working_dir: '/workspace' });
    assert.equal(body.initial_message.content[0].text, 'Complete the bounded assignment.');
    assert.equal(body.max_iterations, 12);

    for (const call of seenFetch.filter(({ url }) => !url.endsWith('/health'))) {
      assert.equal(header(call.init, 'X-Session-API-Key'), header(create.init, 'X-Session-API-Key'));
    }

    assert.deepEqual(executor.lastTelemetry(), {
      executor: 'openhands',
      modelRequested: 'anthropic/claude-sonnet-4-5-20250929',
      providerResolved: 'anthropic',
      modelResolved: 'anthropic/claude-sonnet-4-5-20250929',
      harnessVersion: 'openhands-agent-server-1.41.0',
      isolation: 'agent-server',
      startedAt: '1970-01-01T00:00:01.000Z',
      endedAt: '1970-01-01T00:00:01.004Z',
      durationMs: 4,
      startupMs: 3,
      timeToSubmissionMs: null,
      usage: {
        inputTokens: 150,
        outputTokens: 55,
        cachedInputTokens: 20,
        reasoningOutputTokens: 5,
      },
      costUsd: 1,
      sessionId: 'conversation-1',
      terminalReason: 'completed',
      error: null,
    });
  });

  it('rejects supervised action work before starting a bridge or process', async () => {
    let bridgeStarts = 0;
    let processStarts = 0;
    const executor = new OpenHandsEvalExecutor({
      apiKey: 'provider-secret',
      startSubmitBridge: async () => {
        bridgeStarts += 1;
        throw new Error('must not start');
      },
      runCommand: async () => {
        processStarts += 1;
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      now: () => 1_000,
    });
    const req = request();
    req.supervise = async (_toolName, input) => ({ behavior: 'allow', updatedInput: input });

    const outcome = await executor.execute(req);

    assert.equal(bridgeStarts, 0);
    assert.equal(processStarts, 0);
    assert.match(outcome.error ?? '', /does not support action-worker supervision/);
    assert.equal(executor.lastTelemetry()?.terminalReason, 'unsupported');
  });

  it('pauses an aborted conversation, then stops the container and closes the bridge', async () => {
    const commands: Array<{ command: string; args: string[] }> = [];
    const seenFetch: SeenFetch[] = [];
    let bridgeClosed = 0;
    const abort = new AbortController();
    const runCommand: CommandRunner = async (command, args) => {
      commands.push({ command, args: [...args] });
      return args[0] === 'port'
        ? { exitCode: 0, stdout: '127.0.0.1:49153\n', stderr: '' }
        : { exitCode: 0, stdout: '', stderr: '' };
    };
    const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input);
      seenFetch.push({ url, init });
      if (url.endsWith('/health')) return response({ status: 'ok' });
      if (url.endsWith('/api/conversations') && init.method === 'POST') {
        return response({ id: 'conversation-abort', execution_status: 'idle' });
      }
      if (url.endsWith('/run')) return response({ success: true });
      if (url.endsWith('/pause')) return response({ success: true });
      if (url.endsWith('/api/conversations/conversation-abort')) {
        abort.abort();
        const error = new Error('cancelled by harness wall');
        error.name = 'AbortError';
        throw error;
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof globalThis.fetch;
    const executor = new OpenHandsEvalExecutor({
      apiKey: 'provider-secret',
      runCommand,
      fetch: fetchImpl,
      startSubmitBridge: async () => ({
        url: 'http://host.docker.internal:41874/mcp',
        token: 'token',
        async close() {
          bridgeClosed += 1;
        },
      }),
      sleep: async () => undefined,
      now: () => 1_000,
    });
    const req = request();
    req.abort = abort;

    const outcome = await executor.execute(req);

    assert.equal(outcome.costUsd, 0);
    assert.equal(outcome.sessionId, 'conversation-abort');
    assert.match(outcome.error ?? '', /cancelled by harness wall/);
    assert.equal(executor.lastTelemetry()?.terminalReason, 'aborted');
    assert.ok(seenFetch.some(({ url }) => url.endsWith('/conversation-abort/pause')));
    assert.ok(commands.some(({ args }) => args[0] === 'stop'));
    assert.equal(bridgeClosed, 1);
  });

  it('best-effort stops the unique container name when docker run itself fails', async () => {
    const commands: string[][] = [];
    let bridgeClosed = 0;
    const executor = new OpenHandsEvalExecutor({
      apiKey: 'provider-secret',
      runCommand: async (_command, args) => {
        commands.push([...args]);
        if (args[0] === 'run') {
          return { exitCode: 125, stdout: '', stderr: 'daemon lost reply after create' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      startSubmitBridge: async () => ({
        url: 'http://host.docker.internal:41875/mcp',
        token: 'token',
        async close() {
          bridgeClosed += 1;
        },
      }),
      now: () => 1_000,
    });

    const outcome = await executor.execute(request());

    assert.match(outcome.error ?? '', /docker run failed: daemon lost reply after create/);
    const run = commands.find((args) => args[0] === 'run');
    const stop = commands.find((args) => args[0] === 'stop');
    assert.ok(run);
    assert.ok(stop);
    assert.equal(stop.at(-1), valueAfter(run, '--name'));
    assert.equal(bridgeClosed, 1);
  });

  it('fails closed when a distinct additional directory would widen the mount set', async () => {
    let sideEffects = 0;
    const executor = new OpenHandsEvalExecutor({
      apiKey: 'provider-secret',
      runCommand: async () => {
        sideEffects += 1;
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      startSubmitBridge: async () => {
        sideEffects += 1;
        throw new Error('must not start');
      },
      now: () => 1_000,
    });
    const req = request();
    req.additionalDirectories = ['/work/repo', '/work/other'];

    const outcome = await executor.execute(req);

    assert.equal(sideEffects, 0);
    assert.match(outcome.error ?? '', /mounts only cwd/);
    assert.equal(executor.lastTelemetry()?.terminalReason, 'unsupported');
  });
});

function request(): WorkerExecutionRequest {
  return {
    workstreamSlug: 'eval-openhands',
    assignmentId: 'asg_openhands',
    prompt: 'Complete the bounded assignment.',
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append: 'Submit exactly once through submit_result.',
    },
    model: 'anthropic/claude-sonnet-4-5-20250929',
    tools: { type: 'preset', preset: 'claude_code' },
    allowedTools: ['mcp__weaver__*'],
    permissionMode: 'bypassPermissions',
    settingSources: ['user', 'project', 'local'],
    strictMcpConfig: false,
    maxTurns: 12,
    cwd: '/work/repo',
    additionalDirectories: ['/work/repo'],
    env: {},
    operatorMcpServers: {},
    submit: {
      async appendSection() {
        return { text: 'appended' };
      },
      async submitResult() {
        return { text: 'submitted' };
      },
    },
    abort: new AbortController(),
  };
}

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function valueAfter(args: string[], flag: string): string {
  const index = args.indexOf(flag);
  assert.notEqual(index, -1, `missing ${flag}`);
  return args[index + 1]!;
}

function valuesAfter(args: string[], flag: string): string[] {
  return args.flatMap((arg, index) => (arg === flag ? [args[index + 1]!] : []));
}

function header(init: RequestInit, name: string): string {
  return new Headers(init.headers).get(name) ?? '';
}

function increasingClock(): () => number {
  let value = 999;
  return () => {
    value += 1;
    return value;
  };
}
