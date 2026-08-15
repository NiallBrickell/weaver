/**
 * The OpenHands executor: a worker's model loop run inside a pinned OpenHands
 * Agent Server container instead of the local SDK. This is the first REMOTE
 * substrate behind the WorkerExecutor seam — the durable Workstream contract is
 * unchanged, only where the disposable loop runs. Durable provider credentials
 * remain in the host process behind a per-run inference proxy; neither the
 * model container nor its conversation config receives the real key.
 *
 * Containment is real here: the declared host working directories are
 * bind-mounted at deterministic container paths, the container is `--rm` and
 * always torn down, and the worker's
 * only Weaver API is the submit surface reached over an ephemeral HTTP bridge
 * (advertised as host.docker.internal, bearer-authenticated). Action-worker
 * supervision is NOT supported yet, so an action request fails closed rather
 * than running unsupervised tool calls in the container.
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { loadExecutorSecrets, redactSecrets } from '../secrets.js';
import { startMcpRelay, type McpRelay } from './mcpRelay.js';
import {
  startProviderProxy,
  type ProviderProxy,
} from './providerProxy.js';
import { startSubmitBridge, type SubmitBridge } from './submitBridge.js';
import { planWorkspaceMounts, type WorkspaceMountPlan } from './workspaceMounts.js';
import type {
  ExecutorTelemetry,
  ExecutorUsage,
  SubmitSurface,
  WorkerExecutionOutcome,
  WorkerExecutionRequest,
  WorkerExecutor,
} from './types.js';

export const OPENHANDS_AGENT_SERVER_IMAGE =
  'ghcr.io/openhands/agent-server:1.41.0-python';

const AGENT_SERVER_PORT = '8000/tcp';
const HARNESS_VERSION = 'openhands-agent-server-1.41.0-weaver.3';
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const OPENHANDS_TOOL_MODULES = {
  terminal: 'openhands.tools.terminal.definition',
  file_editor: 'openhands.tools.file_editor.definition',
  task_tracker: 'openhands.tools.task_tracker.definition',
} as const;
const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_STARTUP_TIMEOUT_MS = 60_000;
const CONTAINER_LABEL = 'weaver.executor=openhands';
const CONTAINER_OWNER_HOST = hostname();

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (
  command: string,
  args: string[],
  options?: { signal?: AbortSignal },
) => Promise<CommandResult>;

export interface OpenHandsExecutorOptions {
  apiKey?: string;
  baseUrl?: string;
  dockerCommand?: string;
  fetch?: typeof globalThis.fetch;
  runCommand?: CommandRunner;
  startSubmitBridge?: typeof startSubmitBridge;
  startProviderProxy?: typeof startProviderProxy;
  startMcpRelay?: typeof startMcpRelay;
  loadExecutorSecrets?: typeof loadExecutorSecrets;
  now?: () => number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  pollIntervalMs?: number;
  startupTimeoutMs?: number;
  isProcessAlive?: (pid: number) => boolean;
}

interface ConversationInfo {
  id: string;
  execution_status?: string;
  agent_status?: string;
  status?: string;
  error?: unknown;
  detail?: unknown;
  message?: unknown;
  agent?: {
    state?: {
      error?: unknown;
      last_error?: unknown;
      message?: unknown;
    };
  };
  stats?: unknown;
  conversation_stats?: unknown;
}

interface ProviderConfiguration {
  apiKey: string;
  apiKeyName: string;
  baseUrl: string;
  provider: string | null;
}

interface MetricsTotals {
  costUsd: number | null;
  usage: ExecutorUsage;
}

interface NamedMcpRelay {
  name: string;
  relay: McpRelay;
}

class UnsupportedOpenHandsRequest extends Error {}

class OpenHandsConversationError extends Error {
  constructor(
    status: string,
    readonly info: ConversationInfo,
  ) {
    const detail = conversationErrorDetail(info);
    super(`OpenHands conversation ${status}${detail ? `: ${detail}` : ''}`);
  }
}

export class OpenHandsExecutor implements WorkerExecutor {
  readonly id = 'openhands' as const;

  private readonly apiKeyOverride: string | undefined;
  private readonly baseUrlOverride: string | undefined;
  private readonly dockerCommand: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly runCommand: CommandRunner;
  private readonly bridgeStarter: typeof startSubmitBridge;
  private readonly providerProxyStarter: typeof startProviderProxy;
  private readonly mcpRelayStarter: typeof startMcpRelay;
  private readonly executorSecretsLoader: typeof loadExecutorSecrets;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  private readonly pollIntervalMs: number;
  private readonly startupTimeoutMs: number;
  private readonly isProcessAlive: (pid: number) => boolean;
  private telemetry: ExecutorTelemetry | null = null;

  constructor(options: OpenHandsExecutorOptions = {}) {
    this.apiKeyOverride = options.apiKey;
    this.baseUrlOverride = options.baseUrl;
    this.dockerCommand = options.dockerCommand ?? 'docker';
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.runCommand = options.runCommand ?? runCommand;
    this.bridgeStarter = options.startSubmitBridge ?? startSubmitBridge;
    this.providerProxyStarter = options.startProviderProxy ?? startProviderProxy;
    this.mcpRelayStarter = options.startMcpRelay ?? startMcpRelay;
    this.executorSecretsLoader = options.loadExecutorSecrets ?? loadExecutorSecrets;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? abortableSleep;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    this.isProcessAlive = options.isProcessAlive ?? processAlive;
  }

  lastTelemetry(): ExecutorTelemetry | null {
    return this.telemetry;
  }

  async execute(req: WorkerExecutionRequest): Promise<WorkerExecutionOutcome> {
    const startedAtMs = this.now();
    const startedAt = new Date(startedAtMs).toISOString();
    let startupMs: number | null = null;
    let timeToSubmissionMs: number | null = null;
    let sessionId: string | null = null;
    let metrics: MetricsTotals = emptyMetrics();
    let terminalReason: ExecutorTelemetry['terminalReason'] = 'error';
    let error: string | null = null;
    let bridge: SubmitBridge | null = null;
    let providerProxy: ProviderProxy | null = null;
    let providerConfiguration: ProviderConfiguration | null = null;
    let workspacePlan: WorkspaceMountPlan | null = null;
    let containerStarted = false;
    let containerAttempted = false;
    let agentServerUrl: string | null = null;
    let sessionApiKey: string | null = null;
    const cleanupFailures: string[] = [];
    const operatorRelays: NamedMcpRelay[] = [];
    const containerName = `weaver-openhands-${safeName(req.assignmentId)}-${randomBytes(6).toString('hex')}`;

    try {
      this.validateRequest(req);
      workspacePlan = planWorkspaceMounts({
        cwd: resolve(req.cwd ?? process.cwd()),
        additionalDirectories: req.additionalDirectories,
        prompt: req.prompt,
      });
      providerConfiguration = this.providerConfiguration(req.model);
      if (req.abort.signal.aborted) throw abortError();

      for (const [name, config] of Object.entries(req.operatorMcpServers)) {
        const relay = await this.mcpRelayStarter(config, {
          env: req.env,
          bindHost: '0.0.0.0',
          advertiseHost: 'host.docker.internal',
        });
        operatorRelays.push({ name, relay });
      }

      providerProxy = await this.providerProxyStarter({
        upstreamBaseUrl: providerConfiguration.baseUrl,
        upstreamApiKey: providerConfiguration.apiKey,
        allowedModels: providerModelVariants(req.model),
        maxRequests: req.maxTurns + 2,
        bindHost: '0.0.0.0',
        advertiseHost: 'host.docker.internal',
      });

      const submit: SubmitSurface = {
        appendSection: async (content) => sanitizeReply(
          await req.submit.appendSection(this.sanitizePrivate(
            content,
            providerConfiguration,
            sessionApiKey,
            bridge?.token,
            providerProxy?.token,
            operatorRelays.map(({ relay }) => relay.token),
          )),
          (text) => this.sanitizePrivate(
            text,
            providerConfiguration,
            sessionApiKey,
            bridge?.token,
            providerProxy?.token,
            operatorRelays.map(({ relay }) => relay.token),
          ),
        ),
        submitResult: async (args) => {
          const sanitize = (value: string) => this.sanitizePrivate(
            value,
            providerConfiguration,
            sessionApiKey,
            bridge?.token,
            providerProxy?.token,
            operatorRelays.map(({ relay }) => relay.token),
          );
          const sanitized = {
            summary: sanitize(args.summary),
            artifact: Object.fromEntries(Object.entries(args.artifact).map(([key, value]) => [
              key, sanitize(value),
            ])) as typeof args.artifact,
          };
          const reply = await req.submit.submitResult(sanitized);
          if (!reply.isError && timeToSubmissionMs === null) {
            timeToSubmissionMs = Math.max(0, this.now() - startedAtMs);
          }
          return sanitizeReply(reply, sanitize);
        },
      };
      bridge = await this.bridgeStarter(submit, {
        bindHost: '0.0.0.0',
        advertiseHost: 'host.docker.internal',
      });

      sessionApiKey = randomBytes(32).toString('hex');
      await this.reapOrphanedContainers(req.abort.signal);
      containerAttempted = true;
      await this.checkedCommand(
        [
          'run',
          '--rm',
          '--detach',
          '--name',
          containerName,
          '--label',
          CONTAINER_LABEL,
          '--label',
          `weaver.owner_pid=${process.pid}`,
          '--label',
          `weaver.owner_host=${CONTAINER_OWNER_HOST}`,
          '--publish',
          `127.0.0.1::${AGENT_SERVER_PORT.split('/')[0]}`,
          '--add-host',
          'host.docker.internal:host-gateway',
          '--env',
          `SESSION_API_KEY=${sessionApiKey}`,
          '--env',
          'OH_ENABLE_VNC=false',
          '--env',
          'OH_CONVERSATIONS_PATH=/tmp/weaver-conversations',
          '--env',
          'OH_BASH_EVENTS_DIR=/tmp/weaver-bash-events',
          '--env',
          'OH_WORKSPACE_PATH=/tmp/weaver-agent-server-workspace',
          ...workspacePlan.dockerArgs,
          OPENHANDS_AGENT_SERVER_IMAGE,
          '--host',
          '0.0.0.0',
        ],
        req.abort.signal,
      );
      containerStarted = true;

      const portResult = await this.checkedCommand(
        ['port', containerName, AGENT_SERVER_PORT],
        req.abort.signal,
      );
      agentServerUrl = parseDockerPort(portResult.stdout);
      await this.waitForHealth(agentServerUrl, req.abort.signal);
      startupMs = Math.max(0, this.now() - startedAtMs);

      const conversation = await this.requestJson<ConversationInfo>(
        agentServerUrl,
        sessionApiKey,
        '/api/conversations',
        {
          method: 'POST',
          body: JSON.stringify(this.createConversationRequest(
            req,
            bridge,
            workspacePlan,
            providerProxy,
            operatorRelays,
          )),
        },
        req.abort.signal,
      );
      if (!conversation.id) throw new Error('OpenHands did not return a conversation id');
      sessionId = conversation.id;

      // A v1.41 conversation carrying initial_message starts immediately.
      // POSTing /run as well races that live loop and is correctly rejected as
      // "Conversation already running".
      const finalInfo = await this.waitForConversation(
        agentServerUrl,
        sessionApiKey,
        sessionId,
        req.abort.signal,
      );
      metrics = readMetrics(finalInfo.stats ?? finalInfo.conversation_stats);
      const upstreamModel = providerProxy.modelResolved();
      if (!upstreamModel) {
        throw new Error(
          'OpenHands provider response did not report a model identity; refusing false resolved-model provenance',
        );
      }
      terminalReason = 'completed';
    } catch (caught) {
      if (caught instanceof OpenHandsConversationError) {
        metrics = readMetrics(caught.info.stats ?? caught.info.conversation_stats);
      }
      let caughtMessage = caught instanceof Error ? caught.message : String(caught);
      if (
        caught instanceof OpenHandsConversationError &&
        agentServerUrl !== null &&
        sessionApiKey !== null &&
        sessionId !== null
      ) {
        try {
          const events = await this.requestJson<unknown>(
            agentServerUrl,
            sessionApiKey,
            `/api/conversations/${encodeURIComponent(sessionId)}/events/search?limit=100`,
            { method: 'GET' },
            AbortSignal.timeout(5_000),
          );
          const detail = conversationEventErrorDetail(events);
          if (detail && !caughtMessage.includes(detail)) caughtMessage += `: ${detail}`;
        } catch {
          // The typed conversation status remains the primary failure. Event
          // lookup is bounded, best-effort diagnostic enrichment only.
        }
      }
      error = this.sanitizePrivate(
        caughtMessage,
        providerConfiguration,
        sessionApiKey,
        bridge?.token,
        providerProxy?.token,
        operatorRelays.map(({ relay }) => relay.token),
      );
      if (isAbort(caught, req.abort.signal)) {
        terminalReason = 'aborted';
      } else if (caught instanceof UnsupportedOpenHandsRequest) {
        terminalReason = 'unsupported';
      } else {
        terminalReason = 'error';
      }
    } finally {
      if (
        containerStarted &&
        agentServerUrl !== null &&
        sessionApiKey !== null &&
        sessionId !== null &&
        terminalReason !== 'completed'
      ) {
        try {
          await this.requestJson(
            agentServerUrl,
            sessionApiKey,
            `/api/conversations/${encodeURIComponent(sessionId)}/pause`,
            { method: 'POST' },
            AbortSignal.timeout(5_000),
          );
        } catch (caught) {
          cleanupFailures.push(`pause: ${caught instanceof Error ? caught.message : String(caught)}`);
        }
      }
      if (containerAttempted) {
        let stopped = false;
        try {
          const stop = await this.runCommand(
            this.dockerCommand,
            ['stop', '--timeout', '5', containerName],
            { signal: AbortSignal.timeout(15_000) },
          );
          stopped = stop.exitCode === 0;
        } catch {
          stopped = false;
        }
        if (!stopped && containerStarted) {
          try {
            const removed = await this.runCommand(
              this.dockerCommand,
              ['rm', '--force', containerName],
              { signal: AbortSignal.timeout(15_000) },
            );
            if (removed.exitCode !== 0) cleanupFailures.push(`container removal exited ${removed.exitCode}`);
          } catch (caught) {
            cleanupFailures.push(`container removal: ${caught instanceof Error ? caught.message : String(caught)}`);
          }
        }
      }
      for (const { relay } of operatorRelays) {
        try { await relay.close(); }
        catch { cleanupFailures.push('operator MCP relay: failed to close'); }
      }
      if (bridge) {
        try { await bridge.close(); }
        catch (caught) { cleanupFailures.push(`submit bridge: ${caught instanceof Error ? caught.message : String(caught)}`); }
      }
      if (providerProxy) {
        try { await providerProxy.close(); }
        catch (caught) { cleanupFailures.push(`provider proxy: ${caught instanceof Error ? caught.message : String(caught)}`); }
      }
      if (cleanupFailures.length) {
        error = [error, ...cleanupFailures].filter(Boolean).join('; ');
        terminalReason = 'error';
      }
      if (error !== null) {
        error = this.sanitizePrivate(
          error,
          providerConfiguration,
          sessionApiKey,
          bridge?.token,
          providerProxy?.token,
          operatorRelays.map(({ relay }) => relay.token),
        );
      }

      const endedAtMs = this.now();
      const modelResolved = terminalReason === 'completed'
        ? providerProxy?.modelResolved() ?? null
        : null;
      this.telemetry = {
        executor: this.id,
        modelRequested: req.model,
        providerResolved: modelResolved ? providerConfiguration?.provider ?? null : null,
        modelResolved,
        harnessVersion: HARNESS_VERSION,
        isolation: 'agent-server',
        startedAt,
        endedAt: new Date(endedAtMs).toISOString(),
        durationMs: Math.max(0, endedAtMs - startedAtMs),
        startupMs,
        timeToSubmissionMs,
        usage: metrics.usage,
        costUsd: metrics.costUsd,
        sessionId,
        terminalReason,
        error,
      };
    }

    return {
      costUsd: metrics.costUsd,
      ...(sessionId !== null ? { sessionId } : {}),
      ...(error !== null ? { error } : {}),
    };
  }

  private validateRequest(req: WorkerExecutionRequest): void {
    if (req.supervise) {
      throw new UnsupportedOpenHandsRequest(
        'OpenHands executor does not support action-worker supervision',
      );
    }
    if (Object.keys(req.operatorMcpServers).some((name) => name.toLowerCase() === 'weaver')) {
      throw new UnsupportedOpenHandsRequest(
        "operator MCP server name 'weaver' is reserved for the submission surface",
      );
    }
  }

  private providerConfiguration(model: string): ProviderConfiguration {
    const provider = providerFromModel(model);
    const executorSecrets = this.executorSecretsLoader();
    const providerKeyName = providerSecretName(provider);
    const apiKey =
      this.apiKeyOverride ??
      (providerKeyName ? executorSecrets[providerKeyName] : undefined) ??
      executorSecrets.WEAVER_MODEL_API_KEY ??
      process.env.WEAVER_MODEL_API_KEY ??
      process.env.LLM_API_KEY;
    if (!apiKey) {
      throw new UnsupportedOpenHandsRequest(
        `OpenHands executor requires ${providerKeyName ?? 'WEAVER_MODEL_API_KEY'} in executor-only secrets ` +
          '(`weaver secret set <NAME> --executor`)',
      );
    }

    const baseUrl =
      this.baseUrlOverride ??
      process.env.WEAVER_OPENHANDS_BASE_URL ??
      (provider === 'openrouter' ? OPENROUTER_BASE_URL : undefined);
    if (!baseUrl) {
      throw new UnsupportedOpenHandsRequest(
        'OpenHands requires WEAVER_OPENHANDS_BASE_URL for this provider so the durable API key can remain behind the host proxy',
      );
    }
    return {
      apiKey,
      apiKeyName: this.apiKeyOverride ? 'WEAVER_MODEL_API_KEY' : providerKeyName ?? 'WEAVER_MODEL_API_KEY',
      baseUrl,
      provider,
    };
  }

  private createConversationRequest(
    req: WorkerExecutionRequest,
    bridge: SubmitBridge,
    workspacePlan: WorkspaceMountPlan,
    providerProxy: ProviderProxy,
    operatorRelays: readonly NamedMcpRelay[],
  ): Record<string, unknown> {
    return {
      agent: {
        kind: 'Agent',
        llm: {
          usage_id: 'agent',
          model: req.model,
          api_key: providerProxy.token,
          base_url: providerProxy.url,
        },
        tools: [
          { name: 'terminal' },
          { name: 'file_editor' },
          { name: 'task_tracker' },
        ],
        system_prompt_kwargs: { cli_mode: true },
        agent_context: {
          system_message_suffix: [
            req.systemPrompt.append,
            [
              'The declared host directories are mounted at these runtime paths:',
              ...workspacePlan.pathMappings.map(
                ({ hostPath, containerPath }) => `- ${hostPath} → ${containerPath}`,
              ),
              'Use the runtime paths inside this container.',
            ].join('\n'),
          ].join('\n\n'),
          load_project_skills: false,
        },
        mcp_config: Object.fromEntries([
          ['weaver', {
            url: bridge.url,
            transport: 'streamable-http',
            auth: { strategy: 'bearer', value: bridge.token },
          }],
          ...operatorRelays.map(({ name, relay }) => [name, {
            url: relay.url,
            transport: 'streamable-http',
            auth: { strategy: 'bearer', value: relay.token },
          }]),
        ]),
      },
      initial_message: {
        role: 'user',
        content: [{ type: 'text', text: workspacePlan.prompt }],
      },
      max_iterations: req.maxTurns,
      stuck_detection: true,
      // The Agent Server binary does not pre-register tool modules. Its
      // official RemoteConversation client transports the current registry on
      // creation; name-only Tool definitions otherwise fail at POST time.
      tool_module_qualnames: { ...OPENHANDS_TOOL_MODULES },
      agent_definitions: [],
      plugins: null,
      workspace: { type: 'local', working_dir: workspacePlan.workingDirectory },
      hook_config: null,
      user_id: null,
    };
  }

  private sanitizePrivate(
    text: string,
    provider: ProviderConfiguration | null,
    sessionApiKey: string | null,
    submitToken?: string | null,
    providerProxyToken?: string | null,
    operatorRelayTokens: readonly string[] = [],
  ): string {
    const secrets: Record<string, string> = {};
    if (provider) secrets[provider.apiKeyName] = provider.apiKey;
    if (sessionApiKey) secrets.OPENHANDS_SESSION_API_KEY = sessionApiKey;
    if (submitToken) secrets.OPENHANDS_SUBMIT_TOKEN = submitToken;
    if (providerProxyToken) secrets.OPENHANDS_PROVIDER_PROXY_TOKEN = providerProxyToken;
    for (const [index, token] of operatorRelayTokens.entries()) {
      secrets[`OPENHANDS_OPERATOR_MCP_TOKEN_${index + 1}`] = token;
    }
    return redactProviderDiagnostics(redactSecrets(text, secrets));
  }

  private async checkedCommand(args: string[], signal: AbortSignal): Promise<CommandResult> {
    const result = await this.runCommand(this.dockerCommand, args, { signal });
    if (result.exitCode !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`;
      throw new Error(`${this.dockerCommand} ${args[0]} failed: ${detail}`);
    }
    return result;
  }

  private async reapOrphanedContainers(signal: AbortSignal): Promise<void> {
    const listed = await this.runCommand(this.dockerCommand, [
      'ps', '--all', '--filter', `label=${CONTAINER_LABEL}`,
      '--filter', `label=weaver.owner_host=${CONTAINER_OWNER_HOST}`, '--format',
      '{{.Names}}\t{{.Label "weaver.owner_pid"}}',
    ], { signal });
    if (listed.exitCode !== 0) {
      throw new Error('failed to inspect prior OpenHands containers');
    }
    for (const line of listed.stdout.split('\n')) {
      if (!line.trim()) continue;
      const [name, rawPid] = line.split('\t');
      if (!name || !/^weaver-openhands-[a-z0-9_-]+$/.test(name)) continue;
      const ownerPid = Number(rawPid);
      if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0 || this.isProcessAlive(ownerPid)) continue;
      const removed = await this.runCommand(
        this.dockerCommand,
        ['rm', '--force', name],
        { signal: AbortSignal.timeout(15_000) },
      );
      if (removed.exitCode !== 0) {
        throw new Error('failed to remove an orphaned OpenHands container');
      }
    }
  }

  private async waitForHealth(baseUrl: string, signal: AbortSignal): Promise<void> {
    const deadline = this.now() + this.startupTimeoutMs;
    let lastError = 'not ready';
    while (this.now() <= deadline) {
      if (signal.aborted) throw abortError();
      try {
        const response = await this.fetchImpl(`${baseUrl}/health`, { signal });
        if (response.ok) return;
        lastError = `HTTP ${response.status}`;
      } catch (caught) {
        if (isAbort(caught, signal)) throw caught;
        lastError = caught instanceof Error ? caught.message : String(caught);
      }
      await this.sleep(this.pollIntervalMs, signal);
    }
    throw new Error(`OpenHands Agent Server health check timed out: ${lastError}`);
  }

  private async waitForConversation(
    baseUrl: string,
    sessionApiKey: string,
    conversationId: string,
    signal: AbortSignal,
  ): Promise<ConversationInfo> {
    const encodedId = encodeURIComponent(conversationId);
    while (true) {
      const info = await this.requestJson<ConversationInfo>(
        baseUrl,
        sessionApiKey,
        `/api/conversations/${encodedId}`,
        { method: 'GET' },
        signal,
      );
      const status = info.execution_status ?? info.agent_status ?? info.status;
      if (status === 'finished') return info;
      if (status === 'error' || status === 'stuck') {
        throw new OpenHandsConversationError(status, info);
      }
      if (status === 'paused' || status === 'waiting_for_confirmation') {
        throw new Error(`OpenHands conversation cannot continue: ${status}`);
      }
      await this.sleep(this.pollIntervalMs, signal);
    }
  }

  private async requestJson<T = unknown>(
    baseUrl: string,
    sessionApiKey: string,
    path: string,
    init: RequestInit,
    signal: AbortSignal,
  ): Promise<T> {
    const response = await this.fetchImpl(`${baseUrl}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        'X-Session-API-Key': sessionApiKey,
        ...init.headers,
      },
      signal,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(
        `OpenHands ${init.method ?? 'GET'} ${path} failed: HTTP ${response.status}${detail ? ` ${detail}` : ''}`,
      );
    }
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }
}

async function runCommand(
  command: string,
  args: string[],
  options: { signal?: AbortSignal } = {},
): Promise<CommandResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      resolvePromise({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

function parseDockerPort(output: string): string {
  const line = output.trim().split(/\r?\n/).find(Boolean);
  const match = line?.match(/:(\d+)$/);
  if (!match) throw new Error(`could not parse Docker Agent Server port from ${JSON.stringify(output)}`);
  return `http://127.0.0.1:${match[1]}`;
}

function safeName(value: string): string {
  const safe = value.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '');
  return (safe || 'assignment').slice(0, 40);
}

function providerFromModel(model: string): string | null {
  const separator = model.indexOf('/');
  return separator > 0 ? model.slice(0, separator) : null;
}

function providerSecretName(provider: string | null): string | null {
  if (!provider) return null;
  const normalized = provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  return normalized ? `${normalized}_API_KEY` : null;
}

function providerModelVariants(model: string): string[] {
  const separator = model.indexOf('/');
  return separator > 0 ? [model, model.slice(separator + 1)] : [model];
}

function sanitizeReply(
  reply: Awaited<ReturnType<SubmitSurface['submitResult']>>,
  sanitize: (text: string) => string,
): Awaited<ReturnType<SubmitSurface['submitResult']>> {
  return { ...reply, text: sanitize(reply.text) };
}

function conversationErrorDetail(info: ConversationInfo): string | null {
  const candidates = [
    info.error,
    info.detail,
    info.message,
    info.agent?.state?.last_error,
    info.agent?.state?.error,
    info.agent?.state?.message,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim().slice(0, 2_000);
    }
    if (isRecord(candidate)) {
      const encoded = JSON.stringify(candidate);
      if (encoded !== '{}') return encoded.slice(0, 2_000);
    }
  }
  return null;
}

function conversationEventErrorDetail(value: unknown): string | null {
  if (!isRecord(value) || !Array.isArray(value.items)) return null;
  for (const item of [...value.items].reverse()) {
    if (!isRecord(item)) continue;
    const eventKind = [item.kind, item.type, item.event_type]
      .find((candidate): candidate is string => typeof candidate === 'string');
    const code = typeof item.code === 'string' ? item.code.trim() : '';
    const detail = [item.detail, item.error, item.message]
      .find((candidate): candidate is string =>
        typeof candidate === 'string' && candidate.trim().length > 0)
      ?.trim();
    if (detail && (Boolean(code) || Boolean(eventKind && /error/i.test(eventKind)))) {
      return summarizeProviderError(code, detail);
    }
  }
  return null;
}

function summarizeProviderError(eventCode: string, detail: string): string {
  const marker = 'OpenrouterException - ';
  const markerIndex = detail.indexOf(marker);
  if (markerIndex >= 0) {
    try {
      const payload = JSON.parse(detail.slice(markerIndex + marker.length)) as unknown;
      if (isRecord(payload) && isRecord(payload.error)) {
        const providerCode = payload.error.code;
        const message = payload.error.message;
        if (typeof message === 'string' && message.trim()) {
          const label = typeof providerCode === 'number' || typeof providerCode === 'string'
            ? `OpenRouter ${providerCode}`
            : 'OpenRouter';
          return `${label}: ${message.trim()}`.slice(0, 2_000);
        }
      }
    } catch {
      // Fall through to the typed event detail if a future provider changes
      // the wrapper format.
    }
  }
  return `${eventCode ? `${eventCode}: ` : ''}${detail}`.slice(0, 2_000);
}

function redactProviderDiagnostics(text: string): string {
  return text.replace(
    /https:\/\/openrouter\.ai\/workspaces\/[^/\s"']+\/keys\/[a-z0-9_-]+/gi,
    '[OpenRouter key settings]',
  );
}

function emptyMetrics(): MetricsTotals {
  return {
    costUsd: null,
    usage: {
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
      reasoningOutputTokens: null,
    },
  };
}

function readMetrics(value: unknown): MetricsTotals {
  const result = emptyMetrics();
  if (!isRecord(value) || !isRecord(value.usage_to_metrics)) return result;

  let costUsd = 0;
  let sawCost = false;
  const input: number[] = [];
  const output: number[] = [];
  const cached: number[] = [];
  const reasoning: number[] = [];
  for (const item of Object.values(value.usage_to_metrics)) {
    if (!isRecord(item)) continue;
    if (typeof item.accumulated_cost === 'number') {
      costUsd += item.accumulated_cost;
      sawCost = true;
    }
    const usage = item.accumulated_token_usage;
    if (!isRecord(usage)) continue;
    collectNumber(usage, ['input_tokens', 'prompt_tokens'], input);
    collectNumber(usage, ['output_tokens', 'completion_tokens'], output);
    collectNumber(usage, ['cache_read_tokens', 'cached_tokens'], cached);
    collectNumber(usage, ['reasoning_tokens', 'reasoning_output_tokens'], reasoning);
  }

  result.costUsd = sawCost ? costUsd : null;
  result.usage = {
    inputTokens: sumOrNull(input),
    outputTokens: sumOrNull(output),
    cachedInputTokens: sumOrNull(cached),
    reasoningOutputTokens: sumOrNull(reasoning),
  };
  return result;
}

function collectNumber(record: Record<string, unknown>, keys: string[], target: number[]): void {
  for (const key of keys) {
    if (typeof record[key] === 'number') {
      target.push(record[key]);
      return;
    }
  }
}

function sumOrNull(values: number[]): number | null {
  return values.length ? values.reduce((total, value) => total + value, 0) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolvePromise, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolvePromise();
    }, milliseconds);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (caught) {
    return !(caught instanceof Error && 'code' in caught && caught.code === 'ESRCH');
  }
}

function abortError(): Error {
  const error = new Error('OpenHands run aborted');
  error.name = 'AbortError';
  return error;
}

function isAbort(caught: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (caught instanceof Error && caught.name === 'AbortError');
}
