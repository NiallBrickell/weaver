import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  startProviderProxy,
  type ProviderProxy,
  type ProviderProxyOptions,
} from '../../executor/providerProxy.js';
import type { SubmitBridge, SubmitBridgeOptions } from '../../executor/submitBridge.js';
import { startSubmitBridge } from '../../executor/submitBridge.js';
import type {
  SubmitSurface,
  WorkerExecutionOutcome,
  WorkerExecutionRequest,
} from '../../executor/types.js';
import { loadExecutorSecrets, redactSecrets } from '../../secrets.js';
import type {
  EvalExecutionTelemetry,
  EvalExecutor,
  EvalUsage,
} from '../types.js';

interface ProviderModel {
  providerID: string;
  modelID: string;
}

interface OpenCodeProviderConfiguration {
  apiKey: string;
  apiKeyName: string;
  upstreamBaseUrl: string;
}

const OPEN_CODE_ADAPTER_EPOCH = 'weaver.3';
const PROVIDERS: Record<string, Omit<OpenCodeProviderConfiguration, 'apiKey'>> = {
  openrouter: {
    apiKeyName: 'OPENROUTER_API_KEY',
    upstreamBaseUrl: 'https://openrouter.ai/api/v1',
  },
  'zai-coding-plan': {
    apiKeyName: 'ZHIPU_API_KEY',
    upstreamBaseUrl: 'https://api.z.ai/api/coding/paas/v4',
  },
};

interface OpenCodePromptInput {
  model: ProviderModel;
  prompt: string;
  system: string;
  signal: AbortSignal;
}

interface OpenCodeTokens {
  input?: unknown;
  output?: unknown;
  reasoning?: unknown;
  cache?: { read?: unknown };
}

interface OpenCodePromptResult {
  info?: {
    cost?: unknown;
    tokens?: OpenCodeTokens;
    providerID?: unknown;
    modelID?: unknown;
    error?: unknown;
  };
}

export interface OpenCodeRuntime {
  readonly harnessVersion: string;
  createSession(title: string): Promise<string>;
  prompt(sessionId: string, input: OpenCodePromptInput): Promise<OpenCodePromptResult>;
  abortSession(sessionId: string): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  close(): Promise<void>;
}

export interface OpenCodeRuntimeStart {
  cwd: string;
  bridge: SubmitBridge;
  maxTurns: number;
  model: ProviderModel;
  providerProxy: ProviderProxy;
}

export type StartOpenCodeRuntime = (input: OpenCodeRuntimeStart) => Promise<OpenCodeRuntime>;

export interface OpenCodeEvalExecutorDependencies {
  startRuntime?: StartOpenCodeRuntime;
  startBridge?: (
    submit: SubmitSurface,
    options?: SubmitBridgeOptions,
  ) => Promise<SubmitBridge>;
  startProviderProxy?: (options: ProviderProxyOptions) => Promise<ProviderProxy>;
  executorSecrets?: Record<string, string>;
  now?: () => number;
}

type OpenCodeSdkModule = typeof import('@opencode-ai/sdk/v2');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function responseData(value: unknown): unknown {
  return isRecord(value) && value.data !== undefined ? value.data : value;
}

function requiredString(value: unknown, description: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`OpenCode returned no ${description}`);
  }
  return value;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function splitOpenCodeModel(model: string): ProviderModel {
  if (model.includes('#')) {
    throw new Error(`OpenCode model variants are not supported by this eval adapter, got '${model}'`);
  }
  const slash = model.indexOf('/');
  if (slash <= 0 || slash === model.length - 1) {
    throw new Error(
      `OpenCode requires a provider-qualified model (provider/model), got '${model}'`,
    );
  }
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
}

async function loadOpenCodeSdk(): Promise<OpenCodeSdkModule> {
  const packageName = '@opencode-ai/sdk/v2';
  try {
    return await import('@opencode-ai/sdk/v2');
  } catch (error) {
    throw new Error(`cannot load ${packageName}: ${errorMessage(error)}`);
  }
}

/**
 * OpenCode's SDK helper unconditionally spreads raw process.env into its
 * coding-agent server. Build the child environment explicitly instead: the
 * agent gets enough operating-system context to run local tools, but no
 * Weaver state path, provider credential, auth socket, or operator home.
 */
export function isolatedOpenCodeEnv(
  tempHome: string,
  config: unknown,
  ambient: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const candidates: NodeJS.ProcessEnv = {
    HOME: tempHome,
    XDG_CONFIG_HOME: path.join(tempHome, 'config'),
    XDG_DATA_HOME: path.join(tempHome, 'data'),
    XDG_CACHE_HOME: path.join(tempHome, 'cache'),
    XDG_STATE_HOME: path.join(tempHome, 'state'),
    PATH: ambient.PATH,
    SHELL: ambient.SHELL,
    LANG: ambient.LANG ?? 'C.UTF-8',
    LC_ALL: ambient.LC_ALL,
    TMPDIR: ambient.TMPDIR ?? os.tmpdir(),
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
  };
  return Object.fromEntries(
    Object.entries(candidates).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

export interface IsolatedOpenCodeServer {
  url: string;
  close(): Promise<void>;
}

const OPEN_CODE_START_TIMEOUT_MS = 10_000;
const OPEN_CODE_STOP_TIMEOUT_MS = 5_000;

export async function startIsolatedOpenCodeServer(input: {
  cwd: string;
  config: unknown;
  executable?: string;
  args?: string[];
  ambientEnv?: NodeJS.ProcessEnv;
  startTimeoutMs?: number;
  stopTimeoutMs?: number;
}): Promise<IsolatedOpenCodeServer> {
  const startTimeoutMs = input.startTimeoutMs ?? OPEN_CODE_START_TIMEOUT_MS;
  const stopTimeoutMs = input.stopTimeoutMs ?? OPEN_CODE_STOP_TIMEOUT_MS;
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'weaver-opencode-'));
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(
      input.executable ?? 'opencode',
      input.args ?? ['serve', '--hostname=127.0.0.1', '--port=0'],
      {
        cwd: input.cwd,
        env: isolatedOpenCodeEnv(tempHome, input.config, input.ambientEnv),
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
  } catch (error) {
    await fs.rm(tempHome, { recursive: true, force: true });
    throw error;
  }

  let output = '';
  let startupSettled = false;
  let terminationSettled = false;
  let resolveTermination!: () => void;
  const terminated = new Promise<void>((resolve) => { resolveTermination = resolve; });
  const markTerminated = () => {
    if (terminationSettled) return;
    terminationSettled = true;
    resolveTermination();
  };
  child.once('exit', markTerminated);
  child.once('error', markTerminated);

  const startup = new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (startupSettled) return;
      startupSettled = true;
      reject(new Error(`timeout waiting ${startTimeoutMs}ms for OpenCode server`));
    }, startTimeoutMs);
    timeout.unref?.();

    const rejectStartup = (error: Error) => {
      if (startupSettled) return;
      startupSettled = true;
      clearTimeout(timeout);
      reject(error);
    };
    child.once('error', rejectStartup);
    child.once('exit', (code, signal) => {
      rejectStartup(new Error(
        `OpenCode server exited before readiness (${signal ?? code ?? 'unknown'})` +
          (output.trim() ? `: ${output.trim()}` : ''),
      ));
    });
    child.stdout.on('data', (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-64 * 1024);
      if (startupSettled) return;
      for (const line of output.split(/\r?\n/)) {
        if (!line.startsWith('opencode server listening')) continue;
        const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
        if (!match) {
          rejectStartup(new Error(`cannot parse OpenCode server URL from: ${line}`));
          return;
        }
        startupSettled = true;
        clearTimeout(timeout);
        resolve(match[1]!);
        return;
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-64 * 1024);
    });
  });

  let closed = false;
  const waitForTermination = async (timeoutMs: number): Promise<boolean> => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        terminated.then(() => true),
        new Promise<false>((resolve) => {
          timeout = setTimeout(() => resolve(false), timeoutMs);
          timeout.unref?.();
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  };
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    try {
      if (!terminationSettled) child.kill('SIGTERM');
      const stopped = await waitForTermination(stopTimeoutMs);
      if (!stopped && !terminationSettled) {
        child.kill('SIGKILL');
        if (!await waitForTermination(stopTimeoutMs)) {
          throw new Error('OpenCode server did not exit after SIGKILL');
        }
      }
    } finally {
      await fs.rm(tempHome, { recursive: true, force: true });
    }
  };

  try {
    return { url: await startup, close };
  } catch (error) {
    await close();
    throw error;
  }
}

export const startLocalOpenCodeRuntime: StartOpenCodeRuntime = async ({
  cwd,
  bridge,
  maxTurns,
  model,
  providerProxy,
}) => {
  const sdk = await loadOpenCodeSdk();
  const config = {
    autoupdate: false,
    share: 'disabled' as const,
    enabled_providers: [model.providerID],
    permission: 'allow' as const,
    agent: { build: { maxSteps: maxTurns } },
    provider: {
      [model.providerID]: {
        npm: '@ai-sdk/openai-compatible',
        options: {
          apiKey: providerProxy.token,
          baseURL: providerProxy.url,
        },
        models: {
          [model.modelID]: {
            id: model.modelID,
            name: model.modelID,
            reasoning: true,
            tool_call: true,
            limit: { context: 1_000_000, output: 131_072 },
          },
        },
      },
    },
    mcp: {
      weaver: {
        type: 'remote' as const,
        url: bridge.url,
        enabled: true,
        oauth: false,
        headers: { Authorization: `Bearer ${bridge.token}` },
      },
    },
  };
  const server = await startIsolatedOpenCodeServer({ cwd, config });

  try {
    const client = sdk.createOpencodeClient({
      baseUrl: server.url,
      directory: cwd,
      throwOnError: true,
    });
    const health = responseData(await client.global.health());
    const harnessVersion = isRecord(health) && typeof health.version === 'string'
      ? health.version
      : 'unknown';

    return {
      harnessVersion,
      async createSession(title) {
        const created = responseData(await client.session.create({ title }));
        return requiredString(isRecord(created) ? created.id : undefined, 'session id');
      },
      async prompt(sessionId, input) {
        const result = responseData(await client.session.prompt({
          sessionID: sessionId,
          agent: 'build',
          model: input.model,
          system: input.system,
          parts: [{ type: 'text', text: input.prompt }],
        }, { signal: input.signal }));
        return isRecord(result) ? result as OpenCodePromptResult : {};
      },
      async abortSession(sessionId) {
        await client.session.abort({ sessionID: sessionId });
      },
      async deleteSession(sessionId) {
        await client.session.delete({ sessionID: sessionId });
      },
      async close() {
        await server.close();
      },
    };
  } catch (error) {
    await server.close();
    throw error;
  }
};

const NULL_USAGE: EvalUsage = {
  inputTokens: null,
  outputTokens: null,
  cachedInputTokens: null,
  reasoningOutputTokens: null,
};

export class OpenCodeEvalExecutor implements EvalExecutor {
  readonly id = 'opencode' as const;
  private telemetry: EvalExecutionTelemetry | null = null;
  private readonly startRuntime: StartOpenCodeRuntime;
  private readonly startBridge: NonNullable<OpenCodeEvalExecutorDependencies['startBridge']>;
  private readonly startProviderProxy: NonNullable<OpenCodeEvalExecutorDependencies['startProviderProxy']>;
  private readonly executorSecrets: Record<string, string>;
  private readonly now: () => number;

  constructor(dependencies: OpenCodeEvalExecutorDependencies = {}) {
    this.startRuntime = dependencies.startRuntime ?? startLocalOpenCodeRuntime;
    this.startBridge = dependencies.startBridge ?? startSubmitBridge;
    this.startProviderProxy = dependencies.startProviderProxy ?? startProviderProxy;
    this.executorSecrets = dependencies.executorSecrets ?? loadExecutorSecrets();
    this.now = dependencies.now ?? Date.now;
  }

  lastTelemetry(): EvalExecutionTelemetry | null {
    return this.telemetry;
  }

  async execute(req: WorkerExecutionRequest): Promise<WorkerExecutionOutcome> {
    this.telemetry = null;
    const startedMs = this.now();
    const startedAt = new Date(startedMs).toISOString();

    if (req.supervise) {
      const message = 'OpenCode is eval-only and does not support supervised action workers';
      this.telemetry = this.makeTelemetry({
        req,
        startedMs,
        startedAt,
        terminalReason: 'unsupported',
        error: message,
      });
      return { costUsd: 0, error: message };
    }

    let model: ProviderModel;
    try {
      model = splitOpenCodeModel(req.model);
    } catch (error) {
      const message = errorMessage(error);
      this.telemetry = this.makeTelemetry({
        req,
        startedMs,
        startedAt,
        terminalReason: 'error',
        error: message,
      });
      return { costUsd: 0, error: message };
    }

    let provider: OpenCodeProviderConfiguration;
    try {
      provider = this.providerConfiguration(model);
    } catch (error) {
      const message = errorMessage(error);
      this.telemetry = this.makeTelemetry({
        req,
        startedMs,
        startedAt,
        terminalReason: 'unsupported',
        error: message,
      });
      return { costUsd: 0, error: message };
    }

    if (req.abort.signal.aborted) {
      const message = 'OpenCode eval run was aborted before launch';
      this.telemetry = this.makeTelemetry({
        req,
        startedMs,
        startedAt,
        terminalReason: 'aborted',
        error: message,
      });
      return { costUsd: 0, error: message };
    }

    let submissionMs: number | null = null;
    const observedSubmit: SubmitSurface = {
      appendSection: (content) => req.submit.appendSection(content),
      submitResult: async (args) => {
        const reply = await req.submit.submitResult(args);
        if (!reply.isError) submissionMs ??= this.now();
        return reply;
      },
    };

    let providerProxy: ProviderProxy | undefined;
    let bridge: SubmitBridge | undefined;
    let runtime: OpenCodeRuntime | undefined;
    let sessionId: string | undefined;
    let startupMs: number | null = null;
    let result: OpenCodePromptResult | undefined;
    let failure: string | null = null;
    let terminalReason: EvalExecutionTelemetry['terminalReason'] = 'completed';
    const cleanupFailures: string[] = [];
    let redactionSecrets: Record<string, string> = { ...this.executorSecrets };

    try {
      providerProxy = await this.startProviderProxy({
        upstreamBaseUrl: provider.upstreamBaseUrl,
        upstreamApiKey: provider.apiKey,
        allowedModels: [model.modelID],
        maxRequests: req.maxTurns,
      });
      redactionSecrets = {
        ...redactionSecrets,
        OPEN_CODE_PROVIDER_PROXY_TOKEN: providerProxy.token,
      };
      bridge = await this.startBridge(observedSubmit, {
        rejectArgumentValues: Object.values(redactionSecrets),
        rejectArgumentMessage: 'REFUSED: submission contains executor-private credentials',
      });
      runtime = await this.startRuntime({
        cwd: req.cwd ?? process.cwd(),
        bridge,
        maxTurns: req.maxTurns,
        model,
        providerProxy,
      });
      startupMs = this.now() - startedMs;
      sessionId = await runtime.createSession(`${req.workstreamSlug}/${req.assignmentId}`);
      result = await runtime.prompt(sessionId, {
        model,
        prompt: req.prompt,
        system: [
          req.systemPrompt.append,
          'In OpenCode, Weaver submission tools are named weaver_append_section and weaver_submit_result.',
          `Stop after no more than ${req.maxTurns} provider turns.`,
        ].join('\n\n'),
        signal: req.abort.signal,
      });
      if (result.info?.error !== undefined) {
        failure = errorMessage(result.info.error);
        terminalReason = 'error';
      }
    } catch (error) {
      failure = errorMessage(error);
      terminalReason = req.abort.signal.aborted ? 'aborted' : 'error';
    } finally {
      if (runtime && sessionId && terminalReason !== 'completed') {
        try { await runtime.abortSession(sessionId); }
        catch (error) { cleanupFailures.push(`abort: ${errorMessage(error)}`); }
      }
      if (runtime && sessionId) {
        try { await runtime.deleteSession(sessionId); }
        catch (error) { cleanupFailures.push(`delete: ${errorMessage(error)}`); }
      }
      if (runtime) {
        try { await runtime.close(); }
        catch (error) { cleanupFailures.push(`runtime close: ${errorMessage(error)}`); }
      }
      if (bridge) {
        try { await bridge.close(); }
        catch (error) { cleanupFailures.push(`submit bridge close: ${errorMessage(error)}`); }
      }
      if (providerProxy) {
        try { await providerProxy.close(); }
        catch (error) { cleanupFailures.push(`provider proxy close: ${errorMessage(error)}`); }
      }
    }

    if (cleanupFailures.length) {
      failure = [failure, ...cleanupFailures].filter(Boolean).join('; ');
      terminalReason = 'error';
    }
    if (failure) failure = redactSecrets(failure, redactionSecrets);

    const info = result?.info;
    const usage: EvalUsage = {
      inputTokens: optionalNumber(info?.tokens?.input),
      outputTokens: optionalNumber(info?.tokens?.output),
      cachedInputTokens: optionalNumber(info?.tokens?.cache?.read),
      reasoningOutputTokens: optionalNumber(info?.tokens?.reasoning),
    };
    // Coding Plan quota is subscription-backed. OpenCode reports catalog cost
    // zero, which is not a bill or a marginal-dollar measurement.
    const costUsd = model.providerID === 'zai-coding-plan'
      ? null
      : optionalNumber(info?.cost);
    const resolvedModel = providerProxy?.modelResolved() ?? null;
    const endedMs = this.now();
    this.telemetry = {
      executor: this.id,
      modelRequested: req.model,
      providerResolved: resolvedModel ? model.providerID : null,
      modelResolved: resolvedModel,
      harnessVersion: `${runtime?.harnessVersion ?? 'unknown'}-${OPEN_CODE_ADAPTER_EPOCH}`,
      isolation: 'host-process',
      startedAt,
      endedAt: new Date(endedMs).toISOString(),
      durationMs: endedMs - startedMs,
      startupMs,
      timeToSubmissionMs: submissionMs === null ? null : submissionMs - startedMs,
      usage,
      costUsd,
      sessionId: sessionId ?? null,
      terminalReason,
      error: failure,
    };

    return {
      costUsd: costUsd ?? 0,
      ...(sessionId ? { sessionId } : {}),
      ...(failure ? { error: failure } : {}),
    };
  }

  private providerConfiguration(model: ProviderModel): OpenCodeProviderConfiguration {
    const known = PROVIDERS[model.providerID];
    if (!known) {
      throw new Error(
        `OpenCode eval provider '${model.providerID}' has no executor-only proxy configuration`,
      );
    }
    const apiKey = this.executorSecrets[known.apiKeyName];
    if (!apiKey) {
      throw new Error(
        `OpenCode eval requires ${known.apiKeyName} in executor-only secrets ` +
          '(`weaver secret set <NAME> --executor`)',
      );
    }
    return { ...known, apiKey };
  }

  private makeTelemetry(input: {
    req: WorkerExecutionRequest;
    startedMs: number;
    startedAt: string;
    terminalReason: EvalExecutionTelemetry['terminalReason'];
    error: string;
  }): EvalExecutionTelemetry {
    const endedMs = this.now();
    return {
      executor: this.id,
      modelRequested: input.req.model,
      providerResolved: null,
      modelResolved: null,
      harnessVersion: 'unknown',
      isolation: 'host-process',
      startedAt: input.startedAt,
      endedAt: new Date(endedMs).toISOString(),
      durationMs: endedMs - input.startedMs,
      startupMs: null,
      timeToSubmissionMs: null,
      usage: { ...NULL_USAGE },
      costUsd: null,
      sessionId: null,
      terminalReason: input.terminalReason,
      error: input.error,
    };
  }
}
