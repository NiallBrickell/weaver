import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';
import { setExecutorSecret } from '../../secrets.js';
import type { SubmitBridge } from '../../executor/submitBridge.js';
import type { SubmitSurface, WorkerExecutionRequest } from '../../executor/types.js';
import {
  OPENHANDS_AGENT_SERVER_IMAGE,
  OpenHandsEvalExecutor,
  type CommandRunner,
} from './openHands.js';

interface SeenFetch {
  url: string;
  init: RequestInit;
}

const TEST_WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-openhands-workspace-'));
const TEST_WORKSPACE_REAL = fs.realpathSync(TEST_WORKSPACE);
after(() => fs.rmSync(TEST_WORKSPACE, { recursive: true, force: true }));

describe('OpenHands eval executor', () => {
  it('runs one fresh pinned Agent Server conversation and always tears it down', async () => {
    const commands: Array<{ command: string; args: string[] }> = [];
    const seenFetch: SeenFetch[] = [];
    const selectedValue = 'selected-container-secret-4821';
    const unrelatedHostValue = 'ambient-host-secret-7392';
    let workerEnvFilePath = '';
    let workerEnvFileContent = '';
    let workerEnvFileMode = 0;
    let bridgeClosed = 0;
    let providerProxyClosed = 0;
    let operatorRelayClosed = 0;
    let statusReads = 0;
    const runCommand: CommandRunner = async (command, args) => {
      commands.push({ command, args: [...args] });
      if (args[0] === 'ps') {
        return {
          exitCode: 0,
          stdout: 'weaver-openhands-orphan-dead\t424242\nweaver-openhands-live\t7\n',
          stderr: '',
        };
      }
      if (args[0] === 'port') {
        return { exitCode: 0, stdout: '127.0.0.1:49152\n', stderr: '' };
      }
      if (args[0] === 'run') {
        workerEnvFilePath = valueAfter(args, '--env-file');
        workerEnvFileContent = fs.readFileSync(workerEnvFilePath, 'utf8');
        workerEnvFileMode = fs.statSync(workerEnvFilePath).mode & 0o777;
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
      hostGatewayIp: '10.170.0.2',
      gitIdentity: async () => ({
        name: 'weaver-fleet-production-912c84[bot]',
        email: '321406343+weaver-fleet-production-912c84[bot]@users.noreply.github.com',
      }),
      runCommand,
      fetch: fetchImpl,
      startSubmitBridge: async () => bridge,
      startMcpRelay: async (config, options) => {
        assert.deepEqual(config, {
          type: 'http', url: 'https://tracker.example.invalid/mcp',
          headers: { Authorization: '${TRACKER_TOKEN}' },
        });
        assert.equal(options.env.TRACKER_TOKEN, 'host-only-tracker-secret');
        assert.equal(options.bindHost, '0.0.0.0');
        assert.equal(options.advertiseHost, 'host.docker.internal');
        return {
          url: 'http://host.docker.internal:41920/mcp',
          token: 'operator-relay-secret',
          async close() { operatorRelayClosed += 1; },
        };
      },
      startProviderProxy: async (options) => {
        assert.equal(options.upstreamApiKey, 'provider-secret');
        assert.equal(options.upstreamBaseUrl, 'https://provider.example/v1');
        assert.deepEqual(options.allowedModels, [
          'anthropic/claude-sonnet-4-5-20250929',
          'claude-sonnet-4-5-20250929',
        ]);
        assert.equal(options.maxRequests, 14);
        return {
          url: 'http://host.docker.internal:41900/v1',
          token: 'provider-proxy-secret',
          modelResolved: () => 'anthropic/claude-sonnet-4-5-20250929',
          async close() { providerProxyClosed += 1; },
        };
      },
      sleep: async () => undefined,
      isProcessAlive: (pid) => pid === 7,
      now: increasingClock(),
    });

    const req = request();
    req.env.TRACKER_TOKEN = 'host-only-tracker-secret';
    req.env.READONLY_API_TOKEN = selectedValue;
    req.env.UNRELATED_AMBIENT_TOKEN = unrelatedHostValue;
    req.workerVisibleEnv = { READONLY_API_TOKEN: selectedValue };
    req.redactionSecrets = {
      READONLY_API_TOKEN: selectedValue,
      UNRELATED_AMBIENT_TOKEN: unrelatedHostValue,
    };
    req.operatorMcpServers = {
      tracker: {
        type: 'http', url: 'https://tracker.example.invalid/mcp',
        headers: { Authorization: '${TRACKER_TOKEN}' },
      },
    };
    const outcome = await executor.execute(req);

    assert.deepEqual(outcome, { costUsd: 1, sessionId: 'conversation-1' });
    assert.equal(bridgeClosed, 1);
    assert.equal(providerProxyClosed, 1);
    assert.equal(operatorRelayClosed, 1);
    assert.equal(statusReads, 2);

    const dockerRun = commands.find(({ args }) => args[0] === 'run');
    assert.ok(dockerRun);
    assert.equal(dockerRun.command, 'docker');
    assert.ok(dockerRun.args.includes('--rm'));
    assert.ok(dockerRun.args.includes('--detach'));
    assert.ok(dockerRun.args.includes(OPENHANDS_AGENT_SERVER_IMAGE));
    assert.ok(valuesAfter(dockerRun.args, '--label').includes('weaver.executor=openhands'));
    assert.ok(valuesAfter(dockerRun.args, '--label').includes(`weaver.owner_pid=${process.pid}`));
    assert.ok(valuesAfter(dockerRun.args, '--label').some((label) => label.startsWith('weaver.owner_host=')));
    assert.deepEqual(valuesAfter(dockerRun.args, '--volume'), [`${TEST_WORKSPACE_REAL}:/workspace:rw`]);
    assert.deepEqual(valuesAfter(dockerRun.args, '--add-host'), [
      'host.docker.internal:10.170.0.2',
    ]);
    assert.ok(valuesAfter(dockerRun.args, '--env').includes('OH_CONVERSATIONS_PATH=/tmp/weaver-conversations'));
    assert.ok(valuesAfter(dockerRun.args, '--env').includes('OH_BASH_EVENTS_DIR=/tmp/weaver-bash-events'));
    assert.ok(valuesAfter(dockerRun.args, '--env').includes('OH_WORKSPACE_PATH=/tmp/weaver-agent-server-workspace'));
    // Commits made inside the container carry the fleet identity, not the
    // OpenHands image default `openhands@all-hands.dev`.
    const botEmail = '321406343+weaver-fleet-production-912c84[bot]@users.noreply.github.com';
    assert.ok(valuesAfter(dockerRun.args, '--env').includes('GIT_AUTHOR_NAME=weaver-fleet-production-912c84[bot]'));
    assert.ok(valuesAfter(dockerRun.args, '--env').includes(`GIT_AUTHOR_EMAIL=${botEmail}`));
    assert.ok(valuesAfter(dockerRun.args, '--env').includes('GIT_COMMITTER_NAME=weaver-fleet-production-912c84[bot]'));
    assert.ok(valuesAfter(dockerRun.args, '--env').includes(`GIT_COMMITTER_EMAIL=${botEmail}`));
    assert.equal(valueAfter(dockerRun.args, '--env-file'), workerEnvFilePath);
    assert.equal(workerEnvFileMode, 0o600);
    assert.equal(workerEnvFileContent, `READONLY_API_TOKEN=${selectedValue}\n`);
    assert.equal(fs.existsSync(workerEnvFilePath), false);
    assert.equal(fs.existsSync(path.dirname(workerEnvFilePath)), false);
    assert.equal(dockerRun.args.filter((arg) => arg.includes('provider-secret')).length, 0);
    assert.ok(!JSON.stringify(commands).includes(selectedValue));
    assert.ok(!JSON.stringify(commands).includes(unrelatedHostValue));
    assert.ok(!workerEnvFileContent.includes(unrelatedHostValue));
    assert.ok(!JSON.stringify({ outcome, telemetry: executor.lastTelemetry() }).includes(selectedValue));

    const dockerStop = commands.find(({ args }) => args[0] === 'stop');
    assert.ok(dockerStop);
    assert.equal(dockerStop.args.at(-1), valueAfter(dockerRun.args, '--name'));
    assert.ok(commands.some(({ args }) =>
      args[0] === 'rm' && args[1] === '--force' && args[2] === 'weaver-openhands-orphan-dead',
    ));
    assert.ok(!commands.some(({ args }) => args.includes('weaver-openhands-live')));

    const create = seenFetch.find(
      ({ url, init }) => url.endsWith('/api/conversations') && init.method === 'POST',
    );
    assert.ok(create);
    assert.equal(header(create.init, 'X-Session-API-Key').length, 64);
    const body = JSON.parse(String(create.init.body)) as Record<string, any>;
    assert.equal(body.agent.kind, 'Agent');
    assert.equal(body.agent.llm.model, 'anthropic/claude-sonnet-4-5-20250929');
    assert.equal(body.agent.llm.api_key, 'provider-proxy-secret');
    assert.equal(body.agent.llm.base_url, 'http://host.docker.internal:41900/v1');
    assert.ok(!JSON.stringify(body).includes('provider-secret'));
    assert.deepEqual(body.agent.tools, [
      { name: 'terminal' },
      { name: 'file_editor' },
      { name: 'task_tracker' },
    ]);
    assert.deepEqual(body.agent.mcp_config, {
      weaver: {
        url: bridge.url,
        transport: 'streamable-http',
        auth: { strategy: 'bearer', value: bridge.token },
      },
      tracker: {
        url: 'http://host.docker.internal:41920/mcp',
        transport: 'streamable-http',
        auth: { strategy: 'bearer', value: 'operator-relay-secret' },
      },
    });
    assert.ok(!JSON.stringify(body).includes('host-only-tracker-secret'));
    assert.ok(!JSON.stringify(body).includes('tracker.example.invalid'));
    assert.match(body.agent.agent_context.system_message_suffix, /→ \/workspace/);
    assert.equal(body.agent.agent_context.load_project_skills, false);
    assert.deepEqual(body.workspace, { type: 'local', working_dir: '/workspace' });
    assert.match(body.initial_message.content[0].text, /^Complete the bounded assignment\./);
    assert.match(body.initial_message.content[0].text, /OpenHands workspace path mapping/);
    assert.equal(body.max_iterations, 12);
    assert.deepEqual(body.tool_module_qualnames, {
      terminal: 'openhands.tools.terminal.definition',
      file_editor: 'openhands.tools.file_editor.definition',
      task_tracker: 'openhands.tools.task_tracker.definition',
    });
    assert.deepEqual(body.agent_definitions, []);
    assert.equal(body.plugins, null);

    for (const call of seenFetch.filter(({ url }) => !url.endsWith('/health'))) {
      assert.equal(header(call.init, 'X-Session-API-Key'), header(create.init, 'X-Session-API-Key'));
    }
    assert.ok(!seenFetch.some(({ url }) => url.endsWith('/run')));

    assert.deepEqual(executor.lastTelemetry(), {
      executor: 'openhands',
      modelRequested: 'anthropic/claude-sonnet-4-5-20250929',
      providerResolved: 'anthropic',
      modelResolved: 'anthropic/claude-sonnet-4-5-20250929',
      harnessVersion: 'openhands-agent-server-1.41.0-weaver.5',
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

  it('refuses a non-IPv4 host gateway before starting a bridge or container', async () => {
    let sideEffects = 0;
    const executor = new OpenHandsEvalExecutor({
      apiKey: 'provider-secret',
      baseUrl: 'https://provider.example/v1',
      hostGatewayIp: 'host-gateway;unsafe',
      startSubmitBridge: async () => {
        sideEffects += 1;
        throw new Error('must not start');
      },
      runCommand: async () => {
        sideEffects += 1;
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      now: () => 1_000,
    });

    const outcome = await executor.execute(request());

    assert.equal(sideEffects, 0);
    assert.match(outcome.error ?? '', /must be one IPv4 address owned by the execution host/);
    assert.equal(executor.lastTelemetry()?.terminalReason, 'unsupported');
  });

  it('rejects supervised action work before starting a bridge or process', async () => {
    let bridgeStarts = 0;
    let processStarts = 0;
    const executor = new OpenHandsEvalExecutor({
      apiKey: 'provider-secret',
      baseUrl: 'https://provider.example/v1',
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

  it('rejects malformed worker-visible environment before any side effect', async () => {
    let sideEffects = 0;
    const executor = new OpenHandsEvalExecutor({
      apiKey: 'provider-secret',
      baseUrl: 'https://provider.example/v1',
      startSubmitBridge: async () => {
        sideEffects += 1;
        throw new Error('must not start');
      },
      runCommand: async () => {
        sideEffects += 1;
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      now: () => 1_000,
    });

    for (const [env, expected] of [
      [{ 'NOT-AN-ENV-NAME': 'value' }, /invalid name/],
      [{ VALID_NAME: 'first\nsecond' }, /VALID_NAME contains a newline or NUL byte/],
      [{ VALID_NAME: 'first\0second' }, /VALID_NAME contains a newline or NUL byte/],
    ] as const) {
      const req = request();
      req.workerVisibleEnv = env;
      const outcome = await executor.execute(req);
      assert.match(outcome.error ?? '', expected);
    }

    assert.equal(sideEffects, 0);
  });

  it("reserves the 'weaver' MCP name for submission before any relay or process starts", async () => {
    let sideEffects = 0;
    const executor = new OpenHandsEvalExecutor({
      apiKey: 'provider-secret',
      baseUrl: 'https://provider.example/v1',
      startMcpRelay: async () => {
        sideEffects += 1;
        throw new Error('must not start');
      },
      startProviderProxy: async () => {
        sideEffects += 1;
        throw new Error('must not start');
      },
      runCommand: async () => {
        sideEffects += 1;
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      now: () => 1_000,
    });
    const req = request();
    req.operatorMcpServers = {
      Weaver: { type: 'http', url: 'https://example.invalid/mcp' },
    };

    const outcome = await executor.execute(req);

    assert.equal(sideEffects, 0);
    assert.match(outcome.error ?? '', /reserved for the submission surface/);
    assert.equal(executor.lastTelemetry()?.terminalReason, 'unsupported');
  });

  it('degrades past a dead operator MCP server and still tears every relay down', async () => {
    let relayStarts = 0;
    let firstRelayClosed = 0;
    let relayUrlsPassedToContainer = 0;
    let liveRelayPassedToContainer = false;
    let initialMessage: string | null = null;
    const executor = new OpenHandsEvalExecutor({
      apiKey: 'provider-secret',
      baseUrl: 'https://provider.example/v1',
      startMcpRelay: async () => {
        relayStarts += 1;
        if (relayStarts === 2) throw new Error('failed to connect to configured MCP server');
        return {
          url: 'http://host.docker.internal:41922/mcp', token: 'first-relay-token',
          async close() { firstRelayClosed += 1; },
        };
      },
      startProviderProxy: async () => ({
        url: 'http://host.docker.internal:41923/proxy',
        token: 'proxy-token',
        modelResolved: () => 'openai/gpt-test',
        async close() {},
      }),
      startSubmitBridge: async () => ({
        url: 'http://host.docker.internal:41924/mcp', token: 'bridge-token',
        async close() {},
      }),
      runCommand: async (command: string, args: string[]) => {
        if (command.includes('docker') && args[0] === 'port') {
          return { exitCode: 0, stdout: '0.0.0.0:41925\n', stderr: '' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        const target = String(url);
        if (target.endsWith('/api/conversations') && init?.method === 'POST') {
          const raw = String(init.body);
          const body = JSON.parse(raw) as Record<string, unknown>;
          const findMcpConfig = (node: unknown): Record<string, unknown> | null => {
            if (!node || typeof node !== 'object') return null;
            if ('mcp_config' in (node as Record<string, unknown>)) {
              return (node as Record<string, unknown>).mcp_config as Record<string, unknown>;
            }
            for (const child of Object.values(node as Record<string, unknown>)) {
              const found = findMcpConfig(child);
              if (found) return found;
            }
            return null;
          };
          const mcpConfig = findMcpConfig(body) ?? {};
          initialMessage = (body.initial_message as { content?: { text?: string }[] } | undefined)?.content?.[0]?.text ?? null;
          relayUrlsPassedToContainer = Object.keys(mcpConfig).length;
          liveRelayPassedToContainer = raw.includes('first-relay-token');
          return new Response(JSON.stringify({ id: 'conv-1' }), { status: 200 });
        }
        if (/\/api\/conversations\//.test(target)) {
          return new Response(JSON.stringify({ id: 'conv-1', execution_status: 'finished', stats: {} }), { status: 200 });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      }) as unknown as typeof fetch,
      now: () => 1_000,
    });
    const req = request();
    req.operatorMcpServers = {
      first: { type: 'http', url: 'https://first.example.invalid/mcp' },
      second: { type: 'http', url: 'https://second.example.invalid/mcp' },
    };

    const outcome = await executor.execute(req);

    // One dead server must not fail the launch: the container is created with
    // the live relay only, the prompt names the absent server, and the started
    // relay is still closed afterwards.
    assert.equal(relayStarts, 2);
    assert.match(initialMessage ?? '', /unavailable during this run: second/);
    assert.equal(relayUrlsPassedToContainer >= 2, true, 'weaver submit bridge plus the live relay');
    assert.equal(liveRelayPassedToContainer, true);
    assert.equal(outcome.error ?? '', '');
    assert.ok(firstRelayClosed >= 1);
  });

  it('scrubs durable and per-run credentials from every submission field and relay reply', async () => {
    const selectedWorkerSecret = 'selected-worker-secret';
    let relayed: SubmitSurface | null = null;
    let submitted = '';
    let replySeenByAgent = '';
    let statusReads = 0;
    const runCommand: CommandRunner = async (_command, args) => args[0] === 'port'
      ? { exitCode: 0, stdout: '127.0.0.1:49154\n', stderr: '' }
      : { exitCode: 0, stdout: '', stderr: '' };
    const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input);
      if (url.endsWith('/health')) return response({ status: 'ok' });
      if (url.endsWith('/api/conversations') && init.method === 'POST') {
        return response({ id: 'conversation-secrets', execution_status: 'idle' });
      }
      if (url.endsWith('/api/conversations/conversation-secrets')) {
        const session = header(init, 'X-Session-API-Key');
        if (statusReads === 0) {
          assert.ok(relayed);
          const secretText = [
            'provider-secret',
            'provider-proxy-token',
            'bridge-secret',
            'operator-relay-token',
            selectedWorkerSecret,
            session,
          ].join(' / ');
          replySeenByAgent = (await relayed.submitResult({
            summary: secretText,
            artifact: {
              title: secretText,
              kind: secretText,
              file_name: secretText,
              content: secretText,
            },
          })).text;
        }
        statusReads += 1;
        return response({
          id: 'conversation-secrets',
          execution_status: statusReads === 1 ? 'running' : 'finished',
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof globalThis.fetch;
    const executor = new OpenHandsEvalExecutor({
      apiKey: 'provider-secret',
      baseUrl: 'https://provider.example/v1',
      runCommand,
      fetch: fetchImpl,
      startSubmitBridge: async (submit) => {
        relayed = submit;
        return {
          url: 'http://host.docker.internal:41876/mcp',
          token: 'bridge-secret',
          async close() {},
        };
      },
      startProviderProxy: async () => ({
        url: 'http://host.docker.internal:41902/v1',
        token: 'provider-proxy-token',
        modelResolved: () => 'anthropic/claude-sonnet-4-5-20250929',
        async close() {},
      }),
      startMcpRelay: async () => ({
        url: 'http://host.docker.internal:41921/mcp',
        token: 'operator-relay-token',
        async close() {},
      }),
      sleep: async () => undefined,
      now: increasingClock(),
    });
    const req = request();
    // The adapter must derive redaction from the values it exposes rather
    // than relying on callers to duplicate them in redactionSecrets.
    req.workerVisibleEnv = { READONLY_API_TOKEN: selectedWorkerSecret };
    req.operatorMcpServers = {
      tracker: { type: 'http', url: 'https://tracker.example.invalid/mcp' },
    };
    req.submit.submitResult = async (args) => {
      submitted = JSON.stringify(args);
      return { text: `ack provider-secret provider-proxy-token bridge-secret ${args.summary}` };
    };

    const outcome = await executor.execute(req);

    assert.equal(outcome.error, undefined);
    for (const secret of [
      'provider-secret', 'provider-proxy-token', 'bridge-secret', 'operator-relay-token',
      selectedWorkerSecret,
    ]) {
      assert.ok(!submitted.includes(secret));
      assert.ok(!replySeenByAgent.includes(secret));
    }
    assert.match(submitted, /«secret:/);
    assert.match(replySeenByAgent, /«secret:/);
  });

  it('does not manufacture resolved identity when the upstream provider response omits it', async () => {
    let statusReads = 0;
    const executor = new OpenHandsEvalExecutor({
      apiKey: 'provider-secret',
      baseUrl: 'https://provider.example/v1',
      runCommand: async (_command, args) => args[0] === 'port'
        ? { exitCode: 0, stdout: '127.0.0.1:49155\n', stderr: '' }
        : { exitCode: 0, stdout: '', stderr: '' },
      fetch: (async (input: string | URL | Request, init: RequestInit = {}) => {
        const url = String(input);
        if (url.endsWith('/health')) return response({ status: 'ok' });
        if (url.endsWith('/api/conversations') && init.method === 'POST') {
          return response({ id: 'conversation-no-model', execution_status: 'idle' });
        }
        if (url.endsWith('/api/conversations/conversation-no-model')) {
          statusReads += 1;
          return response({
            id: 'conversation-no-model',
            execution_status: statusReads === 1 ? 'running' : 'finished',
          });
        }
        throw new Error(`unexpected fetch ${url}`);
      }) as typeof globalThis.fetch,
      startSubmitBridge: async () => ({
        url: 'http://host.docker.internal:41877/mcp',
        token: 'bridge-secret',
        async close() {},
      }),
      startProviderProxy: async () => ({
        url: 'http://host.docker.internal:41903/v1',
        token: 'provider-proxy-token',
        modelResolved: () => null,
        async close() {},
      }),
      sleep: async () => undefined,
      now: increasingClock(),
    });

    const outcome = await executor.execute(request());

    assert.match(outcome.error ?? '', /did not report a model identity/);
    assert.equal(executor.lastTelemetry()?.terminalReason, 'error');
    assert.equal(executor.lastTelemetry()?.providerResolved, null);
    assert.equal(executor.lastTelemetry()?.modelResolved, null);
  });

  it('retains a concise typed provider failure without leaking provider account identifiers', async () => {
    const keySettingsUrl =
      'https://openrouter.ai/workspaces/default/keys/account-specific-identifier';
    const executor = new OpenHandsEvalExecutor({
      apiKey: 'provider-secret',
      runCommand: async (_command, args) => args[0] === 'port'
        ? { exitCode: 0, stdout: '127.0.0.1:49158\n', stderr: '' }
        : { exitCode: 0, stdout: '', stderr: '' },
      fetch: (async (input: string | URL | Request, init: RequestInit = {}) => {
        const url = String(input);
        if (url.endsWith('/health')) return response({ status: 'ok' });
        if (url.endsWith('/api/conversations') && init.method === 'POST') {
          return response({ id: 'conversation-provider-error', execution_status: 'idle' });
        }
        if (url.endsWith('/api/conversations/conversation-provider-error')) {
          return response({ id: 'conversation-provider-error', execution_status: 'error' });
        }
        if (url.endsWith('/events/search?limit=100')) {
          return response({
            items: [{
              kind: 'ConversationErrorEvent',
              code: 'APIError',
              detail: 'litellm.APIError: OpenrouterException - ' + JSON.stringify({
                error: {
                  code: 402,
                  message: `More credits required; visit ${keySettingsUrl}`,
                  metadata: { previous_errors: ['duplicate-noise'] },
                },
              }),
            }],
          });
        }
        if (url.endsWith('/pause') && init.method === 'POST') return response({ success: true });
        throw new Error(`unexpected fetch ${url}`);
      }) as typeof globalThis.fetch,
      startSubmitBridge: async () => ({
        url: 'http://host.docker.internal:41880/mcp',
        token: 'bridge-secret',
        async close() {},
      }),
      startProviderProxy: async () => ({
        url: 'http://host.docker.internal:41906/v1',
        token: 'provider-proxy-token',
        modelResolved: () => null,
        async close() {},
      }),
      sleep: async () => undefined,
      now: increasingClock(),
    });
    const req = request();
    req.model = 'openrouter/moonshotai/kimi-k3';

    const outcome = await executor.execute(req);

    assert.match(outcome.error ?? '', /OpenRouter 402: More credits required/);
    assert.match(outcome.error ?? '', /\[OpenRouter key settings\]/);
    assert.ok(!outcome.error?.includes('account-specific-identifier'));
    assert.ok(!outcome.error?.includes('previous_errors'));
    assert.equal(executor.lastTelemetry()?.error, outcome.error);
    assert.equal(executor.lastTelemetry()?.terminalReason, 'error');
  });

  it('reloads the executor-only OpenRouter key for every run and supplies the official base URL', async () => {
    const previousHome = process.env.WEAVER_HOME;
    process.env.WEAVER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-openhands-key-'));
    try {
      const seen: Array<{ key: string; baseUrl: string }> = [];
      const executor = new OpenHandsEvalExecutor({
        startProviderProxy: async (options) => {
          seen.push({ key: options.upstreamApiKey, baseUrl: options.upstreamBaseUrl });
          throw new Error('stop after credential resolution');
        },
        now: () => 1_000,
      });
      const req = request();
      req.model = 'openrouter/moonshotai/kimi-k3';

      setExecutorSecret('OPENROUTER_API_KEY', 'first-provider-key');
      await executor.execute(req);
      setExecutorSecret('OPENROUTER_API_KEY', 'second-provider-key');
      await executor.execute(req);

      assert.deepEqual(seen, [
        { key: 'first-provider-key', baseUrl: 'https://openrouter.ai/api/v1' },
        { key: 'second-provider-key', baseUrl: 'https://openrouter.ai/api/v1' },
      ]);
    } finally {
      if (previousHome === undefined) delete process.env.WEAVER_HOME;
      else process.env.WEAVER_HOME = previousHome;
    }
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
      baseUrl: 'https://provider.example/v1',
      runCommand,
      fetch: fetchImpl,
      startSubmitBridge: async () => ({
        url: 'http://host.docker.internal:41874/mcp',
        token: 'token',
        async close() {
          bridgeClosed += 1;
        },
      }),
      startProviderProxy: async () => fakeProviderProxy(),
      sleep: async () => undefined,
      now: () => 1_000,
    });
    const req = request();
    req.abort = abort;

    const outcome = await executor.execute(req);

    assert.equal(outcome.costUsd, null);
    assert.equal(outcome.sessionId, 'conversation-abort');
    assert.match(outcome.error ?? '', /cancelled by harness wall/);
    assert.equal(executor.lastTelemetry()?.terminalReason, 'aborted');
    assert.ok(seenFetch.some(({ url }) => url.endsWith('/conversation-abort/pause')));
    assert.ok(commands.some(({ args }) => args[0] === 'stop'));
    assert.equal(bridgeClosed, 1);
  });

  it('best-effort stops the unique container name when docker run itself fails', async () => {
    const commands: string[][] = [];
    const selectedValue = 'selected-docker-failure-secret-9182';
    let workerEnvFilePath = '';
    let workerEnvFileMode = 0;
    let workerEnvFileContent = '';
    let bridgeClosed = 0;
    const executor = new OpenHandsEvalExecutor({
      apiKey: 'provider-secret',
      baseUrl: 'https://provider.example/v1',
      runCommand: async (_command, args) => {
        commands.push([...args]);
        if (args[0] === 'run') {
          workerEnvFilePath = valueAfter(args, '--env-file');
          workerEnvFileMode = fs.statSync(workerEnvFilePath).mode & 0o777;
          workerEnvFileContent = fs.readFileSync(workerEnvFilePath, 'utf8');
          return {
            exitCode: 125,
            stdout: '',
            stderr: `daemon lost reply after create: ${selectedValue}`,
          };
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
      startProviderProxy: async () => fakeProviderProxy(),
      now: () => 1_000,
    });

    const req = request();
    req.workerVisibleEnv = { READONLY_API_TOKEN: selectedValue };
    req.redactionSecrets = { READONLY_API_TOKEN: selectedValue };
    const outcome = await executor.execute(req);

    assert.match(outcome.error ?? '', /docker run failed: daemon lost reply after create: «secret:READONLY_API_TOKEN»/);
    assert.ok(!JSON.stringify(outcome).includes(selectedValue));
    assert.ok(!JSON.stringify(executor.lastTelemetry()).includes(selectedValue));
    const run = commands.find((args) => args[0] === 'run');
    const stop = commands.find((args) => args[0] === 'stop');
    assert.ok(run);
    assert.ok(stop);
    assert.equal(stop.at(-1), valueAfter(run, '--name'));
    assert.equal(workerEnvFileMode, 0o600);
    assert.equal(workerEnvFileContent, `READONLY_API_TOKEN=${selectedValue}\n`);
    assert.ok(!JSON.stringify(commands).includes(selectedValue));
    assert.equal(fs.existsSync(workerEnvFilePath), false);
    assert.equal(fs.existsSync(path.dirname(workerEnvFilePath)), false);
    assert.equal(bridgeClosed, 1);
  });

  it('mounts distinct additional directories and rewrites their prompt paths', async () => {
    const additional = fs.mkdtempSync(path.join(os.tmpdir(), 'weaver-openhands-additional-'));
    const seenCommands: string[][] = [];
    let createBody: Record<string, any> | undefined;
    const executor = new OpenHandsEvalExecutor({
      apiKey: 'provider-secret',
      baseUrl: 'https://provider.example/v1',
      runCommand: async (_command, args) => {
        seenCommands.push([...args]);
        return args[0] === 'port'
          ? { exitCode: 0, stdout: '127.0.0.1:49159\n', stderr: '' }
          : { exitCode: 0, stdout: '', stderr: '' };
      },
      fetch: (async (input: string | URL | Request, init: RequestInit = {}) => {
        const url = String(input);
        if (url.endsWith('/health')) return response({ status: 'ok' });
        if (url.endsWith('/api/conversations') && init.method === 'POST') {
          createBody = JSON.parse(String(init.body));
          return response({ id: 'conversation-mounts' });
        }
        if (url.endsWith('/api/conversations/conversation-mounts')) {
          return response({ id: 'conversation-mounts', execution_status: 'finished' });
        }
        throw new Error(`unexpected fetch ${url}`);
      }) as typeof globalThis.fetch,
      startSubmitBridge: async () => ({
        url: 'http://host.docker.internal:41881/mcp', token: 'bridge-secret', async close() {},
      }),
      startProviderProxy: async () => fakeProviderProxy(),
      sleep: async () => undefined,
      now: increasingClock(),
    });
    const req = request();
    req.additionalDirectories = [TEST_WORKSPACE, additional];
    req.prompt = `Compare ${TEST_WORKSPACE}/source.ts with ${additional}/reference.ts.`;

    try {
      const outcome = await executor.execute(req);

      assert.equal(outcome.error, undefined);
      const dockerRun = seenCommands.find((args) => args[0] === 'run');
      assert.ok(dockerRun);
      assert.deepEqual(valuesAfter(dockerRun, '--volume'), [
        `${TEST_WORKSPACE_REAL}:/workspace:rw`,
        `${fs.realpathSync(additional)}:/weaver-sources/1:rw`,
      ]);
      assert.ok(createBody);
      assert.match(createBody.initial_message.content[0].text, /Compare \/workspace\/source\.ts with \/weaver-sources\/1\/reference\.ts/);
      assert.match(createBody.agent.agent_context.system_message_suffix, new RegExp(additional.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    } finally {
      fs.rmSync(additional, { recursive: true, force: true });
    }
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
    cwd: TEST_WORKSPACE,
    additionalDirectories: [TEST_WORKSPACE],
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

function fakeProviderProxy() {
  return {
    url: 'http://host.docker.internal:41901/v1',
    token: 'provider-proxy-token',
    modelResolved: () => 'anthropic/claude-sonnet-4-5-20250929',
    async close() {},
  };
}
