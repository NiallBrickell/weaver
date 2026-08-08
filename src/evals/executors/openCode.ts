import type { SubmitBridge, SubmitBridgeOptions } from '../../executor/submitBridge.js';
import { startSubmitBridge } from '../../executor/submitBridge.js';
import type {
  SubmitSurface,
  WorkerExecutionOutcome,
  WorkerExecutionRequest,
} from '../../executor/types.js';
import type {
  EvalExecutionTelemetry,
  EvalExecutor,
  EvalUsage,
} from '../types.js';

interface ProviderModel {
  providerID: string;
  modelID: string;
}

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
}

export type StartOpenCodeRuntime = (input: OpenCodeRuntimeStart) => Promise<OpenCodeRuntime>;

export interface OpenCodeEvalExecutorDependencies {
  startRuntime?: StartOpenCodeRuntime;
  startBridge?: (
    submit: SubmitSurface,
    options?: SubmitBridgeOptions,
  ) => Promise<SubmitBridge>;
  now?: () => number;
  ambientEnv?: NodeJS.ProcessEnv;
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

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
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

export const startLocalOpenCodeRuntime: StartOpenCodeRuntime = async ({
  cwd,
  bridge,
  maxTurns,
}) => {
  const sdk = await loadOpenCodeSdk();
  const server = await sdk.createOpencodeServer({
    hostname: '127.0.0.1',
    port: 0,
    config: {
      autoupdate: false,
      permission: 'allow',
      agent: { build: { maxSteps: maxTurns } },
      mcp: {
        weaver: {
          type: 'remote',
          url: bridge.url,
          enabled: true,
          oauth: false,
          headers: { Authorization: `Bearer ${bridge.token}` },
        },
      },
    },
  });

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
        server.close();
      },
    };
  } catch (error) {
    server.close();
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
  private readonly now: () => number;
  private readonly ambientEnv: NodeJS.ProcessEnv;

  constructor(dependencies: OpenCodeEvalExecutorDependencies = {}) {
    this.startRuntime = dependencies.startRuntime ?? startLocalOpenCodeRuntime;
    this.startBridge = dependencies.startBridge ?? startSubmitBridge;
    this.now = dependencies.now ?? Date.now;
    this.ambientEnv = dependencies.ambientEnv ?? process.env;
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

    const strippedAmbientCredentials = [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'CLAUDE_CODE_OAUTH_TOKEN',
    ].filter((name) => this.ambientEnv[name] !== undefined && req.env[name] === undefined);
    if (strippedAmbientCredentials.length) {
      const message = `OpenCode's SDK server inherits raw process.env and would bypass Weaver credential sanitization (${strippedAmbientCredentials.join(', ')})`;
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

    let bridge: SubmitBridge | undefined;
    let runtime: OpenCodeRuntime | undefined;
    let sessionId: string | undefined;
    let startupMs: number | null = null;
    let result: OpenCodePromptResult | undefined;
    let failure: string | null = null;
    let terminalReason: EvalExecutionTelemetry['terminalReason'] = 'completed';
    const cleanupFailures: string[] = [];

    try {
      bridge = await this.startBridge(observedSubmit);
      runtime = await this.startRuntime({
        cwd: req.cwd ?? process.cwd(),
        bridge,
        maxTurns: req.maxTurns,
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
    }

    if (cleanupFailures.length) {
      failure = [failure, ...cleanupFailures].filter(Boolean).join('; ');
      terminalReason = 'error';
    }

    const info = result?.info;
    const usage: EvalUsage = {
      inputTokens: optionalNumber(info?.tokens?.input),
      outputTokens: optionalNumber(info?.tokens?.output),
      cachedInputTokens: optionalNumber(info?.tokens?.cache?.read),
      reasoningOutputTokens: optionalNumber(info?.tokens?.reasoning),
    };
    const costUsd = optionalNumber(info?.cost);
    const endedMs = this.now();
    this.telemetry = {
      executor: this.id,
      modelRequested: req.model,
      providerResolved: optionalString(info?.providerID),
      modelResolved: optionalString(info?.modelID),
      harnessVersion: runtime?.harnessVersion ?? 'unknown',
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
