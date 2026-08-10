/**
 * The OpenHands executor: a worker's model loop run inside a pinned OpenHands
 * Agent Server container instead of the local SDK. This is the first REMOTE
 * substrate behind the WorkerExecutor seam — the durable Workstream contract is
 * unchanged, only where the disposable loop runs.
 *
 * Containment is real here: the host working directory is bind-mounted at
 * /workspace, the container is `--rm` and always torn down, and the worker's
 * only Weaver API is the submit surface reached over an ephemeral HTTP bridge
 * (advertised as host.docker.internal, bearer-authenticated). Action-worker
 * supervision is NOT supported yet, so an action request fails closed rather
 * than running unsupervised tool calls in the container.
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { startSubmitBridge, type SubmitBridge } from './submitBridge.js';
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

const AGENT_SERVER_WORKSPACE = '/workspace';
const AGENT_SERVER_PORT = '8000/tcp';
const HARNESS_VERSION = 'openhands-agent-server-1.41.0';
const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_STARTUP_TIMEOUT_MS = 60_000;

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
  now?: () => number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  pollIntervalMs?: number;
  startupTimeoutMs?: number;
}

interface ConversationInfo {
  id: string;
  execution_status?: string;
  agent_status?: string;
  status?: string;
  stats?: unknown;
  conversation_stats?: unknown;
}

interface MetricsTotals {
  costUsd: number | null;
  usage: ExecutorUsage;
}

class UnsupportedOpenHandsRequest extends Error {}

class OpenHandsConversationError extends Error {
  constructor(
    status: string,
    readonly info: ConversationInfo,
  ) {
    super(`OpenHands conversation ${status}`);
  }
}

export class OpenHandsExecutor implements WorkerExecutor {
  readonly id = 'openhands' as const;

  private readonly apiKey: string | undefined;
  private readonly baseUrl: string | undefined;
  private readonly dockerCommand: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly runCommand: CommandRunner;
  private readonly bridgeStarter: typeof startSubmitBridge;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  private readonly pollIntervalMs: number;
  private readonly startupTimeoutMs: number;
  private telemetry: ExecutorTelemetry | null = null;

  constructor(options: OpenHandsExecutorOptions = {}) {
    this.apiKey =
      options.apiKey ??
      process.env.WEAVER_OPENHANDS_API_KEY ??
      process.env.LLM_API_KEY;
    this.baseUrl = options.baseUrl ?? process.env.WEAVER_OPENHANDS_BASE_URL;
    this.dockerCommand = options.dockerCommand ?? 'docker';
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.runCommand = options.runCommand ?? runCommand;
    this.bridgeStarter = options.startSubmitBridge ?? startSubmitBridge;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? abortableSleep;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
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
    let containerStarted = false;
    let containerAttempted = false;
    let agentServerUrl: string | null = null;
    let sessionApiKey: string | null = null;
    const cleanupFailures: string[] = [];
    const containerName = `weaver-openhands-${safeName(req.assignmentId)}-${randomBytes(6).toString('hex')}`;

    try {
      this.validateRequest(req);
      if (req.abort.signal.aborted) throw abortError();

      const submit: SubmitSurface = {
        appendSection: (content) => req.submit.appendSection(content),
        submitResult: async (args) => {
          const sanitized = sessionApiKey
            ? {
                summary: args.summary.replaceAll(sessionApiKey, '[REDACTED]'),
                artifact: Object.fromEntries(Object.entries(args.artifact).map(([key, value]) => [
                  key, value.replaceAll(sessionApiKey!, '[REDACTED]'),
                ])) as typeof args.artifact,
              }
            : args;
          const reply = await req.submit.submitResult(sanitized);
          if (!reply.isError && timeToSubmissionMs === null) {
            timeToSubmissionMs = Math.max(0, this.now() - startedAtMs);
          }
          return reply;
        },
      };
      bridge = await this.bridgeStarter(submit, {
        bindHost: '0.0.0.0',
        advertiseHost: 'host.docker.internal',
      });

      sessionApiKey = randomBytes(32).toString('hex');
      const cwd = resolve(req.cwd ?? process.cwd());
      containerAttempted = true;
      await this.checkedCommand(
        [
          'run',
          '--rm',
          '--detach',
          '--name',
          containerName,
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
          '--volume',
          `${cwd}:${AGENT_SERVER_WORKSPACE}`,
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
          body: JSON.stringify(this.createConversationRequest(req, bridge, cwd)),
        },
        req.abort.signal,
      );
      if (!conversation.id) throw new Error('OpenHands did not return a conversation id');
      sessionId = conversation.id;

      await this.requestJson(
        agentServerUrl,
        sessionApiKey,
        `/api/conversations/${encodeURIComponent(sessionId)}/run`,
        { method: 'POST' },
        req.abort.signal,
      );

      const finalInfo = await this.waitForConversation(
        agentServerUrl,
        sessionApiKey,
        sessionId,
        req.abort.signal,
      );
      metrics = readMetrics(finalInfo.stats ?? finalInfo.conversation_stats);
      terminalReason = 'completed';
    } catch (caught) {
      if (caught instanceof OpenHandsConversationError) {
        metrics = readMetrics(caught.info.stats ?? caught.info.conversation_stats);
      }
      error = caught instanceof Error ? caught.message : String(caught);
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
            ['stop', '--time', '5', containerName],
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
      if (bridge) {
        try { await bridge.close(); }
        catch (caught) { cleanupFailures.push(`submit bridge: ${caught instanceof Error ? caught.message : String(caught)}`); }
      }
      if (cleanupFailures.length) {
        error = [error, ...cleanupFailures].filter(Boolean).join('; ');
        terminalReason = 'error';
      }

      const endedAtMs = this.now();
      const resolved = terminalReason === 'completed';
      this.telemetry = {
        executor: this.id,
        modelRequested: req.model,
        providerResolved: resolved ? providerFromModel(req.model) : null,
        modelResolved: resolved ? req.model : null,
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
      costUsd: metrics.costUsd ?? 0,
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
    if (!this.apiKey) {
      throw new UnsupportedOpenHandsRequest(
        'OpenHands executor requires WEAVER_OPENHANDS_API_KEY (or LLM_API_KEY)',
      );
    }

    const cwd = resolve(req.cwd ?? process.cwd());
    const extraDirectories = new Set(
      req.additionalDirectories.map((directory) => resolve(directory)).filter((directory) => directory !== cwd),
    );
    if (extraDirectories.size > 0) {
      throw new UnsupportedOpenHandsRequest(
        'OpenHands executor mounts only cwd; distinct additionalDirectories are unsupported',
      );
    }
  }

  private createConversationRequest(
    req: WorkerExecutionRequest,
    bridge: SubmitBridge,
    hostCwd: string,
  ): Record<string, unknown> {
    return {
      agent: {
        kind: 'Agent',
        llm: {
          usage_id: 'agent',
          model: req.model,
          api_key: this.apiKey,
          ...(this.baseUrl ? { base_url: this.baseUrl } : {}),
        },
        tools: [
          { name: 'TerminalTool' },
          { name: 'FileEditorTool' },
          { name: 'TaskTrackerTool' },
        ],
        system_prompt_kwargs: { cli_mode: true },
        agent_context: {
          system_message_suffix: [
            req.systemPrompt.append,
            `The host working directory ${hostCwd} is mounted at ${AGENT_SERVER_WORKSPACE}; use ${AGENT_SERVER_WORKSPACE} inside this runtime.`,
          ].join('\n\n'),
          load_project_skills: false,
        },
        mcp_config: {
          weaver: {
            url: bridge.url,
            transport: 'streamable-http',
            auth: { strategy: 'bearer', value: bridge.token },
          },
        },
      },
      initial_message: {
        role: 'user',
        content: [{ type: 'text', text: req.prompt }],
      },
      max_iterations: req.maxTurns,
      stuck_detection: true,
      workspace: { type: 'local', working_dir: AGENT_SERVER_WORKSPACE },
      hook_config: null,
      user_id: null,
    };
  }

  private async checkedCommand(args: string[], signal: AbortSignal): Promise<CommandResult> {
    const result = await this.runCommand(this.dockerCommand, args, { signal });
    if (result.exitCode !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`;
      throw new Error(`${this.dockerCommand} ${args[0]} failed: ${detail}`);
    }
    return result;
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

function abortError(): Error {
  const error = new Error('OpenHands run aborted');
  error.name = 'AbortError';
  return error;
}

function isAbort(caught: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (caught instanceof Error && caught.name === 'AbortError');
}
